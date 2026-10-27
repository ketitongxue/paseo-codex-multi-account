import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { accountEnvironment, CodexRpc } from "../server/codex-rpc";
import { Logins, officialLoginUrl } from "../server/login";
import { nativePreflight } from "../server/switching";
import { authJson, fixture } from "./helpers";

const command = [
  process.execPath,
  fileURLToPath(new URL("./fixtures/fake-codex.cjs", import.meta.url)),
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(scenario = "success", timeout = 10000) {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const account = await f.store.create("safe");
  f.keyring.set(account.home, authJson("secure-account"));
  const env = {
    ...process.env,
    TEST_CODEX_SCENARIO: scenario,
    TEST_CODEX_CAPTURE: join(f.root, "capture.json"),
    OPENAI_API_KEY: "SHOULD_BE_REMOVED",
    PI_TEST_SECRET: "SHOULD_BE_REMOVED",
  };
  const logins = new Logins(f.accounts, command, env, timeout);
  cleanups.push(() => logins.close());
  return { ...f, account, logins, env };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}
describe("official Codex secure sign-in subprocess", () => {
  it.each(["success", "early"])(
    "handles %s completion without writing any credential file",
    async (scenario) => {
      const f = await setup(scenario);
      const result = await f.logins.start(f.account, "device");
      await waitFor(() => f.logins.status(result.id).status === "complete");
      expect(f.logins.status(result.id)).toMatchObject({
        status: "complete",
        url: null,
        code: null,
      });
      await waitFor(() => !f.logins.busy(f.account.id));
      expect(await readdir(f.account.home)).toEqual(["config.toml"]);
      const capture = JSON.parse(await readFile(join(f.root, "capture.json"), "utf8"));
      expect(capture.argv).toContain('cli_auth_credentials_store="keyring"');
      expect(capture.argv).toContain('auth_keyring_backend="direct"');
      expect(capture.apiKey).toBeUndefined();
      expect(capture.pi).toBeUndefined();
      expect(JSON.stringify(f.logins.status(result.id))).not.toContain("SECRET");
    },
  );
  it.each(["missing", "expired", "unknown-identity"])(
    "does not trust a completion event when keyring verification is %s",
    async (state) => {
      const f = await setup("early");
      if (state === "missing") f.keyring.delete(f.account.home);
      else if (state === "expired") f.keyring.set(f.account.home, authJson("expired", 1));
      else
        f.keyring.set(
          f.account.home,
          JSON.stringify({ tokens: { access_token: "opaque-synthetic" } }),
        );
      const result = await f.logins.start(f.account, "device");
      await waitFor(() => f.logins.status(result.id).status === "error");
      expect(f.logins.status(result.id)).toMatchObject({ url: null, code: null });
      await waitFor(() => !f.logins.busy(f.account.id));
      expect(await readdir(f.account.home)).toEqual(["config.toml"]);
    },
  );
  it("supports browser URLs and clears transient authorization data on cancel", async () => {
    const f = await setup("wait");
    const result = await f.logins.start(f.account, "browser");
    expect(f.logins.active(f.account.id)?.id).toBe(result.id);
    expect(result.url).toContain("https://auth.openai.com/oauth/authorize");
    expect(result.code).toBeNull();
    await expect(f.logins.start(f.account, "device")).rejects.toThrow("正在登录");
    await f.logins.cancel(result.id);
    expect(f.logins.status(result.id)).toMatchObject({ status: "canceled", url: null, code: null });
    expect(f.logins.busy(f.account.id)).toBe(false);
    expect(f.logins.active(f.account.id)).toBeNull();
  });
  it("ignores foreign completion; enforces timeout and cleanup", async () => {
    const f = await setup("mismatch", 200);
    const result = await f.logins.start(f.account, "device");
    expect(result.status).toBe("waiting");
    await waitFor(() => f.logins.status(result.id).status === "error");
    await waitFor(() => !f.logins.busy(f.account.id));
    expect(f.logins.status(result.id).url).toBeNull();
  });
  it.each(["unsafe", "error"])(
    "sanitizes %s upstream output and rejects nonofficial links",
    async (scenario) => {
      const f = await setup(scenario);
      await expect(f.logins.start(f.account, "device")).rejects.toThrow("安全登录");
      expect(f.logins.busy(f.account.id)).toBe(false);
      expect(() =>
        officialLoginUrl("https://auth.openai.com.evil.invalid/codex/device", "device"),
      ).toThrow();
      expect(() =>
        officialLoginUrl("https://user:pass@auth.openai.com/codex/device", "device"),
      ).toThrow();
    },
  );
  it("will not log in to external homes and never silently falls back to files", async () => {
    const f = await setup();
    const external = await f.home(".codex-external");
    await expect(f.logins.start(external, "device")).rejects.toThrow();
    expect((await readdir(external.home)).includes("auth.json")).toBe(true);
  });
  it("rejects a thread invisible to the target home without creating a model turn", async () => {
    const f = await setup("missing-thread");
    await expect(nativePreflight(command, f.env)(f.account, "old-thread")).rejects.toThrow(
      "原会话历史",
    );
    const capture = JSON.parse(await readFile(join(f.root, "capture.json"), "utf8"));
    expect(capture.home).toBe(f.account.home);
  });
  it("handles RPC timeout and missing executable without hanging cleanup", async () => {
    const f = await setup("hang");
    const rpc = new CodexRpc(command, f.account.home, f.env);
    try {
      await expect(rpc.request("initialize", {}, 100)).rejects.toThrow("超时");
    } finally {
      await rpc.close();
    }
    const missing = new CodexRpc(["/not/a/codex-binary"], f.account.home, f.env);
    try {
      await expect(missing.initialize()).rejects.toThrow("无法启动");
    } finally {
      await missing.close();
    }
    expect(
      accountEnvironment("/test", { OPENAI_API_KEY: "x", CODEX_HOME: "/old", KEEP: "y" }),
    ).toMatchObject({ CODEX_HOME: "/test", KEEP: "y" });
  });
});
