import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshot } from "../scripts/preview/data";

const root = process.cwd();
const json = async (name: string) => JSON.parse(await readFile(resolve(root, name), "utf8"));

describe("marketplace publication materials", () => {
  it("ships English/Chinese overviews without plugin installation commands", async () => {
    const pkg = await json("package.json");
    expect(pkg.files).toEqual(
      expect.arrayContaining(["OVERVIEW.md", "OVERVIEW.*.md", "assets", "npm-shrinkwrap.json"]),
    );
    for (const name of ["OVERVIEW.md", "OVERVIEW.zh-CN.md"]) {
      const text = await readFile(resolve(root, name), "utf8");
      expect(text.length).toBeGreaterThan(200);
      expect(text).not.toMatch(
        /\b(?:paseo\s+plugin\s+(?:add|install)|npm\s+(?:install|i)(?:\s|$))/i,
      );
    }
    expect(await readFile(resolve(root, "OVERVIEW.md"), "utf8")).toContain("synthetic");
  });
  it("uses a synchronized, publishable lock and no lifecycle scripts for preparation", async () => {
    const pkg = await json("package.json"),
      lock = await json("npm-shrinkwrap.json");
    const manifest = await json("paseo-plugin.json");
    expect(manifest.build).toEqual([
      ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    ]);
    expect(lock.packages[""]).toMatchObject({
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
    });
    const toml = lock.packages["node_modules/@iarna/toml"];
    expect(toml.version).toBe(pkg.dependencies["@iarna/toml"]);
    expect(toml.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    expect(toml.integrity).toMatch(/^sha512-/);
  });
  it("declares a current PNG interface preview using synthetic accounts only", async () => {
    const manifest = await json("paseo-plugin.json");
    expect(manifest.media).toContain("assets/accounts-preview.png");
    const path = resolve(root, manifest.media[0]);
    expect((await stat(path)).size).toBeLessThan(2 * 1024 * 1024);
    const image = await readFile(path);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(image.readUInt32BE(16)).toBeGreaterThanOrEqual(1000);
    expect(image.readUInt32BE(20)).toBeGreaterThanOrEqual(1000);
    expect(manifest.translations["zh-CN"].name).toBeTruthy();
    for (const account of snapshot.accounts) {
      expect(account.home).toMatch(/^\/Users\/demo\//);
      expect(account.identity?.email).toMatch(/@example\.invalid$/);
    }
  });
});
