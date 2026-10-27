import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AccountsScreen } from "./client/accounts";
import * as rpc from "./shared/contracts";

function Sidebar({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Users"
      label="Codex 账号与额度"
      active={currentScreen?.screenId === "accounts"}
      onPress={() => openScreen({ screenId: "accounts" })}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const cleanup = [
    client.addScreen({ id: "accounts", title: "Codex 账号与额度", Component: AccountsScreen }),
    client.addSidebarHeaderItem({ id: "accounts", title: "Codex 账号与额度", Component: Sidebar }),
    client.addCommandCenterItem({
      id: "codex-accounts",
      title: "Codex 账号与额度",
      icon: "Users",
      context: "agent",
      onSelect: ({ agent, openScreen }) =>
        openScreen({ screenId: "accounts", params: { agentId: agent.id } }),
    }),
    client.addSlashCommand({
      name: "codex-accounts",
      description: "打开 Codex 账号、登录与额度",
      argumentHint: "",
      context: "agent",
      onSubmit: ({ agent, openScreen }) =>
        openScreen({ screenId: "accounts", params: { agentId: agent.id } }),
    }),
    client.addSlashCommand({
      name: "codex-account",
      description: "切换空闲 Codex Agent 的账号；留空打开账号列表",
      argumentHint: "[账号 ID 或唯一名称]",
      context: "agent",
      onSubmit: async ({ args, agent, rpc: call, openScreen }) => {
        if (!args.trim()) {
          openScreen({ screenId: "accounts", params: { agentId: agent.id } });
          return;
        }
        if (agent.provider !== "codex") throw new Error("此命令只支持 Codex Agent。");
        const snapshot = await call(rpc.listAccounts, {});
        const matches = snapshot.accounts.filter(
          (account) => account.id === args.trim() || account.name === args.trim(),
        );
        if (matches.length !== 1)
          throw new Error("账号不存在或名称不唯一，请打开 /codex-accounts 查看 ID。");
        await call(rpc.switchAccount, { agentId: agent.id, accountId: matches[0].id });
      },
    }),
  ];
  return () => {
    for (const remove of cleanup.reverse()) remove();
  };
}
