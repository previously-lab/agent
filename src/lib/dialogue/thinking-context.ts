import type { ModelMessage } from "@/lib/deepseek/types";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { DialogueOrchestrationWorld } from "./orchestrator";

export type OtherWorkState = DialogueOrchestrationWorld["works"][number];

/** Reuse the existing background and checkpoint continuity without turning
 * another input's full question into this work's task. */
export function buildNativeThinkingMessages(
  input: Pick<TurnInput, "turnId" | "lastUserMessage" | "dialogue" | "startedAtIso" | "clientTimezone" | "regenerate">,
  otherWorks: readonly OtherWorkState[] = [],
  options: { contextPrefix?: readonly ModelMessage[] } = {},
): ModelMessage[] {
  const checkpointHistory = options.contextPrefix ?? [];
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
    otherWorks: otherWorks.map(work => ({
      inputId: work.inputId, workId: work.workId, status: work.status,
      ...(work.text ? { title: work.text.slice(0, 500) } : {}),
      ...(work.latestStage ? { latestStage: work.latestStage } : {}),
    })),
    relation: "A relation (new, related, continuation or unclear) describes how this input relates to existing work. Each input retains its own task.",
    responseModeSelection: "Choose the responseMode for the current request. Include it in completeWork.",
    snapshots: "Read a snapshot with readWorkSnapshot only when its public handoff could fill a material gap or avoid repeating needed work. A related title alone needs no lookup.",
    completion: "Complete only this input and hand off its result. Do not repeat or complete other inputs. The single dialogue Actor decides how to integrate and phrase the public answer.",
  };
  return [...checkpointHistory, { role: "user", content: `## Current task contract\n${JSON.stringify(contract)}` }];
}
