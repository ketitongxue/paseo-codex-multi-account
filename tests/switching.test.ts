import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switching } from "../server/switching";
import { ACCOUNT_ENV, ACCOUNT_LABEL } from "../shared/contracts";
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
function request(patch: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest {
  return {
    agentId: "agent-one",
    workspaceId: "workspace-one",
    provider: "codex",
    cwd: "/synthetic",
    reason: "create",
    purpose: "interactive",
    title: null,
    labels: {},
    tools: [],
    mcpServers: {},
    env: {},
    ...patch,
  };
}
function daemon(switching: Switching, status = "idle", failReloads = 0) {
  const agent = {
    provider: "codex",
    status,
    archivedAt: null,
    activeTurn: null,
    pendingPermissions: [],
    persistence: { sessionId: "thread-synthetic" },
  };
  const ref = {
    refresh: vi.fn(async () => ({ agent })),
    reload: vi.fn(async () => {
      if (failReloads-- > 0) throw new Error("RELOAD SECRET");
      await switching.open(request({ reason: "refresh" }));
      return { agent };
    }),
  };
  return { paseo: { agents: { ref: () => ref } } as unknown as PaseoApi, ref, agent };
}
describe("per-agent selection and switching", () => {
  it("binds env/label selectors, injects only CODEX_HOME and leaves Pi/unselected agents untouched", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    expect(await switching.open(request({ provider: "pi" }))).toBeUndefined();
    expect(await switching.open(request())).toBeUndefined();
    const selected = await switching.open(
      request({ env: { [ACCOUNT_ENV]: "keti", KEEP: "value" } }),
    );
    expect(selected?.env).toEqual({ KEEP: "value", CODEX_HOME: a.home });
    expect((await f.store.read()).bindings["agent-one"].accountId).toBe(a.id);
    const b = await f.home(".codex-cody");
    await f.accounts.setDefault(b.id);
    const resumed = await switching.open(
      request({ reason: "resume", labels: { [ACCOUNT_LABEL]: "cody" } }),
    );
    expect(resumed?.env.CODEX_HOME).toBe(a.home);
    const second = await switching.open(
      request({ agentId: "two", labels: { [ACCOUNT_LABEL]: "cody" } }),
    );
    expect(second?.env.CODEX_HOME).toBe(b.home);
  });
  it("applies defaults only at creation, not during history or old-agent resume", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    await f.accounts.setDefault(a.id);
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    expect(await switching.open(request({ purpose: "history" }))).toBeUndefined();
    expect(await switching.open(request({ reason: "resume" }))).toBeUndefined();
    expect((await switching.open(request()))?.env.CODEX_HOME).toBe(a.home);
  });
  it("refuses missing, replaced, busy or overridden authentication; no fallback account", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    await expect(
      switching.open(request({ labels: { [ACCOUNT_LABEL]: "no-account" } })),
    ).rejects.toThrow("不存在");
    await expect(
      switching.open(
        request({ labels: { [ACCOUNT_LABEL]: "keti" }, env: { OPENAI_API_KEY: "SECRET" } }),
      ),
    ).rejects.toThrow("冲突");
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: "keti" } }));
    await writeFile(join(a.home, "auth.json"), authJson("replacement-account"));
    await expect(switching.open(request({ reason: "resume" }))).rejects.toThrow("身份已改变");
    const busy = new Switching(
      f.accounts,
      () => true,
      async () => {},
    );
    await expect(
      busy.open(request({ agentId: "two", labels: { [ACCOUNT_LABEL]: "keti" } })),
    ).rejects.toThrow("正在登录");
  });
  it("refuses to pin an opaque credential without a stable ChatGPT account ID", async () => {
    const f = await setup(),
      a = await f.home(".codex-unknown");
    await writeFile(
      join(a.home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "opaque-synthetic-token" } }),
    );
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    await expect(switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }))).rejects.toThrow(
      "稳定",
    );
    await expect(switching.switch("agent-one", a.id, daemon(switching).paseo)).rejects.toThrow(
      "稳定",
    );
    await expect(f.accounts.setDefault(a.id)).rejects.toThrow("稳定");
    expect((await f.store.read()).bindings).toEqual({});
  });
  it("does not overwrite a competing first-open binding after an asynchronous credential read", async () => {
    const f = await setup(),
      a = await f.home(".codex-first"),
      b = await f.home(".codex-second");
    let proceed!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const original = f.accounts.credential.bind(f.accounts);
    vi.spyOn(f.accounts, "credential").mockImplementation(async (account) => {
      const auth = await original(account);
      if (account.id === a.id) {
        entered();
        await gate;
      }
      return auth;
    });
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    const first = switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }));
    const rejection = expect(first).rejects.toThrow("绑定已变化");
    await started;
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: b.id } }));
    proceed();
    await rejection;
    expect((await f.store.read()).bindings["agent-one"].accountId).toBe(b.id);
  });
  it("switches through the real session-open contract and persists active state", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti"),
      b = await f.home(".codex-cody");
    const preflight = vi.fn(async () => {}),
      switching = new Switching(f.accounts, () => false, preflight);
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }));
    const { paseo, ref } = daemon(switching);
    expect(await switching.switch("agent-one", b.id, paseo)).toMatchObject({
      accountId: b.id,
      status: "active",
    });
    expect(preflight).toHaveBeenCalledWith(b, "thread-synthetic");
    expect(ref.reload).toHaveBeenCalledOnce();
    expect((await switching.open(request({ reason: "resume" })))?.env.CODEX_HOME).toBe(b.home);
  });
  it("can explicitly adopt an existing unbound Agent when the target can read its native history", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    expect(await switching.switch("agent-one", a.id, daemon(switching).paseo)).toMatchObject({
      accountId: a.id,
      status: "active",
    });
  });
  it("blocks busy agents and invisible native history before mutating the binding", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti"),
      b = await f.home(".codex-cody");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {
        throw new Error("history unavailable");
      },
    );
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }));
    const busy = daemon(switching, "running");
    await expect(switching.switch("agent-one", b.id, busy.paseo)).rejects.toThrow("空闲");
    const idle = daemon(switching);
    await expect(switching.switch("agent-one", b.id, idle.paseo)).rejects.toThrow(
      "history unavailable",
    );
    expect(idle.ref.reload).not.toHaveBeenCalled();
    expect((await f.store.read()).bindings["agent-one"].accountId).toBe(a.id);
  });
  it("serializes competing switches and rolls back a failed reload", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti"),
      b = await f.home(".codex-cody");
    let proceed!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {
        entered();
        await gate;
      },
    );
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }));
    const { paseo, ref } = daemon(switching, "idle", 1);
    const operation = switching.switch("agent-one", b.id, paseo);
    const rejection = expect(operation).rejects.toThrow("已恢复原账号");
    await started;
    expect(switching.inUse(b.id)).toBe(true);
    await expect(switching.switch("agent-one", a.id, paseo)).rejects.toThrow("正在切换");
    proceed();
    await rejection;
    expect(ref.reload).toHaveBeenCalledTimes(2);
    expect((await f.store.read()).bindings["agent-one"]).toMatchObject({
      accountId: a.id,
      status: "selected",
    });
  });
  it("reserves both previous and target accounts until reload and rollback finish", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti"),
      b = await f.home(".codex-cody");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }));
    const host = daemon(switching);
    host.ref.reload.mockImplementation(async () => {
      expect((await f.store.read()).bindings["agent-one"].accountId).toBe(b.id);
      expect(switching.inUse(a.id)).toBe(true);
      expect(switching.inUse(b.id)).toBe(true);
      await switching.open(request({ reason: "refresh" }));
      return { agent: host.agent };
    });
    await switching.switch("agent-one", b.id, host.paseo);
    expect(switching.inUse(a.id)).toBe(false);
    expect(switching.inUse(b.id)).toBe(false);
  });
  it("does not accept a history-only session open as switch confirmation", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    const host = daemon(switching);
    host.ref.reload.mockImplementation(async () => {
      await switching.open(request({ reason: "refresh", purpose: "history" }));
      return { agent: host.agent };
    });
    await expect(switching.switch("agent-one", a.id, host.paseo)).rejects.toThrow("未确认");
    expect((await f.store.read()).bindings["agent-one"].status).toBe("unconfirmed");
  });
  it("never resumes an unconfirmed binding after failed rollback or plugin restart", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti"),
      b = await f.home(".codex-cody");
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: a.id } }));
    await expect(
      switching.switch("agent-one", b.id, daemon(switching, "idle", 2).paseo),
    ).rejects.toThrow("未能确认");
    expect((await f.store.read()).bindings["agent-one"].status).toBe("unconfirmed");
    const reopened = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    await expect(reopened.open(request({ reason: "resume" }))).rejects.toThrow("上次切换未确认");
  });
});
