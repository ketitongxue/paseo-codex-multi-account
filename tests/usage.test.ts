import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicError } from "../server/errors";
import { fetchUsage, parseUsage, Usage } from "../server/usage";
import { authJson, fixture, quota } from "./helpers";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  return f;
}
describe("quota parsing and read-only Usage Source", () => {
  it("parses durations, zero credits and feature limits without inventing periods", () => {
    const report = parseUsage({
      ...quota,
      additional_rate_limits: [
        {
          metered_feature: "gpt-5",
          limit_name: "Model",
          rate_limit: { primary_window: { used_percent: "100", limit_window_seconds: 3600 } },
        },
      ],
      code_review_rate_limit: { primary_window: { used_percent: 0 } },
    });
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error();
    expect(report.windows[0]).toMatchObject({ id: "five_hour", remainingPct: 75 });
    expect(report.windows[1].id).toBe("weekly");
    expect(report.windows[2].id).toBe("feature:gpt-5:3600s");
    expect(report.windows[3].label).toBe("Code review · Primary limit");
    expect(report.balances?.[0].remaining).toBe(0);
    const swapped = parseUsage({
      rate_limit: { secondary_window: quota.rate_limit.primary_window },
    });
    expect(swapped.status === "available" && swapped.windows[0].id).toBe("five_hour");
  });
  it("rejects unsafe numeric data and never labels unknown primary as 5h", () => {
    expect(() => parseUsage({ rate_limit: { primary_window: { used_percent: false } } })).toThrow();
    const value = parseUsage({
      rate_limit: { primary_window: { used_percent: null, reset_at: 1e20 } },
    });
    expect(value.status === "available" && value.windows[0]).toMatchObject({
      label: "Primary limit",
      usedPct: null,
      resetsAt: null,
    });
  });
  it("queries exactly the official endpoint with no token in reports, handles expiry/rejection/HTML", async () => {
    const f = await setup(),
      a = await f.home(".codex-a"),
      auth = await f.accounts.credential(a);
    if (!auth) throw new Error("missing synthetic credential");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(quota)));
    const value = await fetchUsage(auth, fetcher);
    expect(fetcher.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
    expect(JSON.stringify(value)).not.toContain(auth.token);
    fetcher.mockResolvedValue(new Response("SENSITIVE BODY", { status: 403 }));
    expect(await fetchUsage(auth, fetcher)).toMatchObject({
      status: "unavailable",
      problem: { kind: "rejected", status: 403 },
    });
    fetcher.mockResolvedValue(new Response("<html>SECRET</html>"));
    await expect(fetchUsage(auth, fetcher)).rejects.toThrow("无法识别");
    expect(await fetchUsage({ ...auth, expiresAt: 1 }, fetcher)).toMatchObject({
      status: "unavailable",
      problem: { kind: "expired" },
    });
  });
  it("rejects an unrelated 200 JSON response instead of reporting empty success", async () => {
    const f = await setup(),
      a = await f.home(".codex-a");
    const auth = await f.accounts.credential(a);
    if (!auth) throw new Error("missing synthetic credential");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ detail: "SENSITIVE UPSTREAM ERROR" })));
    await expect(fetchUsage(auth, fetcher)).rejects.toThrow("无法识别");
    expect(() => parseUsage({})).toThrow();
  });
  it.each([401, 403, 429, 500])(
    "cancels unused HTTP %i bodies without reading diagnostics",
    async (status) => {
      const f = await setup(),
        a = await f.home(".codex-a");
      const auth = await f.accounts.credential(a);
      if (!auth) throw new Error("missing synthetic credential");
      const response = new Response("SENSITIVE BODY", { status });
      if (!response.body) throw new Error("missing body");
      const cancel = vi.spyOn(response.body, "cancel");
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await fetchUsage(auth, fetcher).catch(() => {});
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.bodyUsed).toBe(true);
    },
  );
  it("stops serving a cached success once the selected access token expires", async () => {
    const f = await setup();
    const expires = Math.floor(Date.now() / 1000) + 60;
    const a = await f.home(".codex-a", "expiring", expires);
    let now = (expires - 30) * 1000;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(quota)));
    const usage = new Usage(f.accounts, fetcher, () => now);
    expect((await usage.forAccount(a)).report.status).toBe("available");
    now = expires * 1000;
    expect((await usage.forAccount(a)).report).toMatchObject({
      status: "unavailable",
      problem: { kind: "expired" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("session discovery never scans global homes, defaults or unrelated providers", async () => {
    const f = await setup(),
      a = await f.home(".codex-a"),
      b = await f.home(".codex-b");
    const usage = new Usage(f.accounts);
    const global = await usage.discover({ kind: "global" });
    expect(global).toHaveLength(2);
    const scan = vi.spyOn(f.accounts, "all").mockRejectedValue(new Error("MUST NOT SCAN"));
    const own = await usage.discover({
      kind: "session",
      provider: "codex",
      env: { CODEX_HOME: a.home },
    });
    expect(scan).not.toHaveBeenCalled();
    expect(own).toHaveLength(1);
    expect(own[0].input).toMatchObject({ home: a.home });
    expect(JSON.stringify(own)).not.toContain(b.home);
    expect(
      await usage.discover({ kind: "session", provider: "pi", env: { CODEX_HOME: a.home } }),
    ).toEqual([]);
    expect(
      await usage.discover({ kind: "session", provider: "codex", env: { CODEX_HOME: "/missing" } }),
    ).toEqual([]);
    expect(
      await usage.discover({
        kind: "session",
        provider: "codex",
        env: { CODEX_HOME: a.home, OPENAI_API_KEY: "x" },
      }),
    ).toEqual([]);
  });
  it("keys cache by identity AND token fingerprint; token rotation invalidates and changed identity cannot inherit old reports", async () => {
    const f = await setup(),
      a = await f.home(".codex-a");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(quota)));
    const service = new Usage(f.accounts, fetcher);
    await service.forAccount(a);
    await service.forAccount(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await writeFile(join(a.home, "auth.json"), authJson(".codex-a", undefined, "rotated"));
    await service.forAccount(a);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [discovered] = await service.discover({ kind: "global" });
    await writeFile(join(a.home, "auth.json"), authJson("different-account"));
    const report = await service.source().fetch(discovered.input);
    expect(report).toMatchObject({ status: "error" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not leak transport errors and honors Retry-After even for manual refresh", async () => {
    const f = await setup(),
      a = await f.home(".codex-a");
    let now = Date.now();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response("SECRET", { status: 429, headers: { "retry-after": "120" } }),
      );
    const usage = new Usage(f.accounts, fetcher, () => now);
    const first = await usage.forAccount(a, true);
    await usage.forAccount(a, true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.nextRetryAt).toBe(new Date(now + 120000).toISOString());
    expect(JSON.stringify(first)).not.toContain("SECRET");
    now += 120001;
    await usage.forAccount(a, true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("deduplicates concurrent per-account fetches and caps all workflows at two", async () => {
    const f = await setup();
    const all = await Promise.all([
      f.home(".codex-a"),
      f.home(".codex-b"),
      f.home(".codex-c"),
      f.home(".codex-d"),
    ]);
    let concurrent = 0,
      maximum = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return new Response(JSON.stringify(quota));
    });
    const service = new Usage(f.accounts, fetcher);
    await Promise.all([...all.map((a) => service.forAccount(a)), service.forAccount(all[0])]);
    expect(maximum).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("discards a report if credentials change while the request is in flight", async () => {
    const f = await setup(),
      a = await f.home(".codex-a");
    const service = new Usage(f.accounts, async () => {
      await writeFile(join(a.home, "auth.json"), authJson("swapped"));
      return new Response(JSON.stringify(quota));
    });
    expect(await service.forAccount(a)).toMatchObject({
      report: { status: "error", error: expect.stringContaining("凭据发生变化") },
    });
    expect(() => {
      throw new PublicError("safe");
    }).toThrow("safe");
  });
});
