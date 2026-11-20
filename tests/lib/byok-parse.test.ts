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


describe("optional compatible Chat credentials", () => {
  it("keeps the primary DeepSeek key separate and normalizes the Chat Host", () => {
    expect(parseByok({
      provider: "deepseek", apiKey: "primary-key",
      chatHost: " https://opencode.ai/inference/go/openai/v1/ ", chatKey: " chat-key ",
    })).toEqual({
      provider: "deepseek", model: "deepseek-flash", apiKey: "primary-key",
      chatHost: "https://opencode.ai/inference/go/openai/v1", chatKey: "chat-key", chatModel: "deepseek-v4.1-flash",
    });
  });

  it.each([
    { provider: "deepseek", apiKey: "primary", chatHost: "https://proxy.example/v1" },
    { provider: "deepseek", apiKey: "primary", chatKey: "chat-only" },
    { provider: "deepseek", apiKey: "primary", chatHost: "https://user:secret@proxy.example/v1", chatKey: "chat" },
    { provider: "deepseek", apiKey: "primary", chatHost: "http://proxy.example/v1", chatKey: "chat" },
  ])("rejects incomplete or unsafe alternate routes: %j", input => {
    expect(parseByok(input)).toBeNull();
  });

  it("allows a local HTTP route only for explicit local development", () => {
    expect(parseByok({ provider: "deepseek", apiKey: "primary", chatHost: "http://localhost:3000/v1", chatKey: "local" })?.chatHost)
      .toBe("http://localhost:3000/v1");
  });
});
