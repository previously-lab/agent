/**
 * Incremental summary persistence (v0.42, updated by 711419c).
 * Each burst turn durably starts a run carrying its own record. Completed
 * siblings enhance the batch; the own payload survives registry failure.
 * One bounded step locates saved identities before selecting a landing,
 * appends only missing material, commits, and rings the reflection bell.
 * Duplicate deliveries converge through record identity and Git ref CAS.
 */
import { sleep } from "workflow";
import type {
  SummaryRunPayload,
  SummaryRunOutcome,
  TaskAckSettlement,
  VerifiedTaskReply,
} from "@/lib/chat/turn-types";
import {
  persistTurnSummary,
  acknowledgeSavedTaskFollowups,
  readSourceRunStatusForAck,
  closeChildStream,
} from "./steps";

export async function summaryRun(
  payload: SummaryRunPayload,
): Promise<SummaryRunOutcome> {
  "use workflow";

  try {
    const saved = await persistTurnSummary(payload);
    if (saved.kind !== "committed" && saved.kind !== "deduped") return saved;
    // Old recorded step results carried only ownReply. New results include
    // exact saved evidence for every burst member and child with an intent.
    const verified: VerifiedTaskReply[] = saved.verifiedTaskReplies ?? (
      saved.ownReply && payload.own.taskAckIntents?.length
        ? [{ ...payload.own, taskAckIntents: payload.own.taskAckIntents, reply: saved.ownReply }]
        : []
    );
    if (verified.length === 0) return saved;
    const acknowledgements: TaskAckSettlement[] = [];
    // startSummaryRun returns a run ID to the source; the source never waits
    // for this workflow. Other members can settle while one source is still live.
    let pending = verified.filter(member => member.taskAckIntents.length);
    let delay = 1_000;
    while (pending.length) {
      const next: VerifiedTaskReply[] = [];
      for (const member of pending) {
        if (member.finishReason !== "stop" || member.error || !member.sourceRunId) {
          acknowledgements.push({
            kind: "source", id: member.sourceRunId ?? member.reply.turnId, status: "skipped",
            detail: `Task acknowledgment requires a clean stop without error and original run id; finish=${member.finishReason ?? "unknown"}`,
          });
          continue;
        }
        const status = await readSourceRunStatusForAck(member.sourceRunId);
        if (status === "pending" || status === "running" || status === "unavailable") {
          next.push(member);
        } else if (status === "completed") {
          acknowledgements.push(...await acknowledgeSavedTaskFollowups(member, payload.clientTimezone));
        } else {
          acknowledgements.push({ kind: "source", id: member.sourceRunId, status: "skipped",
            detail: `Task acknowledgment not consumed: source workflow status=${status}` });
        }
      }
      pending = next;
      if (pending.length) {
        await sleep(delay);
        delay = Math.min(60_000, delay * 2);
      }
    }
    return { ...saved, acknowledgements };
  } finally {
    await closeChildStream();
  }
}
