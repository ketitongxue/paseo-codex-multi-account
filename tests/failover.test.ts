import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Failover } from "../server/failover";
import { Switching } from "../server/switching";
import { exhaustedWindows, minRemainingPct, parseUsage, Usage } from "../server/usage";
import { ACCOUNT_LABEL, type FailoverSettings } from "../shared/contracts";
import { fixture, quota } from "./helpers";

const cleanups: Array<() => Promise<void>> = [];
const NOW = 1_800_000_000_000;
let clock = NOW;
const now = () => clock;
afterEach(async () => {
  clock = NOW;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const inSeconds = (seconds: number) => Math.floor(clock / 1000) + seconds;

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
function daemon(switching: Switching, agentId = "agent-one") {
  const agent = {
    provider: "codex",
    status: "idle",
    archivedAt: null,
    activeTurn: null,
    pendingPermissions: [],
    persistence: { sessionId: "thread-synthetic" },
  };
  const ref = {
    refresh: vi.fn(async () => ({ agent })),
    reload: vi.fn(async () => {
      await switching.open(request({ agentId, reason: "refresh" }));
      return { agent };
    }),
    send: vi.fn(async () => {}),
    timeline: { append: vi.fn(async () => ({ seq: 1, epoch: "synthetic" })) },
  };
  return { paseo: { agents: { ref: () => ref } } as unknown as PaseoApi, ref };
}
function turn(
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } },
  turnId = "turn-1",
) {
  const agent: PluginHookAgent = {
    id: "agent-one",
    workspaceId: null,
    parentAgentId: null,
    provider: "codex",
    cwd: "/synthetic",
    title: null,
  };
  return { agent, turnId, outcome };
}
const failed = turn({ kind: "failed", error: { message: "usage limit reached" } });
const completed = turn({ kind: "completed" });
function context(paseo: PaseoApi): PluginHookContext {
  return { paseo, signal: new AbortController().signal };
}
function notice(ref: { timeline: { append: ReturnType<typeof vi.fn> } }) {
  expect(ref.timeline.append).toHaveBeenCalled();
  const item = ref.timeline.append.mock.calls.at(-1)?.[0];
  expect(item).toMatchObject({ type: "plugin", kind: "codex-failover", version: 1 });
  return item?.data as Record<string, unknown>;
}

async function harness(settings?: FailoverSettings) {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const exp = Math.floor(NOW / 1000) + 7200;
  const keti = await f.home(".codex-keti", "keti", exp);
  const cody = await f.home(".codex-cody", "cody", exp);
  const bodies = new Map<string, string>([
    ["keti", JSON.stringify(quota)],
    ["cody", JSON.stringify(quota)],
  ]);
  const setQuota = (account: string, primaryUsed: number) => {
    bodies.set(
      account,
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: primaryUsed,
            reset_at: inSeconds(3600),
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 10,
            reset_at: inSeconds(100000),
            limit_window_seconds: 604800,
          },
        },
      }),
    );
  };
  const usage = new Usage(
    f.accounts,
    vi.fn<typeof fetch>(async (_input, init) => {
      const id = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"];
      return new Response((id && bodies.get(id)) ?? JSON.stringify(quota));
    }),
    now,
  );
  const switching = new Switching(
    f.accounts,
    () => false,
    async () => {},
  );
  const failover = new Failover(f.accounts, usage, switching, () => false, now);
  if (settings) await f.store.change((state) => void (state.failover = settings));
  await switching.open(request({ labels: { [ACCOUNT_LABEL]: keti.id } }));
  return { f, keti, cody, usage, switching, failover, setQuota };
}

