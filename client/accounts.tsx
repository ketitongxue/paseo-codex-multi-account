import { type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as api from "../shared/contracts";
import { localTime, percent, usageProblem } from "./format";

export function AccountsScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const colors = theme.colors,
    queryClient = useQueryClient(),
    paseo = usePaseo();
  const list = useRpc(api.listAccounts),
    save = useRpc(api.saveAccount),
    create = useRpc(api.createAccount);
  const remove = useRpc(api.deleteAccount),
    discover = useRpc(api.rediscover),
    setDefault = useRpc(api.setDefault);
  const login = useRpc(api.startLogin),
    active = useRpc(api.activeLogin),
    status = useRpc(api.loginStatus),
    cancel = useRpc(api.cancelLogin);
  const usage = useRpc(api.getUsage),
    switchTo = useRpc(api.switchAccount),
    release = useRpc(api.releaseBinding);
  const [name, setName] = useState(""),
    [home, setHome] = useState(""),
    [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<"device" | "browser">("device");
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<api.AccountView | null>(null),
    [purge, setPurge] = useState(false);
  const snapshot = useQuery({
    queryKey: ["accounts"],
    queryFn: () => list({}),
    refetchInterval: 10000,
  });
  const quotas = useQuery({
    queryKey: ["usage"],
    queryFn: () => usage({ force: false }),
    refetchInterval: 60000,
  });
  const attempt = useQuery({
    queryKey: ["login", loginId],
    queryFn: () => status({ loginId: loginId ?? "" }),
    enabled: !!loginId,
    refetchInterval: (query) =>
      query.state.data && ["complete", "error", "canceled"].includes(query.state.data.status)
        ? false
        : 1000,
  });
  const currentLogin = attempt.data;
  useEffect(() => {
    if (currentLogin?.status === "complete") {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    }
  }, [currentLogin?.status, queryClient]);
  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (value) {
      setError(value instanceof Error ? value.message : "操作失败，请重试。");
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setPending(false);
    }
  }
  const body = (children: ReactNode, muted = false) => (
    <Text
      selectable
      style={{ color: muted ? colors.foregroundMuted : colors.foreground, fontSize: 14 }}
    >
      {children}
    </Text>
  );
  const button = (label: string, action: () => Promise<unknown>, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={pending || disabled}
      onPress={() => void run(action)}
      style={{
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: pending || disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color: colors.foreground }}>{label}</Text>
    </Pressable>
  );
  const field = (value: string, change: (text: string) => void, placeholder: string) => (
    <TextInput
      accessibilityLabel={placeholder}
      placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      value={value}
      onChangeText={change}
      style={{
        color: colors.foreground,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 10,
        minWidth: 160,
        flexGrow: 1,
      }}
    />
  );
  const agentId = params.agentId;
  const binding = agentId ? snapshot.data?.bindings[agentId] : null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 12 : 24,
          gap: 16,
          maxWidth: 1100,
          width: "100%",
          alignSelf: "center",
        }}
      >
        {body("独立 CODEX_HOME · 新登录仅保存到系统 Keychain/keyring · 不复制 token")}
        {body(
          "发现与保存不修改现有 home；外部账号删除仅隐藏。Usage 为订阅限额，不是本地会话 token 统计。",
          true,
        )}
        {agentId &&
          body(
            `当前 Agent：${agentId} · ${binding ? `${snapshot.data?.accounts.find((a) => a.id === binding.accountId)?.name || binding.accountId} (${binding.status})` : "尚未绑定；切换时会检查原生历史并纳入管理"}`,
          )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button("重新发现（含已隐藏）", async () => {
            await discover({});
            await queryClient.invalidateQueries({ queryKey: ["usage"] });
          })}
          {button("刷新全部额度", async () => {
            queryClient.setQueryData(["usage"], await usage({ force: true }));
          })}
          {button("取消默认账号", () => setDefault({ accountId: null }), !snapshot.data?.defaultId)}
        </View>
        {(error || snapshot.error || quotas.error) && (
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
            {error || snapshot.error?.message || quotas.error?.message}
          </Text>
        )}
        {snapshot.isPending && body("正在发现账号…", true)}
        {snapshot.data?.accounts.length === 0 &&
          body("暂无账号。创建安全登录账号，或保存已有 CODEX_HOME。", true)}
        {snapshot.data?.accounts.map((account) => {
          const row = quotas.data?.find((entry) => entry.accountId === account.id);
          return (
            <View
              key={account.id}
              style={{
                padding: 14,
                gap: 9,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                backgroundColor: colors.surface1,
              }}
            >
              {body(
                `${account.name}${snapshot.data.defaultId === account.id ? " · 默认" : ""} · ${account.managed ? "托管" : "外部"}${account.saved ? " · 已保存" : " · 自动发现"}`,
              )}
              {body(account.home, true)}
              {body(`ID: ${account.id}`, true)}
              {body(
                account.identity
                  ? `${account.identity.email || "ChatGPT"} · ${account.identity.plan || "未知套餐"} · ${account.identity.storage}${account.identity.expired ? " · 认证过期" : ""}`
                  : account.problem || "未登录",
                !account.problem,
              )}
              {row?.report.status === "available" ? (
                <View style={{ gap: 6 }}>
                  {body(`套餐：${row.report.planLabel || account.identity?.plan || "未知"}`)}
                  {!row.report.windows.length && body("服务端未提供限额窗口", true)}
                  {row.report.windows.map((window) => (
                    <View key={window.id} style={{ gap: 3 }}>
                      {body(
                        `${window.label}：已用 ${percent(window.usedPct)} · 剩余 ${percent(window.remainingPct)}`,
                      )}
                      {typeof window.usedPct === "number" && (
                        <View
                          style={{ height: 5, backgroundColor: colors.surface2, borderRadius: 3 }}
                        >
                          <View
                            style={{
                              height: 5,
                              borderRadius: 3,
                              width: `${Math.max(0, Math.min(100, window.usedPct || 0))}%`,
                              backgroundColor:
                                window.tone === "danger"
                                  ? colors.statusDanger
                                  : window.tone === "warning"
                                    ? colors.statusWarning
                                    : colors.accent,
                            }}
                          />
                        </View>
                      )}
                      {body(`重置：${localTime(window.resetsAt)}`, true)}
                    </View>
                  ))}
                  {row.report.balances?.map((balance) => (
                    <Text key={balance.id} style={{ color: colors.foreground }}>
                      {balance.label}：{balance.remaining ?? "未知"} credits
                    </Text>
                  ))}
                </View>
              ) : row ? (
                body(usageProblem(row.report))
              ) : (
                body("额度等待查询…", true)
              )}
              {row &&
                body(
                  `查询：${localTime(row.fetchedAt)}${row.nextRetryAt ? ` · 最早重试：${localTime(row.nextRetryAt)}` : ""}`,
                  true,
                )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {button("保存/重命名", async () => {
                  if (!name.trim()) throw new Error("请在下方名称框填写名称。");
                  await save({ home: account.home, name });
                })}
                {button(
                  "设为默认",
                  () => setDefault({ accountId: account.id }),
                  !account.identity || account.loginBusy,
                )}
                {button(
                  account.loginBusy ? "查看登录" : "登录",
                  async () => {
                    const result = account.loginBusy
                      ? await active({ accountId: account.id })
                      : await login({ accountId: account.id, mode });
                    if (!result) throw new Error("登录正在准备中，请稍后重试。");
                    setLoginId(result.id);
                  },
                  !account.managed,
                )}
                {button("刷新额度", async () => {
                  const values = await usage({ accountId: account.id, force: true });
                  queryClient.setQueryData<api.UsageRow[]>(["usage"], (old) => [
                    ...(old ?? []).filter((entry) => entry.accountId !== account.id),
                    ...values,
                  ]);
                })}
                {agentId &&
                  button(
                    "切换当前 Agent",
                    () => switchTo({ agentId, accountId: account.id }),
                    !account.identity || account.loginBusy,
                  )}
                {button(
                  "用此账号创建 Agent",
                  async () => {
                    if (!cwd.trim()) throw new Error("请先在下方填写新 Agent 的工作目录。");
                    const agent = await paseo.agents.create({
                      cwd,
                      config: { provider: "codex" },
                      labels: { [api.ACCOUNT_LABEL]: account.id },
                      title: `Codex · ${account.name}`,
                    });
                    navigation?.openAgent({ agentId: agent.id });
                  },
                  !account.identity || account.loginBusy,
                )}
                {button("删除…", async () => {
                  setPurge(false);
                  setDeleting(account);
                })}
              </View>
              {!account.managed &&
                body(
                  "外部账号重新登录：使用该 CODEX_HOME 运行 codex login；插件不会改写其认证存储。",
                  true,
                )}
            </View>
          );
        })}
        <View
          style={{
            gap: 8,
            padding: 12,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
          }}
        >
          {body("创建、保存与重命名")}
          {field(name, setName, "账号名称（如 keti）")}
          {field(home, setHome, "已有 CODEX_HOME（如 ~/.codex-keti）")}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {button("保存已有 home", () => save({ home, name }), !name.trim() || !home.trim())}
            {button(
              "创建安全登录账号",
              async () => {
                const account = await create({ name });
                const result = await login({ accountId: account.id, mode });
                setLoginId(result.id);
              },
              !name.trim(),
            )}
            {button(mode === "device" ? "登录模式：设备码" : "登录模式：本机浏览器", async () =>
              setMode(mode === "device" ? "browser" : "device"),
            )}
          </View>
          {field(cwd, setCwd, "新 Agent 工作目录（daemon 上的绝对路径）")}
          {body("已有会话切换需要双方 home 可读取同一原生历史；不共享时请新建 Agent。", true)}
        </View>
        {!!snapshot.data &&
          Object.entries(snapshot.data.bindings).map(([id, value]) => (
            <View key={id} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {body(
                `绑定 ${id} → ${snapshot.data.accounts.find((a) => a.id === value.accountId)?.name || value.accountId} (${value.status})`,
                true,
              )}
              {button("释放归档/已删除 Agent 绑定", () => release({ agentId: id }))}
            </View>
          ))}
      </ScrollView>
      <Modal
        title="Codex 安全登录"
        open={!!loginId}
        onOpenChange={(open) => {
          if (!open && loginId)
            void run(async () => {
              await cancel({ loginId });
              setLoginId(null);
            });
        }}
      >
        <Modal.Content>
          {body(currentLogin?.status || "正在准备登录…")}
          {currentLogin?.url && (
            <ExternalLink href={currentLogin.url}>{body("打开官方登录页面")}</ExternalLink>
          )}
          {currentLogin?.url && body(currentLogin.url, true)}
          {currentLogin?.url && button("复制登录链接", () => copyText(currentLogin.url ?? ""))}
          {currentLogin?.code && body(`设备码：${currentLogin.code}`)}
          {currentLogin?.code && button("复制设备码", () => copyText(currentLogin.code ?? ""))}
          {body(
            mode === "browser"
              ? "浏览器登录必须在 daemon 所在电脑完成回调。"
              : "在任意设备打开链接输入设备码；必要时先启用 ChatGPT 的设备码登录。",
            true,
          )}
          {(currentLogin?.error || attempt.error) &&
            body(currentLogin?.error || attempt.error?.message)}
          {loginId &&
            button("关闭/取消登录", async () => {
              await cancel({ loginId });
              setLoginId(null);
            })}
        </Modal.Content>
      </Modal>
      <Modal
        title="删除账号"
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <Modal.Content>
          {body(`删除 ${deleting?.name || ""}？默认只忘记/隐藏账号，保留认证与原生历史。`)}
          {deleting?.managed &&
            button(
              purge ? "已选择：注销并永久删除托管 home" : "可选：同时注销并删除托管 home",
              async () => setPurge(!purge),
            )}
          {button("确认删除", async () => {
            if (deleting) await remove({ accountId: deleting.id, purge });
            setDeleting(null);
            await queryClient.invalidateQueries({ queryKey: ["usage"] });
          })}
          {button("取消", async () => setDeleting(null))}
          {error && body(error)}
        </Modal.Content>
      </Modal>
    </View>
  );
}
