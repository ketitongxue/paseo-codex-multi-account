import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { optionalText } from "../server/files";
import { fixture } from "./helpers";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  return f;
}
describe("bounded read-only credential/config files", () => {
  it("bounds the actual file behind an external symlink, not the link size", async () => {
    const f = await setup();
    const target = join(f.root, "large.json"),
      link = join(f.user, "auth.json");
    await writeFile(target, "x".repeat(1024 * 1024 + 1));
    await symlink(target, link);
    await expect(optionalText(link).then((text) => text?.length)).rejects.toThrow("过大");
  });
  it("permits ordinary external config symlinks without rewriting their targets", async () => {
    const f = await setup();
    const target = join(f.root, "config.toml"),
      link = join(f.user, "config.toml");
    const text = 'cli_auth_credentials_store = "keyring"\n';
    await writeFile(target, text);
    await symlink(target, link);
    expect(await optionalText(link)).toBe(text);
    expect(await readFile(target, "utf8")).toBe(text);
    expect(await optionalText(join(f.root, "missing"))).toBeNull();
  });
  it("rejects non-regular files with a safe error", async () => {
    const f = await setup();
    const directory = join(f.root, "directory");
    await mkdir(directory);
    await expect(optionalText(directory)).rejects.toThrow("普通文件");
  });
});
