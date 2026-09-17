/**
 * Tests for the slice-id clock rule (B.14 rule 1), now single-sourced in
 * lib/game/slice-clock.ts. The contract under test:
 *
 *  - The two derivations the UI relies on — the corridor's door plate /
 *    date plaque (`sliceClock`) and the game-shell's strand-door NUMBER
 *    (`sliceClockTime`) — yield the SAME 4-digit clock for the same slice
 *    id. They used to be two mirrored regexes kept in sync by a comment;
 *    this test is the permanent guard that the number can never drift
 *    between the corridor and the rooms.
 *  - The date half keeps its "MM·DD" plaque format, and non-slice ids
 *    (fixtures, tests) get no signage anywhere.
 */
import { describe, it, expect } from "vitest";
import { SLICE_ID_RE, sliceClock, sliceClockTime } from "@/lib/game/slice-clock";

describe("slice-clock (B.14 rule 1, single source)", () => {
  it("yields the same door number via both derivations for the same id", () => {
    const ids = [
      "2026-09-15-0746",
      "2026-01-01-0000",
      "2026-12-31-2359",
      "2036-02-29-1230",
    ];
    for (const id of ids) {
      const clock = sliceClock(id);
      expect(clock).not.toBeNull();
      // The corridor's plate time and the shell's strand-door number agree.
      expect(sliceClockTime(id)).toBe(clock!.time);
      // The number is the id's own 4-digit suffix, nothing locale-derived.
      expect(clock!.time).toBe(id.slice(-4));
    }
  });

  it("parses the documented example: 2026-09-15-0746 → Sep 15, 07:46", () => {
    expect(sliceClock("2026-09-15-0746")).toEqual({
      date: "09·15",
      time: "0746",
    });
    expect(sliceClockTime("2026-09-15-0746")).toBe("0746");
  });

  it("keeps the anchored pattern — lookalikes get no signage", () => {
    for (const id of [
      "",
      "2026-09-15", // no clock
      "2026-09-15-074", // short clock
      "2026-09-15-07460", // long clock
      "2026-9-15-0746", // unpadded month
      "x2026-09-15-0746", // prefix
      "2026-09-15-0746-extra", // suffix
    ]) {
      expect(SLICE_ID_RE.test(id)).toBe(false);
      expect(sliceClock(id)).toBeNull();
      expect(sliceClockTime(id)).toBeNull();
    }
  });
});
