import { describe, it, expect } from "vitest";
import { parseSemver, compareSemver } from "@/lib/version/constants";

describe("parseSemver", () => {
  it("parses a valid semver string", () => {
    expect(parseSemver("0.3.0")).toEqual([0, 3, 0]);
  });

  it("parses a major version bump", () => {
    expect(parseSemver("1.0.0")).toEqual([1, 0, 0]);
  });

  it("parses multi-digit versions", () => {
    expect(parseSemver("10.20.30")).toEqual([10, 20, 30]);
  });

  it("returns null for non-semver strings", () => {
    expect(parseSemver("hello")).toBeNull();
  });

  it("returns null for partial versions", () => {
    expect(parseSemver("1.2")).toBeNull();
  });

  it("returns null for versions with prefixes", () => {
    expect(parseSemver("v1.2.3")).toBeNull();
  });

  it("returns null for versions with extra segments", () => {
    expect(parseSemver("1.2.3.4")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("returns positive when a > b (patch)", () => {
    expect(compareSemver("0.3.1", "0.3.0")).toBeGreaterThan(0);
  });

  it("returns negative when a < b (patch)", () => {
    expect(compareSemver("0.2.9", "0.3.0")).toBeLessThan(0);
  });

  it("returns 0 when a == b", () => {
    expect(compareSemver("0.3.0", "0.3.0")).toBe(0);
  });

  it("returns positive when a > b (minor)", () => {
    expect(compareSemver("0.4.0", "0.3.9")).toBeGreaterThan(0);
  });

  it("returns positive when a > b (major)", () => {
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("returns negative for older major version", () => {
    expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
  });

  it("handles multi-digit comparisons", () => {
    expect(compareSemver("10.0.0", "9.99.99")).toBeGreaterThan(0);
  });

  it("returns 0 when both versions are invalid", () => {
    expect(compareSemver("bad", "also-bad")).toBe(0);
  });

  it("returns 0 when first version is invalid", () => {
    expect(compareSemver("bad", "1.0.0")).toBe(0);
  });

  it("returns 0 when second version is invalid", () => {
    expect(compareSemver("1.0.0", "bad")).toBe(0);
  });
});
