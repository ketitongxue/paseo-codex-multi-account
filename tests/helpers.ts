import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../server/accounts";
import { Store } from "../server/store";
export function authJson(
  id = "acct-synthetic-A",
  exp = Math.floor(Date.now() / 1000) + 3600,
  rotation = "a",
) {
  const jwt = (claims: unknown) =>
    `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${rotation}`;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({
        exp,
        "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "plus" },
      }),
      id_token: jwt({ email: `${id}@example.invalid` }),
      account_id: id,
      refresh_token: "REFRESH_SECRET_NEVER_PERSIST",
    },
  });
}
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-codex-multi-test-"));
  const user = join(root, "user");
  await mkdir(user, { mode: 0o700 });
  const store = new Store(join(root, "state"));
  const keyring = new Map<string, string>();
  const accounts = new Accounts(store, user, {}, async (home) => keyring.get(home) ?? null);
  const home = async (name: string, identity = name, exp?: number) => {
    const path = join(user, name);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "auth.json"), authJson(identity, exp), { mode: 0o600 });
    return accounts.save(path, name.replace(/^\.codex-?/, "") || "default");
  };
  return {
    root,
    user,
    store,
    accounts,
    keyring,
    home,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
export const quota = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 25, reset_at: 2000000000, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 60, reset_at: 2000000000, limit_window_seconds: 604800 },
  },
  credits: { balance: "0" },
};
