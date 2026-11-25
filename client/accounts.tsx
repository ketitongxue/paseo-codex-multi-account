import { type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as api from "../shared/contracts";
import { localTime, percent, usageProblem } from "./format";

const bindingStatusLabels = {
  selected: "Selected",
  active: "Active",
  unconfirmed: "Unconfirmed",
};

const signInStatusLabels = {
  starting: "Preparing sign-in…",
  waiting: "Waiting for sign-in…",
  complete: "Signed in",
  error: "Sign-in failed",
  canceled: "Sign-in canceled",
};

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
  const setFailoverMode = useRpc(api.setFailover);
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
      setError(value instanceof Error ? value.message : "The operation failed. Try again.");
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
        {body(
          "Separate CODEX_HOME directories · New sign-ins use the system Keychain or keyring · Tokens are never copied",
        )}
        {body(
          "Discovery and saving leave existing homes intact. Removing an external account only hides it. Usage shows subscription limits.",
          true,
        )}
        {agentId &&
          body(
            `Current agent: ${agentId} · ${binding ? `${snapshot.data?.accounts.find((a) => a.id === binding.accountId)?.name || binding.accountId} (${bindingStatusLabels[binding.status]})` : "No account bound. Switching checks native session history before binding an account."}`,
          )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button("Rediscover accounts (including hidden)", async () => {
            await discover({});
            await queryClient.invalidateQueries({ queryKey: ["usage"] });
          })}
          {button("Refresh all usage", async () => {
            queryClient.setQueryData(["usage"], await usage({ force: true }));
          })}
          {button(
            "Clear default account",
            () => setDefault({ accountId: null }),
            !snapshot.data?.defaultId,
          )}
        </View>
        {(() => {
          const failover = snapshot.data?.failover ?? {
            mode: "offer" as const,
            autoContinue: true,
          };
          const apply = (
            mode: api.FailoverSettings["mode"],
            autoContinue = failover.autoContinue,
          ) => setFailoverMode({ mode, autoContinue });
          return (
            <View
              style={{
                gap: 8,
                padding: 12,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 8,
              }}
            >
              {body("Usage limit failover")}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {button("Off", () => apply("off"), failover.mode === "off")}
                {button("Suggest a switch", () => apply("offer"), failover.mode === "offer")}
                {button("Auto-switch", () => apply("auto"), failover.mode === "auto")}
                {failover.mode === "auto" &&
                  button(
                    failover.autoContinue
                      ? "Send “Continue.” after switching: On"
                      : "Send “Continue.” after switching: Off",
                    () => apply("auto", !failover.autoContinue),
                  )}
              </View>
              {body(
                "After each turn, the plugin checks the account's 5-hour and weekly limits. It can suggest an account in chat or switch automatically to the account with the most remaining usage and optionally send “Continue.” Each agent can auto-switch up to three times per hour and cannot return to the account it just left for one hour.",
                true,
              )}
            </View>
          );
        })()}
        {(error || snapshot.error || quotas.error) && (
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
            {error || snapshot.error?.message || quotas.error?.message}
          </Text>
        )}
        {snapshot.isPending && body("Discovering accounts…", true)}
        {snapshot.data?.accounts.length === 0 &&
          body(
            "No accounts yet. Create an account with secure sign-in or save an existing CODEX_HOME.",
            true,
          )}
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
                `${account.name}${snapshot.data.defaultId === account.id ? " · Default" : ""} · ${account.managed ? "Managed" : "External"}${account.saved ? " · Saved" : " · Discovered"}`,
              )}
              {body(account.home, true)}
              {body(`ID: ${account.id}`, true)}
              {body(
                account.identity
                  ? `${account.identity.email || "ChatGPT"} · ${account.identity.plan || "Unknown plan"} · ${account.identity.storage === "keyring" ? "Keyring" : "File"}${account.identity.expired ? " · Authentication expired" : ""}`
                  : account.problem || "Signed out",
                !account.problem,
              )}
              {row?.report.status === "available" ? (
                <View style={{ gap: 6 }}>
                  {body(`Plan: ${row.report.planLabel || account.identity?.plan || "Unknown"}`)}
                  {!row.report.windows.length &&
                    body("The server did not report usage windows.", true)}
                  {row.report.windows.map((window) => (
                    <View key={window.id} style={{ gap: 3 }}>
                      {body(
                        `${window.label}: ${percent(window.usedPct)} used · ${percent(window.remainingPct)} remaining`,
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
                      {body(`Resets: ${localTime(window.resetsAt)}`, true)}
                    </View>
                  ))}
                  {row.report.balances?.map((balance) => (
                    <Text key={balance.id} style={{ color: colors.foreground }}>
                      {balance.label}: {balance.remaining ?? "Unknown"} credits
                    </Text>
                  ))}
                </View>
              ) : row ? (
                body(usageProblem(row.report))
              ) : (
                body("Usage refresh pending…", true)
              )}
              {row &&
                body(
                  `Checked: ${localTime(row.fetchedAt)}${row.nextRetryAt ? ` · Next retry: ${localTime(row.nextRetryAt)}` : ""}`,
                  true,
                )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {button("Save / rename", async () => {
                  if (!name.trim()) throw new Error("Enter an account name below.");
                  await save({ home: account.home, name });
                })}
                {button(
                  "Set as default",
                  () => setDefault({ accountId: account.id }),
                  !account.identity || account.loginBusy,
                )}
                {button(
                  account.loginBusy ? "View sign-in" : "Sign in",
                  async () => {
                    const result = account.loginBusy
                      ? await active({ accountId: account.id })
                      : await login({ accountId: account.id, mode });
                    if (!result) throw new Error("Sign-in is starting. Try again shortly.");
                    setLoginId(result.id);
                  },
                  !account.managed,
                )}
                {button("Refresh usage", async () => {
                  const values = await usage({ accountId: account.id, force: true });
                  queryClient.setQueryData<api.UsageRow[]>(["usage"], (old) => [
                    ...(old ?? []).filter((entry) => entry.accountId !== account.id),
                    ...values,
                  ]);
                })}
                {agentId &&
                  button(
                    "Switch current agent",
                    () => switchTo({ agentId, accountId: account.id }),
                    !account.identity || account.loginBusy,
                  )}
                {button(
                  "Create agent with this account",
                  async () => {
                    if (!cwd.trim())
                      throw new Error("Enter the new agent's working directory below.");
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
                {button("Remove…", async () => {
                  setPurge(false);
                  setDeleting(account);
                })}
              </View>
              {!account.managed &&
                body(
                  "To sign in again to an external account, run codex login with its CODEX_HOME. The plugin leaves its credential storage intact.",
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
          {body("Create, save, or rename accounts")}
          {field(name, setName, "Account name (e.g. keti)")}
          {field(home, setHome, "Existing CODEX_HOME (e.g. ~/.codex-keti)")}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {button("Save existing home", () => save({ home, name }), !name.trim() || !home.trim())}
            {button(
              "Create account with secure sign-in",
              async () => {
                const account = await create({ name });
                const result = await login({ accountId: account.id, mode });
                setLoginId(result.id);
              },
              !name.trim(),
            )}
            {button(
              mode === "device" ? "Sign-in method: Device code" : "Sign-in method: Local browser",
              async () => setMode(mode === "device" ? "browser" : "device"),
            )}
          </View>
          {field(cwd, setCwd, "New agent working directory (absolute path on the daemon host)")}
          {body(
            "To switch an existing session, both homes must be able to read the same native session history. Create a new agent if the history is unavailable to the target account.",
            true,
          )}
        </View>
        {!!snapshot.data &&
          Object.entries(snapshot.data.bindings).map(([id, value]) => (
            <View key={id} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {body(
                `Account binding for ${id} → ${snapshot.data.accounts.find((a) => a.id === value.accountId)?.name || value.accountId} (${bindingStatusLabels[value.status]})`,
                true,
              )}
              {button("Release archived or deleted agent binding", () => release({ agentId: id }))}
            </View>
          ))}
      </ScrollView>
      <Modal
        title="Secure Codex sign-in"
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
          {body(
            currentLogin ? signInStatusLabels[currentLogin.status] : signInStatusLabels.starting,
          )}
          {currentLogin?.url && (
            <ExternalLink href={currentLogin.url}>
              {body("Open official sign-in page")}
            </ExternalLink>
          )}
          {currentLogin?.url && body(currentLogin.url, true)}
          {currentLogin?.url && button("Copy sign-in link", () => copyText(currentLogin.url ?? ""))}
          {currentLogin?.code && body(`Device code: ${currentLogin.code}`)}
          {currentLogin?.code &&
            button("Copy device code", () => copyText(currentLogin.code ?? ""))}
          {body(
            mode === "browser"
              ? "Complete browser sign-in on the computer running the daemon."
              : "Open the link on any device and enter the device code. Enable device-code sign-in in ChatGPT first if needed.",
            true,
          )}
          {(currentLogin?.error || attempt.error) &&
            body(currentLogin?.error || attempt.error?.message)}
          {loginId &&
            button("Close / cancel sign-in", async () => {
              await cancel({ loginId });
              setLoginId(null);
            })}
        </Modal.Content>
      </Modal>
      <Modal
        title="Remove account"
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <Modal.Content>
          {body(
            `Remove ${deleting?.name || ""}? By default, removal only forgets or hides the account and keeps its credentials and native session history.`,
          )}
          {deleting?.managed &&
            button(
              purge
                ? "Selected: Sign out and permanently delete the managed home"
                : "Also sign out and delete the managed home",
              async () => setPurge(!purge),
            )}
          {button("Confirm removal", async () => {
            if (deleting) await remove({ accountId: deleting.id, purge });
            setDeleting(null);
            await queryClient.invalidateQueries({ queryKey: ["usage"] });
          })}
          {button("Cancel", async () => setDeleting(null))}
          {error && body(error)}
        </Modal.Content>
      </Modal>
    </View>
  );
}
