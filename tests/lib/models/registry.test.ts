import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODELS, getAvailableModels, getDefaultModelId, getModel, resolveModelId } from "@/lib/models/registry";
import { readClientByokSync } from "@/lib/byok-sync";

vi.mock("@/lib/byok-sync", () => ({ readClientByokSync: vi.fn() }));
const byok = vi.mocked(readClientByokSync);
beforeEach(() => { vi.stubEnv("PREVIOUSLY_MODE", "cloud"); vi.stubEnv("DEEPSEEK_API_KEY", ""); byok.mockReturnValue(null); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("fixed DeepSeek model", () => {
  it("normalizes every persisted legacy preference to Flash without selecting another provider", () => {
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "bridge/claude", "byok/gpt-4", "unknown", ""]) {
      expect(getModel(id)).toMatchObject({ id: "deepseek-flash", sdk: "deepseek", defaultThinking: true, defaultEffort: "high" });
      expect(resolveModelId(id)).toBe("deepseek-flash");
    }
    expect(ALL_MODELS).toHaveLength(1);
    expect(getDefaultModelId()).toBe("deepseek-flash");
  });

  it("does not activate retired bridges or provider credentials", () => {
    vi.stubEnv("PREVIOUSLY_BRAIN", "bridge"); vi.stubEnv("OPENAI_API_KEY", "not-deepseek"); vi.stubEnv("ANTHROPIC_API_KEY", "not-deepseek");
    expect(getAvailableModels()).toEqual([]);
  });

  it("lists cloud Flash only with a nonblank DeepSeek credential", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", " ");
    expect(getAvailableModels()).toEqual([]);
    vi.stubEnv("DEEPSEEK_API_KEY", "fixture-secret");
    expect(getAvailableModels()).toHaveLength(1);
    expect(JSON.stringify(getAvailableModels())).not.toContain("fixture-secret");
    expect(byok).not.toHaveBeenCalled();
  });

  it("resolves local BYOK availability without putting its key in model/workflow configuration", () => {
    vi.stubEnv("PREVIOUSLY_MODE", "client");
    byok.mockReturnValue({ provider: "deepseek", model: "deepseek-flash", apiKey: "local-fixture-secret" });
    expect(getAvailableModels().map((model) => model.id)).toEqual(["deepseek-flash"]);
    expect(JSON.stringify(getModel("deepseek-flash"))).not.toContain("local-fixture-secret");
    expect(getModel("deepseek-flash")).not.toHaveProperty("apiKey");
  });
});
