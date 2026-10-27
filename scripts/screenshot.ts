// Render the actual account component with synthetic data in an isolated local browser profile.
// No daemon, provider CLI, keyring or user configuration is accessed. No browser is downloaded.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "paseo-codex-preview-"));
const output = join(project, "assets", "accounts-preview.png");
const server = createServer();
try {
  const host = join(project, "scripts", "preview", "host.jsx");
  const bundle = join(temporary, "preview.js");
  await build({
    absWorkingDir: project,
    entryPoints: ["scripts/preview/main.jsx"],
    outfile: bundle,
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    alias: {
      "react-native": "react-native-web",
      "@getpaseo/plugin/client": host,
      "@getpaseo/plugin/client/ui": host,
    },
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
    logLevel: "silent",
  });
  const javascript = await readFile(bundle);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex account preview</title><style>html,body,#root{height:100%;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>`;
  server.on("request", (request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'",
    );
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } else if (request.url === "/preview.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(javascript);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server did not start.");
  await mkdir(dirname(output), { recursive: true });
  const binary =
    process.env.CHROME_BINARY ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "chromium");
  await promisify(execFile)(
    binary,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--password-store=basic",
      "--use-mock-keychain",
      "--hide-scrollbars",
      `--user-data-dir=${join(temporary, "browser")}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--window-size=1440,1740",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=4000",
      `--screenshot=${output}`,
      `http://127.0.0.1:${address.port}/`,
    ],
    {
      env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, TZ: "UTC" },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  console.log("Saved assets/accounts-preview.png (actual account component; synthetic data only).");
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(temporary, { recursive: true, force: true });
}
