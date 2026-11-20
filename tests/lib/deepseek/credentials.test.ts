import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ readClientByokSync: vi.fn(), isClientMode: vi.fn() }));
vi.mock("@/lib/byok-sync", () => ({ readClientByokSync: config.readClientByokSync }));
vi.mock("@/lib/mode", () => ({ isClientMode: config.isClientMode }));
import { compatibleChatRoute, deepseekApiKey, hasCompatibleChatRoute, hasDeepSeekCredential } from "@/lib/deepseek/credentials";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  config.isClientMode.mockReturnValue(true);
  config.readClientByokSync.mockReturnValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("DeepSeek credentials at the request boundary", () => {
  it("prefers saved DeepSeek BYOK over an explicitly inherited key", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "inherited-key");
    config.readClientByokSync.mockReturnValue({ provider: "deepseek", apiKey: " saved-key " });
    expect(deepseekApiKey()).toBe("saved-key");
  });
  it("allows an explicitly inherited DeepSeek key without saved BYOK", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", " inherited-key ");
    expect(deepseekApiKey()).toBe("inherited-key");
  });
  it("does not cache a saved key or repurpose another provider key", () => {
    config.readClientByokSync.mockReturnValueOnce({ provider: "deepseek", apiKey: "saved-key" });
    expect(deepseekApiKey()).toBe("saved-key");
    config.readClientByokSync.mockReturnValue({ provider: "anthropic", apiKey: "different-provider-key" });
    expect(() => deepseekApiKey()).toThrow("Configure a DeepSeek API key");
  });
  it("uses only the deployment key in cloud mode", () => {
    config.isClientMode.mockReturnValue(false);
    vi.stubEnv("DEEPSEEK_API_KEY", " deployment-key ");
    expect(deepseekApiKey()).toBe("deployment-key");
    expect(config.readClientByokSync).not.toHaveBeenCalled();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(() => deepseekApiKey()).toThrow("DEEPSEEK_API_KEY is not configured");
  });
});


describe("compatible Chat credentials", () => {
  it("uses a complete alternate host/key pair without reading the primary key", () => {
    vi.stubEnv("CHAT_API_HOST", " https://opencode.ai/inference/go/openai/v1/ ");
    vi.stubEnv("CHAT_API_KEY", " alternate-key ");
    vi.stubEnv("CHAT_API_MODEL", " deepseek-v4.1-flash ");
    expect(compatibleChatRoute()).toMatchObject({
      endpoint: "https://opencode.ai/inference/go/openai/v1/chat/completions",
      model: "deepseek-v4.1-flash", apiKey: "alternate-key",
    });
    expect(hasCompatibleChatRoute()).toBe(true);
  });

  it("never sends a primary or inherited key to an incomplete alternate route", () => {
    vi.stubEnv("CHAT_API_HOST", "https://proxy.example/v1");
    vi.stubEnv("CHAT_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "primary-must-not-be-used");
    expect(() => compatibleChatRoute()).toThrow("must be configured together");
    expect(hasCompatibleChatRoute()).toBe(false);
  });

  it("uses saved alternate BYOK credentials without mixing the primary key", () => {
    config.readClientByokSync.mockReturnValue({
      provider: "deepseek", model: "deepseek-flash", apiKey: "primary-key",
      chatHost: "https://proxy.example/v1", chatKey: "alternate-key", chatModel: "custom-model",
    });
    expect(compatibleChatRoute()).toMatchObject({ apiKey: "alternate-key", model: "custom-model" });
  });
});


describe("native DeepSeek capability separation", () => {
  it("does not treat a Chat-only credential as a native DeepSeek credential", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("CHAT_API_HOST", "https://proxy.example/v1");
    vi.stubEnv("CHAT_API_KEY", "chat-only-key");
    expect(hasDeepSeekCredential()).toBe(false);
    expect(hasCompatibleChatRoute()).toBe(true);
    vi.stubEnv("DEEPSEEK_API_KEY", "primary-key");
    expect(hasDeepSeekCredential()).toBe(true);
  });
});
