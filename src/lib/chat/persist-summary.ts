import type { SummaryRunPayload, SummaryRunOutcome, TurnRunResult, TaskAckSource, VerifiedTaskReply } from "./turn-types";
import { locateSummaryRecords } from "./summary-records";
import { COMMIT_PREFIX } from "./commit-contract";
import {
  appendTurn, closeSlice, saveSliceSnapshot, deterministicSliceMark,
  analyzeTurn, readSlicePart, writeAgentTimeline, readPreviously, writePreviously,
  type TimeSlice, type WriteBatch, type SlicingSignal,
} from "@/lib/episodic";
import { persistEvidenceAttachments } from "@/lib/tools/attachments";
import { deliverReflectionWake } from "@/app/api/evolution/reflection-wake";
import { seedGitHubReadHead, withGitHubReadView } from "@/lib/github/read-view";

type Landing = { slice: TimeSlice; sealedEdge: { edge: TimeSlice; signal: SlicingSignal } | null } | { error: Error };

/** Shared full/minimal persistence. All I/O runs inside the owning step. */
async function persistSummaryMembersInView(
  payload: SummaryRunPayload,
  candidates: TurnRunResult[],
  failedTurns: Array<{ note: string }>,
  batch: WriteBatch,
  resolveLanding: (payload: SummaryRunPayload, first: TurnRunResult | undefined, batch: WriteBatch) => Promise<Landing>,
  flush: (batch: WriteBatch, message: string, slice: TimeSlice) => Promise<string | null>,
  minimal = false,
): Promise<SummaryRunOutcome> {
  const members = [...new Map(candidates.map((m) => [m.turnId, m])).values()];
  const nestedIdentities = members.flatMap((member) =>
    (member.nestedReplies ?? []).map((bubble): TurnRunResult => ({
      turnId: bubble.turnId, sliceId: member.sliceId, at: member.at,
      userText: "", replyText: bubble.text, cognition: "",
    })),
  );
  const { saved, commitSha: verifiedCommit } = await locateSummaryRecords(payload, [...members, ...nestedIdentities]);
  if (payload.useGithub && verifiedCommit) {
    batch.baseHeadSha = verifiedCommit;
    seedGitHubReadHead(payload.repo, payload.owner, { headSha: verifiedCommit });
  }
  const pending = members.filter((m) => !saved.has(m.turnId));
  const landing = pending.length
    ? await resolveLanding(payload, pending[0], batch)
    : { slice: saved.get(payload.own.turnId) ?? saved.values().next().value!, sealedEdge: null };
  if ("error" in landing) throw landing.error;
  const defaultSlice = landing.slice;
  if (!defaultSlice) throw new Error("No verified landing for summary");
  const body: string[] = [];
  if (minimal) body.push("degraded commit - the full summary failed twice; landed the user turn + produced reply only (v0.42 section 5)");
  const touched = new Map<string, TimeSlice>();
  const targets = new Map<string, TimeSlice>();
  const slicesById = new Map([[defaultSlice.slice_id, defaultSlice]]);
  const sharedSlice = (slice: TimeSlice): TimeSlice => {
    const existing = slicesById.get(slice.slice_id);
    if (existing) return existing;
    slicesById.set(slice.slice_id, slice);
    return slice;
  };
  const agentBodies = new Map<string, string>();
  const verifiedTaskReplies: VerifiedTaskReply[] = [];
  const verifyReply = (source: TaskAckSource, turnId: string, text: string, slice: TimeSlice): void => {
    if (!source.taskAckIntents?.length || !text.trim() || !slice.turns.some((turn) =>
      turn.role === "agent" && turn.turnId === turnId && turn.content === text
    )) return;
    verifiedTaskReplies.push({
      ...(source.sourceRunId ? { sourceRunId: source.sourceRunId } : {}),
      ...(source.finishReason ? { finishReason: source.finishReason } : {}),
      ...(source.error ? { error: source.error } : {}),
      taskAckIntents: source.taskAckIntents,
      reply: { status: "persisted", sliceId: slice.slice_id, turnId },
    });
  };
  if (landing.sealedEdge) {
    const { edge, signal } = landing.sealedEdge;
    if (!minimal) {
      const analysis = await analyzeTurn({ model: payload.modelConfig, userMessage: pending[0]?.userText ?? "", closingSlice: { turns: edge.turns } }).catch(() => null);
      const mark = analysis?.closedMarking;
      if (mark?.focus) edge.focus = mark.focus;
      if (mark?.summary) edge.summary = mark.summary;
      if (mark?.tone) edge.emotional_tone = mark.tone;
      if (mark?.openLoops) edge.open_loops = mark.openLoops;
      if (mark?.decisions) edge.decisions = mark.decisions;
    }
    const fallback = deterministicSliceMark(edge);
    edge.focus ||= fallback.focus;
    edge.summary ||= fallback.summary;
    await closeSlice(edge, signal, batch);
    body.push(`sealed ${edge.slice_id} (${signal})`);
  }
  for (const m of members) {
    const slice = sharedSlice(saved.get(m.turnId) ?? defaultSlice);
    targets.set(m.turnId, slice);
    const burst = m.burstId ?? payload.burstId;
    const lastUser = slice.turns.filter((t) => t.role === "user").at(-1);
    const legacyQuestion = m.regenerate && slice.slice_id === payload.sliceId
      && !lastUser?.clientMessageId && lastUser?.content === m.userText ? lastUser : undefined;
    const question = slice.turns.find((t) => t.role === "user" && (
      t.turnId === m.turnId || (m.clientMessageId && t.clientMessageId === m.clientMessageId)
    )) ?? legacyQuestion;
    const userId = question?.turnId ?? m.turnId;
    if (m.userText && !question) {
      appendTurn(slice, { timestamp: m.at, role: "user", content: m.userText, turnId: userId,
        ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}), ...(burst ? { burst } : {}) });
      body.push(`user turn ${userId}`);
      touched.set(slice.slice_id, slice);
    } else if (question) {
      if (!saved.has(m.turnId)) {
        // createSlice seeds its first question in memory; it still owes a
        // snapshot even when this turn produced no answer or client id.
        if (burst) question.burst = burst;
        body.push(`user turn ${userId}`);
        touched.set(slice.slice_id, slice);
      }
      if (m.clientMessageId && !question.clientMessageId) {
        question.clientMessageId = m.clientMessageId;
        touched.set(slice.slice_id, slice);
      }
    }
    const user = slice.turns.find((t) => t.role === "user" && t.turnId === userId);
    if (m.attachments?.length && user && !user.content.includes("[attachments:")) {
      const result = await persistEvidenceAttachments({ sliceId: slice.slice_id, turnId: userId,
        files: m.attachments.map((a) => ({ name: a.name, data: Buffer.from(a.dataBase64, "base64") })), batch });
      for (const skipped of result.skipped) console.warn(`[Attachments] skipped ${skipped.name}: ${skipped.reason}`);
      if (result.saved.length) {
        user.content += `\n\n[attachments: ${result.saved.map((a) => a.name).join(", ")}]`;
        touched.set(slice.slice_id, slice);
      }
    }
    if (m.replyText && !slice.turns.some((t) => t.role === "agent" && t.turnId === m.turnId)) {
      appendTurn(slice, { timestamp: m.at, role: "agent", content: m.replyText, turnId: m.turnId,
        ...(m.regenerate || userId !== m.turnId ? { replyTo: userId } : {}), ...(burst ? { burst } : {}) });
      body.push(`reply ${m.turnId}`);
      touched.set(slice.slice_id, slice);
    }
    verifyReply(m, m.turnId, m.replyText, slice);
    for (const bubble of m.nestedReplies ?? []) {
      const target = sharedSlice(saved.get(bubble.turnId) ?? slice);
      targets.set(bubble.turnId, target);
      if (bubble.text && !target.turns.some((turn) => turn.role === "agent" && turn.turnId === bubble.turnId)) {
        appendTurn(target, {
          timestamp: bubble.doneAt ?? m.at,
          role: "agent",
          content: bubble.finishReason === "stop" ? bubble.text : `[partial] ${bubble.text}`,
          turnId: bubble.turnId,
          replyTo: bubble.replyTo,
          ...(burst ? { burst } : {}),
        });
        body.push(`reply ${bubble.turnId}`);
        touched.set(target.slice_id, target);
      }
      verifyReply(bubble, bubble.turnId, bubble.text, target);
    }
    if (!minimal && m.mergeLine?.trim() && !slice.turns.some((t) => t.turnId === `m${m.turnId}`)) {
      appendTurn(slice, { timestamp: m.at, role: "agent", content: m.mergeLine.trim(), turnId: `m${m.turnId}`, merge: true, ...(burst ? { burst } : {}) });
      body.push(`merge ${m.turnId}`);
      touched.set(slice.slice_id, slice);
    }
    if (!minimal && m.cognition) {
      const known = agentBodies.get(slice.slice_id) ?? await readSlicePart(slice.slice_id, "agent", batch).catch(() => "");
      if (!known.includes(`## Cognition ${m.turnId} `)) {
        const block = `## Cognition ${m.turnId} \u2014 ${new Date().toISOString()}\n${m.cognition}`;
        await writeAgentTimeline(slice.slice_id, block, batch);
        agentBodies.set(slice.slice_id, `${known}\n\n${block}`);
        body.push(`cognition ${m.turnId}`);
      }
    }
  }
  const ownSlice = targets.get(payload.own.turnId)!;
  if (payload.own.previously?.trim() && (await readPreviously(ownSlice.slice_id).catch(() => "")) !== payload.own.previously) {
    await writePreviously(ownSlice.slice_id, payload.own.previously, batch);
  }
  for (const slice of touched.values()) await saveSliceSnapshot(slice, batch);
  if (touched.size) body.push("snapshot");
  const records = [...new Set([...targets.values()].map((s) => s.slice_id))].map((sliceId) => ({
    sliceId, turnIds: [...targets].filter(([, slice]) => slice.slice_id === sliceId).map(([turnId]) => turnId),
  }));
  const taskProof = verifiedTaskReplies.length > 0 ? { verifiedTaskReplies } : {};
  const own = payload.own;
  const ownReply = own.replyText.trim().length > 0 && ownSlice.turns.some((turn) =>
    turn.role === "agent" && turn.turnId === own.turnId && turn.content === own.replyText
  )
    ? { status: "persisted" as const, sliceId: ownSlice.slice_id, turnId: own.turnId }
    : undefined;
  if (batch.entries.size === 0) {
    return { kind: "deduped",
      ...(verifiedCommit ? { receipt: { version: 1 as const, commitSha: verifiedCommit, records } } : {}),
      ...taskProof,
      ...(ownReply ? { ownReply } : {}) };
  }
  for (const f of failedTurns) body.push(f.note);
  for (const m of members) {
    const target = targets.get(m.turnId)!;
    body.push(`record ${m.turnId} in ${target.slice_id}`);
    if (m.clientMessageId) body.push(`message ${encodeURIComponent(m.clientMessageId)} in ${target.slice_id}`);
  }
  const message = COMMIT_PREFIX.summary(defaultSlice.slice_id) + `\n\n${body.map((line) => `- ${line}`).join("\n")}`;
  const commitSha = await flush(batch, message, defaultSlice);
  for (const record of records) await deliverReflectionWake(record);
  console.log(`[Summary] ${defaultSlice.slice_id} committed: ${body.join(", ")}`);
  return { kind: "committed", segments: body,
    ...(commitSha ? { receipt: { version: 1 as const, commitSha, records } } : {}),
    ...taskProof,
    ...(ownReply ? { ownReply } : {}) };
}

export async function persistSummaryMembers(...args: Parameters<typeof persistSummaryMembersInView>): Promise<SummaryRunOutcome> {
  return withGitHubReadView(() => persistSummaryMembersInView(...args), { fresh: true });
}
