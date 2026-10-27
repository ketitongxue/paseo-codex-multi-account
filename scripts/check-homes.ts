// Read-only smoke: no login, model turn, config edit, daemon install or token output.
import { homedir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../server/accounts";
import { Store } from "../server/store";
import { Usage } from "../server/usage";

const accounts = new Accounts(
  new Store(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "codex-multi-account")),
  homedir(),
  process.env,
);
const snapshot = await accounts.snapshot();
for (const account of snapshot.accounts)
  console.log(
    JSON.stringify({
      name: account.name,
      home: account.home,
      signedIn: !!account.identity,
      storage: account.identity?.storage,
      expired: account.identity?.expired,
      problem: account.problem,
    }),
  );
if (process.argv.includes("--usage")) {
  const reports = await new Usage(accounts).list();
  for (const entry of reports)
    console.log(
      JSON.stringify({
        account: snapshot.accounts.find((a) => a.id === entry.accountId)?.name,
        report: entry.report,
        fetchedAt: entry.fetchedAt,
      }),
    );
}
