import { describe, it, expect } from "vitest";
import {
  DOC_WRITE_WINDOW_MINUTES,
  DOC_WRITE_WINDOW_MS,
  DOC_WRITE_WINDOW_RULE,
  isWithinWriteWindow,
  CaseWriteRefusal,
} from "@/lib/docs";
import { DEFAULTS } from "@/lib/config/defaults";

describe("the write-window constant — defined once, on the slice side", () => {
  it("IS the slice idle gap's shipped default (one definition, two consumers)", () => {
    expect(DOC_WRITE_WINDOW_MINUTES).toBe(DEFAULTS.slicing.idleGapMinutes);
    expect(DOC_WRITE_WINDOW_MINUTES).toBe(30);
    expect(DOC_WRITE_WINDOW_MS).toBe(30 * 60_000);
  });

  it("the shared discipline sentence names the same window", () => {
    expect(DOC_WRITE_WINDOW_RULE).toContain(`${DOC_WRITE_WINDOW_MINUTES} minutes`);
    // Prompt-facing: English, no backticks (it interpolates into prompts).
    expect(DOC_WRITE_WINDOW_RULE).not.toContain("`");
  });
});

describe("isWithinWriteWindow", () => {
  const NOW = new Date("2026-09-05T13:00:00.000Z").getTime();

  it("inside the window → true; exactly at the edge → true (≤ window)", () => {
    expect(isWithinWriteWindow("2026-09-05T12:59:00.000Z", NOW)).toBe(true);
    expect(isWithinWriteWindow("2026-09-05T12:30:00.000Z", NOW)).toBe(true);
  });

  it("past the window → false", () => {
    expect(isWithinWriteWindow("2026-09-05T12:29:59.000Z", NOW)).toBe(false);
    expect(isWithinWriteWindow("2026-09-05", NOW)).toBe(false); // date-only = midnight
    expect(isWithinWriteWindow("2026-08-01T00:00:00.000Z", NOW)).toBe(false);
  });

  it("an unparseable/empty stamp reads as OUT of window (conservative)", () => {
    expect(isWithinWriteWindow("", NOW)).toBe(false);
    expect(isWithinWriteWindow("not-a-date", NOW)).toBe(false);
  });
});

describe("CaseWriteRefusal — the structured refusal", () => {
  it("carries a machine-readable code next to the model-facing message", () => {
    const refusal = new CaseWriteRefusal("rewrite_window_closed", "settled — append instead");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe("CaseWriteRefusal");
    expect(refusal.code).toBe("rewrite_window_closed");
    expect(refusal.message).toContain("append");
    const conflict = new CaseWriteRefusal("rewrite_conflict", "moved — re-read");
    expect(conflict.code).toBe("rewrite_conflict");
  });
});
