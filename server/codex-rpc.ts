import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { PublicError } from "./errors";

export const AUTH_OVERRIDES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_API_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_ACCESS_TOKEN",
  "CODEX_AUTH_TOKEN",
];
export function accountEnvironment(home: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {
    ...base,
    CODEX_HOME: home,
    NO_COLOR: "1",
    BROWSER: process.platform === "win32" ? "" : "/usr/bin/true",
  };
  for (const key of Object.keys(env))
    if (AUTH_OVERRIDES.includes(key) || key.startsWith("PASEO_") || key.startsWith("PI_"))
      delete env[key as keyof typeof env];
  return env;
}
export type Notification = { method: string; params: unknown };
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(message: Notification) => void>();
  private buffer = "";
  private sequence = 0;
  private failure: Error | null = null;
  private closed: Promise<void>;
  constructor(command: string[], home: string, baseEnv: NodeJS.ProcessEnv, secure = false) {
    const flags = secure
      ? ["-c", 'cli_auth_credentials_store="keyring"', "-c", 'auth_keyring_backend="direct"']
      : [];
    this.child = spawn(command[0], [...command.slice(1), ...flags, "app-server", "--stdio"], {
      cwd: home,
      env: accountEnvironment(home, baseEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => {
        this.fail(new PublicError("Codex app-server 已退出。"));
        resolve();
      }),
    );
    this.child.on("error", () =>
      this.fail(new PublicError("无法启动 Codex CLI；请确认已安装且在 PATH 中。")),
    );
    this.child.stdin.on("error", () => this.fail(new PublicError("Codex app-server 管道已关闭。")));
    // Never log or retain stderr: upstream diagnostics can include authorization material.
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.receive(chunk));
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) {
      this.fail(new PublicError("Codex 响应过大。"));
      this.kill("SIGKILL");
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line);
        if (!value || typeof value !== "object") throw new Error();
      } catch {
        this.fail(new PublicError("Codex app-server 返回无效协议数据。"));
        return;
      }
      if (typeof value.id === "number") {
        const request = this.pending.get(value.id);
        if (!request) continue;
        clearTimeout(request.timer);
        this.pending.delete(value.id);
        if (value.error)
          request.reject(new PublicError("Codex 请求失败；请检查 CLI 登录状态和版本。"));
        else request.resolve(value.result);
      } else if (typeof value.method === "string") {
        for (const listener of this.listeners)
          listener({ method: value.method, params: value.params });
      }
    }
  }
  notify(method: string): void {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`);
  }
  request(method: string, params: unknown, timeout = 15000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PublicError("Codex 请求超时。"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  subscribe(listener: (message: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "paseo_codex_multi_account",
        title: "Paseo Codex Multi Account",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }
  private kill(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch {
      /* Already gone. */
    }
  }
  async close(): Promise<void> {
    this.listeners.clear();
    this.buffer = "";
    this.fail(new PublicError("Codex 请求已取消。"));
    this.child.stdin.end();
    const term = setTimeout(() => this.kill("SIGTERM"), 100);
    const force = setTimeout(() => this.kill("SIGKILL"), 800);
    try {
      await this.closed;
    } finally {
      clearTimeout(term);
      clearTimeout(force);
    }
  }
  onClose(): Promise<void> {
    return this.closed;
  }
}
