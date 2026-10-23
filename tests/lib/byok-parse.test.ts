import { describe, expect, it } from "vitest";
import { parseByok } from "@/lib/byok-parse";

describe("DeepSeek BYOK migration", () => {
  it("retains a valid old DeepSeek credential and normalizes the fixed model", () => {
    expect(parseByok({ provider: "deepseek", apiKey: " fixture-key ", model: "deepseek-v4-flash" })).toEqual({ provider: "deepseek", apiKey: "fixture-key", model: "deepseek-flash" });
    expect(parseByok({ provider: "deepseek", apiKey: "key" })?.model).toBe("deepseek-flash");
  });
  it.each([null, [], "key", {}, { provider: "deepseek", apiKey: " " }, { provider: "openai", apiKey: "key" },
    { provider: "custom", apiKey: "key", baseUrl: "https://api.deepseek.com" },
    { provider: "deepseek", apiKey: "key", baseUrl: "https://proxy.example" },
    { provider: "deepseek", apiKey: "key", baseUrl: "https://api.deepseek.com.evil.example" },
    { provider: "deepseek", apiKey: "key", baseUrl: "http://api.deepseek.com" },
  ])("never sends unsupported/proxy credentials to the official endpoint: %j", (input) => {
    expect(parseByok(input)).toBeNull();
  });
  it.each(["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"])("accepts a prior official endpoint: %s", (baseUrl) => {
    expect(parseByok({ provider: "deepseek", apiKey: "key", baseUrl })?.apiKey).toBe("key");
  });
});
