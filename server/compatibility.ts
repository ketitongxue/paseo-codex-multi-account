import type {
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
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
