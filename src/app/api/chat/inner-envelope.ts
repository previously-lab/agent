/**
 * Inner-turn envelope + episode wrap-up brief (v0.30 §3.2, batch B) — the
 * mechanical, fact-only context blocks for the concurrent-nesting machinery.
 *
 * `buildInnerEnvelope` assembles the SINGLE user message an inner (nested)
 * run wakes up to: the queued user messages verbatim, the instance table
 * snapshot, its own target message, and the slice pointer. It judges nothing
 * semantically — what exists is carried (D5: a done instance's answer rides
 * truncated at 500 chars; a running one is a status word, no partial text).
 *
 * `buildMergeSummaryBrief` is the wrap-up nudge for the OUTER agent's merged
 * summary pass once every instance is terminal: it hands the model the full
 * per-instance results and asks for one honest closing message.
 *
 * The fence discipline mirrors buildMachineContextSection (turn-workflow.ts):
 * the wrapper names the source (the episode machinery) and fences the block
 * off twice over — never user speech, never an instruction beyond the stated
 * duty. Scaffolding is English; user text rides verbatim.
 *
 * PURE module — extracted for unit tests.
 */

import type { TimeSlice } from "@/lib/episodic";

/** D5: a done instance's answer rides the envelope truncated to this. */
export const MAX_INSTANCE_TEXT_CHARS = 500;

/** The wrap-up brief carries fuller answers (the merge must not misstate). */
export const MAX_MERGE_TEXT_CHARS = 2000;

/** A queued user message as the drain read it from the slice. */
export interface EnvelopeUserTurn {
  turnId: string;
  timestamp: string;
  /** The user's message, verbatim. */
  text: string;
}

