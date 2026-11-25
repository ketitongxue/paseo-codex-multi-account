import { readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Account, AccountView, Snapshot } from "../shared/contracts";
import { Name } from "../shared/contracts";
import { homeConfig, type KeyringRead, readCredential } from "./credentials";
import { PublicError, safeMessage } from "./errors";
import { canonicalHome } from "./files";
import { homeId, resolveFailover, type Store } from "./store";

export class Accounts {
  constructor(
    readonly store: Store,
    readonly userHome: string,
    readonly env: NodeJS.ProcessEnv,
    readonly keyring?: KeyringRead,
  ) {}
  async all(): Promise<Account[]> {
    const state = await this.store.read();
    const discovered = new Map<string, Account>();
    const paths = [
      join(this.userHome, ".codex"),
      ...(this.env.CODEX_HOME ? [this.env.CODEX_HOME] : []),
    ];
    try {
      for (const entry of await readdir(this.userHome, { withFileTypes: true })) {
        if (
          /^\.codex[-_][^/]+$/.test(entry.name) &&
          (entry.isDirectory() || entry.isSymbolicLink())
        )
          paths.push(join(this.userHome, entry.name));
      }
    } catch {
      /* Explicit saved homes remain usable if the parent cannot be listed. */
    }
    for (const path of paths.slice(0, 128)) {
      try {
        const home = await canonicalHome(path, this.userHome);
        if (!state.hidden.includes(home)) {
          const name = Name.safeParse(basename(path).replace(/^\.codex[-_]?/, "") || "default");
          discovered.set(home, {
            id: homeId(home),
            name: name.success ? name.data : "Codex",
            home,
            managed: false,
          });
        }
      } catch {
        /* Missing automatic candidates are not accounts. */
      }
    }
    for (const account of state.accounts) discovered.set(account.home, account);
    return [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async resolve(selector: string): Promise<Account> {
    const all = await this.all();
    const exact = all.find((account) => account.id === selector || account.home === selector);
    if (exact) return exact;
    const names = all.filter((account) => account.name === selector);
    if (names.length === 1) return names[0];
    throw new PublicError(
      names.length
        ? "More than one account has that name. Use an account ID."
        : "Account not found or hidden. Rediscover or save the account.",
    );
  }
  async credential(account: Account) {
    if ((await realpath(account.home)) !== account.home)
      throw new PublicError("The operation was denied because the CODEX_HOME path was replaced.");
    if (account.managed) {
      await this.store.assertManaged(account);
      const config = await homeConfig(account.home);
      if (config.mode !== "keyring" || !config.direct)
        throw new PublicError("Managed accounts must use strict direct keyring mode.");
    }
    return readCredential(account.home, this.keyring);
  }
  async requireCredential(account: Account) {
    const auth = await this.credential(account);
    if (!auth || auth.identity.expired)
      throw new PublicError(
        "The selected account is signed out or its credentials have expired. Sign in again through Codex.",
      );
    if (!auth.accountId)
      throw new PublicError(
        "A stable ChatGPT account ID is required to bind an agent. Sign in again through Codex.",
      );
    return auth;
  }
  async view(account: Account, saved: boolean, loginBusy = false): Promise<AccountView> {
    try {
      const auth = await this.credential(account);
      return {
        ...account,
        saved,
        identity: auth?.identity ?? null,
        problem: auth ? null : "No ChatGPT subscription account is signed in",
        loginBusy,
      };
    } catch (error) {
      return { ...account, saved, identity: null, problem: safeMessage(error), loginBusy };
    }
  }
  async snapshot(busy: (accountId: string) => boolean = () => false): Promise<Snapshot> {
    const state = await this.store.read();
    const accounts: AccountView[] = [];
    // Keychain prompts and reads are bounded, not one process for every account at once.
    for (const account of await this.all())
      accounts.push(
        await this.view(
          account,
          state.accounts.some((a) => a.id === account.id),
          busy(account.id),
        ),
      );
    return {
      accounts,
      defaultId: state.defaultId,
      bindings: state.bindings,
      failover: resolveFailover(state.failover),
    };
  }
  async save(homeInput: string, name: string): Promise<Account> {
    const home = await canonicalHome(homeInput, this.userHome);
    const previous = (await this.all()).find((account) => account.home === home);
    const account = {
      id: homeId(home),
      home,
      name: Name.parse(name),
      managed: previous?.managed ?? false,
    };
    await this.store.change((state) => {
      state.accounts = state.accounts.filter((a) => a.id !== account.id);
      state.accounts.push(account);
      state.hidden = state.hidden.filter((path) => path !== home);
    });
    return account;
  }
  async setDefault(accountId: string | null): Promise<void> {
    const account = accountId ? await this.resolve(accountId) : null;
    if (account) await this.requireCredential(account);
    await this.store.change((state) => {
      if (account && state.hidden.includes(account.home))
        throw new PublicError("The account was just removed. Save it again before selecting it.");
      state.defaultId = account?.id ?? null;
    });
  }
}
