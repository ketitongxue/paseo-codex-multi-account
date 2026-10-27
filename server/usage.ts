import { basename } from "node:path";
import {
  toneFromUsedPct,
  type UsageAccount,
  type UsageScope,
  type UsageSourceRegistration,
  windowFromReportedDuration,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { Account, Report, UsageRow } from "../shared/contracts";
import type { Accounts } from "./accounts";
import type { Credential } from "./credentials";
import { PublicError, safeMessage } from "./errors";
import { canonicalHome } from "./files";
import { homeId } from "./store";

const number = z
  .union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite());
const window = z.object({
  used_percent: number.nullish(),
  reset_at: number.nullish(),
  limit_window_seconds: number.nullish(),
});
const rate = z.object({ primary_window: window.nullish(), secondary_window: window.nullish() });
const Response = z
  .object({
    plan_type: z.string().max(80).optional(),
    rate_limit: rate.nullish(),
    additional_rate_limits: z
      .array(
        z.object({
          limit_name: z.string().max(160).optional(),
          metered_feature: z.string().max(160).optional(),
          rate_limit: rate.nullish(),
        }),
      )
      .nullish(),
    code_review_rate_limit: rate.nullish(),
    credits: z.object({ balance: number.nullish() }).nullish(),
  })
  .refine(
    (value) =>
      value.plan_type !== undefined ||
      value.rate_limit != null ||
      !!value.additional_rate_limits?.length ||
      value.code_review_rate_limit != null ||
      value.credits != null,
    "Unrecognized Codex usage response",
  );
