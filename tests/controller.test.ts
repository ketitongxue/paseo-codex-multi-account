import { mkdir, readdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import { Controller } from "../server/controller";
import { fixture } from "./helpers";

const command = [
  process.execPath,
  fileURLToPath(new URL("./fixtures/fake-codex.cjs", import.meta.url)),
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const controller = new Controller({}, f.user, f.store.root, command);
  cleanups.push(() => controller.close());
  return { ...f, controller };
}
describe("account deletion and retired bindings", () => {
  it("forgets an external account without touching its auth file; rediscovery is explicit", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    const before = await readFile(join(a.home, "auth.json"), "utf8");
    await expect(f.controller.remove(a.id, true)).rejects.toThrow("外部");
    expect((await f.store.read()).hidden).toEqual([]);
    await f.controller.remove(a.id, false);
    expect(await f.accounts.all()).toEqual([]);
    expect(await readFile(join(a.home, "auth.json"), "utf8")).toBe(before);
    await f.store.change((state) => {
      state.hidden = [];
    });
    expect((await f.accounts.all())[0].id).toBe(a.id);
  });
  it("blocks deletion of default or bound accounts and refuses release of live Agents", async () => {
    const f = await setup(),
      a = await f.home(".codex-keti");
    await f.accounts.setDefault(a.id);
    await expect(f.controller.remove(a.id, false)).rejects.toThrow("默认");
    await f.accounts.setDefault(null);
    const identity = await f.accounts.credential(a);
    if (!identity) throw new Error();
    await f.store.change((state) => {
      state.bindings["agent-one"] = {
        accountId: a.id,
        identityKey: identity.identity.key,
        status: "selected",
      };
    });
    await expect(f.controller.remove(a.id, false)).rejects.toThrow("绑定");
    const live = {
      agents: { ref: () => ({ refresh: async () => ({ agent: { archivedAt: null } }) }) },
    } as unknown as PaseoApi;
    await expect(f.controller.release("agent-one", live)).rejects.toThrow("归档");
    const archived = {
      agents: { ref: () => ({ refresh: async () => ({ agent: { archivedAt: "2026-01-01" } }) }) },
    } as unknown as PaseoApi;
    await f.controller.release("agent-one", archived);
    await f.controller.remove(a.id, false);
    expect((await f.store.read()).released).toContain("agent-one");
    await expect(
      f.controller.switching.open({
        agentId: "agent-one",
        provider: "codex",
        workspaceId: null,
        cwd: f.root,
        reason: "resume",
        purpose: "interactive",
        title: null,
        labels: {},
        env: {},
        tools: [],
        mcpServers: {},
      }),
    ).rejects.toThrow("绑定已释放");
  });
  it("blocks deletion, re-login and binding release while a switch may still need rollback", async () => {
    const f = await setup(),
      a = await f.home(".codex-first"),
      b = await f.home(".codex-second");
    const request = {
      agentId: "switching-agent",
      provider: "codex",
      workspaceId: null,
      cwd: f.root,
      reason: "create" as const,
      purpose: "interactive" as const,
      title: null,
      labels: { "codex/account": a.id },
      env: {},
      tools: [],
      mcpServers: {},
    };
    await f.controller.switching.open(request);
    const agent = {
      provider: "codex",
      archivedAt: null,
      status: "idle",
      activeTurn: null,
      pendingPermissions: [],
      persistence: { sessionId: "synthetic-thread" },
    };
    const ref = {
      refresh: async () => ({ agent }),
      reload: async () => {
        expect((await f.store.read()).bindings[request.agentId].accountId).toBe(b.id);
        await expect(f.controller.remove(a.id, false)).rejects.toThrow("操作");
        await expect(f.controller.login(a.id, "device")).rejects.toThrow("变更");
        await expect(f.controller.release(request.agentId, paseo)).rejects.toThrow("切换结束");
        await f.controller.switching.open({ ...request, reason: "refresh" });
        return { agent };
      },
    };
    const paseo = { agents: { ref: () => ref } } as unknown as PaseoApi;
    await f.controller.switching.switch(request.agentId, b.id, paseo);
    await f.controller.remove(a.id, false);
    expect((await f.store.read()).bindings[request.agentId].accountId).toBe(b.id);
  });
  it("purges only a validated managed home via official logout; never follows a redirected path", async () => {
    const f = await setup(),
      a = await f.store.create("managed");
    await f.controller.remove(a.id, true);
    await expect(stat(a.home)).rejects.toThrow();
    expect((await f.store.read()).accounts).toEqual([]);
    const b = await f.store.create("redirected"),
      outside = join(f.user, "outside");
    await mkdir(outside);
    const { rm } = await import("node:fs/promises");
    await rm(b.home, { recursive: true });
    await symlink(outside, b.home);
    await expect(f.controller.remove(b.id, true)).rejects.toThrow("不安全");
    expect(await readdir(outside)).toEqual([]);
    expect((await f.store.read()).accounts.some((a) => a.id === b.id)).toBe(true);
  });
});
