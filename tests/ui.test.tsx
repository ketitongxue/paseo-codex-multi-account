import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as Array<{ name: string; input: unknown }> }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => ({ agents: { create: vi.fn() } }),
  useRpc: (contract: { name: string }) => async (input: unknown) => {
    state.calls.push({ name: contract.name, input });
    if (contract.name === "accounts.list")
      return {
        defaultId: null,
        bindings: {},
        accounts: [
          {
            id: "home-test",
            name: "keti",
            home: "/synthetic/.codex-keti",
            managed: true,
            saved: true,
            identity: {
              key: "identity",
              email: "synthetic@example.invalid",
              storage: "keyring",
              expired: false,
              plan: "plus",
            },
            problem: null,
            loginBusy: false,
          },
        ],
      };
    if (contract.name === "usage.list")
      return [
        {
          accountId: "home-test",
          report: {
            status: "available",
            planLabel: "plus",
            windows: [
              { id: "five_hour", label: "5-hour", usedPct: 25, remainingPct: 75, resetsAt: null },
            ],
          },
          fetchedAt: "2026-01-01T00:00:00Z",
          nextRetryAt: null,
        },
      ];
    return {};
  },
}));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    {
      Content: ({ children }: { children: ReactNode }) =>
        React.createElement(React.Fragment, null, children),
    },
  );
  return {
    ScrollView: "ScrollView",
    TextInput: "TextInput",
    ExternalLink: "ExternalLink",
    Modal,
    copyText: vi.fn(),
  };
});

import { AccountsScreen } from "../client/accounts";

const colors = Object.fromEntries(
  [
    "surface0",
    "surface1",
    "surface2",
    "border",
    "foreground",
    "foregroundMuted",
    "accent",
    "accentForeground",
    "statusSuccess",
    "statusWarning",
    "statusDanger",
  ].map((key) => [key, "#888888"]),
);
let renderer: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  queryClient?.clear();
  state.calls.length = 0;
});
describe("account screen", () => {
  it("renders quota and secure storage, manual refresh and confirmation before deleting", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props = {
      theme: { colors },
      layout: { compact: true, platform: "ios" },
      params: {},
      host: { id: "test", label: "test" },
    } as PluginScreenProps;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client: queryClient as QueryClient },
          createElement(AccountsScreen, props),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const text = JSON.stringify(renderer?.toJSON());
    expect(text).toContain("keyring");
    expect(text).toContain("25%");
    expect(text).toContain("75%");
    const root = renderer?.root;
    if (!root) throw new Error("screen did not mount");
    await act(async () => {
      root.findByProps({ accessibilityLabel: "刷新全部额度" }).props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      state.calls.some(
        (call) => call.name === "usage.list" && (call.input as { force: boolean }).force,
      ),
    ).toBe(true);
    await act(async () => {
      root.findByProps({ accessibilityLabel: "删除…" }).props.onPress();
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("确认删除");
    expect(state.calls.some((call) => call.name === "accounts.delete")).toBe(false);
    await act(async () => {
      root.findByProps({ accessibilityLabel: "确认删除" }).props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.calls.find((call) => call.name === "accounts.delete")?.input).toEqual({
      accountId: "home-test",
      purge: false,
    });
  });
});
