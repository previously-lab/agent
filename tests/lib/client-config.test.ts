import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readClientConfig, writeClientConfig } from "@/lib/client-config";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "previously-client-config-"));
  vi.stubEnv("PREVIOUSLY_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
  await rm(home, { recursive: true, force: true });
});

describe("compatible Chat settings", () => {
  it("persists the alternate route without exposing either key in the snapshot", async () => {
    await writeClientConfig({ byok: { apiKey: "primary-fixture" } });
    const snapshot = await writeClientConfig({ byok: {
      chatHost: " https://opencode.ai/inference/go/openai/v1/ ", chatKey: "alternate-fixture",
      chatModel: "deepseek-v4.1-flash",
    } });
    expect(snapshot.byok).toMatchObject({
      configured: true,
      chat: { configured: true, host: "https://opencode.ai/inference/go/openai/v1", model: "deepseek-v4.1-flash" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("alternate-fixture");
    expect(JSON.stringify(snapshot)).not.toContain("primary-fixture");
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).byok).toMatchObject({
      apiKey: "primary-fixture", chatKey: "alternate-fixture",
    });

    const removed = await writeClientConfig({ byok: { chatHost: "", chatKey: "", chatModel: "" } });
    expect(removed.byok.configured).toBe(true);
    expect(removed.byok.chat).toBeUndefined();
  });

  it("rejects a partial alternate route without replacing the existing config", async () => {
    await writeClientConfig({ byok: { apiKey: "primary-fixture" } });
    await expect(writeClientConfig({ byok: { chatHost: "https://proxy.example/v1" } })).rejects.toThrow("configured together");
    expect((await readClientConfig()).byok.chat).toBeUndefined();
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).byok.apiKey).toBe("primary-fixture");
  });

  it("keeps a saved Chat key bound to the endpoint that received it", async () => {
    await writeClientConfig({ byok: {
      apiKey: "primary-fixture", chatHost: "https://first.example/v1", chatKey: "first-fixture",
    } });
    await writeClientConfig({ byok: { chatHost: "https://first.example/v1/chat/completions", chatModel: "new-model" } });
    for (const chatHost of ["https://second.example/v1", "https://first.example/other"]) {
      await expect(writeClientConfig({ byok: { chatHost } })).rejects.toThrow("new endpoint");
    }
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).byok.chatKey).toBe("first-fixture");
    const moved = await writeClientConfig({ byok: { chatHost: "https://second.example/v1", chatKey: "second-fixture" } });
    expect(moved.byok.chat?.host).toBe("https://second.example/v1");
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).byok.chatKey).toBe("second-fixture");
  });
});
