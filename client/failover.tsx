import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { FailoverNotice } from "../shared/contracts";
import { localTime } from "./format";

export function FailoverTimelineRow({ theme, item }: PluginTimelineItemProps) {
  const notice = FailoverNotice.parse(item.data);
  const colors = theme.colors;
  const text =
    notice.variant === "switched"
      ? `Automatically switched from ${notice.fromName} to ${notice.toName ?? "another account"}${notice.continued ? ' and sent "Continue."' : "."}`
      : notice.variant === "failed"
        ? `Automatic switch to ${notice.toName ?? "another account"} failed: ${notice.reason ?? "Unknown reason"}`
        : `⚠️ ${notice.fromName} reached its usage limit.${notice.resetsAt ? ` Usage resets at ${localTime(notice.resetsAt)}.` : ""} ${
            notice.toName
              ? `Suggested switch: /codex-account ${notice.toName}`
              : "No other account is available."
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
