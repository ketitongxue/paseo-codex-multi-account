import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { FailoverSettings } from "../shared/contracts";
import { Accounts } from "./accounts";
import { CodexRpc } from "./codex-rpc";
import { PublicError } from "./errors";
import { Failover } from "./failover";
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
  readonly failover: Failover;
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
    const busy = (id: string) => this.logins.busy(id) || this.mutations.has(id);
    this.switching = new Switching(this.accounts, busy, nativePreflight(command, env));
    this.failover = new Failover(this.accounts, this.usage, this.switching, busy);
  }
  async login(accountId: string, mode: "device" | "browser") {
    const account = await this.accounts.resolve(accountId);
    if (this.mutations.has(account.id) || this.switching.inUse(account.id))
      throw new PublicError("An account change is in progress.");
    this.mutations.add(account.id);
    try {
      const state = await this.accounts.store.read();
      if (Object.values(state.bindings).some((binding) => binding.accountId === account.id))
        throw new PublicError(
          "This account is already bound to an agent. Create another account to sign in without replacing the active identity.",
        );
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
      throw new PublicError("Wait for the account operation to finish.");
    this.mutations.add(account.id);
    try {
      const state = await this.accounts.store.read();
      if (
        state.defaultId === account.id ||
        Object.values(state.bindings).some((binding) => binding.accountId === account.id)
      )
        throw new PublicError(
          "Clear the default account and switch bound agents to another account or release their bindings before removing this account.",
        );
      if (purge) await this.accounts.store.assertManaged(account);
      // Claim deletion in the serialized registry before any credential or filesystem mutation.
      await this.accounts.store.change((registry) => {
        if (
          registry.defaultId === account.id ||
          Object.values(registry.bindings).some((binding) => binding.accountId === account.id)
        )
          throw new PublicError("Removal was denied because the account binding changed.");
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
    if (this.switching.isApplying(agentId))
      throw new PublicError("Wait for the agent's account switch to finish.");
    const live = await paseo.agents.ref(agentId).refresh();
    if (live && !live.agent.archivedAt)
      throw new PublicError("Bindings can only be released for archived or deleted agents.");
    await this.accounts.store.change((state) => {
      if (this.switching.isApplying(agentId))
        throw new PublicError("Wait for the agent's account switch to finish.");
      delete state.bindings[agentId];
      if (!state.released.includes(agentId)) state.released.push(agentId);
    });
    return {};
  }
  async setFailover(settings: FailoverSettings): Promise<void> {
    await this.accounts.store.change((state) => {
      state.failover = settings;
    });
  }
  async close(): Promise<void> {
    await this.logins.close();
  }
}
