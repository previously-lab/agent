import { describe, it, expect } from "vitest";
import { checkIdleGap, checkSliceAge } from "@/lib/episodic/slicer";

const MIN = 60_000;

describe("checkIdleGap", () => {
  it("fires when the last turn is older than the gap", () => {
    const old = new Date(Date.now() - 30 * MIN - MIN).toISOString();
    expect(checkIdleGap(old, 30 * MIN)).toBe(true);
  });

  it("does not fire within the gap", () => {
    const recent = new Date(Date.now() - 5 * MIN).toISOString();
    expect(checkIdleGap(recent, 30 * MIN)).toBe(false);
  });

  it("honors an explicit threshold", () => {
    const tenMinAgo = new Date(Date.now() - 10 * MIN).toISOString();
    expect(checkIdleGap(tenMinAgo, 5 * MIN)).toBe(true);
    expect(checkIdleGap(tenMinAgo, 30 * MIN)).toBe(false);
  });

  it("never fires on an unparseable timestamp or threshold", () => {
    expect(checkIdleGap("not-a-date", 30 * MIN)).toBe(false);
    const old = new Date(Date.now() - 300 * MIN).toISOString();
    expect(checkIdleGap(old, Number.NaN)).toBe(false);
  });
});

describe("checkSliceAge", () => {
  it("fires when the slice is older than the cap, not before", () => {
    const young = new Date(Date.now() - 29 * MIN).toISOString();
    const old = new Date(Date.now() - 31 * MIN).toISOString();
    expect(checkSliceAge(young, 30 * MIN)).toBe(false);
    expect(checkSliceAge(old, 30 * MIN)).toBe(true);
  });

  it("never fires on an unparseable start", () => {
    expect(checkSliceAge("not-a-date", 30 * MIN)).toBe(false);
  });
});
