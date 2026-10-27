import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath as canonicalPath } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";
import type { Identity } from "../shared/contracts";
import { PublicError } from "./errors";
import { optionalText } from "./files";

export type KeyringRead = (home: string) => Promise<string | null>;
export async function keyringAccount(home: string): Promise<string> {
  const canonical = await canonicalPath(home);
  return `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}
export async function readKeyring(home: string): Promise<string | null> {
  const account = await keyringAccount(home);
  const executable = process.platform === "darwin" ? "/usr/bin/security" : "secret-tool";
  const args =
    process.platform === "darwin"
      ? ["find-generic-password", "-s", "Codex Auth", "-a", account, "-w"]
      : ["lookup", "service", "Codex Auth", "username", account];
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new PublicError("此平台尚不支持读取 Codex keyring。");
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim() || null);
        if (
          (process.platform === "darwin" && error.code === 44) ||
          (process.platform === "linux" && error.code === 1 && !stderr.trim())
        )
          return resolve(null);
        reject(
          new PublicError(
            "无法读取系统安全存储；请解锁 Keychain/keyring（Linux 需要 Secret Service 与 secret-tool）。",
          ),
        );
      },
    );
  });
}
export interface HomeConfig {
  mode: "file" | "keyring" | "auto" | "ephemeral";
  direct: boolean;
  subscription: boolean;
}
export async function homeConfig(home: string): Promise<HomeConfig> {
  try {
    const text = await optionalText(join(home, "config.toml"));
    const config = text ? TOML.parse(text) : {};
    const mode = z
      .enum(["file", "keyring", "auto", "ephemeral"])
      .parse(config.cli_auth_credentials_store ?? "file");
    const subscription =
      (!config.model_provider || config.model_provider === "openai") &&
      !config.chatgpt_base_url &&
      (!config.forced_login_method || config.forced_login_method === "chatgpt") &&
      !config.model_providers;
    return {
      mode,
      direct: !config.auth_keyring_backend || config.auth_keyring_backend === "direct",
      subscription,
    };
  } catch {
    throw new PublicError("无法解析该 CODEX_HOME 的 config.toml。");
  }
}
const Auth = z.object({
  OPENAI_API_KEY: z.string().nullish(),
  tokens: z
    .object({
      access_token: z
        .string()
        .min(1)
        .max(128 * 1024),
      id_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .optional(),
});
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function claims(token?: string): Record<string, unknown> {
  try {
    return object(
      JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
  } catch {
    return {};
  }
}
function text(value: unknown, limit = 256): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : null;
}
export interface Credential {
  token: string;
  accountId: string | null;
  expiresAt: number | null;
  fingerprint: string;
  identity: Identity;
}
export async function readCredential(
  home: string,
  keyring: KeyringRead = readKeyring,
  now = Date.now(),
): Promise<Credential | null> {
  const config = await homeConfig(home);
  if (!config.subscription)
    throw new PublicError("该 Codex 配置覆盖了 ChatGPT 订阅认证，不能用于账号切换。");
  if (!config.direct && config.mode !== "file")
    throw new PublicError("暂不支持 Codex secrets keyring 后端；请使用 direct 后端或原 CLI。");
  let raw: string | null = null;
  let storage: "file" | "keyring" = "file";
  if (config.mode === "ephemeral") return null;
  if (config.mode === "auto" || config.mode === "keyring") {
    // Deliberately fail closed on locked/unavailable keyring instead of reading a potentially stale fallback.
    raw = await keyring(home);
    storage = "keyring";
  }
  if (raw === null && config.mode !== "keyring") {
    raw = await optionalText(join(home, "auth.json"));
    storage = "file";
  }
  if (raw === null) return null;
  let value: z.infer<typeof Auth>;
  try {
    value = Auth.parse(JSON.parse(raw));
  } catch {
    throw new PublicError("该账号认证数据无效，请通过 Codex 重新登录。");
  }
  if (!value.tokens || value.OPENAI_API_KEY) return null;
  const { access_token: token, id_token: idToken } = value.tokens;
  const access = claims(token),
    id = claims(idToken);
  const accessAuth = object(access["https://api.openai.com/auth"]);
  const idAuth = object(id["https://api.openai.com/auth"]);
  const auth = { ...idAuth, ...accessAuth };
  const accountId =
    text(value.tokens.account_id) ??
    text(accessAuth.chatgpt_account_id) ??
    text(access.chatgpt_account_id) ??
    text(idAuth.chatgpt_account_id) ??
    text(id.chatgpt_account_id);
  const email =
    text(id.email) ??
    text(object(access["https://api.openai.com/profile"]).email) ??
    text(access.email);
  const expiresAt =
    typeof access.exp === "number" &&
    Number.isFinite(access.exp) &&
    access.exp > 0 &&
    access.exp < 8.64e12
      ? access.exp * 1000
      : null;
  const identity: Identity = {
    key: createHash("sha256")
      .update(accountId ?? `home:${home}`)
      .digest("hex"),
    email,
    plan: text(auth.chatgpt_plan_type, 80),
    storage,
    expired: expiresAt !== null && expiresAt <= now,
  };
  return {
    token,
    accountId,
    expiresAt,
    identity,
    fingerprint: createHash("sha256").update(token).digest("hex"),
  };
}
