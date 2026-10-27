import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { AUTH_OVERRIDES } from "./server/codex-rpc";
import { Controller } from "./server/controller";
import { PublicError, safe } from "./server/errors";
import * as rpc from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const controller = new Controller();
  const { accounts, usage, logins, switching } = controller;
  server.handle(rpc.listAccounts, () => safe(() => accounts.snapshot((id) => logins.busy(id))));
  server.handle(rpc.saveAccount, ({ home, name }) => safe(() => accounts.save(home, name)));
  server.handle(rpc.createAccount, ({ name }) => safe(() => accounts.store.create(name)));
  server.handle(rpc.deleteAccount, ({ accountId, purge }) =>
    safe(() => controller.remove(accountId, purge)),
  );
  server.handle(rpc.rediscover, () =>
    safe(async () => {
      await accounts.store.change((state) => {
        state.hidden = [];
      });
      return {};
    }),
  );
  server.handle(rpc.setDefault, ({ accountId }) =>
    safe(async () => {
      await accounts.setDefault(accountId);
      return {};
    }),
  );
  server.handle(rpc.startLogin, ({ accountId, mode }) =>
    safe(() => controller.login(accountId, mode)),
  );
  server.handle(rpc.activeLogin, ({ accountId }) => safe(async () => logins.active(accountId)));
  server.handle(rpc.loginStatus, ({ loginId }) => safe(async () => logins.status(loginId)));
  server.handle(rpc.cancelLogin, ({ loginId }) =>
    safe(async () => {
      await logins.cancel(loginId);
      return {};
    }),
  );
  server.handle(rpc.getUsage, ({ accountId, force }) => safe(() => usage.list(accountId, force)));
  server.handle(rpc.switchAccount, ({ agentId, accountId }, { paseo }) =>
    safe(() => switching.switch(agentId, accountId, paseo)),
  );
  server.handle(rpc.releaseBinding, ({ agentId }, { paseo }) =>
    safe(() => controller.release(agentId, paseo)),
  );
  server.registerUsageSource(usage.source());
  const listTool = defineAgentTool({
    name: "codex_accounts",
    title: "Codex accounts and quota",
    description:
      'List available Codex account IDs/names and quota. To select an account for a NEW Codex agent, pass labels {"codex/account":"<id or unique name>"} to Paseo agent creation. Existing chats can use /codex-account <id>. Never ask for or pass tokens.',
    input: z.object({ usage: z.boolean().default(false) }),
    execute: async ({ usage: includeUsage }) => {
      const snapshot = await accounts.snapshot();
      return {
        structuredContent: {
          accounts: snapshot.accounts.map(({ id, name, identity, problem }) => ({
            id,
            name,
            signedIn: !!identity,
            plan: identity?.plan,
            problem,
          })),
          defaultId: snapshot.defaultId,
          ...(includeUsage ? { usage: await usage.list() } : {}),
        },
      };
    },
  });
  const removeHook = server.before("agent.session_open", async ({ request }, { paseo }) =>
    safe(async () => {
      if (request.provider !== "codex") return;
      // Provider launch overrides are not included in the hook's launch-only env map.
      const result = await switching.open(request);
      if (!result)
        return request.purpose === "interactive"
          ? { ...request, tools: [...request.tools, listTool] }
          : undefined;
      const { config } = await paseo.config.get();
      const provider = config.providers?.codex;
      if (provider) {
        const providerEnv = z.record(z.string(), z.unknown()).parse(provider.env ?? {});
        for (const key of AUTH_OVERRIDES)
          if (providerEnv[key])
            throw new PublicError(`Codex provider 环境变量 ${key} 覆盖订阅认证，请先移除。`);
        if (provider.command)
          throw new PublicError(
            "请先移除 Codex provider 的自定义 command；插件不会覆盖可能破坏账号隔离的启动器。",
          );
      }
      return request.purpose === "interactive"
        ? { ...result, tools: [...result.tools, listTool] }
        : result;
    }),
  );
  return async () => {
    removeHook();
    await controller.close();
  };
}
