import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkSliceAge } from "../slicer";

/** The production time_cap is config-driven (slicing.maxSliceMinutes, 30 min
 *  default in src/lib/config/defaults.ts) — the slicer takes the threshold
 *  explicitly and owns no defaults of its own. */
const CAP_MS = 30 * 60 * 1000;

describe("checkSliceAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when the slice just started", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(checkSliceAge(new Date(now).toISOString(), CAP_MS)).toBe(false);
  });

  it("returns false when the slice started 5 minutes ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    expect(checkSliceAge(fiveMinAgo, CAP_MS)).toBe(false);
  });

  it("returns false exactly at the cap boundary minus 1ms", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const boundary = new Date(now - CAP_MS + 1).toISOString();
    expect(checkSliceAge(boundary, CAP_MS)).toBe(false);
  });

  it("returns true exactly at the cap boundary", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const boundary = new Date(now - CAP_MS).toISOString();
    expect(checkSliceAge(boundary, CAP_MS)).toBe(true);
  });

  it("returns true when well past the cap (1 hour)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    expect(checkSliceAge(oneHourAgo, CAP_MS)).toBe(true);
  });

  it("returns true when days past the cap", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const daysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(checkSliceAge(daysAgo, CAP_MS)).toBe(true);
  });

  it("handles a future start time (clock skew) — returns false", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const future = new Date(now + 60 * 1000).toISOString();
    expect(checkSliceAge(future, CAP_MS)).toBe(false);
  });

  it("honours a custom cap", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    expect(checkSliceAge(tenMinAgo, 5 * 60 * 1000)).toBe(true);
    expect(checkSliceAge(tenMinAgo, 15 * 60 * 1000)).toBe(false);
  });
});
