import type { PluginHandlerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { ACCOUNT_ENV, ACCOUNT_LABEL, type Account, type Binding } from "../shared/contracts";
import type { Accounts } from "./accounts";
import { AUTH_OVERRIDES, CodexRpc } from "./codex-rpc";
import { PublicError } from "./errors";

type PaseoApi = PluginHandlerContext["paseo"];
export type Preflight = (account: Account, threadId: string | null) => Promise<void>;
export class Switching {
  private applying = new Set<string>();
  private overrides = new Map<string, Binding>();
  private observed = new Map<string, string>();
  private targets = new Map<string, Set<string>>();
  inUse(accountId: string): boolean {
    return [...this.targets.values()].some((accounts) => accounts.has(accountId));
  }
  isApplying(agentId: string): boolean {
    return this.applying.has(agentId);
  }
  constructor(
    readonly accounts: Accounts,
    readonly busy: (accountId: string) => boolean,
    readonly preflight: Preflight,
  ) {}
  async open(request: PluginSessionOpenRequest): Promise<PluginSessionOpenRequest | undefined> {
    if (request.provider !== "codex") return;
    const state = await this.accounts.store.read();
    const stored = Object.hasOwn(state.bindings, request.agentId)
      ? state.bindings[request.agentId]
      : undefined;
    const override = this.overrides.get(request.agentId);
    if (state.released.includes(request.agentId) && !override)
      throw new PublicError(
        "This agent's account binding was released. Select an account explicitly to start this agent.",
      );
    if (stored?.status === "unconfirmed" && !override)
      throw new PublicError(
        "This agent's previous switch was unconfirmed. Select an account again before starting the agent.",
      );
    const selector =
      override?.accountId ??
      stored?.accountId ??
      request.env[ACCOUNT_ENV] ??
      request.labels[ACCOUNT_LABEL] ??
      (request.reason === "create" && request.purpose === "interactive" ? state.defaultId : null);
    if (!selector) return;
    for (const key of AUTH_OVERRIDES)
      if (request.env[key] || this.accounts.env[key])
        throw new PublicError(
          `Environment variable ${key} conflicts with ChatGPT account isolation. Remove it from the Codex provider or daemon environment.`,
        );
    const account = await this.accounts.resolve(selector);
    if (this.busy(account.id))
      throw new PublicError(
        "Sign-in is in progress for this account. Wait for it to finish before starting the agent.",
      );
    const auth = await this.accounts.requireCredential(account);
    if (this.busy(account.id))
      throw new PublicError(
        "An account change is in progress. Try starting the agent again later.",
      );
    const binding = override ?? stored;
    if (binding && binding.identityKey !== auth.identity.key)
      throw new PublicError(
        "The account identity for the selected CODEX_HOME changed. Select an account again.",
      );
    if (!stored && !override && request.purpose === "interactive")
      await this.accounts.store.change((registry) => {
        if (registry.hidden.includes(account.home) || this.busy(account.id))
          throw new PublicError(
            "Account removal or sign-in is in progress. The account could not be bound.",
          );
        const current = Object.hasOwn(registry.bindings, request.agentId)
          ? registry.bindings[request.agentId]
          : undefined;
        if (
          registry.released.includes(request.agentId) ||
          this.overrides.has(request.agentId) ||
          (current &&
            (current.accountId !== account.id ||
              current.identityKey !== auth.identity.key ||
              current.status === "unconfirmed"))
        )
          throw new PublicError("The agent binding changed. Reopen the session.");
        if (!current)
          registry.bindings[request.agentId] = {
            accountId: account.id,
            identityKey: auth.identity.key,
            status: "selected",
          };
      });
    if (override && request.purpose === "interactive" && request.reason === "refresh")
      this.observed.set(request.agentId, account.id);
    const { [ACCOUNT_ENV]: _selector, ...env } = request.env;
    return { ...request, env: { ...env, CODEX_HOME: account.home } };
  }
  async switch(agentId: string, selector: string, paseo: PaseoApi): Promise<Binding> {
    if (this.applying.has(agentId))
      throw new PublicError("This agent is already switching accounts.");
    this.applying.add(agentId);
    let previous: Binding | undefined;
    let started = false;
    try {
      const account = await this.accounts.resolve(selector);
      const reserved = new Set([account.id]);
      this.targets.set(agentId, reserved);
      if (this.busy(account.id))
        throw new PublicError("Wait for this account's sign-in to finish.");
      const auth = await this.accounts.requireCredential(account);
      const ref = paseo.agents.ref(agentId);
      const inspect = async () => {
        const live = await ref.refresh();
        if (!live) throw new PublicError("Agent not found.");
        const agent = live.agent;
        if (agent.provider !== "codex" || agent.archivedAt)
          throw new PublicError("Account switching is available only for unarchived Codex agents.");
        if (
          !["idle", "error", "closed"].includes(agent.status) ||
          agent.activeTurn ||
          agent.pendingPermissions.length
        )
          throw new PublicError(
            "Wait until the agent is idle and resolve pending permission requests before switching.",
          );
        return agent;
      };
      const agent = await inspect();
      const state = await this.accounts.store.read();
      previous = Object.hasOwn(state.bindings, agentId) ? state.bindings[agentId] : undefined;
      // The registry will temporarily point at the target. Keep the rollback account reserved
      // as well, so another client cannot delete it or replace its login during reload.
      if (previous) reserved.add(previous.accountId);
      await this.preflight(account, agent.persistence?.sessionId ?? null);
      await inspect();
      const binding: Binding = {
        accountId: account.id,
        identityKey: auth.identity.key,
        status: "active",
      };
      // Persist unknown before changing the running session. A crash never leaves an assumed active account.
      await this.accounts.store.change((registry) => {
        registry.bindings[agentId] = { ...binding, status: "unconfirmed" };
      });
      this.overrides.set(agentId, binding);
      this.observed.delete(agentId);
      started = true;
      const reloaded = await ref.reload();
      if (!reloaded || this.observed.get(agentId) !== account.id)
        throw new PublicError("The new account's session_open was unconfirmed.");
      await this.accounts.store.change((registry) => {
        registry.bindings[agentId] = binding;
        registry.released = registry.released.filter((id) => id !== agentId);
      });
      return binding;
    } catch (error) {
      if (started && previous) {
        let restored = false;
        this.overrides.set(agentId, previous);
        this.observed.delete(agentId);
        try {
          const ref = paseo.agents.ref(agentId),
            live = await ref.refresh();
          if (
            live &&
            ["idle", "error", "closed"].includes(live.agent.status) &&
            !live.agent.activeTurn &&
            !live.agent.pendingPermissions.length
          ) {
            restored = !!(await ref.reload()) && this.observed.get(agentId) === previous.accountId;
          }
        } catch {
          /* Preserve unconfirmed state rather than pretending rollback succeeded. */
        }
        const prior = previous;
        await this.accounts.store.change((registry) => {
          registry.bindings[agentId] = {
            ...prior,
            status: restored ? prior.status : "unconfirmed",
          };
        });
        throw new PublicError(
          restored
            ? "The switch failed. The original account was restored."
            : "The switch and rollback could not be confirmed. Select an account again or create a new agent before sending messages.",
        );
      }
      if (started)
        throw new PublicError(
          "The switch failed. The original session account is unknown and the binding is marked unconfirmed. Select the original account or create a new agent.",
        );
      throw error;
    } finally {
      this.overrides.delete(agentId);
      this.observed.delete(agentId);
      this.applying.delete(agentId);
      this.targets.delete(agentId);
    }
  }
}
export function nativePreflight(command: string[], env: NodeJS.ProcessEnv): Preflight {
  return async (account, threadId) => {
    const rpc = new CodexRpc(command, account.home, env, account.managed);
    try {
      await rpc.initialize();
      const value = (await rpc.request("account/read", { refreshToken: false })) as {
        account?: { type?: string };
      };
      if (value?.account?.type !== "chatgpt")
        throw new PublicError("The target account must be signed in to a ChatGPT subscription.");
      if (threadId) {
        try {
          await rpc.request("thread/read", { threadId, includeTurns: false });
        } catch {
          throw new PublicError(
            "The target CODEX_HOME cannot read the original session history. Create a new agent with the target account or configure shared native session history before switching.",
          );
        }
      }
    } finally {
      await rpc.close();
    }
  };
}