describe("exhaustion predicates", () => {
  it("only a full account-wide window with a future reset proves exhaustion", () => {
    const base = {
      rate_limit: {
        primary_window: {
          used_percent: 100,
          reset_at: inSeconds(600),
          limit_window_seconds: 18000,
        },
      },
    };
    expect(exhaustedWindows(parseUsage(base), clock)).toHaveLength(1);
    expect(
      exhaustedWindows(
        parseUsage({
          rate_limit: {
            primary_window: {
              used_percent: 100,
              reset_at: inSeconds(-600),
              limit_window_seconds: 18000,
            },
          },
        }),
        clock,
      ),
    ).toEqual([]);
    expect(
      exhaustedWindows(
        parseUsage({
          rate_limit: {
            primary_window: { used_percent: 100, limit_window_seconds: 18000 },
          },
        }),
        clock,
      ),
    ).toEqual([]);
    expect(
      exhaustedWindows(
        parseUsage({
          ...base,
          additional_rate_limits: [
            {
              metered_feature: "gpt-5",
              rate_limit: {
                primary_window: {
                  used_percent: 100,
                  reset_at: inSeconds(600),
                  limit_window_seconds: 3600,
                },
              },
            },
          ],
        }),
        clock,
      ),
    ).toHaveLength(1);
    expect(exhaustedWindows({ status: "error", error: "x" }, clock)).toEqual([]);
  });
  it("ranks candidates by the tightest account-wide remaining window", () => {
    const report = parseUsage(quota);
    expect(minRemainingPct(report)).toBe(40);
    expect(minRemainingPct({ status: "error", error: "x" })).toBeNull();
  });
});

