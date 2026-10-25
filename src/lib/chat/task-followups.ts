import { z } from "zod";
import type { ModelMessage } from "@/lib/deepseek/types";
import { taskFollowupSchema, taskRefSchema } from "@/lib/tasks/contracts";

export const REPORT_TASK_FOLLOWUP_TOOL = "reportTaskFollowup" as const;

export const reportTaskFollowupInputSchema = z.union([
  z.object({ ref: taskRefSchema }).strict(),
  z.object({ resultId: z.string().min(1).max(200) }).strict(),
]);

export const taskAckIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task"),
    followup: taskFollowupSchema,
  }).strict(),
  z.object({
    kind: z.literal("result"),
    resultId: z.string().min(1).max(200),
    expectedRevision: z.number().int().positive(),
  }).strict(),
]);

export type TaskAckIntent = z.infer<typeof taskAckIntentSchema>;
export type ReportTaskFollowupInput = z.infer<typeof reportTaskFollowupInputSchema>;

const taskAckMetadataSchema = z.object({
  taskAckIntents: z.array(taskAckIntentSchema).max(20).optional(),
  error: z.string().optional(),
});

/** Preserve validated private metadata beside the legacy inbox envelope. */
export function parseTaskAckMetadata(value: unknown): z.infer<typeof taskAckMetadataSchema> {
  const parsed = taskAckMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : { error: "Invalid task acknowledgment metadata" };
}

export type ReportTaskFollowupResult =
  | { ok: true; ackIntent: TaskAckIntent }
  | { ok: false; reason: string };

function ackIntentKey(intent: TaskAckIntent): string {
  return intent.kind === "task"
    ? `task:${intent.followup.ref}`
    : `result:${intent.resultId}`;
}

export function collectTaskAckIntents(messages: ModelMessage[]): TaskAckIntent[] {
  const calls = new Map<string, ReportTaskFollowupInput>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== REPORT_TASK_FOLLOWUP_TOOL) continue;
      const parsed = reportTaskFollowupInputSchema.safeParse(part.input);
      if (parsed.success) calls.set(part.toolCallId, parsed.data);
    }
  }

  const intents = new Map<string, TaskAckIntent>();
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (
        part.type !== "tool-result" ||
        part.toolName !== REPORT_TASK_FOLLOWUP_TOOL ||
        part.isError ||
        part.output.type !== "json" ||
        !calls.has(part.toolCallId)
      ) continue;
      const call = calls.get(part.toolCallId)!;
      const value = part.output.value;
      if (value === null || typeof value !== "object" || !("ackIntent" in value)) continue;
      const parsed = taskAckIntentSchema.safeParse(value.ackIntent);
      if (!parsed.success) continue;
      const intent = parsed.data;
      if (intent.kind === "task") {
        if (!("ref" in call) || call.ref !== intent.followup.ref) continue;
      } else if (!("resultId" in call) || call.resultId !== intent.resultId) {
        continue;
      }
      if (!intents.has(ackIntentKey(intent)) && intents.size < 20) {
        intents.set(ackIntentKey(intent), intent);
      }
    }
  }
  return [...intents.values()];
}
