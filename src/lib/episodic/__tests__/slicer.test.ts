import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkTimeSilence, DEFAULT_TIME_SILENCE_MS } from "../slicer";

describe("checkTimeSilence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when last activity was just now", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(checkTimeSilence(now)).toBe(false);
  });

  it("returns false when last activity was 5 minutes ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const fiveMinAgo = now - 5 * 60 * 1000;
    expect(checkTimeSilence(fiveMinAgo)).toBe(false);
  });

  it("returns false exactly at the threshold boundary minus 1ms", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const boundary = now - DEFAULT_TIME_SILENCE_MS + 1;
    expect(checkTimeSilence(boundary)).toBe(false);
  });

  it("returns true exactly at the threshold boundary", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const boundary = now - DEFAULT_TIME_SILENCE_MS;
    expect(checkTimeSilence(boundary)).toBe(true);
  });

  it("returns true when well past the threshold (1 hour)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const oneHourAgo = now - 60 * 60 * 1000;
    expect(checkTimeSilence(oneHourAgo)).toBe(true);
  });

  it("returns true when days past the threshold", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const daysAgo = now - 3 * 24 * 60 * 60 * 1000;
    expect(checkTimeSilence(daysAgo)).toBe(true);
  });

  it("handles future timestamp (clock skew) — returns false", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const future = now + 60 * 1000;
    expect(checkTimeSilence(future)).toBe(false);
  });

  it("threshold is exactly 30 minutes in milliseconds", () => {
    expect(DEFAULT_TIME_SILENCE_MS).toBe(30 * 60 * 1000);
  });
});
