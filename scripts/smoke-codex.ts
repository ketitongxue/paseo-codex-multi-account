// Real CLI protocol smoke, entirely in a disposable home. No OAuth, keyring access or model turn.
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpc } from "../server/codex-rpc";

const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-codex-protocol-")));
let rpc: CodexRpc | undefined;
try {
  const user = join(root, "user"),
    home = join(user, ".codex"),
    temporary = join(root, "tmp");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: user,
    USERPROFILE: user,
    XDG_CONFIG_HOME: join(user, ".config"),
    XDG_DATA_HOME: join(user, ".local", "share"),
    XDG_STATE_HOME: join(user, ".local", "state"),
    XDG_CACHE_HOME: join(user, ".cache"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    // Startup must not contact a provider, even if a future CLI adds a background probe.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  };
  rpc = new CodexRpc(
    [
      process.env.PASEO_CODEX_BINARY || "codex",
      "-c",
      'cli_auth_credentials_store="ephemeral"',
      "-c",
      "analytics.enabled=false",
      "-c",
      "feedback.enabled=false",
    ],
    home,
    env,
  );
  await rpc.initialize();
  const value = await rpc.request("account/read", { refreshToken: false });
  if (!value || typeof value !== "object" || !("account" in value) || value.account !== null)
    throw new Error("Isolated Codex account/read did not return the expected signed-out account.");
  await rpc.close();
  rpc = undefined;
  const files = await readdir(root, { recursive: true });
  if (files.some((path) => /(^|[/\\])auth\.json$/.test(path)))
    throw new Error("Unexpected auth.json created by the isolated protocol smoke.");
  console.log(
    JSON.stringify({
      transport: "stdio",
      initialize: "ok",
      accountRead: "signed-out",
      credentialStore: "ephemeral",
      authFileCreated: false,
      modelTurns: 0,
      existingConfigurationTouched: false,
    }),
  );
} finally {
  await rpc?.close();
  await rm(root, { recursive: true, force: true });
}
