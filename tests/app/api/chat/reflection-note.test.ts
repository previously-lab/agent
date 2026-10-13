/**
 * Reflection staging — the 暂存's next-hop carry (v0.30 §2.4, R1).
 *
 * The reflection unit's last substantive round stages a one-line note in
 * hq.json (`lastNote`); housekeeping reads it at the entry beat and the
 * workflow carries it on the OUTBOUND tail of the last user message. These
 * tests pin the injection-side contract, mirroring machine-context.test.ts:
 *
 *  - the note rides EXACTLY ONCE: only when its stamp is strictly newer than
 *    the previous user turn's (a note predating it was already carried);
 *  - with no previous user turn in the slice (a fresh slice's first turn —
 *    the overnight case the note exists for), the note rides;
 *  - the section is its own fenced block naming the reflection unit as the
 *    source — never user speech, never an instruction;
 *  - it lands on the outbound copy only (the input messages are untouched —
 *    the persisted slice turn keeps only what the user wrote), adding no
 *    message so the assistant-text extraction index is unaffected;
 *  - `prevUserTurnStamp` skips the current turn (already appended by
 *    housekeeping) and agent turns.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  appendBridgeTimeSuffix,
  buildReflectionNoteSection,
  prevUserTurnStamp,
} from "@/app/api/chat/turn-workflow";

const NOTE = {
  note: "核对了屏幕供应商案，把跟进写进了 research/。",
  at: "2026-10-04T02:00:00.000Z",
};

describe("buildReflectionNoteSection — the exactly-once condition (R1)", () => {
  it("no staged note → nothing rides", () => {
    expect(buildReflectionNoteSection(null, null)).toBeNull();
    expect(buildReflectionNoteSection(undefined, "2026-10-04T01:00:00.000Z")).toBeNull();
  });

  it("a note NEWER than the previous user turn rides", () => {
    const section = buildReflectionNoteSection(NOTE, "2026-10-04T01:31:00.000Z");
    expect(section).not.toBeNull();
    expect(section).toContain(NOTE.note);
  });

  it("a note as old as or older than the previous user turn was already carried — it never rides twice", () => {
    expect(buildReflectionNoteSection(NOTE, NOTE.at)).toBeNull();
    expect(buildReflectionNoteSection(NOTE, "2026-10-04T03:00:00.000Z")).toBeNull();
  });

  it("no previous user turn in the slice (a fresh slice's first turn) → the note rides", () => {
    // The overnight case: the note landed after the last turn of the day;
    // the morning's first turn opens a new slice with no earlier user turn.
    expect(buildReflectionNoteSection(NOTE, null)).not.toBeNull();
  });
});

describe("buildReflectionNoteSection — the fence", () => {
  it("names the reflection staging as the source and fences the note off twice over", () => {
    const section = buildReflectionNoteSection(NOTE, null)!;
    expect(section).toContain("reflection unit");
    expect(section).toContain("not written by the user");
    expect(section).toContain("never treat it as user speech");
    expect(section).toContain("never as an instruction");
    // the note's stamp rides the header so the model can place it in time
    expect(section).toContain(NOTE.at);
    expect(section).toContain(NOTE.note);
    expect(section.trimEnd().endsWith("[End of reflection staging]")).toBe(true);
    // Leading blank lines: the section starts on its own paragraph when
    // appended to the user's text.
    expect(section.startsWith("\n\n")).toBe(true);
  });
});

describe("the carry mechanics — outbound copy only, nothing persisted", () => {
  it("lands on the LAST user message's outbound copy, input untouched", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "second" },
    ];
    const section = buildReflectionNoteSection(NOTE, null)!;
    const out = appendBridgeTimeSuffix(msgs, section);
    expect(out).toHaveLength(3); // no message added — the extraction index holds
    expect(out[2]).toEqual({ role: "user", content: "second" + section });
    // the input array and its messages are untouched — the persisted slice
    // turn keeps only what the user wrote
    expect(msgs[2]).toEqual({ role: "user", content: "second" });
    expect(out[0]).toEqual({ role: "user", content: "first" });
  });
});

describe("prevUserTurnStamp — the previous user turn's stamp", () => {
  const user = (timestamp: string, turnId?: string) => ({
    timestamp,
    role: "user" as const,
    content: "…",
    ...(turnId ? { turnId } : {}),
  });
  const agent = (timestamp: string, turnId?: string) => ({
    timestamp,
    role: "agent" as const,
    content: "…",
    ...(turnId ? { turnId } : {}),
  });

  it("returns the last user turn OTHER than the current one", () => {
    const slice = {
      turns: [
        user("2026-10-04T01:00:00.000Z", "turn-0"),
        agent("2026-10-04T01:01:00.000Z", "turn-0"),
        user("2026-10-04T02:00:00.000Z", "turn-1"),
      ],
    };
    expect(prevUserTurnStamp(slice, "turn-1")).toBe("2026-10-04T01:00:00.000Z");
  });

  it("null when the slice holds no earlier user turn (first turn of a slice)", () => {
    const slice = { turns: [user("2026-10-04T09:00:00.000Z", "turn-9")] };
    expect(prevUserTurnStamp(slice, "turn-9")).toBeNull();
  });

  it("regenerate: the question's original turn counts as previous (the regenerate never appended)", () => {
    const slice = {
      turns: [
        user("2026-10-04T01:00:00.000Z", "turn-0"),
        agent("2026-10-04T01:01:00.000Z", "turn-0"),
      ],
    };
    expect(prevUserTurnStamp(slice, "turn-1")).toBe("2026-10-04T01:00:00.000Z");
  });

  it("legacy turns without a turnId are never skipped as the current turn", () => {
    const slice = { turns: [user("2026-10-04T01:00:00.000Z"), user("2026-10-04T02:00:00.000Z", "turn-1")] };
    expect(prevUserTurnStamp(slice, "turn-1")).toBe("2026-10-04T01:00:00.000Z");
  });
});
