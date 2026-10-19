/**
 * The commit-message contract (v0.39 §2.3) — the writer/reader round trip:
 * the frozen prefixes, the reflection round message with its trailer, and
 * the parse that reads it back (the cursor's durable shape).
 */
import { describe, it, expect } from "vitest";
import {
  COMMIT_PREFIX,
  REFLECTION_ROUND_PREFIX,
  buildReflectionRoundMessage,
  parseReflectionRoundMessage,
} from "@/lib/chat/commit-contract";

describe("the frozen prefixes (v0.39 §2.5)", () => {
  it("the six registered prefixes, verbatim", () => {
    expect(COMMIT_PREFIX.userTurn("a1b2c3")).toBe("Turn a1b2c3 — user turn");
    expect(COMMIT_PREFIX.finalize("a1b2c3")).toBe("Turn a1b2c3 — finalize");
    expect(COMMIT_PREFIX.reply("a1b2c3")).toBe("Turn a1b2c3 — reply");
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

  it("the six call sites use the contract builders (source audit — 前缀漂移即红)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const steps = read("../../../src/app/api/chat/steps.ts");
    expect(steps).toContain("Turn ${input.turnId} — user turn");
    expect(steps).toContain("Turn ${input.turnId} — finalize");
    expect(steps).toContain("Turn ${payload.turnId} — reply");
    const hq = read("../../../src/app/api/evolution/hq-agent.ts");
    expect(hq).toContain("buildReflectionRoundMessage");
    const bg = read("../../../src/app/api/evolution/background-steps.ts");
    expect(bg).toContain("Question run — ${sliceId}");
    const te = read("../../../src/app/api/agent/tool-executors.ts");
    expect(te).toContain("writeCase ${category}/${caseName}");
  });
});

describe("the reflection round message — build/parse round trip", () => {
  it("a clean round with writes: note + seen + evolved trailers", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      note: "处理了周末安排。",
      trailer: {
        seen: { sliceId: "2026-10-19-1721" },
        evolved: { date: "2026-10-19" },
      },
    });
    expect(message).toBe(
      "Reflection round — 2026-10-19\n\n处理了周末安排。\n\n—\nseen: 2026-10-19-1721\nevolved: 2026-10-19",
    );
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed).toEqual({
      date: "2026-10-19",
      note: "处理了周末安排。",
      trailer: {
        seen: { sliceId: "2026-10-19-1721" },
        evolved: { date: "2026-10-19" },
        superseded: undefined,
      },
    });
  });

  it("an idle round: NO note, the seen trailer alone (空轮空提交只载 trailer)", () => {
    const message = buildReflectionRoundMessage({
      date: "2026-10-19",
      trailer: { seen: { sliceId: "2026-10-19-1721" } },
    });
    expect(message).toBe(
      "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721",
    );
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.note).toBeNull();
    expect(parsed?.trailer?.seen?.sliceId).toBe("2026-10-19-1721");
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
      trailer: { seen: { sliceId: "2026-10-19-1721" } },
    });
    const parsed = parseReflectionRoundMessage(message);
    expect(parsed?.note).toBe("第一段。\n\n第二段。");
    expect(parsed?.trailer?.seen?.sliceId).toBe("2026-10-19-1721");
  });

  it("forward tolerance: unknown trailer lines are ignored, not fatal", () => {
    const parsed = parseReflectionRoundMessage(
      "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721\nfutureKey: whatever",
    );
    expect(parsed?.trailer?.seen?.sliceId).toBe("2026-10-19-1721");
  });

  it("a non-reflection commit does not parse (the reader's filter)", () => {
    expect(parseReflectionRoundMessage("Turn a1b2c3 — reply")).toBeNull();
    expect(parseReflectionRoundMessage("")).toBeNull();
    expect(
      parseReflectionRoundMessage(`${REFLECTION_ROUND_PREFIX}`),
    ).not.toBeNull();
  });
});
