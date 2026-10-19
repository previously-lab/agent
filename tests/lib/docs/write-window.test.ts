import { describe, it, expect } from "vitest";
import {
  DOC_WRITE_WINDOW_MINUTES,
  DOC_WRITE_WINDOW_MS,
  DOC_WRITE_WINDOW_RULE,
  MEMORY_IS_GIT_RULE,
  isWithinWriteWindow,
  WriteRefusal,
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


describe("WriteRefusal — the unified write-surface refusal (v0.37 §3)", () => {
  it("enumerates the seven codes; the message carries the recovery path by contract", () => {
    const codes = [
      "rewrite_conflict",
      "rewrite_window_closed",
      "already_exists",
      "invalid_category",
      "falsification_missing",
      "not_found_on_update",
      "commit_failed",
    ] as const;
    for (const code of codes) {
      const refusal = new WriteRefusal(code, `recovery for ${code}`);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal.name).toBe("WriteRefusal");
      expect(refusal.code).toBe(code);
    }
  });

  it("CaseWriteRefusal stays backward compatible — a WriteRefusal subclass, name preserved", () => {
    const legacy = new CaseWriteRefusal("rewrite_conflict", "moved — re-read");
    expect(legacy).toBeInstanceOf(WriteRefusal);
    expect(legacy.name).toBe("CaseWriteRefusal");
    expect(legacy.code).toBe("rewrite_conflict");
  });
});

describe("MEMORY_IS_GIT_RULE — the single-source contract sentence (v0.37 §2.3)", () => {
  it("states the world's shape in one English sentence, no backticks (prompt-facing)", () => {
    expect(MEMORY_IS_GIT_RULE).toContain("Memory is a git tree, not a database");
    expect(MEMORY_IS_GIT_RULE).toContain("every write is a commit");
    expect(MEMORY_IS_GIT_RULE).toContain("re-read fresh and decide again");
    expect(MEMORY_IS_GIT_RULE).not.toContain("`");
  });
});
