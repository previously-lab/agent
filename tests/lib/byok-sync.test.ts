import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readClientByokSync } from "@/lib/byok-sync";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "previously-byok-sync-")); vi.stubEnv("PREVIOUSLY_HOME", home); });
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(home).startsWith(resolve(tmpdir()) + sep) || !home.includes("previously-byok-sync-")) throw new Error("Unexpected test directory");
  await rm(home, { recursive: true, force: true });
});
describe("local credential resolution", () => {
  it("treats missing or corrupt config as unconfigured without modifying it", async () => {
    expect(readClientByokSync()).toBeNull();
    await writeFile(join(home, "config.json"), "broken");
    expect(readClientByokSync()).toBeNull();
  });
  it("supports only the legacy DeepSeek env-key slot when BYOK has not been configured", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ apiKeys: { DEEPSEEK_API_KEY: "legacy" } }));
    expect(readClientByokSync()).toEqual({ provider: "deepseek", model: "deepseek-flash", apiKey: "legacy" });
    await writeFile(join(home, "config.json"), JSON.stringify({ byok: { provider: "custom", apiKey: "proxy-key" }, apiKeys: { DEEPSEEK_API_KEY: "legacy" } }));
    expect(readClientByokSync()).toBeNull();
  });
});
