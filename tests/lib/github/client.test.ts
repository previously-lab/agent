import { describe, it, expect, beforeEach } from "vitest";
import { getOctokit, resetOctokit } from "@/lib/github/client";

describe("getOctokit", () => {
  beforeEach(() => {
    resetOctokit();
    delete process.env.GITHUB_TOKEN;
  });

  it("throws when GITHUB_TOKEN is not set", () => {
    expect(() => getOctokit()).toThrow("GITHUB_TOKEN");
  });

  it("returns an octokit instance when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "test-token-123";
    const octokit = getOctokit();
    expect(octokit).toBeDefined();
  });

  it("returns the same instance on repeated calls (singleton)", () => {
    process.env.GITHUB_TOKEN = "test-token-456";
    const a = getOctokit();
    const b = getOctokit();
    expect(a).toBe(b);
  });
});

describe("resetOctokit", () => {
  it("clears the singleton so next call creates a new instance", () => {
    process.env.GITHUB_TOKEN = "token-a";
    const a = getOctokit();
    resetOctokit();
    process.env.GITHUB_TOKEN = "token-b";
    const b = getOctokit();
    expect(a).not.toBe(b);
  });
});
