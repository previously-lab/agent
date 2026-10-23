import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ readClientByokSync: vi.fn(), isClientMode: vi.fn() }));
vi.mock("@/lib/byok-sync", () => ({ readClientByokSync: config.readClientByokSync }));
vi.mock("@/lib/mode", () => ({ isClientMode: config.isClientMode }));
import { deepseekApiKey } from "@/lib/deepseek/credentials";

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
