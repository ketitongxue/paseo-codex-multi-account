import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Accounts } from "../server/accounts";
import { keyringAccount, readCredential } from "../server/credentials";
import { authJson, fixture } from "./helpers";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  return f;
}
describe("account registry and credentials", () => {
  it("discovers .codex, suffix homes and CODEX_HOME without writing; canonicalizes aliases", async () => {
    const f = await setup();
    await f.home(".codex");
    await f.home(".codex-keti");
    const custom = await f.home("custom");
    await symlink(join(f.user, ".codex-keti"), join(f.user, ".codex-alias"));
    await f.store.change((state) => {
      state.accounts = [];
    });
    const service = new Accounts(f.store, f.user, { CODEX_HOME: custom.home }, f.accounts.keyring);
    const before = await readFile(f.store.path, "utf8");
    expect((await service.all()).map((a) => a.home)).toHaveLength(3);
    expect((await service.all()).some((a) => a.home === custom.home)).toBe(true);
    expect(await readFile(f.store.path, "utf8")).toBe(before);
  });
  it("serializes concurrent writes; does not store any token; uses private permissions", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.store.change((state) => {
          state.hidden.push(`hidden-${i}`);
        }),
      ),
    );
    expect((await f.store.read()).hidden).toHaveLength(20);
    const snapshot = await f.accounts.snapshot();
    const text = JSON.stringify(snapshot) + (await readFile(f.store.path, "utf8"));
    expect(text).not.toContain("REFRESH_SECRET");
    expect(text).not.toContain("access_token");
    const auth = await f.accounts.credential(a);
    expect(auth).not.toBeNull();
    if (!auth) throw new Error("missing synthetic credential");
    expect(text).not.toContain(auth.token);
    expect((await stat(f.store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(f.store.root)).mode & 0o777).toBe(0o700);
  });
  it("creates a keyring-only home, rereads rotated tokens, never writes auth.json", async () => {
    const f = await setup(),
      a = await f.store.create("safe");
    const config = await readFile(join(a.home, "config.toml"), "utf8");
    expect(config).toContain('cli_auth_credentials_store = "keyring"');
    expect(config).not.toContain('"auto"');
    f.keyring.set(a.home, authJson("secure-A"));
    const first = await f.accounts.credential(a);
    expect(first?.identity.storage).toBe("keyring");
    f.keyring.set(a.home, authJson("secure-A", undefined, "rotated"));
    const second = await f.accounts.credential(a);
    expect(second?.identity.key).toBe(first?.identity.key);
    expect(second?.fingerprint).not.toBe(first?.fingerprint);
    expect(await readdir(a.home)).toEqual(["config.toml"]);
    expect(await keyringAccount(a.home)).toMatch(/^cli\|[a-f0-9]{16}$/);
  });
  it("recognizes root-level account claims without using email as stable identity", async () => {
    const f = await setup(),
      a = await f.home(".codex-root-claim");
    const value = JSON.parse(authJson("root-identity"));
    delete value.tokens.account_id;
    value.tokens.access_token = `test.${Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        chatgpt_account_id: "root-identity",
      }),
    ).toString("base64url")}.test`;
    await writeFile(join(a.home, "auth.json"), JSON.stringify(value));
    expect((await f.accounts.credential(a))?.accountId).toBe("root-identity");
  });
  it("does not accept an expired login as the default for new Agents", async () => {
    const f = await setup(),
      a = await f.home(".codex-expired-default", "expired", 1);
    await expect(f.accounts.setDefault(a.id)).rejects.toThrow("过期");
    expect((await f.store.read()).defaultId).toBeNull();
  });
  it("never falls back from a failed keyring to an older file credential", async () => {
    const f = await setup(),
      a = await f.home(".codex-auto");
    await writeFile(join(a.home, "config.toml"), 'cli_auth_credentials_store = "auto"');
    await expect(
      readCredential(a.home, async () => {
        throw new Error("LOCKED SECRET");
      }),
    ).rejects.toThrow();
    const view = await f.accounts.view(a, true);
    expect(JSON.stringify(view)).not.toContain("LOCKED SECRET");
  });
  it("fails closed on corrupt registry, symlinked managed homes and unsafe paths", async () => {
    const f = await setup();
    await expect(f.accounts.save("relative-home", "bad")).rejects.toThrow("绝对");
    const a = await f.store.create("safe");
    const external = join(f.user, "external");
    await mkdir(external);
    await symlink(external, join(f.store.homes, "link"));
    await expect(
      f.store.assertManaged({ ...a, home: join(f.store.homes, "link") }),
    ).rejects.toThrow("不安全");
    await writeFile(f.store.path, '{"tokens":"SENSITIVE"');
    await expect(
      f.store.change((state) => {
        state.defaultId = a.id;
      }),
    ).rejects.toThrow("注册表损坏");
    expect(await readFile(f.store.path, "utf8")).toBe('{"tokens":"SENSITIVE"');
  });
  it("handles missing, API key, expired and malformed credentials without returning tokens", async () => {
    const f = await setup(),
      a = await f.home(".codex-expired", "old", 1);
    expect((await f.accounts.credential(a))?.identity.expired).toBe(true);
    await writeFile(join(a.home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "API_SECRET" }));
    expect(await f.accounts.credential(a)).toBeNull();
    await writeFile(join(a.home, "auth.json"), "BAD_TOKEN_CONTENT");
    const view = await f.accounts.view(a, true);
    expect(view.identity).toBeNull();
    expect(JSON.stringify(view)).not.toContain("BAD_TOKEN_CONTENT");
  });
});
