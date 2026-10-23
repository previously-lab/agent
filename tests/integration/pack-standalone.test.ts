import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const fixturePrefix = "aftrbrez-pack-standalone-";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), fixturePrefix)); roots.push(root);
  const standalone = join(root, ".next", "standalone");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(standalone, "node_modules", ".pnpm", "node_modules"), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../../scripts/pack-standalone.mjs", import.meta.url)), join(root, "scripts", "pack-standalone.mjs"));
  return { root, standalone, run: () => execFileSync(process.execPath, [join(root, "scripts", "pack-standalone.mjs")], { encoding: "utf8", stdio: "pipe" }) };
}
function write(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function link(target: string, path: string) { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path, "junction"); }
function links(path: string): string[] {
  return readdirSync(path).flatMap(name => {
    const child = join(path, name), st = lstatSync(child);
    return st.isSymbolicLink() ? [child] : st.isDirectory() ? links(child) : [];
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith(fixturePrefix)) throw new Error("Unexpected fixture cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("standalone dependency packaging", () => {
  it("recovers the exact omitted pnpm target and preserves transitive resolution after relocation", () => {
    const { root, standalone, run } = fixture();
    const packageRel = join("node_modules", ".pnpm", "sample@1.2.3", "node_modules", "sample");
    const helper = join(root, "node_modules", ".pnpm", "helper@4.5.6", "node_modules", "helper");
    write(join(root, packageRel, "index.js"), "module.exports = { value: require('helper'), dependency: require.resolve('helper') };\n");
    write(join(helper, "index.js"), "module.exports = 'exact dependency';\n");
    link(helper, join(root, "node_modules", ".pnpm", "sample@1.2.3", "node_modules", "helper"));
    write(join(root, "node_modules", ".pnpm", "sample@9.9.9", "node_modules", "sample", "index.js"), "throw new Error('wrong version');\n");
    link(join(standalone, packageRel), join(standalone, "node_modules", ".pnpm", "node_modules", "sample"));
    write(join(root, ".next", "static", "app.css"), "fixture css");
    write(join(root, "public", "favicon.txt"), "fixture asset");
    expect(run()).toContain("1 symlink(s) dereferenced");
    expect(run()).toContain("0 symlink(s) dereferenced");
    expect(links(standalone)).toEqual([]);
    const relocated = join(root, "relocated");
    if (dirname(relocated) !== root || dirname(dirname(standalone)) !== root) throw new Error("Unexpected fixture move target");
    renameSync(standalone, relocated);
    const copiedPackage = join(relocated, "node_modules", ".pnpm", "node_modules", "sample");
    const loaded = createRequire(import.meta.url)(copiedPackage);
    expect(loaded.value).toBe("exact dependency");
    expect(loaded.dependency).toBe(join(copiedPackage, "node_modules", "helper", "index.js"));
    expect(readFileSync(join(relocated, ".next", "static", "app.css"), "utf8")).toBe("fixture css");
    expect(readFileSync(join(relocated, "public", "favicon.txt"), "utf8")).toBe("fixture asset");
  });

  it("fails on a truly missing target without substituting another version or destroying the link", () => {
    const { root, standalone, run } = fixture();
    write(join(root, "node_modules", ".pnpm", "sample@2.0.0", "node_modules", "sample", "index.js"), "module.exports = 'wrong version';\n");
    const path = join(standalone, "node_modules", ".pnpm", "node_modules", "sample");
    link(join(standalone, "node_modules", ".pnpm", "sample@1.0.0", "node_modules", "sample"), path);
    expect(run).toThrow(/could not be dereferenced/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("still rejects actual symlink cycles", () => {
    const { standalone, run } = fixture();
    const first = join(standalone, "first"), second = join(standalone, "second");
    link(second, first); link(first, second);
    expect(run).toThrow(/symlink cycle/);
    expect(lstatSync(first).isSymbolicLink()).toBe(true);
    expect(lstatSync(second).isSymbolicLink()).toBe(true);
  });
});
