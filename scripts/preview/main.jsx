import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AccountsScreen } from "../../client/accounts";
import { snapshot, usage } from "./data";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
queryClient.setQueryData(["accounts"], snapshot);
queryClient.setQueryData(["usage"], usage);
const colors = {
  surface0: "#fafafa",
  surface1: "#ffffff",
  surface2: "#e9edf2",
  border: "#dfe3e8",
  foreground: "#19202a",
  foregroundMuted: "#697383",
  accent: "#3b7560",
  accentForeground: "#ffffff",
  statusSuccess: "#3b7560",
  statusWarning: "#b27a1d",
  statusDanger: "#bb4242",
};
createRoot(document.getElementById("root")).render(
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      "main",
      {
        style: {
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: colors.surface0,
        },
      },
      createElement(
        "header",
        {
          style: {
            padding: "24px 48px",
            borderBottom: `1px solid ${colors.border}`,
            background: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          },
        },
        createElement(
          "div",
          null,
          createElement(
            "div",
            { style: { fontSize: 24, fontWeight: 600, color: colors.foreground } },
            "Codex 账号与额度",
          ),
          createElement(
            "div",
            { style: { marginTop: 6, fontSize: 14, color: colors.foregroundMuted } },
            "Codex multi-account · Account screen preview",
          ),
        ),
        createElement(
          "div",
          { style: { fontSize: 13, color: colors.foregroundMuted } },
          "Synthetic data · No live accounts",
        ),
      ),
      createElement(AccountsScreen, {
        theme: { colors },
        layout: { compact: false, platform: "web" },
        host: { id: "preview", label: "Preview" },
        params: { agentId: "agent-demo" },
      }),
    ),
  ),
);
