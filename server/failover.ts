import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { Account, FailoverNotice } from "../shared/contracts";
import { FAILOVER_KIND } from "../shared/contracts";
import type { Accounts } from "./accounts";
import type { TurnEndedEvent } from "./compatibility";
import { safeMessage } from "./errors";
import { resolveFailover } from "./store";
import { StaleTurn, type Switching } from "./switching";
import { exhaustedWindows, minRemainingPct, type Usage } from "./usage";

type PaseoApi = PluginHookContext["paseo"];

// Auto switching is bounded so a chain of failing turns cannot bounce accounts forever.
const AUTO_WINDOW_MS = 3_600_000;
const AUTO_MAX_PER_HOUR = 3;
const NO_RETURN_MS = 3_600_000;

const iso = (value: number) => new Date(value).toISOString();

export class Failover {
  private autoAt = new Map<string, number[]>();
  private leftAt = new Map<string, Map<string, number>>();
  private offered = new Map<string, { accountId: string; resetsAt: number }>();

  constructor(
    readonly accounts: Accounts,
    readonly usage: Usage,
    readonly switching: Switching,
    readonly busy: (accountId: string) => boolean,
    readonly now: () => number = Date.now,
  ) {}

  async onTurnEnded(event: TurnEndedEvent, context: PluginHookContext): Promise<void> {
    if (event.agent.provider !== "codex") return;
    const origin = this.switching.turn(event.agent.id, event.turnId);
    if (!origin || origin.ended) return;
    origin.ended = true;
    const currentTurn = () => this.switching.turn(event.agent.id, event.turnId) === origin;
    try {
      await this.evaluate(event, context.paseo, currentTurn);
    } catch (error) {
      console.error("[failover] turn check failed", error);
    } finally {
      this.switching.forgetTurn(event.agent.id, origin);
    }
  }

  private async evaluate(
    event: TurnEndedEvent,
    paseo: PaseoApi,
    currentTurn: () => boolean,
  ): Promise<void> {
    // A canceled turn stopped by the user says nothing about the account.
    if (event.outcome.kind === "canceled") return;
    const state = await this.accounts.store.read();
    const settings = resolveFailover(state.failover);
    if (!currentTurn() || settings.mode === "off") return;
    const agentId = event.agent.id;
    const binding = Object.hasOwn(state.bindings, agentId) ? state.bindings[agentId] : undefined;
    // Only agents this plugin manages; unconfirmed bindings need an explicit re-selection.
    if (!binding || state.released.includes(agentId) || binding.status === "unconfirmed") return;

    const now = this.now();
    // A failed Codex turn is how quota exhaustion surfaces, so read that account for real.
    // Completed turns only consult the last cached report: no provider request per turn.
    const current =
      event.outcome.kind === "failed"
        ? (await this.usage.list(binding.accountId, true))[0]
        : this.usage.peek(binding.accountId);
    if (!currentTurn() || !current) return;
    const exhausted = exhaustedWindows(current.report, now);
    if (!exhausted.length) return;

    const account = state.accounts.find((entry) => entry.id === binding.accountId);
    const fromName = account?.name ?? binding.accountId;
    // The latest reset among the used-up windows, as the time the user waits for.
    const resetMs = exhausted.reduce(
      (latest, window) => Math.max(latest, window.resetsAt ? Date.parse(window.resetsAt) : 0),
      0,
    );

    if (settings.mode === "auto" && this.autoAllowed(agentId, now)) {
      const target = (await this.candidates(agentId, binding.accountId, now))[0];
      if (!currentTurn()) return;
      if (!target) {
        await this.notice(paseo, agentId, {
          variant: "exhausted",
          at: iso(now),
          fromName,
          resetsAt: resetMs ? iso(resetMs) : null,
          auto: true,
        });
        return;
      }
      try {
        let continued = false;
        const continueTurn = async () => {
          try {
            await paseo.agents.ref(agentId).send("Continue.");
            continued = true;
          } catch (error) {
            console.error("[failover] continue message failed", error);
          }
        };
        await this.switching.switch(agentId, target.account.id, paseo, {
          source: binding,
          currentTurn,
          afterCommit:
            settings.autoContinue && event.outcome.kind === "failed" ? continueTurn : undefined,
        });
        this.recordAuto(agentId, binding.accountId, now);
        await this.notice(paseo, agentId, {
          variant: "switched",
          at: iso(now),
          fromName,
          toName: target.account.name,
          auto: true,
          continued,
        });
      } catch (error) {
        if (error instanceof StaleTurn) return;
        await this.notice(paseo, agentId, {
          variant: "failed",
          at: iso(now),
          fromName,
          toName: target.account.name,
          auto: true,
          reason: safeMessage(error),
        });
      }
      return;
    }
    // Offer (or auto past its guards): one row per used-up account and reset.
    const previous = this.offered.get(agentId);
    if (previous && previous.accountId === binding.accountId && previous.resetsAt === resetMs)
      return;
    const candidates = await this.candidates(agentId, binding.accountId, now);
    if (!currentTurn()) return;
    this.offered.set(agentId, { accountId: binding.accountId, resetsAt: resetMs });
    await this.notice(paseo, agentId, {
      variant: "exhausted",
      at: iso(now),
      fromName,
      toName: candidates[0]?.account.name,
      resetsAt: resetMs ? iso(resetMs) : null,
      auto: false,
    });
  }

  /** Accounts this agent may switch to, best remaining room first; no provider requests. */
  private async candidates(
    agentId: string,
    fromAccountId: string,
    now: number,
  ): Promise<Array<{ account: Account; remaining: number | null }>> {
    const departed = this.leftAt.get(agentId);
    const result: Array<{ account: Account; remaining: number | null }> = [];
    for (const account of await this.accounts.all()) {
      if (account.id === fromAccountId) continue;
      if (this.busy(account.id) || this.switching.inUse(account.id)) continue;
      const left = departed?.get(account.id);
      if (left != null && now - left < NO_RETURN_MS) continue;
      try {
        await this.accounts.requireCredential(account);
      } catch {
        continue;
      }
      const row = this.usage.peek(account.id);
      if (row && exhaustedWindows(row.report, now).length) continue;
      result.push({
        account,
        remaining: row && row.report.status === "available" ? minRemainingPct(row.report) : null,
      });
    }
    return result.sort((a, b) => {
      if (a.remaining == null || b.remaining == null) {
        if (a.remaining != null) return -1;
        if (b.remaining != null) return 1;
        return a.account.name.localeCompare(b.account.name);
      }
      return b.remaining - a.remaining;
    });
  }

  private autoAllowed(agentId: string, now: number): boolean {
    const recent = (this.autoAt.get(agentId) ?? []).filter((time) => now - time < AUTO_WINDOW_MS);
    this.autoAt.set(agentId, recent);
    return recent.length < AUTO_MAX_PER_HOUR;
  }

  private recordAuto(agentId: string, fromAccountId: string, now: number): void {
    const history = this.autoAt.get(agentId) ?? [];
    history.push(now);
    this.autoAt.set(agentId, history);
    let departed = this.leftAt.get(agentId);
    if (!departed) {
      departed = new Map();
      this.leftAt.set(agentId, departed);
    }
    departed.set(fromAccountId, now);
  }

  /** Chat rows are best effort: a refused or lost row never undoes a switch. */
  private async notice(paseo: PaseoApi, agentId: string, data: FailoverNotice): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `failover-${this.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`,
        kind: FAILOVER_KIND,
        version: 1,
        data,
      });
    } catch (error) {
      console.error("[failover] timeline notice skipped", error);
    }
  }
}
