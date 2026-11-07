import { describe, expect, it } from "vitest";
import { dialogueStreamRows } from "../dialogue-stream-rows";
import type { DialogueWorkView, ManuscriptEntry } from "../dialogue-projection";

const makeInput = (id: string, n: number) => ({ inputId: id, clientMessageId: `client-${id}`, userSeq: n, eventSeq: n,
  text: id, acceptedAt: `2026-11-07T00:00:0${n}.000Z` });
const a = makeInput("A", 1), b = makeInput("B", 2);
const inputs = new Map([[a.inputId, a], [b.inputId, b]]);
const entries: ManuscriptEntry[] = [a, b].map(input => ({ kind: "input", id: input.inputId, input }));
const works: DialogueWorkView[] = [a, b].map(input => ({ workId: `work-${input.inputId}`, inputId: input.inputId, userSeq: input.userSeq, status: "running" }));
const streamed: ManuscriptEntry = { kind: "message", id: "reply-A", sourceInputId: "A", timeIso: "2026-11-07T00:00:03Z",
  isStreaming: true, message: { id: "reply-A", role: "assistant", parts: [{ type: "text", text: "First reply" }] } };

describe("per-prompt thinking seats", () => {
  it("keeps a separate persistent seat for two concurrent prompts before either produces a reply", () => {
    const view = dialogueStreamRows(entries, inputs, works);
    expect(view.items.map(item => item.key)).toEqual(["dialogue-input:A", "dialogue-work:work-A", "dialogue-input:B", "dialogue-work:work-B"]);
    expect(view.workSeats.get("dialogue-work:work-B")?.work.inputId).toBe("B");
  });
  it("fills A's seat even if B was submitted more recently, without adding a second copy", () => {
    const before = dialogueStreamRows(entries, inputs, works);
    const after = dialogueStreamRows([...entries, streamed], inputs, works);
    expect(after.items.map(item => item.key)).toEqual(before.items.map(item => item.key));
    expect(after.workSeats.get("dialogue-work:work-A")?.reply).toBe(streamed);
    expect(after.workSeats.get("dialogue-work:work-B")?.reply).toBeUndefined();
  });
  it("preserves the same seat when a provisional message becomes a committed publication", () => {
    const final: ManuscriptEntry = { kind: "utterance", id: "final-A", utterance: {
      utteranceId: "final-A", inputIds: ["A"], publicSeq: 1, committedAt: "2026-11-07T00:00:04Z", sourceResults: [],
      blocks: [{ kind: "markdown", blockId: "body", text: "First reply" }],
    } };
    const preview = dialogueStreamRows([...entries, streamed], inputs, works);
    const complete = dialogueStreamRows([...entries, final], inputs, works);
    expect(complete.items.map(item => item.key)).toEqual(preview.items.map(item => item.key));
    expect(complete.workSeats.get("dialogue-work:work-A")?.reply).toBe(final);
  });
});
