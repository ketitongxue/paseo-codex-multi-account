import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Account, Login } from "../shared/contracts";
import type { Accounts } from "./accounts";
import { CodexRpc } from "./codex-rpc";
import { homeConfig } from "./credentials";
import { PublicError } from "./errors";
import { optionalText } from "./files";

export function officialLoginUrl(value: unknown, mode: "device" | "browser"): string {
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x20\x7f]/.test(value))
    throw new PublicError("Codex 返回了不安全的登录链接。");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== (mode === "device" ? "/codex/device" : "/oauth/authorize")
  )
    throw new PublicError("Codex 返回了不安全的登录链接。");
  return url.toString();
}
const Start = z.object({
  loginId: z.string().min(1),
  type: z.string(),
  authUrl: z.string().optional(),
  verificationUrl: z.string().optional(),
  userCode: z
    .string()
    .regex(/^[A-Za-z0-9-]{3,64}$/)
    .optional(),
});
const Completion = z.object({ loginId: z.string(), success: z.boolean() });
interface Entry {
  value: Login;
  account: Account;
  rpc: CodexRpc;
  nativeId?: string;
  timer: ReturnType<typeof setTimeout>;
  finishing?: Promise<void>;
}
export class Logins {
  private entries = new Map<string, Entry>();
  private reserved = new Set<string>();
  private disposed = false;
  constructor(
    readonly accounts: Accounts,
    readonly command: string[],
    readonly env: NodeJS.ProcessEnv,
    readonly timeoutMs = 15 * 60000,
  ) {}
  busy(accountId: string): boolean {
    return this.reserved.has(accountId);
  }
  async start(account: Account, mode: "device" | "browser"): Promise<Login> {
    if (this.disposed || this.busy(account.id))
      throw new PublicError("该账号正在登录或插件正在关闭。");
    this.reserved.add(account.id);
    // Keep only a bounded in-memory tail of completed attempts; no authorization data is persisted.
    for (const [id, entry] of this.entries) {
      if (this.entries.size < 32) break;
      if (entry.finishing) this.entries.delete(id);
    }
    let entry: Entry | undefined;
    try {
      await this.accounts.store.assertManaged(account);
      const config = await homeConfig(account.home);
      if (
        config.mode !== "keyring" ||
        !config.direct ||
        (await optionalText(join(account.home, "auth.json"))) !== null
      )
        throw new PublicError(
          "托管登录要求严格 keyring 配置且不存在 auth.json；不会覆盖已有认证文件。",
        );
      // Check keyring access first. A missing item is expected, a locked/unavailable store is not.
      await this.accounts.keyring?.(account.home);
      const rpc = new CodexRpc(this.command, account.home, this.env, true);
      const id = randomUUID();
      entry = {
        account,
        rpc,
        value: {
          id,
          accountId: account.id,
          status: "starting",
          url: null,
          code: null,
          error: null,
          expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
        },
        timer: setTimeout(() => {
          void this.finish(id, "error", "登录已过期，请重试。");
        }, this.timeoutMs),
      };
      entry.timer.unref();
      this.entries.set(id, entry);
      // Completion can arrive before the login-start response. Keep only bounded non-secret completion metadata.
      const completions: z.infer<typeof Completion>[] = [];
      rpc.subscribe((message) => {
        if (message.method !== "account/login/completed") return;
        const parsed = Completion.safeParse(message.params);
        if (!parsed.success) return;
        if (entry?.nativeId === parsed.data.loginId) void this.complete(id, parsed.data.success);
        else if (!entry?.nativeId && completions.length < 8) completions.push(parsed.data);
      });
      void rpc.onClose().then(() => {
        if (entry && !entry.finishing) void this.finish(id, "error", "登录进程意外退出，请重试。");
      });
      await rpc.initialize();
      const started = Start.parse(
        await rpc.request("account/login/start", {
          type: mode === "device" ? "chatgptDeviceCode" : "chatgpt",
        }),
      );
      if (entry.finishing) throw new PublicError("登录已取消或过期。");
      if (
        started.type !== (mode === "device" ? "chatgptDeviceCode" : "chatgpt") ||
        (mode === "device" && !started.userCode)
      )
        throw new PublicError("该 Codex CLI 不支持所选登录方式。");
      entry.nativeId = started.loginId;
      entry.value.url = officialLoginUrl(
        mode === "device" ? started.verificationUrl : started.authUrl,
        mode,
      );
      entry.value.code = mode === "device" ? (started.userCode ?? null) : null;
      entry.value.status = "waiting";
      const pending = completions.find((value) => value.loginId === started.loginId);
      if (pending) await this.complete(id, pending.success);
      return structuredClone(entry.value);
    } catch {
      if (entry)
        await this.finish(
          entry.value.id,
          "error",
          "无法完成登录；请检查 Codex 版本、设备登录设置与系统 keyring。",
        );
      else this.reserved.delete(account.id);
      throw new PublicError("无法开始安全登录；请检查 Codex 版本、设备登录设置与系统 keyring。");
    }
  }
  private async complete(id: string, success: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.finishing) return;
    if (!success) {
      await this.finish(id, "error", "Codex 未完成登录，请重试。");
      return;
    }
    try {
      // Verify the official CLI saved a usable subscription credential in the system keyring, not a file.
      const auth = await this.accounts.requireCredential(entry.account);
      if (
        auth.identity.storage !== "keyring" ||
        (await optionalText(join(entry.account.home, "auth.json"))) !== null
      )
        throw new Error();
      await this.finish(id, "complete");
    } catch {
      await this.finish(id, "error", "无法验证 keyring 中的登录结果，未将账号标记为已登录。");
    }
  }
  private finish(id: string, status: Login["status"], error: string | null = null): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.finishing) return entry.finishing;
    entry.value.status = status;
    entry.value.url = null;
    entry.value.code = null;
    entry.value.error = error;
    clearTimeout(entry.timer);
    entry.finishing = (async () => {
      await entry.rpc.close();
      this.reserved.delete(entry.account.id);
    })();
    return entry.finishing;
  }
  active(accountId: string): Login | null {
    const entry = [...this.entries.values()].find(
      (entry) => entry.account.id === accountId && !entry.finishing,
    );
    return entry ? structuredClone(entry.value) : null;
  }
  status(id: string): Login {
    const entry = this.entries.get(id);
    if (!entry) throw new PublicError("登录已失效，请重新开始。");
    return structuredClone(entry.value);
  }
  async cancel(id: string): Promise<void> {
    if (!this.entries.has(id)) throw new PublicError("登录已失效。");
    await this.finish(id, "canceled");
  }
  async close(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.cancel(id)));
    this.entries.clear();
  }
}
