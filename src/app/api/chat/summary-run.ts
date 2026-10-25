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

const ACK_SOURCE_POLLS = 5;

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
    for (const member of verified) {
      if (member.taskAckIntents.length === 0) continue;
      if (member.finishReason !== "stop" || member.error || !member.sourceRunId) {
        acknowledgements.push({
          kind: "source", id: member.sourceRunId ?? member.reply.turnId,
          status: "skipped",
          detail: `Task acknowledgment requires a clean stop without error and original run id; finish=${member.finishReason ?? "unknown"}`,
        });
        continue;
      }

      let sourceStatus = await readSourceRunStatusForAck(member.sourceRunId);
      for (
        let poll = 1;
        (sourceStatus === "pending" || sourceStatus === "running") && poll < ACK_SOURCE_POLLS;
        poll += 1
      ) {
        await sleep("1s");
        sourceStatus = await readSourceRunStatusForAck(member.sourceRunId);
      }
      if (sourceStatus === "completed") {
        acknowledgements.push(...await acknowledgeSavedTaskFollowups(member, payload.clientTimezone));
        continue;
      }
      const deferred: TaskAckSettlement = {
        kind: "source",
        id: member.sourceRunId,
        status: sourceStatus === "pending" || sourceStatus === "running" || sourceStatus === "unavailable"
          ? "pending"
          : "skipped",
        detail: `Task acknowledgment not consumed: source workflow status=${sourceStatus}`,
      };
      acknowledgements.push(deferred);
    }
    return { ...saved, acknowledgements };
  } finally {
    await closeChildStream();
  }
}