function iso(seconds: number | null | undefined): string | null {
  if (seconds == null || Math.abs(seconds) > 8.64e12) return null;
  return new Date(seconds * 1000).toISOString();
}
function windows(
  value: z.infer<typeof rate> | null | undefined,
  scope?: { id: string; label: string },
) {
  return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
    const entry = value?.[slot];
    if (!entry) return [];
    const pct = entry.used_percent == null ? null : Math.max(0, Math.min(100, entry.used_percent));
    return [
      windowFromReportedDuration({
        durationSeconds: entry.limit_window_seconds ?? null,
        scope,
        summary: !scope,
        unknown: {
          id: `unknown_${slot}`,
          label: slot === "primary_window" ? "Primary limit" : "Secondary limit",
          shortLabel: "",
        },
        utilizationPct: pct,
        resetsAt: iso(entry.reset_at),
        tone: toneFromUsedPct(pct),
      }),
    ];
  });
}
export function parseUsage(value: unknown): Report {
  const data = Response.parse(value);
  return {
    status: "available",
    planLabel: data.plan_type,
    windows: [
      ...windows(data.rate_limit),
      ...(data.additional_rate_limits ?? []).flatMap((extra) => {
        const key = extra.metered_feature || extra.limit_name;
        return key
          ? windows(extra.rate_limit, {
              id: `feature:${encodeURIComponent(key)}`,
              label: extra.limit_name || key,
            })
          : [];
      }),
      ...windows(data.code_review_rate_limit, { id: "code_review", label: "Code review" }),
    ],
    balances:
      data.credits?.balance == null
        ? []
        : [{ id: "credits", label: "Credits", unit: "credits", remaining: data.credits.balance }],
    details: [],
  };
}
export class RateLimited extends PublicError {
  constructor(readonly retryMs: number) {
    super("额度接口限流，请稍后重试。");
  }
}
export async function fetchUsage(
  auth: Credential,
  fetchApi: typeof fetch = fetch,
  now = Date.now(),
): Promise<Report> {
  if (auth.expiresAt !== null && auth.expiresAt <= now)
    return {
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(auth.expiresAt).toISOString(),
        refreshedBy: "codex",
      },
    };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 Paseo-Codex-Multi-Account",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Awaited<ReturnType<typeof fetch>> | undefined;
  try {
    try {
      response = await fetchApi("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new PublicError("额度查询超时或网络不可用。");
    }
    if (response.status === 401 || response.status === 403)
      return {
        status: "unavailable",
        problem: { kind: "rejected", status: response.status, refreshedBy: "codex" },
      };
    if (response.status === 429) {
      const value = response.headers.get("retry-after");
      const delay =
        value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value ?? "") - now;
      throw new RateLimited(
        Number.isFinite(delay) ? Math.max(1000, Math.min(86400000, delay)) : 60000,
      );
    }
    if (!response.ok) throw new PublicError(`额度接口返回 HTTP ${response.status}。`);
    try {
      // Bound the body even if the upstream ignores Content-Length.
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 1024 * 1024) throw new Error();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return parseUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new PublicError("额度接口返回了无法识别的数据；未显示估算额度。");
    }
  } finally {
    clearTimeout(timer);
    // Rejection/rate-limit bodies are not parsed, but must be disposed to release the connection.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
const SourceInput = z
  .object({ accountId: z.string(), home: z.string(), identityKey: z.string() })
  .strict();
export class Usage {
  private cache = new Map<
    string,
    { fingerprint: string; identity: string; row: UsageRow; deadline: number; failures: number }
  >();
  private pending = new Map<string, Promise<UsageRow>>();
  private sessionHomes = new Map<string, Account>();
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(
    readonly accounts: Accounts,
    readonly fetchApi: typeof fetch = fetch,
    readonly now = Date.now,
  ) {}
  async forAccount(account: Account, force = false): Promise<UsageRow> {
    const existing = this.pending.get(account.id);
    if (existing) return existing;
    const work = this.collect(account, force).finally(() => this.pending.delete(account.id));
    this.pending.set(account.id, work);
    return work;
  }
  private async collect(account: Account, force: boolean): Promise<UsageRow> {
    if (this.running >= 2) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.running++;
    try {
      const auth = await this.accounts.credential(account);
      if (!auth) throw new PublicError("请先通过 Codex 登录 ChatGPT 订阅账号。");
      const cached = this.cache.get(account.id),
        now = this.now();
      const same =
        cached?.fingerprint === auth.fingerprint && cached.identity === auth.identity.key;
      if (same && cached.deadline > now && (!force || cached.row.nextRetryAt)) return cached.row;
      let report: Report,
        retry = 0,
        failures = same ? cached.failures : 0;
      try {
        report = await fetchUsage(auth, this.fetchApi, now);
        if (report.status !== "available") retry = 60000;
        else failures = 0;
      } catch (error) {
        failures++;
        retry =
          error instanceof RateLimited
            ? error.retryMs
            : Math.min(1800000, 30000 * 2 ** Math.min(failures - 1, 6));
        report = { status: "error", error: safeMessage(error) };
      }
      const after = await this.accounts.credential(account);
      if (
        !after ||
        after.identity.key !== auth.identity.key ||
        after.fingerprint !== auth.fingerprint
      )
        throw new PublicError("查询期间账号凭据发生变化，请重新刷新。");
      const row: UsageRow = {
        accountId: account.id,
        report,
        fetchedAt: new Date(now).toISOString(),
        nextRetryAt: retry ? new Date(now + retry).toISOString() : null,
      };
      this.cache.set(account.id, {
        fingerprint: auth.fingerprint,
        identity: auth.identity.key,
        row,
        failures,
        deadline:
          report.status === "available"
            ? Math.min(now + 300000, auth.expiresAt ?? Number.POSITIVE_INFINITY)
            : now + (retry || 300000),
      });
      return row;
    } catch (error) {
      this.cache.delete(account.id);
      return {
        accountId: account.id,
        report: { status: "error", error: safeMessage(error) },
        fetchedAt: new Date(this.now()).toISOString(),
        nextRetryAt: null,
      };
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }
  async list(accountId?: string, force = false): Promise<UsageRow[]> {
    const all = accountId ? [await this.accounts.resolve(accountId)] : await this.accounts.all();
    return Promise.all(all.map((account) => this.forAccount(account, force)));
  }
  forget(id: string): void {
    this.cache.delete(id);
  }
  source(): UsageSourceRegistration {
    return {
      id: "codex-multi-account",
      label: "Codex Multi Account",
      input: SourceInput,
      discover: (scope) => this.discover(scope),
      fetch: async (value) => {
        try {
          const input = SourceInput.parse(value);
          // Inputs are opaque locators, not authority to read arbitrary files.
          const account =
            this.sessionHomes.get(input.accountId) ??
            (await this.accounts.resolve(input.accountId));
          if (account.home !== input.home)
            throw new PublicError("账号路径已变化，请重新发现账号。");
          const auth = await this.accounts.credential(account);
          if (!auth || auth.identity.key !== input.identityKey)
            throw new PublicError("账号身份已变化，请重新打开 Usage。");
          const { report } = await this.forAccount(account, true);
          const after = await this.accounts.credential(account);
          if (
            !after ||
            after.identity.key !== input.identityKey ||
            after.fingerprint !== auth.fingerprint
          )
            throw new PublicError("查询期间凭据发生变化，请重新打开 Usage。");
          return report;
        } catch (error) {
          return { status: "error", error: safeMessage(error) };
        }
      },
    };
  }
  async discover(scope: UsageScope): Promise<UsageAccount[]> {
    let all: Account[];
    if (scope.kind === "global") all = await this.accounts.all();
    else {
      if (
        scope.provider !== "codex" ||
        scope.env.OPENAI_BASE_URL ||
        scope.env.OPENAI_API_KEY ||
        scope.env.CODEX_API_KEY
      )
        return [];
      const home = await canonicalHome(
        scope.env.CODEX_HOME ||
          joinDefault(scope.env.HOME || scope.env.USERPROFILE || this.accounts.userHome),
        this.accounts.userHome,
      ).catch(() => null);
      if (!home) return [];
      // Session discovery reads exactly this launch's home, never scans global candidates.
      const state = await this.accounts.store.read();
      const account = state.accounts.find((entry) => entry.home === home) ?? {
        id: homeId(home),
        home,
        name: basename(home).slice(0, 80) || "Codex",
        managed: false,
      };
      this.sessionHomes.set(account.id, account);
      all = [account];
    }
    const found: UsageAccount[] = [];
    for (const account of all) {
      try {
        const auth = await this.accounts.credential(account);
        if (auth)
          found.push({
            key: auth.identity.key,
            label: auth.identity.email || account.name,
            harness: `Codex · ${account.name}`,
            input: { accountId: account.id, home: account.home, identityKey: auth.identity.key },
          });
      } catch {
        /* Unreadable credentials appear with a remedy on the plugin account screen. */
      }
    }
    return found;
  }
}
function joinDefault(home: string): string {
  return `${home}/.codex`;
}
