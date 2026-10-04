/**
 * Tests for the doc_rework classification (src/lib/episodic/rework-signal.ts)
 * — the pure per-conversation record: recordDocRead + checkDocRework.
 * No I/O is exercised here (logDocReworkSignal's double write is covered by
 * tests/app/api/agent/docs-tools.test.ts); each test uses a unique
 * conversation id because the record is module-level state.
 */
import { describe, it, expect } from "vitest";
import { recordDocRead, checkDocRework } from "@/lib/episodic/rework-signal";

describe("checkDocRework", () => {
  it("returns null when no document has been read in the conversation", () => {
    expect(checkDocRework("conv-none", "2026-08-20-1430")).toBeNull();
  });

  it("returns the document's file name when the read slice is one it references", () => {
    recordDocRead("conv-hit", "2026-09-05-手机购买调研.md", [
      "2026-09-04-2130",
      "2026-09-05-1030",
    ]);
    expect(checkDocRework("conv-hit", "2026-09-04-2130")).toBe(
      "2026-09-05-手机购买调研.md",
    );
  });

  it("returns null for a slice no read document references", () => {
    recordDocRead("conv-miss", "2026-09-05-手机购买调研.md", ["2026-09-04-2130"]);
    expect(checkDocRework("conv-miss", "2026-09-06-0900")).toBeNull();
  });

  it("checks every document read this conversation", () => {
    recordDocRead("conv-multi", "a.md", ["2026-09-01-1000"]);
    recordDocRead("conv-multi", "b.md", ["2026-09-02-1000"]);
    expect(checkDocRework("conv-multi", "2026-09-02-1000")).toBe("b.md");
    expect(checkDocRework("conv-multi", "2026-09-01-1000")).toBe("a.md");
  });

  it("never classifies the ongoing conversation slice", () => {
    // The conversation IS slice 2026-09-10-1000; reading it is never a
    // doc_rework signal even when a read document cites it.
    recordDocRead("2026-09-10-1000", "a.md", ["2026-09-10-1000"]);
    expect(checkDocRework("2026-09-10-1000", "2026-09-10-1000")).toBeNull();
  });

  it("a document read LATER does not retroactively classify an earlier read", () => {
    // checkDocRework is a pure read of the current record; the executor calls
    // it per read, so ordering is enforced by call order, not the record.
    recordDocRead("conv-order", "a.md", ["2026-09-01-1000"]);
    expect(checkDocRework("conv-order", "2026-09-01-1000")).toBe("a.md");
    expect(checkDocRework("conv-order", "2026-09-02-1000")).toBeNull();
  });
});
