import type {
  PluginHookAgent,
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";

export type SessionOpenHandler = (
  input: { request: PluginSessionOpenRequest },
  context: PluginHookContext,
) => Promise<PluginSessionOpenRequest | undefined>;

type HookHost = Pick<PluginServerContext, "before"> & {
  addHook?: (name: "agent.open.before", handler: SessionOpenHandler) => () => void;
};

// Detect the capability instead of guessing from the daemon's prerelease version string.
// Keep imports on the oldest supported SDK; older 0.14 builds do not export the new hook types.
export function registerSessionOpenHook(host: HookHost, handler: SessionOpenHandler): () => void {
  if (typeof host.addHook === "function") return host.addHook("agent.open.before", handler);
  return host.before("agent.session_open", handler);
}

export type TurnEndedEvent = {
  agent: PluginHookAgent;
  turnId: string | null;
  outcome: PluginTurnOutcome;
};
export type TurnEndedHandler = (
  event: TurnEndedEvent,
  context: PluginHookContext,
) => void | Promise<void>;

type TurnHost = Pick<PluginServerContext, "on"> & {
  // Newer hosts require the hook to return a promise; wrap sync handlers for them.
  addHook?: (
    name: "agent.turn.after",
    handler: (event: TurnEndedEvent, context: PluginHookContext) => Promise<void>,
  ) => () => void;
};

// 0.15+ renamed agent.turn_ended to agent.turn.after; the legacy name stays mapped until 2027-04.
export function registerTurnEndedHook(host: TurnHost, handler: TurnEndedHandler): () => void {
  if (typeof host.addHook === "function")
    return host.addHook("agent.turn.after", async (event, context) => {
      await handler(event, context);
    });
  return host.on("agent.turn_ended", handler);
}
