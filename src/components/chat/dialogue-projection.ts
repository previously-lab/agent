import type { DialogueEvent, DialogueInput, DialoguePage, DialogueWork, PublicUtterance } from "@/lib/chat/dialogue-contract";

export type ManuscriptEntry =
  | { kind: "input"; id: string; input: DialogueInput }
  | { kind: "utterance"; id: string; utterance: PublicUtterance };

export interface DialogueProjection {
  cursor: number;
  entries: readonly ManuscriptEntry[];
  inputs: ReadonlyMap<string, DialogueInput>;
  utterances: ReadonlySet<string>;
  works: ReadonlyMap<string, DialogueWork>;
  receiptCount: number;
}

export function emptyDialogueProjection(): DialogueProjection {
  return { cursor: 0, entries: [], inputs: new Map(), utterances: new Set(), works: new Map(), receiptCount: 0 };
}

/** A page is a contiguous event prefix. Never insert into an already visible
 * part of the manuscript, even if an accepted POST races a catch-up read. */
export function projectDialoguePage(previous: DialogueProjection, page: Pick<DialoguePage, "version" | "events" | "cursor">): DialogueProjection {
  if (page.version !== 1 || !Array.isArray(page.events) || !Number.isSafeInteger(page.cursor)) throw new Error("Invalid dialogue page");
  if (page.cursor <= previous.cursor) return previous;
  let cursor = previous.cursor;
  let receiptCount = previous.receiptCount;
  let entries: ManuscriptEntry[] | undefined;
  let inputs: Map<string, DialogueInput> | undefined;
  let utterances: Set<string> | undefined;
  let works: Map<string, DialogueWork> | undefined;
  for (const event of page.events) {
    if (!Number.isSafeInteger(event.eventSeq)) throw new Error("Invalid dialogue event");
    if (event.eventSeq <= cursor) continue;
    if (event.eventSeq !== cursor + 1) throw new Error("Missing dialogue events");
    cursor = event.eventSeq;
    if (event.type === "input.accepted") {
      if (event.input.eventSeq !== cursor || !event.input.inputId) throw new Error("Invalid input event");
      if ((inputs ?? previous.inputs).has(event.input.inputId)) continue;
      (inputs ??= new Map(previous.inputs)).set(event.input.inputId, event.input);
      (entries ??= [...previous.entries]).push({ kind: "input", id: event.input.inputId, input: event.input });
    } else if (event.type === "manuscript.append") {
      if (!event.utterance.utteranceId || !Array.isArray(event.utterance.blocks)) throw new Error("Invalid utterance event");
      if ((utterances ?? previous.utterances).has(event.utterance.utteranceId)) continue;
      (utterances ??= new Set(previous.utterances)).add(event.utterance.utteranceId);
      (entries ??= [...previous.entries]).push({ kind: "utterance", id: event.utterance.utteranceId, utterance: event.utterance });
    } else if (event.type === "work.status") {
      (works ??= new Map(previous.works)).set(event.work.workId, event.work);
    } else if (event.type === "projection.receipt") {
      receiptCount++;
    } else {
      throw new Error("Unknown dialogue event");
    }
  }
  if (cursor !== page.cursor) throw new Error("Incomplete dialogue page");
  return { cursor, receiptCount, entries: entries ?? previous.entries, inputs: inputs ?? previous.inputs,
    utterances: utterances ?? previous.utterances, works: works ?? previous.works };
}

export function projectAcceptedInput(previous: DialogueProjection, input: DialogueInput): DialogueProjection {
  if (input.eventSeq !== previous.cursor + 1) return previous;
  const event: DialogueEvent = { eventSeq: input.eventSeq, type: "input.accepted", input };
  return projectDialoguePage(previous, { version: 1, events: [event], cursor: event.eventSeq });
}
