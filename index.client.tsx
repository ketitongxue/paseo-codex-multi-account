import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AccountsScreen } from "./client/accounts";
import { FailoverTimelineRow } from "./client/failover";
import * as rpc from "./shared/contracts";

function Sidebar({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Users"
      label="Codex Accounts & Usage"
      active={currentScreen?.screenId === "accounts"}
      onPress={() => openScreen({ screenId: "accounts" })}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const cleanup = [
    client.addScreen({
      id: "accounts",
      title: "Codex Accounts & Usage",
      Component: AccountsScreen,
    }),
    client.addSidebarHeaderItem({
      id: "accounts",
      title: "Codex Accounts & Usage",
      Component: Sidebar,
    }),
    client.addTimelineRenderer({
      kind: rpc.FAILOVER_KIND,
      version: 1,
      schema: rpc.FailoverNotice,
      Component: FailoverTimelineRow,
    }),
    client.addCommandCenterItem({
      id: "codex-accounts",
      title: "Codex Accounts & Usage",
      icon: "Users",
      context: "agent",
      onSelect: ({ agent, openScreen }) =>
        openScreen({ screenId: "accounts", params: { agentId: agent.id } }),
    }),
    client.addSlashCommand({
      name: "codex-accounts",
      description: "Open Codex accounts, sign-in, and usage",
      argumentHint: "",
      context: "agent",
      onSubmit: ({ agent, openScreen }) =>
        openScreen({ screenId: "accounts", params: { agentId: agent.id } }),
    }),
    client.addSlashCommand({
      name: "codex-account",
      description:
        "Switch the account for an idle Codex agent. Leave blank to open the account list.",
      argumentHint: "[account ID or unique name]",
      context: "agent",
      onSubmit: async ({ args, agent, rpc: call, openScreen }) => {
        if (!args.trim()) {
          openScreen({ screenId: "accounts", params: { agentId: agent.id } });
          return;
        }
        if (agent.provider !== "codex")
          throw new Error("This command is only available for Codex agents.");
        const snapshot = await call(rpc.listAccounts, {});
        const matches = snapshot.accounts.filter(
          (account) => account.id === args.trim() || account.name === args.trim(),
        );
        if (matches.length !== 1)
          throw new Error(
            "Account not found or name is ambiguous. Open /codex-accounts to find the account ID.",
          );
        await call(rpc.switchAccount, { agentId: agent.id, accountId: matches[0].id });
      },
    }),
  ];
  return () => {
    for (const remove of cleanup.reverse()) remove();
  };
}
