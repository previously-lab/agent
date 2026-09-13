import { describe, expect, it } from "vitest";
import { boundaryBetween } from "@/lib/timeline3d/boundary";

describe("boundaryBetween", () => {
  it("states the interval between two adjacent slices", () => {
    expect(
      boundaryBetween(
        { start: "2026-08-11T10:00:00.000Z", end: "2026-08-11T10:24:00.000Z" },
        { start: "2026-08-11T14:00:00.000Z" },
      ),
    ).toEqual({
      atIso: "2026-08-11T14:00:00.000Z",
      fromIso: "2026-08-11T10:24:00.000Z",
    });
  });

  it("falls back to the older side's start when it never closed", () => {
    // A live slice has no `end`; the catalog cannot give a last-activity time
    // for it, so the interval is measured from where it began.
    const b = boundaryBetween(
      { start: "2026-08-11T10:00:00.000Z" },
      { start: "2026-08-11T14:00:00.000Z" },
    );
    expect(b?.fromIso).toBe("2026-08-11T10:00:00.000Z");
  });

  it("carries the two focuses so the gate can name both sides", () => {
    const b = boundaryBetween(
      { start: "a", end: "a2", focus: "shipping the parser" },
      { start: "b", focus: "the wedding speech" },
    );
    expect(b?.prevFocus).toBe("shipping the parser");
    expect(b?.focus).toBe("the wedding speech");
  });

  it("omits a focus it does not have rather than emitting an empty string", () => {
    // The gate's `usableFocus` filters blanks anyway, but an absent key is the
    // honest representation and keeps a caller's truthiness checks correct.
    const b = boundaryBetween({ start: "a" }, { start: "b" });
    expect(b).not.toBeNull();
    expect("focus" in (b as object)).toBe(false);
    expect("prevFocus" in (b as object)).toBe(false);
  });

  it("is null when either side is missing", () => {
    expect(boundaryBetween(undefined, { start: "b" })).toBeNull();
    expect(boundaryBetween({ start: "a" }, undefined)).toBeNull();
    expect(boundaryBetween({ start: "" }, { start: "b" })).toBeNull();
  });

  it("is null for two sides at the same instant", () => {
    // A boundary you cannot measure is not one, and the gate would otherwise
    // announce "moments apart" against itself.
    expect(boundaryBetween({ start: "a" }, { start: "a" })).toBeNull();
  });
});
