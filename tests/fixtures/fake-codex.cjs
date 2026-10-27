// Synthetic stdio app-server. No real login, credentials or provider connection.
const readline = require("node:readline");
const fs = require("node:fs");
const scenario = process.env.TEST_CODEX_SCENARIO || "success";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (process.env.TEST_CODEX_CAPTURE)
  fs.writeFileSync(
    process.env.TEST_CODEX_CAPTURE,
    JSON.stringify({
      argv: process.argv.slice(2),
      home: process.env.CODEX_HOME,
      apiKey: process.env.OPENAI_API_KEY,
      pi: process.env.PI_TEST_SECRET,
    }),
  );
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (scenario === "hang") return;
  if (request.method === "initialize")
    return send({ id: request.id, result: { userAgent: "synthetic" } });
  if (request.method === "account/read")
    return send({
      id: request.id,
      result: { account: { type: "chatgpt", email: "synthetic@example.invalid" } },
    });
  if (request.method === "thread/read" && scenario === "missing-thread")
    return send({ id: request.id, error: { message: "SENSITIVE PROVIDER ERROR" } });
  if (request.method === "account/login/start") {
    if (scenario === "error")
      return send({ id: request.id, error: { message: "ACCESS_TOKEN_SHOULD_NOT_LEAK" } });
    const completed = () =>
      send({
        method: "account/login/completed",
        params: {
          loginId: scenario === "mismatch" ? "foreign-attempt" : "synthetic-login",
          success: true,
        },
      });
    if (scenario === "early") completed();
    send({
      id: request.id,
      result: {
        loginId: "synthetic-login",
        type: request.params.type,
        verificationUrl:
          scenario === "unsafe"
            ? "https://evil.invalid/codex/device"
            : "https://auth.openai.com/codex/device",
        userCode: "TEST-CODE",
        authUrl: "https://auth.openai.com/oauth/authorize?state=test&code_challenge=test",
      },
    });
    if (!["early", "wait", "unsafe"].includes(scenario)) setTimeout(completed, 20);
    process.stderr.write("SECRET_STDERR_NEVER_LOG\n");
    return;
  }
  send({ id: request.id, result: {} });
});
