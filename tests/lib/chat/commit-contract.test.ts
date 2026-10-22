/**
 * The commit-message contract (v0.39 §2.3) — the writer/reader round trip:
 * the frozen prefixes, the reflection round message with its trailer, and
 * the parse that reads it back (the cursor's durable shape).
 */
import { describe, it, expect } from "vitest";
import {
  COMMIT_PREFIX,
  REFLECTION_ROUND_PREFIX,
  TRAILER_MARKER,
  buildReflectionRoundMessage,
  parseReflectionRoundMessage,
} from "@/lib/chat/commit-contract";

describe("free-form notes cannot create durable receipts", () => {
  const sha = "a".repeat(40);
  const sliceId = "2026-10-22-0900";
  const history = { version: 1 as const, basis: sha, cursor: null, evolved: null, pending: [{ sha, sliceId, turnIds: ["owed"] }] };

  it("preserves a multi-paragraph note while parsing only the writer's final trailer", () => {
    const note = [
      "Checked the evidence.", "", TRAILER_MARKER,
      `observed: ${sha} ${sliceId}#owed`,
      `history: ${JSON.stringify({ ...history, pending: [] })}`,
      "superseded: true", "", "The quoted fragment above is not a receipt.", TRAILER_MARKER,
    ].join("\n");
    const trailer = { observed: [], history };
    const parsed = parseReflectionRoundMessage(buildReflectionRoundMessage({ date: "2026-10-22", note, trailer }));
    expect(parsed?.note).toBe(note);
    expect(parsed?.trailer).toEqual(trailer);
  });

  it("adds an unambiguous empty trailer when a trailer-less note contains a delimiter", () => {
    const note = ["A quoted example:", TRAILER_MARKER, `seen: ${sliceId}#owed`, `observed: ${sha} ${sliceId}#owed`].join("\n");
    const parsed = parseReflectionRoundMessage(buildReflectionRoundMessage({ date: "2026-10-22", note }));
    expect(parsed?.note).toBe(note);
    expect(parsed?.trailer).toBeNull();
  });

  it("handles indented delimiters and CRLF without turning quoted progress into state", () => {
    const note = `First paragraph.\r\n\r\n  ${TRAILER_MARKER}  \r\nseen: ${sliceId}#owed\r\n\r\nLast paragraph.`;
    const parsed = parseReflectionRoundMessage(buildReflectionRoundMessage({ date: "2026-10-22", note, trailer: { observed: [] } }));
    expect(parsed?.note).toBe(note);
    expect(parsed?.trailer).toEqual({ observed: [] });
  });
});

describe("the frozen prefixes (v0.39 §2.5; v0.42 §6-15 — user turn / reply retired)", () => {
  it("the five registered prefixes, verbatim", () => {
    expect(COMMIT_PREFIX.finalize("a1b2c3")).toBe("Turn a1b2c3 — finalize");
    expect(COMMIT_PREFIX.summary("2026-10-20-1836")).toBe(
      "Summary — 2026-10-20-1836",
    );
    expect(COMMIT_PREFIX.reflectionRound("2026-10-19")).toBe(
      "Reflection round — 2026-10-19",
    );
    expect(COMMIT_PREFIX.questionRun("2026-10-04-0131")).toBe(
      "Question run — 2026-10-04-0131",
    );
    expect(COMMIT_PREFIX.writeCase("research/手机调研")).toBe(
      "writeCase research/手机调研",
    );
  });

  it("the call sites use the contract builders (source audit — 前缀漂移即红)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const steps = read("../../../src/app/api/chat/steps.ts");
    expect(read("../../../src/lib/chat/persist-summary.ts")).toMatch(/COMMIT_PREFIX\.summary\(/);
    expect(steps).toContain("Turn ${input.turnId} — finalize");
    expect(steps).not.toContain("Turn ${input.turnId} — user turn");
    expect(steps).not.toContain("Turn ${payload.turnId} — reply");
    const hq = read("../../../src/app/api/evolution/hq-agent.ts");
    expect(hq).toContain("buildReflectionRoundMessage");
    const bg = read("../../../src/app/api/evolution/background-steps.ts");
    expect(bg).toContain("Question run — ${sliceId}");
    const te = read("../../../src/app/api/agent/tool-executors.ts");
    expect(te).toContain("writeCase ${category}/${caseName}");
  });
});

