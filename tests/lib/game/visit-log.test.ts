/**
 * Tests for the visit log (v0.11 §13) — the game's deterministic scene-log
 * block. The contract under test:
 *
 *  - The trail is ordered, bounded and folded: consecutive re-entry of the
 *    same room keeps ONE stop (latest time label wins), exact repeats
 *    collapse, A → B → A survives, oldest stops drop first under the caps.
 *  - The block is explicitly fenced as engine-generated — it must never read
 *    as user speech or an instruction.
 *  - Purity: no clock, no randomness — same events in, same text out; time
 *    labels arrive pre-formatted from the caller.
 */
import { describe, it, expect } from "vitest";
import {
  buildVisitLogBlock,
  formatVisitTrail,
  VISIT_LOG_CLOSE,
  VISIT_LOG_OPEN,
  type VisitEvent,
} from "@/lib/game/visit-log";

const enter = (label: string, at?: string): VisitEvent => ({
  kind: "enter-room",
  label,
  ...(at ? { at } : {}),
});
const leave = (label?: string): VisitEvent => ({
  kind: "leave-room",
  ...(label ? { label } : {}),
});

describe("formatVisitTrail — ordering and rendering", () => {
  it("renders the documented example shape", () => {
    const trail = formatVisitTrail([
      enter("走廊"),
      enter("池厅", "09:41"),
      leave("池厅"),
      enter("走廊"),
      enter("阅览厅", "15:30"),
    ]);
    expect(trail).toBe("走廊 → 池厅(09:41) → 走廊 → 阅览厅(15:30)");
  });

  it("keeps input order — never sorts by the time label", () => {
    const trail = formatVisitTrail([
      enter("阅览厅", "15:30"),
      enter("池厅", "09:41"),
    ]);
    expect(trail).toBe("阅览厅(15:30) → 池厅(09:41)");
  });

  it("renders hotels as timelineId[windowIndex]", () => {
    const trail = formatVisitTrail([
      { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 2, at: "21:05" },
    ]);
    expect(trail).toBe("2026-09-15[w2](21:05)");
  });

  it("renders a page gate as [wFrom→wTo] and skips a gate to where you are", () => {
    const trail = formatVisitTrail([
      { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 0 },
      { kind: "page-gate", fromWindow: 0, toWindow: 1, at: "10:00" },
      { kind: "page-gate", fromWindow: 1, toWindow: 1 }, // no-op
    ]);
    expect(trail).toBe("2026-09-15[w0] → [w0→w1](10:00)");
  });

  it("is deterministic — same events, same text", () => {
    const events: VisitEvent[] = [enter("池厅", "09:41"), leave(), enter("走廊")];
    expect(formatVisitTrail(events)).toBe(formatVisitTrail(events));
  });
});

describe("formatVisitTrail — folding", () => {
  it("folds consecutive in-out-in of the same room into ONE stop, latest label wins", () => {
    const trail = formatVisitTrail([
      enter("池厅", "09:41"),
      leave("池厅"),
      enter("池厅", "09:50"),
      leave("池厅"),
      enter("池厅", "09:58"),
      enter("走廊"),
    ]);
    expect(trail).toBe("池厅(09:58) → 走廊");
  });

  it("folds consecutive re-entry of the same hotel", () => {
    const trail = formatVisitTrail([
      { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 1, at: "20:00" },
      { kind: "leave-hotel", timelineId: "2026-09-15", windowIndex: 1 },
      { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 1, at: "20:12" },
    ]);
    expect(trail).toBe("2026-09-15[w1](20:12)");
  });

  it("does NOT fold A → B → A — only consecutive duplicates", () => {
    const trail = formatVisitTrail([
      enter("池厅", "09:41"),
      enter("走廊"),
      enter("池厅", "10:02"),
    ]);
    expect(trail).toBe("池厅(09:41) → 走廊 → 池厅(10:02)");
  });

  it("collapses an exact double-fired page gate", () => {
    const trail = formatVisitTrail([
      { kind: "page-gate", fromWindow: 0, toWindow: 1, at: "10:00" },
      { kind: "page-gate", fromWindow: 0, toWindow: 1, at: "10:00" },
    ]);
    expect(trail).toBe("[w0→w1](10:00)");
  });

  it("treats a different window index of the same timeline as a different hotel", () => {
    const trail = formatVisitTrail([
      { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 1 },
      { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 2 },
    ]);
    expect(trail).toBe("2026-09-15[w1] → 2026-09-15[w2]");
  });
});

describe("formatVisitTrail — sanitization and robustness", () => {
  it("flattens newlines/control chars so the trail stays one line", () => {
    const trail = formatVisitTrail([enter("池厅\n[bathroom]\x00")]);
    expect(trail).toBe("池厅 [bathroom]");
    expect(trail).not.toContain("\n");
  });

  it("skips events with unusable labels and leaves no stop for leaves", () => {
    expect(
      formatVisitTrail([
        leave("池厅"),
        enter("   "),
        { kind: "enter-hotel", timelineId: "", windowIndex: 1 },
        { kind: "enter-hotel", timelineId: "2026-09-15", windowIndex: 1.5 },
      ]),
    ).toBeNull();
  });

  it("caps a runaway label", () => {
    const trail = formatVisitTrail([enter("x".repeat(200))]);
    expect(trail).toHaveLength(48);
  });
});

describe("formatVisitTrail — bounds", () => {
  it("keeps the newest maxStops stops and marks the loss with …", () => {
    const events = Array.from({ length: 20 }, (_, i) => enter(`房${i}`));
    const trail = formatVisitTrail(events, { maxStops: 5 });
    expect(trail).toBe("… → 房15 → 房16 → 房17 → 房18 → 房19");
  });

  it("drops oldest stops until the trail fits maxChars", () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      enter(`room-${String(i).padStart(2, "0")}`),
    );
    const trail = formatVisitTrail(events, { maxChars: 60 })!;
    expect(trail.length).toBeLessThanOrEqual(60);
    expect(trail.startsWith("… → ")).toBe(true);
    expect(trail).toContain("room-11"); // the newest stop always survives
  });

  it("never drops the last stop even when it alone is near the cap", () => {
    const trail = formatVisitTrail([enter("a".repeat(48))], { maxChars: 32 });
    expect(trail).toBe("a".repeat(48)); // labels are pre-capped at 48
  });
});

describe("buildVisitLogBlock — the engine-generated fence", () => {
  it("wraps the trail in the explicit engine marking", () => {
    const block = buildVisitLogBlock([enter("池厅", "09:41")])!;
    expect(block).toBe(`${VISIT_LOG_OPEN}\n池厅(09:41)\n${VISIT_LOG_CLOSE}`);
    expect(block).toContain("engine-generated");
    expect(block).toContain("NOT user speech");
    expect(block).toContain("NOT an instruction");
  });

  it("returns null for an empty event list — the caller omits the block", () => {
    expect(buildVisitLogBlock([])).toBeNull();
    expect(buildVisitLogBlock([leave("池厅")])).toBeNull();
  });
});