describe("failover after a turn", () => {
  it("offers a switch for an exhausted account without touching the session", async () => {
    const t = await harness(),
      host = daemon(t.switching);
    t.setQuota("keti", 100);
    t.setQuota("cody", 40);
    await t.usage.list(); // warm the cache both accounts are ranked from
    await t.failover.onTurnEnded(failed, context(host.paseo));
    expect(host.ref.reload).not.toHaveBeenCalled();
    expect(notice(host.ref)).toMatchObject({
      variant: "exhausted",
      fromName: "keti",
      toName: "cody",
      auto: false,
    });
    await t.failover.onTurnEnded(
      turn({ kind: "failed", error: { message: "again" } }, "turn-2"),
      context(host.paseo),
    );
    expect(host.ref.timeline.append).toHaveBeenCalledOnce();
    expect((await t.f.store.read()).bindings["agent-one"].accountId).toBe(t.keti.id);
  });
  it("switches automatically, continues a failed turn and records the departure", async () => {
    const t = await harness({ mode: "auto", autoContinue: true }),
      host = daemon(t.switching);
    t.setQuota("keti", 100);
    t.setQuota("cody", 40);
    await t.usage.list();
    await t.failover.onTurnEnded(failed, context(host.paseo));
    expect(host.ref.reload).toHaveBeenCalledOnce();
    expect(host.ref.send).toHaveBeenCalledWith("Continue.");
    expect(notice(host.ref)).toMatchObject({
      variant: "switched",
      fromName: "keti",
      toName: "cody",
      auto: true,
      continued: true,
    });
    expect((await t.f.store.read()).bindings["agent-one"]).toMatchObject({
      accountId: t.cody.id,
      status: "active",
    });
  });
  it("acts on a completed turn only from the cached report and never sends a message", async () => {
    const t = await harness({ mode: "auto", autoContinue: true }),
      host = daemon(t.switching);
    t.setQuota("keti", 100);
    await t.usage.list();
    const calls = (t.usage as unknown as { fetchApi: ReturnType<typeof vi.fn> }).fetchApi.mock.calls
      .length;
    await t.failover.onTurnEnded(completed, context(host.paseo));
    expect(
      (t.usage as unknown as { fetchApi: ReturnType<typeof vi.fn> }).fetchApi.mock.calls.length,
    ).toBe(calls);
    expect(host.ref.reload).toHaveBeenCalledOnce();
    expect(host.ref.send).not.toHaveBeenCalled();
  });
  it("ignores canceled turns, unbound agents and other providers", async () => {
    const t = await harness(),
      host = daemon(t.switching);
    t.setQuota("keti", 100);
    await t.usage.list();
    await t.failover.onTurnEnded(
      { ...failed, outcome: { kind: "canceled", reason: "user" } },
      context(host.paseo),
    );
    await t.failover.onTurnEnded(
      { ...failed, agent: { ...failed.agent, provider: "pi" } },
      context(host.paseo),
    );
    await t.f.store.change((state) => void delete state.bindings["agent-one"]);
    await t.failover.onTurnEnded(failed, context(host.paseo));
    expect(host.ref.timeline.append).not.toHaveBeenCalled();
  });
  it("does nothing while the mode is off or the binding is unconfirmed", async () => {
    const t = await harness({ mode: "off", autoContinue: true }),
      host = daemon(t.switching);
    t.setQuota("keti", 100);
    await t.usage.list();
    await t.failover.onTurnEnded(failed, context(host.paseo));
    expect(host.ref.timeline.append).not.toHaveBeenCalled();
    await t.f.store.change((state) => {
      state.failover = { mode: "auto", autoContinue: true };
      state.bindings["agent-one"].status = "unconfirmed";
    });
    await t.failover.onTurnEnded(
      turn({ kind: "failed", error: { message: "x" } }, "turn-2"),
      context(host.paseo),
    );
    expect(host.ref.reload).not.toHaveBeenCalled();
  });
  it("reports exhaustion without a recommendation when every other account is unusable", async () => {
    const t = await harness({ mode: "auto", autoContinue: true }),
      host = daemon(t.switching);
    t.setQuota("keti", 100);
    t.setQuota("cody", 100);
    await t.usage.list();
    await t.failover.onTurnEnded(failed, context(host.paseo));
    expect(host.ref.reload).not.toHaveBeenCalled();
    expect(notice(host.ref)).toMatchObject({ variant: "exhausted", fromName: "keti", auto: true });
    expect(notice(host.ref).toName).toBeUndefined();
  });
  it("bounds auto switches per hour and never returns to an account it just left", async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const exp = Math.floor(NOW / 1000) + 7200;
    const homes = [];
    for (const name of ["keti", "cody", "dave", "emma", "fred"])
      homes.push(await f.home(`.codex-${name}`, name, exp));
    const bodies = new Map<string, string>();
    const setQuota = (account: string, primaryUsed: number) =>
      bodies.set(
        account,
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: primaryUsed,
              reset_at: inSeconds(3600),
              limit_window_seconds: 18000,
            },
          },
        }),
      );
    for (const name of ["keti", "cody", "dave", "emma", "fred"]) setQuota(name, 20);
    const usage = new Usage(
      f.accounts,
      vi.fn<typeof fetch>(async (_input, init) => {
        const id = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"];
        return new Response((id && bodies.get(id)) ?? JSON.stringify(quota));
      }),
      now,
    );
    const switching = new Switching(
      f.accounts,
      () => false,
      async () => {},
    );
    const failover = new Failover(f.accounts, usage, switching, () => false, now);
    await f.store.change((state) => void (state.failover = { mode: "auto", autoContinue: false }));
    await switching.open(request({ labels: { [ACCOUNT_LABEL]: homes[0].id } }));
    const host = daemon(switching);
    await usage.list();
    let turnId = 0;
    const run = async (exhausted: string) => {
      setQuota(exhausted, 100);
      await failover.onTurnEnded(
        turn({ kind: "failed", error: { message: "limit" } }, `turn-${turnId++}`),
        context(host.paseo),
      );
    };
    await run("keti");
    expect(host.ref.reload).toHaveBeenCalledTimes(1); // keti → cody
    await run("cody");
    expect(host.ref.reload).toHaveBeenCalledTimes(2); // cody → dave
    await run("dave");
    expect(host.ref.reload).toHaveBeenCalledTimes(3); // dave → emma
    await run("emma"); // 4th switch within the hour is refused; fred is available but not offered
    expect(host.ref.reload).toHaveBeenCalledTimes(3);
    expect(notice(host.ref)).toMatchObject({
      variant: "exhausted",
      fromName: "emma",
      toName: "fred",
    });
    clock += 3_600_001;
    await run("emma"); // bounds expired; fred is the only room left (earlier ones still full or just left)
    expect(host.ref.reload).toHaveBeenCalledTimes(4);
    expect((await f.store.read()).bindings["agent-one"].accountId).toBe(homes[4].id);
  });
  it("surfaces a refused switch as a failure row instead of undoing anything", async () => {
    const t = await harness({ mode: "auto", autoContinue: true });
    t.setQuota("keti", 100);
    t.setQuota("cody", 40);
    await t.usage.list();
    const host = daemon(t.switching);
    host.ref.reload.mockImplementation(async () => {
      throw new Error("reload crashed");
    });
    await t.failover.onTurnEnded(failed, context(host.paseo));
    expect(notice(host.ref)).toMatchObject({
      variant: "failed",
      fromName: "keti",
      toName: "cody",
    });
  });
});
