import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { percent, usageProblem } from "../client/format";

vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("../client/accounts", () => ({ AccountsScreen: () => null }));

import contribute from "../index.client";

describe("client registration and display", () => {
  it("never shows unknown quota as zero, and explains expired/rejected logins", () => {
    expect(percent(null)).toBe("未知");
    expect(percent(0)).toBe("0%");
    expect(percent(Number.NaN)).toBe("未知");
    expect(
      usageProblem({
        status: "unavailable",
        problem: { kind: "expired", expiresAt: "2020-01-01" },
      }),
    ).toContain("过期");
    expect(
      usageProblem({ status: "unavailable", problem: { kind: "rejected", status: 401 } }),
    ).toContain("401");
  });
  it("registers a screen, sidebar, agent command and both slash commands, all cleaned up", async () => {
    const remove = vi.fn(),
      slash: Array<{ name: string; onSubmit: (context: unknown) => Promise<void> }> = [];
    const client = {
      addScreen: vi.fn(() => remove),
      addSidebarHeaderItem: vi.fn(() => remove),
      addCommandCenterItem: vi.fn(() => remove),
      addSlashCommand: vi.fn((item) => {
        slash.push(item);
        return remove;
      }),
    };
    const cleanup = contribute(client as unknown as PluginClientContext);
    expect(slash.map((entry) => entry.name)).toEqual(["codex-accounts", "codex-account"]);
    const openScreen = vi.fn();
    await slash[1].onSubmit({ args: "", agent: { id: "agent-one" }, openScreen });
    expect(openScreen).toHaveBeenCalledWith({
      screenId: "accounts",
      params: { agentId: "agent-one" },
    });
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ accounts: [{ id: "account-one", name: "keti" }] })
      .mockResolvedValue({});
    await slash[1].onSubmit({
      args: "keti",
      agent: { id: "agent-one", provider: "codex" },
      rpc,
      openScreen,
    });
    expect(rpc.mock.calls[1][1]).toEqual({ agentId: "agent-one", accountId: "account-one" });
    await cleanup();
    expect(remove).toHaveBeenCalledTimes(5);
  });
});