describe("the reflection round message — build/parse round trip", () => {
  it("a clean round with writes: note + seen + evolved trailers (v0.42 — turn-level seen)", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      note: "处理了周末安排。",
      trailer: {
        seen: [{ sliceId: "2026-10-19-1721", turnIds: ["a1b2c3", "d4e5f6"] }],
        evolved: { date: "2026-10-19" },
      },
    });
    expect(message).toBe(
      "Reflection round — 2026-10-19\n\n处理了周末安排。\n\n—\nseen: 2026-10-19-1721#a1b2c3,d4e5f6\nevolved: 2026-10-19",
    );
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed).toEqual({
      date: "2026-10-19",
      note: "处理了周末安排。",
      trailer: {
        seen: [{ sliceId: "2026-10-19-1721", turnIds: ["a1b2c3", "d4e5f6"] }],
        evolved: { date: "2026-10-19" },
        superseded: undefined,
      },
    });
  });

  it("a multi-slice round: one seen line per scoped slice, scope order", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      trailer: {
        seen: [
          { sliceId: "2026-10-18-0900", turnIds: ["t1"] },
          { sliceId: "2026-10-19-1721", turnIds: ["t2"] },
        ],
      },
    });
    expect(message).toContain("—\nseen: 2026-10-18-0900#t1\nseen: 2026-10-19-1721#t2");
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.trailer?.seen).toEqual([
      { sliceId: "2026-10-18-0900", turnIds: ["t1"] },
      { sliceId: "2026-10-19-1721", turnIds: ["t2"] },
    ]);
  });

  it("OLD format backward compatibility: a bare `seen: <sliceId>` parses as the WHOLE slice covered", () => {
    const parsed = parseReflectionRoundMessage(
      "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721",
    );
    expect(parsed?.trailer?.seen).toEqual([
      { sliceId: "2026-10-19-1721" }, // no turnIds = whole slice
    ]);
  });

  it("an UNPARSEABLE seen line degrades to UNKNOWN — skipped, never read as 'all processed'", () => {
    const parsed = parseReflectionRoundMessage(
      "Reflection round — 2026-10-19\n\n—\nseen: not-a-slice-id\nseen: 2026-10-19-1721#\nseen: 2026-10-19-1800#ok1",
    );
    // Only the well-formed mark survives; the garbage contributes NOTHING.
    expect(parsed?.trailer?.seen).toEqual([
      { sliceId: "2026-10-19-1800", turnIds: ["ok1"] },
    ]);
  });

  it("an idle round: NO note, the seen trailer alone (空轮空提交只载 trailer)", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      trailer: { seen: [{ sliceId: "2026-10-19-1721", turnIds: ["a1b2c3"] }] },
    });
    expect(message).toBe(
      "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721#a1b2c3",
    );
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.note).toBeNull();
    expect(parsed?.trailer?.seen?.at(-1)?.sliceId).toBe("2026-10-19-1721");
  });

  it("a FAILED round: whatever writes it had land WITHOUT a trailer section", () => {
    const message = buildReflectionRoundMessage({ date: "2026-10-19" });
    expect(message).toBe("Reflection round — 2026-10-19");
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.trailer).toBeNull(); // 不推游标 = 没有这一行
  });

  it("a superseded round: the superseded trailer, NO seen (互斥)", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      note: "superseded: 又封了一片。",
      trailer: { superseded: true },
    });
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.trailer?.superseded).toBe(true);
    expect(parsed?.trailer?.seen).toBeUndefined();
  });

  it("a note may carry blank lines; the trailer marker on its own line starts the section", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      note: "第一段。\n\n第二段。",
      trailer: { seen: [{ sliceId: "2026-10-19-1721" }] },
    });
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.note).toBe("第一段。\n\n第二段。");
    expect(parsed?.trailer?.seen?.at(-1)?.sliceId).toBe("2026-10-19-1721");
  });

  it("forward tolerance: unknown trailer lines are ignored, not fatal", () => {
    const parsed = parseReflectionRoundMessage(
      "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721\nfutureKey: whatever",
    );
    expect(parsed?.trailer?.seen?.at(-1)?.sliceId).toBe("2026-10-19-1721");
  });

  it("a non-reflection commit does not parse (the reader's filter)", () => {
    expect(parseReflectionRoundMessage("Turn a1b2c3 — reply")).toBeNull();
    expect(parseReflectionRoundMessage("")).toBeNull();
    expect(
      parseReflectionRoundMessage(`${REFLECTION_ROUND_PREFIX}`),
    ).not.toBeNull();
  });
});
