import type { ModelMessage, ModelPart } from "@/lib/deepseek/types";
import { imageAttachmentMapping } from "@/lib/chat/image-attachments";
import type { TurnInput } from "@/lib/chat/turn-types";
import { judgeSliceLanding } from "@/lib/chat/slice-landing";
import type { TimeSlice } from "@/lib/episodic/types";
import type { DialogueOrchestrationWorld } from "./orchestrator";

export type OtherWorkState = DialogueOrchestrationWorld["works"][number];

type CurrentImages = Pick<TurnInput, "verifiedImages"> & Partial<Pick<TurnInput, "imageAttachments">>;
type ThinkingInput = Pick<TurnInput, "turnId" | "lastUserMessage" | "dialogue" | "startedAtIso" | "clientTimezone" | "regenerate">
  & CurrentImages & { config?: Pick<TurnInput["config"], "slicing"> };

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + "…";
}

/** Resolve visible exchanges against the same active record, as of submission. */
function recentPublicExchanges(input: ThinkingInput, slice?: TimeSlice) {
  const hints = input.dialogue?.recentExchangeHints;
  if (input.regenerate || !hints || slice?.status !== "active" || !input.config?.slicing) return;
  const cutoff = Date.parse(input.startedAtIso);
  const prior = slice.turns.filter(turn => turn.attribution !== "ambiguous" && Date.parse(turn.timestamp) < cutoff);
  const last = prior.reduce<string | null>((at, turn) =>
    at === null || Date.parse(turn.timestamp) > Date.parse(at) ? turn.timestamp : at, null);
  const landing = judgeSliceLanding({ sliceId: slice.slice_id, start: slice.start, turnCount: prior.length, lastTurnAt: last },
    cutoff, input.config.slicing);
  if (landing.kind !== "continue-edge") return;
  const sources = new Map<string, { accepted: number; user: string }>();
  const ownId = input.dialogue?.sourceInputId ?? input.turnId;
  for (const turn of prior) {
    const record = turn.dialogue;
    if (turn.role === "user" && record?.kind === "user_input" && record.inputId !== ownId &&
        hints.inputIds.includes(record.inputId) && turn.content.trim()) {
      sources.set(record.inputId, { accepted: Date.parse(turn.timestamp), user: turn.content.trim() });
    }
  }
  // Pair by the publication's recorded owner, regardless of when concurrent browser rows appeared.
  const replies = new Map<string, { published: number; assistant: string }>();
  for (const turn of prior) {
    const record = turn.dialogue;
    if (turn.role !== "agent" || record?.kind !== "public_utterance" || record.inputIds.length !== 1 ||
        !hints.publicationIds.includes(record.publicationId)) continue;
    const id = record.inputIds[0];
    const source = sources.get(id);
    const published = Date.parse(turn.timestamp);
    if (!source || published < source.accepted || published <= (replies.get(id)?.published ?? -Infinity) ||
        cutoff - published >= input.config.slicing.idleGapMinutes * 60_000) continue;
    const text = record.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n").trim();
    if (text) replies.set(id, { published, assistant: text });
  }
  const pairs = [...sources].flatMap(([id, source]) => {
    const reply = replies.get(id);
    return reply ? [{ ...source, assistant: reply.assistant }] : [];
  }).sort((a, b) => a.accepted - b.accepted).slice(-4);
  if (!pairs.length) return;
  const perSide = Math.floor(400 / pairs.length);
  return pairs.map(pair => ({ user: excerpt(pair.user, perSide), assistant: excerpt(pair.assistant, perSide) }));
}

/** Rebuilding an isolated task must retain this input's verified visual evidence. */
export function currentDialogueUserMessage(input: CurrentImages, text: string): ModelMessage {
  if (!input.verifiedImages?.length) return { role: "user", content: text };
  const content: ModelPart[] = [{ type: "text", text }];
  for (const [index, { snapshot, dataBase64 }] of input.verifiedImages.entries()) {
    content.push({ type: "text", text: imageAttachmentMapping(snapshot, index) });
    if (!input.imageAttachments?.length) {
      content.push({ type: "image", image: dataBase64, mediaType: snapshot.mediaType });
    }
  }
  if (input.imageAttachments?.length) {
    content.push({ type: "text", text: "Use viewImage with the mapped source to inspect the attached images." });
  }
  return { role: "user", content };
}

/** Reuse the existing background and checkpoint continuity without turning
 * another input's full question into this work's task. */
export function buildNativeThinkingMessages(
  input: ThinkingInput,
  otherWorks: readonly OtherWorkState[] = [],
  options: { contextPrefix?: readonly ModelMessage[]; slice?: TimeSlice } = {},
): ModelMessage[] {
  const checkpointHistory = options.contextPrefix ?? [];
  const exchanges = recentPublicExchanges(input, options.slice);
  const contract = {
    type: "current_task_contract",
    inputId: input.turnId,
    workId: input.dialogue?.workId ?? input.turnId,
    task: input.lastUserMessage,
    acceptedAt: input.dialogue?.acceptedTime ?? { utc: input.startedAtIso, zone: input.clientTimezone },
    timeScope: input.regenerate
      ? "This work retries an earlier input. The acceptance time dates this retry."
      : "The acceptance time dates this user's current statement. Use its local day when recording what the user says now. Dates in the background or in cited documents belong to those earlier events.",
    background: "The system prompt already carries the living recap, user model and slice background. Any preceding messages are the existing checkpoint continuation, not a queue of new work.",
    ...(exchanges ? { recentPublicExchanges: exchanges,
      exchangeUse: "Use these excerpts of earlier public exchanges to interpret references in the current task. Their words describe what was said. Only the current task calls for action." } : {}),
    otherWorks: otherWorks.map(work => ({
      inputId: work.inputId, workId: work.workId, status: work.status,
      ...(work.text ? { title: work.text.slice(0, 500) } : {}),
      ...(work.latestStage ? { latestStage: work.latestStage } : {}),
    })),
    relation: "A relation (new, related, continuation or unclear) describes how this input relates to existing work. Each input retains its own task.",
    responseModeSelection: "Choose the responseMode for the current request. Include it in completeWork.",
    snapshots: "Read a snapshot with readWorkSnapshot only when its public handoff could fill a material gap or avoid repeating needed work. A related title alone needs no lookup.",
    completion: "Hand off a useful partial answer with workCheckpoint while investigating the rest. When this input is answered, use completeWork. Do not repeat or complete other inputs. The single dialogue Actor decides how to integrate and phrase the public answer.",
  };
  return [...checkpointHistory, currentDialogueUserMessage(input, `## Current task contract\n${JSON.stringify(contract)}`)];
}
