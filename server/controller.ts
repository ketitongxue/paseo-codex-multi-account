import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { Accounts } from "./accounts";
import { CodexRpc } from "./codex-rpc";
import { PublicError } from "./errors";
import { Logins } from "./login";
import { Store } from "./store";
import { nativePreflight, Switching } from "./switching";
import { Usage } from "./usage";

type PaseoApi = PluginHandlerContext["paseo"];

export class Controller {
  readonly accounts: Accounts;
  readonly usage: Usage;
  readonly logins: Logins;
  readonly switching: Switching;
  private mutations = new Set<string>();
  constructor(
    readonly env = process.env,
    readonly userHome = homedir(),
    root = join(env.PASEO_HOME || join(userHome, ".paseo"), "codex-multi-account"),
    readonly command = [env.PASEO_CODEX_BINARY || "codex"],
  ) {
    this.accounts = new Accounts(new Store(resolve(root)), userHome, env);
    this.usage = new Usage(this.accounts);
    this.logins = new Logins(this.accounts, command, env);
    this.switching = new Switching(
      this.accounts,
      (id) => this.logins.busy(id) || this.mutations.has(id),
      nativePreflight(command, env),
    );
  }
  async login(accountId: string, mode: "device" | "browser") {
    const account = await this.accounts.resolve(accountId);
    if (this.mutations.has(account.id) || this.switching.inUse(account.id))
      throw new PublicError("该账号正在变更。");
    this.mutations.add(account.id);
    try {
      const state = await this.accounts.store.read();
      if (Object.values(state.bindings).some((binding) => binding.accountId === account.id))
        throw new PublicError("该账号已绑定 Agent；为避免替换运行中的身份，请创建另一个账号登录。");
      return await this.logins.start(account, mode);
    } finally {
      this.mutations.delete(account.id);
    }
  }
  async remove(accountId: string, purge: boolean) {
    const account = await this.accounts.resolve(accountId);
    if (
      this.logins.busy(account.id) ||
      this.mutations.has(account.id) ||
      this.switching.inUse(account.id)
    )
      throw new PublicError("请先结束该账号的操作。");
    this.mutations.add(account.id);
    try {
      const state = await this.accounts.store.read();
      if (
        state.defaultId === account.id ||
        Object.values(state.bindings).some((binding) => binding.accountId === account.id)
      )
        throw new PublicError("请先取消默认账号，并将已绑定 Agent 切换到其他账号或释放绑定。");
      if (purge) await this.accounts.store.assertManaged(account);
      // Claim deletion in the serialized registry before any credential or filesystem mutation.
      await this.accounts.store.change((registry) => {
        if (
          registry.defaultId === account.id ||
          Object.values(registry.bindings).some((binding) => binding.accountId === account.id)
        )
          throw new PublicError("账号绑定已变化，删除被拒绝。");
        registry.accounts = registry.accounts.filter((entry) => entry.id !== account.id);
        if (!registry.hidden.includes(account.home)) registry.hidden.push(account.home);
      });
      try {
        if (purge) {
          const rpc = new CodexRpc(this.command, account.home, this.env, true);
          try {
            await rpc.initialize();
            await rpc.request("account/logout", {});
          } finally {
            await rpc.close();
          }
          // Never recurse through an external path, shared-home symlink, or the default Codex home.
          await this.accounts.store.assertManaged(account);
          await rm(account.home, { recursive: true, force: false });
        }
      } catch (error) {
        await this.accounts.store.change((registry) => {
          const saved = state.accounts.find((entry) => entry.id === account.id);
          if (saved && !registry.accounts.some((entry) => entry.id === account.id))
            registry.accounts.push(saved);
          if (!state.hidden.includes(account.home))
            registry.hidden = registry.hidden.filter((home) => home !== account.home);
        });
        throw error;
      }
      this.usage.forget(account.id);
      return {};
    } finally {
      this.mutations.delete(account.id);
    }
  }
  async release(agentId: string, paseo: PaseoApi) {
    if (this.switching.isApplying(agentId)) throw new PublicError("请等待 Agent 账号切换结束。");
    const live = await paseo.agents.ref(agentId).refresh();
    if (live && !live.agent.archivedAt)
      throw new PublicError("只能释放已归档或已删除 Agent 的绑定；运行中的账号不能被遗忘。");
    await this.accounts.store.change((state) => {
      if (this.switching.isApplying(agentId)) throw new PublicError("请等待 Agent 账号切换结束。");
      delete state.bindings[agentId];
      if (!state.released.includes(agentId)) state.released.push(agentId);
    });
    return {};
  }
  async close(): Promise<void> {
    await this.logins.close();
  }
}
