import { describe, expect, it } from "vitest";
import type { UIMessage } from "@/lib/chat/protocol";
import {
  appendDialogueTurn,
  applyDialoguePublicMessage,
  dialogueStreamRows,
  patchDialogueAssistant,
} from "../dialogue-stream-rows";

const at = "2026-11-07T00:00:00.000Z";
const user = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: `Question ${id}` }] });
const publicReply = (id: string, text: string): UIMessage => ({
  id: `publication-${id}`,
  role: "assistant",
  parts: [{ type: "text", text, state: "done" }],
});

function conversation() {
  let messages = appendDialogueTurn([], user("A"), "assistant-A", at);
  messages = appendDialogueTurn(messages, user("B"), "assistant-B", "2026-11-07T00:00:01.000Z");
  messages = patchDialogueAssistant(messages, "assistant-A", {
    workId: "work-A", sourceInputId: "input-A", thoughtRunId: "thought-A", workStatus: "running",
  });
  messages = patchDialogueAssistant(messages, "assistant-B", {
    workId: "work-B", sourceInputId: "input-B", thoughtRunId: "thought-B", workStatus: "running",
  });
  return messages;
}

describe("UIMessage dialogue seats", () => {
  it("shows each empty fixed assistant immediately after its own user", () => {
    const view = dialogueStreamRows(conversation());
    expect(view.items.map(item => item.key)).toEqual([
      "dialogue-input:A", "dialogue-work:assistant-A",
      "dialogue-input:B", "dialogue-work:assistant-B",
    ]);
    expect(view.workSeats.get("dialogue-work:assistant-A")?.replies).toBeUndefined();
    expect(view.workSeats.get("dialogue-work:assistant-B")?.replies).toBeUndefined();
    expect(view.workSeats.get("dialogue-work:assistant-B")?.work).toMatchObject({
      workId: "work-B", inputId: "input-B", runId: "thought-B", status: "running",
    });
  });

  it("reuses an existing user when recovery only needs the missing assistant", () => {
    const existing = [{ ...user("A"), metadata: { sourceInputId: "input-A" } }];
    const restored = appendDialogueTurn(existing, {
      ...user("A"), metadata: { sourceInputId: "input-A" },
    }, "assistant-recovered", at);
    expect(restored.map(message => message.id)).toEqual(["A", "assistant-recovered"]);
  });

  it("updates A and B in place when their public runs finish in reverse order", () => {
    const before = dialogueStreamRows(conversation());
    let messages = applyDialoguePublicMessage(conversation(), "assistant-B", publicReply("B", "Answer B"), {
      dialogueRunId: "dialogue-B", workStatus: "completed",
    });
    messages = applyDialoguePublicMessage(messages, "assistant-A", publicReply("A", "Answer A"), {
      dialogueRunId: "dialogue-A", workStatus: "completed",
    });
    const after = dialogueStreamRows(messages);
    expect(after.items.map(item => item.key)).toEqual(before.items.map(item => item.key));
    expect(messages.map(message => message.id)).toEqual(["A", "assistant-A", "B", "assistant-B"]);
    expect(after.workSeats.get("dialogue-work:assistant-A")?.replies?.[0]).toMatchObject({
      kind: "message", message: { id: "assistant-A", parts: [expect.objectContaining({ text: "Answer A" })] },
    });
    expect(after.workSeats.get("dialogue-work:assistant-B")?.replies?.[0]).toMatchObject({
      kind: "message", message: { id: "assistant-B", parts: [expect.objectContaining({ text: "Answer B" })] },
    });
    expect(dialogueMetadataFor(messages, "assistant-A")).toMatchObject({
      thoughtRunId: "thought-A", dialogueRunId: "dialogue-A", publicationId: "publication-A",
    });
  });

  it("keeps private reasoning in its own part and takes text only from the public message", () => {
    const original: UIMessage[] = [{
      id: "assistant-A", role: "assistant", parts: [{ type: "reasoning", text: "Private chain" }],
      metadata: { thoughtRunId: "thought-A", workStatus: "running" },
    }];
    const messages = applyDialoguePublicMessage(original, "assistant-A", {
      id: "publication-A", role: "assistant", parts: [{ type: "text", text: "Public answer" }],
      metadata: { publicationId: "publication-A" },
    });
    expect(messages[0]).toMatchObject({
      id: "assistant-A",
      metadata: { thoughtRunId: "thought-A", publicationId: "publication-A" },
      parts: [{ type: "reasoning", text: "Private chain" }, { type: "text", text: "Public answer" }],
    });
  });
});

function dialogueMetadataFor(messages: UIMessage[], id: string) {
  const message = messages.find(candidate => candidate.id === id);
  return message?.metadata as Record<string, unknown>;
}
