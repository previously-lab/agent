import { describe, expect, it } from "vitest";
import type { DialogueEvent, DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import { emptyDialogueProjection, mergeDialogueProjections, projectAcceptedInput, projectDialoguePage } from "../dialogue-projection";
import { dialogueStreamRows } from "../dialogue-stream-rows";

const at = "2026-11-06T09:00:00.000Z";
const input = (inputId: string, eventSeq: number, text: string): DialogueInput => ({
  inputId, clientMessageId: `client-${inputId}`, eventSeq, userSeq: eventSeq, text, acceptedAt: at,
});
const publication = (utteranceId: string, publicSeq: number, inputId: string): PublicUtterance => ({
  utteranceId, publicSeq, inputIds: [inputId], committedAt: at, sourceResults: [], blocks: [{ kind: "markdown", blockId: "prose", text: utteranceId }],
});
const accepted = (entry: DialogueInput): DialogueEvent => ({ type: "input.accepted", eventSeq: entry.eventSeq, input: entry });
const published = (eventSeq: number, utterance: PublicUtterance): DialogueEvent => ({ type: "manuscript.append", eventSeq, utterance });
const page = (events: DialogueEvent[], cursor = events.at(-1)?.eventSeq ?? 0) => ({ version: 1 as const, events, cursor });

describe("the public manuscript's immutable prefix", () => {
  it("keeps reverse completions in publication order and labels the older question without moving its row", () => {
    const apple = input("apple", 1, "苹果"), audio = input("audio", 2, "音响");
    const first = projectDialoguePage(emptyDialogueProjection(), page([accepted(apple), accepted(audio), published(3, publication("sound", 1, "audio"))]));
    const second = projectDialoguePage(first, page([published(4, publication("fruit", 2, "apple"))]));
    expect(second.entries.map(entry => entry.id)).toEqual(["apple", "audio", "sound", "fruit"]);
    expect(second.entries[2]).toBe(first.entries[2]);
    const rows = dialogueStreamRows(second.entries, second.inputs);
    expect(rows.utterances.get("dialogue-utterance:fruit")?.inReplyTo).toBe("苹果");
    expect(rows.utterances.get("dialogue-utterance:sound")?.inReplyTo).toBeUndefined();
  });

  it("waits for a missing prefix before showing an accepted input; replay never duplicates visible work", () => {
    const apple = input("apple", 1, "苹果"), audio = input("audio", 3, "音响");
    const start = projectAcceptedInput(emptyDialogueProjection(), apple);
    expect(projectAcceptedInput(start, audio)).toBe(start);
    expect(() => projectDialoguePage(start, page([accepted(audio)]))).toThrow("Missing dialogue events");
    const answer = published(2, publication("fruit", 1, "apple"));
    const replay = projectDialoguePage(start, page([accepted(apple), answer, accepted(audio)]));
    expect(replay.entries.map(entry => entry.id)).toEqual(["apple", "fruit", "audio"]);
    expect(projectDialoguePage(replay, page([answer, accepted(audio)]))).toBe(replay);
    const retried = projectDialoguePage(replay, page([published(4, publication("fruit", 1, "apple"))]));
    expect(retried.entries).toBe(replay.entries);
  });

  it("keeps work status and archival receipts out of the published rows", () => {
    const first = projectAcceptedInput(emptyDialogueProjection(), input("a", 1, "question"));
    const next = projectDialoguePage(first, page([
      { type: "work.status", eventSeq: 2, work: { workId: "work", inputId: "a", userSeq: 1, status: "failed" } },
      { type: "projection.receipt", eventSeq: 3, inputIds: ["a"], utteranceIds: [], sliceId: "slice" },
    ]));
    expect(next.entries).toBe(first.entries);
    expect(next.receiptCount).toBe(1);
    expect(next.works.get("work")?.status).toBe("failed");
  });
  it("dedupes optional history against live inputs and public child IDs", () => {
    const historicalInput = input("input-1", 1, "Question");
    const historicalReply = publication("publication-1", 1, "input-1");
    const history = projectDialoguePage(emptyDialogueProjection(), page([
      accepted(historicalInput), published(2, historicalReply), published(3, publication("older-public", 2, "input-1")),
    ], 3));
    const live = {
      ...emptyDialogueProjection(),
      entries: [
        { kind: "input" as const, id: "input-1", input: { ...historicalInput, eventSeq: 0 } },
        { kind: "message" as const, id: "publication-1", timeIso: at, isStreaming: false,
          message: { id: "publication-1", role: "assistant" as const, parts: [{ type: "text" as const, text: "Live answer" }] } },
      ],
      inputs: new Map([["input-1", { ...historicalInput, eventSeq: 0 }]]),
      utterances: new Set(["publication-1"]),
    };
    const merged = mergeDialogueProjections(history, live);
    expect(merged.entries.map(entry => entry.id)).toEqual(["older-public", "input-1", "publication-1"]);
    expect(merged.entries.filter(entry => entry.id === "input-1")).toHaveLength(1);
    expect(merged.entries.filter(entry => entry.id === "publication-1")).toHaveLength(1);
    expect(dialogueStreamRows(merged.entries, merged.inputs).items.at(-1)?.isStreaming).toBe(false);
  });
});
