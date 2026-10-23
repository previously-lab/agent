import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { GET as getConfig, POST as postConfig } from "@/app/api/client/config/route";
import { GET as getStatus } from "@/app/api/client/status/route";
import { readClientByokSync } from "@/lib/byok-sync";

let home: string;
const post = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/client/config", {
  method: "POST", headers: { "content-type": "application/json", origin, host: "localhost:3000" }, body: JSON.stringify(body),
});
const disk = async () => JSON.parse(await readFile(join(home, "config.json"), "utf8"));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "previously-byok-api-"));
  vi.stubEnv("PREVIOUSLY_MODE", "client"); vi.stubEnv("PREVIOUSLY_HOME", home);
  vi.stubEnv("ACCESS_SECRET", "fixture-access"); vi.stubEnv("DEEPSEEK_API_KEY", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(home).startsWith(resolve(tmpdir()) + sep) || !home.includes("previously-byok-api-")) throw new Error("Unexpected test directory");
  await rm(home, { recursive: true, force: true });
});

describe("local BYOK endpoints", () => {
  it("is unavailable in cloud mode and protects cross-origin writes", async () => {
    expect((await postConfig(post({ byok: { apiKey: "key" } }, "https://untrusted.example"))).status).toBe(403);
    vi.stubEnv("PREVIOUSLY_MODE", "cloud");
    expect((await getConfig()).status).toBe(404);
    expect((await getStatus()).status).toBe(404);
    expect((await postConfig(post({ byok: { apiKey: "key" } }))).status).toBe(404);
  });

  it("returns only redacted credential state from GET, POST, and runtime status", async () => {
    const key = "sk-fixture-private-1234";
    const saved = await postConfig(post({ byok: { apiKey: key } }));
    expect(saved.status).toBe(200);
    for (const response of [saved, await getConfig(), await getStatus()]) {
      const body = await response.json();
      expect(body.byok).toMatchObject({ provider: "deepseek", model: "deepseek-flash", configured: true });
      expect(body.byok).not.toHaveProperty("apiKey");
      expect(JSON.stringify(body)).not.toContain(key);
      expect(body).not.toHaveProperty("bridge");
    }
    expect((await disk()).byok.apiKey).toBe(key);
  });

  it("preserves the key when omitted while retaining storage paths and unmanaged settings", async () => {
    const raw = { storage: "github", memoryRoot: "C:/fixture/memory", port: 3838, custom: { retained: true },
      brain: { type: "bridge", agent: "old" }, agents: { old: {} }, executionBackend: "docker",
      byok: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "fixture-key" } };
    await writeFile(join(home, "config.json"), JSON.stringify(raw));
    expect((await postConfig(post({ byok: { model: "deepseek-flash" } }))).status).toBe(200);
    const saved = await disk();
    expect(saved).toMatchObject({ storage: "github", memoryRoot: raw.memoryRoot, port: 3838, custom: { retained: true }, byok: { apiKey: "fixture-key", model: "deepseek-flash" } });
    expect(saved).not.toHaveProperty("brain"); expect(saved).not.toHaveProperty("agents"); expect(saved).not.toHaveProperty("executionBackend");
  });

  it.each([null, { apiKey: "" }])("clears credentials without resurrecting legacy apiKeys: %j", async (byok) => {
    await writeFile(join(home, "config.json"), JSON.stringify({ byok: { provider: "deepseek", apiKey: "new-fixture" }, apiKeys: { DEEPSEEK_API_KEY: "legacy-fixture", OTHER: "keep" } }));
    expect((await postConfig(post({ byok }))).status).toBe(200);
    expect((await (await getConfig()).json()).byok.configured).toBe(false);
    expect(readClientByokSync()).toBeNull();
    expect((await disk()).apiKeys).toEqual({ OTHER: "keep" });
  });

  it.each([
    { brain: { type: "bridge", agent: "old" } }, { executionBackend: "docker" }, { memoryRoot: "C:/elsewhere", byok: {} },
    { byok: { provider: "openai", apiKey: "key" } }, { byok: { model: "deepseek-v4-pro", apiKey: "key" } },
    { byok: { baseUrl: "https://proxy.example", apiKey: "key" } }, { byok: { apiKey: 123 } }, { byok: [] },
  ])("rejects removed or malformed settings without modifying the file: %j", async (body) => {
    const original = JSON.stringify({ storage: "local", byok: { provider: "deepseek", apiKey: "keep-key" } });
    await writeFile(join(home, "config.json"), original);
    expect((await postConfig(post(body))).status).toBe(400);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(original);
  });

  it("reports corrupt config honestly without leaking its contents or overwriting it", async () => {
    const corrupt = '{"apiKey":"sensitive-corrupt-content"';
    await writeFile(join(home, "config.json"), corrupt);
    const response = await getConfig();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive-corrupt-content");
    expect((await postConfig(post({ byok: { apiKey: "replacement" } }))).status).toBe(500);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(corrupt);
  });
});
