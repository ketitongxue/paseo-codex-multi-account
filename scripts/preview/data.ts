// Public, synthetic data only. This preview never reads a daemon, credentials or user configuration.
import { Snapshot, UsageRow } from "../../shared/contracts";

export const snapshot = Snapshot.parse({
  defaultId: "home-demo-personal",
  bindings: {
    "agent-demo": {
      accountId: "home-demo-personal",
      identityKey: "demo-personal",
      status: "active",
    },
  },
  accounts: [
    {
      id: "home-demo-personal",
      name: "personal",
      home: "/Users/demo/.paseo/codex-multi-account/homes/11111111-1111-4111-8111-111111111111",
      managed: true,
      saved: true,
      identity: {
        key: "demo-personal",
        email: "personal@example.invalid",
        plan: "plus",
        storage: "keyring",
        expired: false,
      },
      problem: null,
      loginBusy: false,
    },
    {
      id: "home-demo-team",
      name: "team",
      home: "/Users/demo/.codex-team",
      managed: false,
      saved: false,
      identity: {
        key: "demo-team",
        email: "team@example.invalid",
        plan: "business",
        storage: "file",
        expired: false,
      },
      problem: null,
      loginBusy: false,
    },
  ],
});
export const usage = snapshot.accounts.map((account, index) =>
  UsageRow.parse({
    accountId: account.id,
    fetchedAt: "2026-10-28T00:00:00.000Z",
    nextRetryAt: null,
    report: {
      status: "available",
      planLabel: account.identity?.plan,
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          summary: true,
          usedPct: index ? 92 : 25,
          remainingPct: index ? 8 : 75,
          resetsAt: "2026-10-28T04:00:00.000Z",
          tone: index ? "danger" : "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          summary: true,
          usedPct: index ? 61 : 41,
          remainingPct: index ? 39 : 59,
          resetsAt: "2026-11-02T00:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [{ id: "credits", label: "Credits", unit: "credits", remaining: 0 }],
    },
  }),
);
