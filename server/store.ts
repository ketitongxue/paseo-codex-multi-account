import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Account, Binding } from "../shared/contracts";
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
  })
  .strict();
export type Registry = z.infer<typeof Registry>;
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
      throw new PublicError("账号注册表损坏，已停止写入；请恢复备份。");
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
      throw new PublicError("外部 CODEX_HOME 只读；请用原 Codex CLI 登录，或创建插件托管账号。");
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
      if (missing(error)) throw new PublicError("托管账号目录已丢失。");
      throw new PublicError("托管账号目录不安全，操作已拒绝。");
    }
  }
}
