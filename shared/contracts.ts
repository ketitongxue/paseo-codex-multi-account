import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ACCOUNT_LABEL = "codex/account";
export const ACCOUNT_ENV = "PASEO_CODEX_ACCOUNT";
export const Id = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/);
export const Name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const Account = z
  .object({ id: Id, name: Name, home: z.string(), managed: z.boolean() })
  .strict();
export type Account = z.infer<typeof Account>;
export const Binding = z
  .object({
    accountId: Id,
    identityKey: z.string(),
    status: z.enum(["selected", "active", "unconfirmed"]),
  })
  .strict();
export type Binding = z.infer<typeof Binding>;
export const Window = z.object({
  id: z.string(),
  label: z.string(),
  shortLabel: z.string().optional(),
  summary: z.boolean().optional(),
  usedPct: z.number().finite().nullable().optional(),
  remainingPct: z.number().finite().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  tone: z.enum(["default", "ok", "warning", "danger"]).optional(),
});
export const Report = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    planLabel: z.string().optional(),
    windows: z.array(Window),
    balances: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          remaining: z.number().nullable().optional(),
          unit: z.literal("credits"),
        }),
      )
      .optional(),
    details: z.array(z.object({ id: z.string(), label: z.string(), value: z.string() })).optional(),
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("expired"),
        expiresAt: z.string(),
        refreshedBy: z.string().optional(),
      }),
      z.object({
        kind: z.literal("rejected"),
        status: z.number(),
        refreshedBy: z.string().optional(),
      }),
      z.object({ kind: z.literal("no_quota"), detail: z.string() }),
    ]),
  }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);
export type Report = z.infer<typeof Report>;
export const Identity = z.object({
  key: z.string(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  storage: z.enum(["file", "keyring"]),
  expired: z.boolean(),
});
export type Identity = z.infer<typeof Identity>;
export const AccountView = Account.extend({
  saved: z.boolean(),
  identity: Identity.nullable(),
  problem: z.string().nullable(),
  loginBusy: z.boolean(),
});
export type AccountView = z.infer<typeof AccountView>;
export const Snapshot = z.object({
  accounts: z.array(AccountView),
  defaultId: Id.nullable(),
  bindings: z.record(z.string(), Binding),
});
export type Snapshot = z.infer<typeof Snapshot>;
export const UsageRow = z.object({
  accountId: Id,
  report: Report,
  fetchedAt: z.string(),
  nextRetryAt: z.string().nullable(),
});
export type UsageRow = z.infer<typeof UsageRow>;
export const Login = z.object({
  id: z.string(),
  accountId: Id,
  status: z.enum(["starting", "waiting", "complete", "error", "canceled"]),
  url: z.string().nullable(),
  code: z.string().nullable(),
  error: z.string().nullable(),
  expiresAt: z.string(),
});
export type Login = z.infer<typeof Login>;
const accountId = z.object({ accountId: Id });
const empty = z.object({}).strict();
export const listAccounts = defineRpc({ name: "accounts.list", input: empty, output: Snapshot });
export const saveAccount = defineRpc({
  name: "accounts.save",
  input: z.object({ home: z.string().min(1).max(4096), name: Name }),
  output: Account,
});
export const createAccount = defineRpc({
  name: "accounts.create",
  input: z.object({ name: Name }),
  output: Account,
});
export const deleteAccount = defineRpc({
  name: "accounts.delete",
  input: accountId.extend({ purge: z.boolean().default(false) }),
  output: empty,
});
export const rediscover = defineRpc({ name: "accounts.rediscover", input: empty, output: empty });
export const setDefault = defineRpc({
  name: "accounts.default",
  input: z.object({ accountId: Id.nullable() }),
  output: empty,
});
export const startLogin = defineRpc({
  name: "login.start",
  input: accountId.extend({ mode: z.enum(["device", "browser"]).default("device") }),
  output: Login,
});
export const activeLogin = defineRpc({
  name: "login.active",
  input: accountId,
  output: Login.nullable(),
});
export const loginStatus = defineRpc({
  name: "login.status",
  input: z.object({ loginId: z.string() }),
  output: Login,
});
export const cancelLogin = defineRpc({
  name: "login.cancel",
  input: z.object({ loginId: z.string() }),
  output: empty,
});
export const getUsage = defineRpc({
  name: "usage.list",
  input: z.object({ accountId: Id.optional(), force: z.boolean().default(false) }),
  output: z.array(UsageRow),
});
export const switchAccount = defineRpc({
  name: "agents.switch",
  input: z.object({ agentId: Id, accountId: Id }),
  output: Binding,
});
export const releaseBinding = defineRpc({
  name: "agents.release",
  input: z.object({ agentId: Id }),
  output: empty,
});
