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
      throw new PublicError("此 Agent 的账号绑定已释放；请显式选择账号，不能回落到默认 CLI 身份。");
    if (stored?.status === "unconfirmed" && !override)
      throw new PublicError("此 Agent 上次切换未确认，请重新选择账号，不会自动启动未确认的身份。");
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
          `环境变量 ${key} 与 ChatGPT 账号隔离冲突，请从 Codex provider/daemon 环境中移除。`,
        );
    const account = await this.accounts.resolve(selector);
    if (this.busy(account.id)) throw new PublicError("该账号正在登录，暂不能启动 Agent。");
    const auth = await this.accounts.requireCredential(account);
    if (this.busy(account.id)) throw new PublicError("账号正在变更，请稍后再启动 Agent。");
    const binding = override ?? stored;
    if (binding && binding.identityKey !== auth.identity.key)
      throw new PublicError("所选 CODEX_HOME 的账号身份已改变；请显式重新选择账号。");
    if (!stored && !override && request.purpose === "interactive")
      await this.accounts.store.change((registry) => {
        if (registry.hidden.includes(account.home) || this.busy(account.id))
          throw new PublicError("账号正在删除或登录，绑定已拒绝。");
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
          throw new PublicError("Agent 绑定已变化，请重新打开会话。");
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
    if (this.applying.has(agentId)) throw new PublicError("此 Agent 正在切换账号。");
    this.applying.add(agentId);
    let previous: Binding | undefined;
    let started = false;
    try {
      const account = await this.accounts.resolve(selector);
      const reserved = new Set([account.id]);
      this.targets.set(agentId, reserved);
      if (this.busy(account.id)) throw new PublicError("请等待该账号登录结束。");
      const auth = await this.accounts.requireCredential(account);
      const ref = paseo.agents.ref(agentId);
      const inspect = async () => {
        const live = await ref.refresh();
        if (!live) throw new PublicError("Agent 不存在。");
        const agent = live.agent;
        if (agent.provider !== "codex" || agent.archivedAt)
          throw new PublicError("只能切换未归档的 Codex Agent。");
        if (
          !["idle", "error", "closed"].includes(agent.status) ||
          agent.activeTurn ||
          agent.pendingPermissions.length
        )
          throw new PublicError("请等待 Agent 空闲并处理权限请求后再切换。");
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
        throw new PublicError("新账号的 session_open 未得到确认。");
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
            ? "切换失败，已恢复原账号。"
            : "切换与回退未能确认；请勿继续发送消息，重新选择账号或新建 Agent。",
        );
      }
      if (started)
        throw new PublicError(
          "切换失败，原会话账号未知，已标记为未确认；请显式重选原账号或新建 Agent。",
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
        throw new PublicError("目标账号不是已登录的 ChatGPT 订阅。");
      if (threadId) {
        try {
          await rpc.request("thread/read", { threadId, includeTurns: false });
        } catch {
          throw new PublicError(
            "目标 CODEX_HOME 无法读取原会话历史，已拒绝切换。请用目标账号新建 Agent，或先由你配置共享原生历史。",
          );
        }
      }
    } finally {
      await rpc.close();
    }
  };
}