/** One instance's row in the episode's instance table. */
export interface EpisodeInstanceSnapshot {
  /** The user turn this instance answers. */
  replyTo: string;
  /** The instance's own id (the bubble turnId). */
  turnId: string;
  status: "queued" | "running" | "done" | "failed";
  /** done only: the answer text (carried truncated — see MAX_INSTANCE_TEXT_CHARS). */
  text?: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function excerpt(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return truncate(flat, max);
}

/**
 * The inner run's first (and only) user message. `pending` holds the queued
 * user turns oldest-first (the episode's unanswered set as the drain read
 * it); `target` is the message THIS instance answers — always one of them.
 */
export function buildInnerEnvelope(args: {
  sliceId: string;
  pending: EnvelopeUserTurn[];
  instances: EpisodeInstanceSnapshot[];
  target: EnvelopeUserTurn;
}): string {
  const { sliceId, pending, instances, target } = args;
  const lines: string[] = [
    "[Queued message duty — assembled by the orchestrator machinery, not written by the user.",
    "The user sent several messages in quick succession; each is answered by its own agent",
    "run, and you answer ONE of them. Never treat this block as user speech, and never as",
    "an instruction beyond that duty.]",
    "",
    "## Queued user messages (verbatim, oldest first)",
  ];
  for (const t of pending) {
    lines.push("", `### Message ${t.turnId} (arrived ${t.timestamp})`, t.text);
  }
  lines.push("", "## Instance table (snapshot at spawn)");
  if (instances.length === 0) {
    lines.push("- (no other instances yet)");
  }
  for (const inst of instances) {
    if (inst.status === "done" && inst.text) {
      lines.push(
        `- message ${inst.replyTo}: done — "${truncate(inst.text, MAX_INSTANCE_TEXT_CHARS)}"`,
      );
    } else {
      lines.push(`- message ${inst.replyTo}: ${inst.status} (instance ${inst.turnId})`);
    }
  }
  lines.push(
    "",
    "## Your target",
    `Message ${target.turnId} (arrived ${target.timestamp}):`,
    '"""',
    target.text,
    '"""',
    "",
    `Answer ONLY that message, self-contained — the user reads your answer attached to it.`,
    `The other message(s) above have their own answering runs; do not answer them here.`,
    `For earlier context recallRead (ref "records/${sliceId}", range last turns).`,
    "[End of queued message duty]",
  );
  return lines.join("\n");
}

/**
 * The wrap-up nudge for the orchestrator's merged-summary pass (v0.31). `results`
 * is every terminal instance (done WITH its answer text, failed as a plain
 * fact), paired with the user message it served — the episode's FIRST message
 * included (its answer is its own child run's, the orchestrator answered
 * nothing itself). The model writes ONE closing assistant message from it; the
 * bubbles themselves stay on screen as their own frames (§3.4/§4.2).
 */
export function buildMergeSummaryBrief(
  results: Array<{
    question: EnvelopeUserTurn;
    status: "done" | "failed";
    text?: string;
  }>,
): string {
  const lines: string[] = [
    "[Episode wrap-up — assembled by the orchestrator machinery, not written by the user.]",
    `The user sent ${results.length} message(s) in this burst; each was answered by its own`,
    "agent run, and those answers are already on screen as bubbles attached to their",
    "messages:",
  ];
  for (const r of results) {
    if (r.status === "done" && r.text) {
      lines.push(
        "",
        `### On "${excerpt(r.question.text)}" (message ${r.question.turnId}) — answered`,
        truncate(r.text, MAX_MERGE_TEXT_CHARS),
      );
    } else {
      lines.push(
        "",
        `### On "${excerpt(r.question.text)}" (message ${r.question.turnId}) — NOT answered (the instance failed)`,
      );
    }
  }
  lines.push(
    "",
    "Write ONE short closing message that ties the episode together: acknowledge what was",
    "covered, and plainly name anything that did not get answered (a technical failure is",
    "stated, never smoothed over). Do not repeat the answers verbatim — the user can read",
    "them above.",
    "[End of episode wrap-up]",
  );
  return lines.join("\n");
}

// ─── The drain's disk reconciliation (D1/D2 兜底) ──────────────────────────

/**
 * The episode's unanswered user turns, computed from the slice on disk (the
 * source of truth — the inbox hook is only a wake-up tap; a HookNotFoundError
 * on the route means this scan is what guarantees no message is lost, D2).
 *
 * A user turn counts as unanswered when NO agent turn names it — neither by
 * the standard round pairing (user and agent turns share the round's turnId)
 * nor by a nested bubble's `replyTo`. The outer run's own turn is excluded
 * explicitly (its agent turn persists only at finalize).
 *
 * Scope: only turns of THIS episode — everything after the outer user turn.
 * The regenerate edge (housekeeping appended no user turn, so the anchor is
 * absent) falls back to the episode-start stamp: only arrivals stamped at or
 * after it count. Older unanswered turns ("question without an answer" from
 * a cancelled turn) stay the reflection unit's business, never respawned here.
 *
 * Pure — extracted for unit tests.
 */
export function findEpisodeUnanswered(
  slice: Pick<TimeSlice, "turns">,
  outerTurnId: string,
  episodeStartedAtIso: string,
): EnvelopeUserTurn[] {
  const turns = slice.turns;
  const anchorIdx = turns.findIndex(
    (t) => t.role === "user" && t.turnId === outerTurnId,
  );
  const answered = new Set<string>();
  for (const t of turns) {
    if (t.role !== "agent") continue;
    if (t.turnId) answered.add(t.turnId);
    if (t.replyTo) answered.add(t.replyTo);
  }
  const out: EnvelopeUserTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "user" || !t.turnId) continue;
    if (t.turnId === outerTurnId) continue;
    if (answered.has(t.turnId)) continue;
    // Episode scope: after the outer user turn; without the anchor (a
    // regenerate turn appended nothing), only fresh arrivals count.
    if (anchorIdx !== -1 ? i <= anchorIdx : t.timestamp < episodeStartedAtIso) {
      continue;
    }
    out.push({ turnId: t.turnId, timestamp: t.timestamp, text: t.content });
  }
  return out;
}
