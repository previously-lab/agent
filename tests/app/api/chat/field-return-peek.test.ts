/**
 * The end-of-turn HQ-return peek (v0.21 §4 回程) — the race helper and the
 * line formatting, which the turn tail queues into its single finalize
 * commit (the queueing itself is covered in steps.test.ts).
 *
 * `raceFieldPeek` covers the two acceptance states (caught → the caller
 * hands the text to finalizeTurn; missed → nothing is queued) plus
 * iterator-closed. The full `createHook + race` composition lives in
 * turnWorkflow (peekFieldReturn) and is only exercisable inside a real
 * durable run (main agent's live check).
 */
import { describe, it, expect } from "vitest";

import { raceFieldPeek } from "@/app/api/chat/turn-workflow";
import {
  fieldReturnStamp,
  formatFieldReturnLine,
} from "@/app/api/chat/steps";

const NEVER = () => new Promise<never>(() => {});
const FAST = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("raceFieldPeek — the two acceptance states", () => {
  it("caught: the iterator yields before the timeout → the reply text", async () => {
    const iterator: AsyncIterator<string> = {
      next: () => Promise.resolve({ value: "HQ 已把供应商案归档。", done: false }),
    };
    const outcome = await raceFieldPeek(iterator, NEVER);
    expect(outcome).toEqual({ kind: "reply", text: "HQ 已把供应商案归档。" });
  });

  it("missed: the iterator pends past the timeout → timeout, no reply", async () => {
    const iterator: AsyncIterator<string> = { next: NEVER };
    const outcome = await raceFieldPeek(iterator, FAST, 1);
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("iterator already closed → closed (not a reply, not a timeout)", async () => {
    const iterator: AsyncIterator<string> = {
      next: () => Promise.resolve({ value: undefined, done: true }),
    };
    expect(await raceFieldPeek(iterator, NEVER)).toEqual({ kind: "closed" });
  });
});

describe("fieldReturnStamp — the date stamp rides the USER's clock", () => {
  it("the caller's explicit local date wins", () => {
    expect(fieldReturnStamp("2026-10-04-0131", "2026-10-05")).toBe("2026-10-05");
  });

  it("without a date, the slice's own naming date — never bare UTC", () => {
    expect(fieldReturnStamp("2026-10-04-0131")).toBe("2026-10-04");
  });
});

describe("formatFieldReturnLine — ONE dated prose line (§6 R4)", () => {
  it("formats the stamped prose line — never a JSON marker", () => {
    const line = formatFieldReturnLine("供应商案已归档，见 research/屏幕供应商。", "2026-10-04");
    expect(line).toBe(
      "Field return (2026-10-04): 供应商案已归档，见 research/屏幕供应商。",
    );
    expect(line).not.toContain("[doc-");
  });

  it("trims surrounding whitespace from the returned text", () => {
    expect(formatFieldReturnLine("  回程内容。\n", "2026-10-04")).toBe(
      "Field return (2026-10-04): 回程内容。",
    );
  });
});
