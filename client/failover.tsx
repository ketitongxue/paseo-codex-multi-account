import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { FailoverNotice } from "../shared/contracts";
import { localTime } from "./format";

export function FailoverTimelineRow({ theme, item }: PluginTimelineItemProps) {
  const notice = FailoverNotice.parse(item.data);
  const colors = theme.colors;
  const text =
    notice.variant === "switched"
      ? `已自动从 ${notice.fromName} 切换到 ${notice.toName ?? "另一账号"}${notice.continued ? "，并发送 Continue. 继续任务" : ""}。`
      : notice.variant === "failed"
        ? `自动切换到 ${notice.toName ?? "另一账号"} 失败：${notice.reason ?? "未知原因"}。`
        : `⚠️ ${notice.fromName} 额度已用尽${notice.resetsAt ? `，重置于 ${localTime(notice.resetsAt)}` : ""}。${
            notice.toName
              ? `建议切换到 ${notice.toName}：/codex-account ${notice.toName}`
              : "暂无其他可用账号。"
          }`;
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text
        accessibilityLabel="codex failover notice"
        style={{
          color: notice.variant === "exhausted" ? colors.statusWarning : colors.foregroundMuted,
          fontSize: 13,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
