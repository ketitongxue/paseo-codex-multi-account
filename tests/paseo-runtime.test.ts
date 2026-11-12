import { fork } from "node:child_process";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { MutableDaemonConfigSchema as BaselineConfigSchema } from "@getpaseo/protocol/messages";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { compileDirectoryPlugin as BaselineCompiler } from "../node_modules/@getpaseo/server/dist/server/server/plugins/compiler-build.js";
import type { PluginRuntime as BaselineRuntime } from "../node_modules/@getpaseo/server/dist/server/server/plugins/runtime.js";
import { hostPackage, paseoTargets, serverDirectory } from "../scripts/paseo-targets";
import { fixture } from "./helpers";

const pluginId = "paseo-codex-multi-account";
const hosts = await Promise.all(
  paseoTargets.map(async (target) => {
    const server = serverDirectory(target);
    const require = createRequire(join(server, "package.json"));
    const compiler = await import(
      pathToFileURL(join(server, "dist/server/server/plugins/compiler-build.js")).href
    );
    const runtime = await import(
      pathToFileURL(join(server, "dist/server/server/plugins/runtime.js")).href
    );
    const protocol = await import(
      pathToFileURL(require.resolve("@getpaseo/protocol/messages")).href
    );
    const lifecycle = await import(
      pathToFileURL(join(hostPackage(target, "@getpaseo/plugin"), "dist/server/lifecycle.js")).href
    );
    return {
      version: target.version,
      server,
      compileDirectoryPlugin: compiler.compileDirectoryPlugin as typeof BaselineCompiler,
      PluginRuntime: runtime.PluginRuntime as typeof BaselineRuntime,
      MutableDaemonConfigSchema: protocol.MutableDaemonConfigSchema as typeof BaselineConfigSchema,
      hasEntityMetadata: !!protocol.CreateAgentRequestMessageSchema?.shape?.metadata,
      openHook: lifecycle.pluginHookRegistry?.["agent.open.before"]
        ? "agent.open.before"
        : "agent.session_open",
    };
  }),
);
describe.each(hosts)(
  "real Paseo $version compiler and subprocess",
  ({
    version,
    server,
    compileDirectoryPlugin,
    PluginRuntime,
    MutableDaemonConfigSchema,
    hasEntityMetadata,
    openHook,
  }) => {
    it("compiles both entries with runtime boundary validation and rejects unsupported Paseo", async () => {
      const compiled = await compileDirectoryPlugin(process.cwd(), version);
      expect(compiled.clientBundle?.length).toBeGreaterThan(1000);
      expect(compiled.serverBundle?.length).toBeGreaterThan(1000);
      await expect(compileDirectoryPlugin(process.cwd(), "0.13.2")).rejects.toThrow();
      await expect(compileDirectoryPlugin(process.cwd(), "0.17.0-beta.1")).rejects.toThrow();
    });
    it("compiles an isolated production-only installation with no development SDK dependencies", async () => {
      const f = await fixture();
      try {
        const directory = join(f.root, "installed-plugin");
        await mkdir(directory);
        for (const name of [
          "index.server.ts",
          "index.client.tsx",
          "paseo-plugin.json",
          "package.json",
          "server",
          "client",
          "shared",
          "assets",
          "npm-shrinkwrap.json",
          "OVERVIEW.md",
          "OVERVIEW.zh-CN.md",
        ])
          await cp(resolve(name), join(directory, name), { recursive: true });
        const dependency = join(directory, "node_modules", "@iarna", "toml");
        await cp(resolve("node_modules/@iarna/toml"), dependency, { recursive: true });
        const compiled = await compileDirectoryPlugin(directory, version);
        expect(compiled.serverBundle?.length).toBeGreaterThan(1000);
        expect(compiled.clientBundle?.length).toBeGreaterThan(1000);
      } finally {
        await f.cleanup();
      }
    });
    it("loads the real plugin, validates RPCs, discovers expired accounts and transports session-open env and tools", async () => {
      const f = await fixture(),
        a = await f.home(".codex-first", "synthetic-account", 1);
      const worker = resolve(server, "dist/server/server/plugins/plugin-process.js");
      const env = {
        ...process.env,
        HOME: f.user,
        PASEO_HOME: join(f.root, "paseo"),
        CODEX_HOME: a.home,
      };
      for (const key of Object.keys(env))
        if (key.startsWith("OPENAI_") || key.startsWith("PI_") || key === "CODEX_API_KEY")
          delete env[key as keyof typeof env];
      const runtime = new PluginRuntime(pino({ level: "silent" }), version, {
        spawnChild: () =>
          fork(worker, [], {
            execArgv: [],
            env,
            serialization: "advanced",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          }),
        sessionHost: {
          async attachPluginSocket(_id, socket) {
            const closed = new Promise<void>((done) => socket.once("close", () => done()));
            const send = (message: unknown) =>
              socket.send(JSON.stringify({ type: "session", message }));
            socket.on("message", (data) => {
              if (typeof data !== "string") return;
              const frame = JSON.parse(data);
              if (frame.type === "hello")
                send({
                  type: "status",
                  payload: {
                    status: "server_info",
                    serverId: "isolated-smoke",
                    hostname: "isolated-smoke",
                    version,
                    features: {},
                  },
                });
              const message = frame.message;
              if (message?.type === "get_daemon_config_request")
                send({
                  type: "get_daemon_config_response",
                  payload: {
                    requestId: message.requestId,
                    config: MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
                  },
                });
            });
            return { closed };
          },
        },
      });
      const open = runtime.before.bind(runtime) as (
        hook: string,
        request: PluginSessionOpenRequest,
      ) => Promise<PluginSessionOpenRequest>;
      try {
        await runtime.startPlugin(pluginId, process.cwd());
        expect(runtime.catalog()[0].id).toBe(pluginId);
        const snapshot = (await runtime.invoke(pluginId, "accounts.list", {})) as {
          accounts: Array<{ id: string; name: string; identity: { expired: boolean } }>;
        };
        expect(snapshot.accounts).toHaveLength(1);
        expect(snapshot.accounts[0].identity.expired).toBe(true);
        await expect(
          runtime.invoke(pluginId, "accounts.save", { home: a.home, name: 42 }),
        ).rejects.toThrow();
        const source = runtime.getUsageSourceRegistrations(pluginId)[0];
        expect(source.id).toBe("codex-multi-account");
        const found = (await runtime.discoverUsage(pluginId, source.id, {
          kind: "global",
        })) as Array<{ input: unknown }>;
        expect(found).toHaveLength(1);
        const report = await runtime.fetchUsage(pluginId, source.id, found[0].input);
        expect(report).toMatchObject({ status: "unavailable", problem: { kind: "expired" } });
        const snapshotJson = JSON.stringify(snapshot);
        expect(snapshotJson).not.toContain("access_token");
        expect(snapshotJson).not.toContain("REFRESH_SECRET");
        // Still exercises credential rejection through the actual before-hook IPC, not a direct method call.
        const readOnlyFields = {
          ...(hasEntityMetadata
            ? { metadata: { "other-plugin.note": { id: "synthetic", keep: true } } }
            : {}),
          ...(version === "0.16.0-beta.2" ? { background: true } : {}),
        };
        const request = {
          ...readOnlyFields,
          agentId: "agent-smoke",
          workspaceId: null,
          provider: "codex",
          cwd: f.root,
          reason: "create" as const,
          purpose: "interactive" as const,
          title: null,
          labels: { "codex/account": a.id },
          tools: [],
          env: {},
          mcpServers: {},
        };
        await expect(open(openHook, request)).rejects.toThrow("过期");
        // Refresh the synthetic fixture without any network or real Codex process.
        const { authJson } = await import("./helpers");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(a.home, "auth.json"), authJson("synthetic-account"));
        const transformed = await open(openHook, request);
        expect(transformed.env.CODEX_HOME).toBe(a.home);
        expect(transformed).toMatchObject(readOnlyFields);
        expect(transformed.tools[0].name).toBe("codex_accounts");
        const unaffected = await open(openHook, { ...request, provider: "pi" });
        expect(unaffected.env).toEqual({});
        expect(unaffected.tools).toEqual([]);
        expect(unaffected).toMatchObject(readOnlyFields);
        const stored = await readFile(
          join(env.PASEO_HOME, "codex-multi-account", "accounts.json"),
          "utf8",
        );
        expect(stored).not.toContain("REFRESH_SECRET");
        await runtime.stopPluginById(pluginId);
        expect(runtime.catalog()).toHaveLength(0);
        // Reload/upgrade must preserve the saved account even without the creation label.
        await runtime.startPlugin(pluginId, process.cwd());
        const resumed = await open(openHook, { ...request, reason: "resume", labels: {} });
        expect(resumed.env.CODEX_HOME).toBe(a.home);
        expect(resumed).toMatchObject(readOnlyFields);
      } finally {
        await runtime.stopAll();
        await f.cleanup();
      }
    }, 30000);
  },
);
