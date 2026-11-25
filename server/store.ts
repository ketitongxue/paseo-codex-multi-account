import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  Account,
  Binding,
  FailoverSettings,
  type FailoverSettings as FailoverSettingsValue,
} from "../shared/contracts";
import { PublicError } from "./errors";
import { atomicWrite, missing, optionalText, privateDir } from "./files";

const Registry = z
  .object({
    version: z.literal(1),
    accounts: z.array(Account),
    defaultId: z.string().nullable(),
    hidden: z.array(z.string()),
    bindings: z.record(z.string(), Binding),
    released: z.array(z.string()).default([]),
    failover: FailoverSettings.optional(),
  })
  .strict();
export type Registry = z.infer<typeof Registry>;
// Older registries predate the failover setting; they read as the safe default.
export const DEFAULT_FAILOVER: FailoverSettingsValue = { mode: "offer", autoContinue: true };
export function resolveFailover(value: Registry["failover"]): FailoverSettingsValue {
  return value ?? DEFAULT_FAILOVER;
}
export function homeId(home: string): string {
  return `home-${createHash("sha256").update(home).digest("hex").slice(0, 24)}`;
}
export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  readonly path: string;
  readonly homes: string;
  constructor(readonly root: string) {
    this.path = join(root, "accounts.json");
    this.homes = join(root, "homes");
  }
  async read(): Promise<Registry> {
    const text = await optionalText(this.path);
    if (text === null)
      return { version: 1, accounts: [], hidden: [], defaultId: null, bindings: {}, released: [] };
    try {
      return Registry.parse(JSON.parse(text));
    } catch {
      throw new PublicError(
        "The account registry is corrupted and writes are disabled. Restore it from a backup.",
      );
    }
  }
  async change<T>(update: (state: Registry) => T | Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const state = await this.read();
      const result = await update(state);
      await atomicWrite(this.path, `${JSON.stringify(Registry.parse(state), null, 2)}\n`);
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async create(name: string): Promise<Account> {
    await privateDir(this.root);
    await privateDir(this.homes);
    const home = join(await realpath(this.homes), randomUUID());
    await privateDir(home);
    // Strict keyring, never "auto": neither first login nor future CLI refresh may fall back to auth.json.
    await atomicWrite(
      join(home, "config.toml"),
      'cli_auth_credentials_store = "keyring"\nauth_keyring_backend = "direct"\n',
    );
    const account = Account.parse({ id: homeId(home), name, home, managed: true });
    await this.change((state) => {
      state.accounts.push(account);
    });
    return account;
  }
  async assertManaged(account: Account): Promise<void> {
    if (!account.managed)
      throw new PublicError(
        "An external CODEX_HOME is read-only. Sign in using the original Codex CLI or create a plugin-managed account.",
      );
    try {
      const home = await lstat(account.home);
      const root = await realpath(this.homes);
      const expected = join(root, account.home.split("/").at(-1) ?? "");
      if (
        !home.isDirectory() ||
        home.isSymbolicLink() ||
        expected !== account.home ||
        (await realpath(account.home)) !== expected
      )
        throw new Error();
      if ((await lstat(this.homes)).isSymbolicLink() || (await lstat(this.root)).isSymbolicLink())
        throw new Error();
    } catch (error) {
      if (missing(error)) throw new PublicError("The managed account directory is missing.");
      throw new PublicError(
        "The operation was denied because the managed account directory is unsafe.",
      );
    }
  }
}
