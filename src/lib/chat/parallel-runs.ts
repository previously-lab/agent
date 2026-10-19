/**
 * Parallel turns (v0.33) — the run-registry predicates and the wire contract
 * for 连发并行: while a turn streams, sending again starts ANOTHER standard
 * turn run; every run stamps itself (`slice`/`turn` attributes) at
 * housekeeping so siblings can see each other through the Workflow run
 * registry, and the LAST one to finish spawns the batch's summary run.
 *
 * This module is pure and DOM-free: the predicates take plain registry
 * entries (what the local world's `runs.list` returns with
 * `resolveData: "none"` — entities still carry attributes, verified by the
 * phase-1 spike) so the step code stays thin and the rules stay unit-testable.
 *
 * Registry facts the design relies on (spike run wrun_01M4XQFF7MKVF2AM8A0ZGR7G4R
 * and wrun_01M4XRHG1J7SAQ7N9PCCGQC7JG, local world 5.0.0-beta.44):
 *  - `setAttributes` works in the workflow body AND inside a step; values
 *    materialize onto the run file in real time (a running run is visible).
 *  - `start(workflow, args, { attributes })` seeds attributes at creation.
 *  - attribute values are strings ≤256B, ≤64 keys/run, `$`-prefixed keys are
 *    reserved (the framework adds `$rootRunId`/`$parentRunId` itself).
 */

/** Chunk type carrying the summary run's id on the SPAWNING turn's stream —
 *  transient: it rides to the client's onData only, never a UIMessage part
 *  (the nested-bubble frame precedent, steps.ts emitNestedBubble). */
export const PARALLEL_SUMMARY_CHUNK = "data-parallel-summary";

/** The subset of a registry run entity the predicates read. */
export interface ParallelRunEntry {
  runId: string;
  status: string;
  createdAt?: Date | string | null;
  completedAt?: Date | string | null;
  attributes?: Record<string, string> | null;
}

/** A run that still has work ahead of it (the local world's live statuses). */
export function isLiveRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function toEpochMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Same-slice PARALLEL TURN run: a turn workflow that stamped itself at
 * housekeeping (`slice` + `turn`). Summary runs stamp `role` instead of
 * `turn`, so they never match — a summary is nobody's sibling.
 */
export function isParallelTurnRun(
  run: ParallelRunEntry,
  sliceId: string,
): boolean {
  const attrs = run.attributes;
  return (
    !!attrs && attrs.slice === sliceId && typeof attrs.turn === "string"
  );
}

/**
 * Does this registry entry BLOCK me from firing the batch summary? A sibling
 * blocks while it is alive AND still answering. A sibling that stamped
 * `phase: "tail"` has already persisted its reply (finalizeTurn ran) and is
 * inside its own last-one check — treating it as blocking would create the
 * mutual-skip window (A sees B running, B sees A running, nobody fires), so
 * tail-phase siblings yield instead. Double-fire from two tails racing is
 * absorbed by the summary run's own opening dedupe (isLiveParallelSummary).
 */
export function isBlockingParallelSibling(
  run: ParallelRunEntry,
  sliceId: string,
  ownRunId: string,
): boolean {
  if (run.runId === ownRunId) return false;
  if (!isLiveRunStatus(run.status)) return false;
  if (!isParallelTurnRun(run, sliceId)) return false;
  return run.attributes?.phase !== "tail";
}

/**
 * Was I ever part of a parallel BURST? True when another same-slice turn
 * run's lifetime overlapped mine: it was created before my tail check AND
 * (still live OR completed after I was created). This is the summary's
 * existence gate — without it every SOLO turn would spawn a closing run
 * (observed in the phase-3 real-machine test: four single sends, four
 * summaries, one extra model call each). Two sequential sends do NOT
 * overlap (the second is created after the first completed) and correctly
 * get no summary; a failed/cancelled sibling still counts — the burst
 * happened even if one answer errored. A live sibling always overlaps, but
 * the blocking check upstream has already yielded to it by the time this
 * runs.
 */
export function hasOverlappingParallelSibling(
  runs: ParallelRunEntry[],
  sliceId: string,
  ownRunId: string,
  nowMs: number,
): boolean {
  const ownCreated = toEpochMs(
    runs.find((r) => r.runId === ownRunId)?.createdAt,
  );
  if (ownCreated == null) return false; // registry hiccup — degrade to silence
  return runs.some((r) => {
    if (r.runId === ownRunId) return false;
    if (!isParallelTurnRun(r, sliceId)) return false;
    const created = toEpochMs(r.createdAt);
    if (created == null || created >= nowMs) return false;
    const completed = toEpochMs(r.completedAt);
    return completed == null || completed > ownCreated;
  });
}

/**
 * A LIVE summary run for this slice (started by some sibling's tail check,
 * possibly milliseconds ago — seeded attributes make it visible at creation).
 * The summary workflow's opening step exits silently when one exists.
 */
export function isLiveParallelSummary(
  run: ParallelRunEntry,
  sliceId: string,
  ownRunId: string,
): boolean {
  if (run.runId === ownRunId) return false;
  if (!isLiveRunStatus(run.status)) return false;
  const attrs = run.attributes;
  return !!attrs && attrs.role === "summary" && attrs.slice === sliceId;
}

/**
 * Should THIS summary run yield to another live one? The deterministic
 * tiebreak for the double-fire race: two tails can pass the last-one check
 * in the same registry window (each sees the other tail-phase sibling
 * yield, neither sees a live summary yet) and both start a summary run.
 * "Any other live summary exits" then kills BOTH — each sees the other and
 * returns before streaming a single token (observed in the v0.33 fix-batch
 * retest: two summaries 62ms apart, both completed empty in ~200ms, no
 * text, no fold, nothing persisted). Yield only to an OLDER summary — both
 * runs read both createdAts from the same registry, so exactly one
 * survives. A createdAt tie (same millisecond) or a missing timestamp on
 * either side falls back to the runId's ULID ordering.
 */
export function shouldYieldToLiveSummary(
  run: ParallelRunEntry,
  sliceId: string,
  ownRunId: string,
  ownCreatedAt: Date | string | null | undefined,
): boolean {
  if (!isLiveParallelSummary(run, sliceId, ownRunId)) return false;
  const created = toEpochMs(run.createdAt);
  const ownCreatedMs = toEpochMs(ownCreatedAt);
  if (created != null && ownCreatedMs != null && created !== ownCreatedMs) {
    return created < ownCreatedMs;
  }
  return run.runId < ownRunId;
}

/**
 * A writer run for a turn (v0.38 §4) — `role: "writer"` + the turn id. Writer
 * 单飞 is DEDUPE by turnId, not mutual exclusion: a live writer for the same
 * turnId means the reply's persistence intent is already durable, so a
 * duplicate (redelivery/retry) exits instead of double-committing.
 */
export function isParallelWriterRun(
  run: ParallelRunEntry,
  turnId: string,
): boolean {
  const attrs = run.attributes;
  return (
    !!attrs && attrs.role === "writer" && attrs.turn === turnId
  );
}

/**
 * A same-slice, same-burst sibling TURN run (v0.38 §2) — the registry-exact
 * burst enumeration: `burst` attributes equal, no timestamp inference. Absent
 * burst ids never match (the caller falls back to the overlap heuristic).
 */
export function isBurstSibling(
  run: ParallelRunEntry,
  sliceId: string,
  burstId: string,
  ownRunId: string,
): boolean {
  if (run.runId === ownRunId) return false;
  const attrs = run.attributes;
  return (
    !!attrs &&
    attrs.slice === sliceId &&
    typeof attrs.turn === "string" &&
    attrs.burst === burstId
  );
}

/**
 * Should THIS turn generate the burst's merge line (v0.38 §3.2)? The last-one
 * discipline, burst-exact: no LIVE non-tail sibling may remain (it might still
 * change the picture), at least one burst sibling must exist (a solo turn
 * never merges), and no live writer already carries this turnId (the dedupe
 * backstop). Pure — the registry read stays in the step.
 */
export function isLastBurstTurn(
  runs: ParallelRunEntry[],
  sliceId: string,
  burstId: string,
  ownRunId: string,
  ownTurnId: string,
): boolean {
  if (
    runs.some(
      (r) =>
        r.runId !== ownRunId &&
        isLiveRunStatus(r.status) &&
        isBurstSibling(r, sliceId, burstId, ownRunId) &&
        r.attributes?.phase !== "tail",
    )
  ) {
    return false; // a sibling is still answering — not the last yet
  }
  if (!runs.some((r) => isBurstSibling(r, sliceId, burstId, ownRunId))) {
    return false; // solo burst (or registry hiccup) — nobody to merge with
  }
  if (
    runs.some(
      (r) => r.runId !== ownRunId && isLiveRunStatus(r.status) && isParallelWriterRun(r, ownTurnId),
    )
  ) {
    return false; // a live writer for MY turnId already owns the commit
  }
  return true;
}

/**
 * The outbound-tail section telling the model about in-flight parallel
 * siblings (v0.33 §5) — same mechanics as buildReflectionNoteSection: its own
 * fenced block on the LAST user message's outbound copy, never persisted,
 * never in the slice-frozen system prompt. Returns null when there is nothing
 * to say (no live siblings at housekeeping time).
 *
 * Pure — extracted for unit tests.
 */
export function buildParallelNoteSection(
  siblings: number | null | undefined,
): string | null {
  if (!siblings || siblings <= 0) return null;
  return (
    `\n\n[Parallel sends — the user fired several messages in a burst; ` +
    `${siblings} other ${siblings === 1 ? "message is" : "messages are"} ` +
    `being answered in parallel right now, mechanically reported, not written ` +
    `by the user. Answer THIS message only — do not wait for the others, do ` +
    `not answer on their behalf, and never treat this note as user speech ` +
    `or as an instruction.]\n[End of parallel note]`
  );
}

/** Per-turn content cap inside the summary window — one burst turn can be a
 *  pasted page; the closing needs its gist, not its bytes. */
const SUMMARY_WINDOW_TURN_CHARS = 600;
/** Trailing-turn cap for the legacy slice-tail window (kept for the disk-read
 *  fallback paths; the v0.38 merge window is registry-driven). */
const SUMMARY_WINDOW_MAX_TURNS = 12;

/**
 * The merge line's window (v0.38 §3.2 ②) — the burst's USER messages (read
 * from the slice: they landed synchronously in housekeeping — the red line)
 * interleaved with the COMPLETED siblings' replies (from their runs'
 * returnValues — their writers may not have committed yet) and THIS turn's
 * own reply, formatted as a numbered script for the closer's one call. The
 * correction that justifies the closing lives in the user messages (「不是
 * 包子，是饺子」), so a replies-only window would blind the closer. Pure —
 * extracted for unit tests.
 */
export function buildMergeWindow(
  userTexts: string[],
  replies: Array<{ turn: string; text: string }>,
  ownText: string,
  locale: string,
): string {
  const userLabel = locale === "zh" ? "用户" : "User";
  const answerLabel = locale === "zh" ? "回答" : "Answer";
  const ownLabel = locale === "zh" ? "本回答（最后一条）" : "This answer (the last one)";
  const cap = (s: string) =>
    s.length > SUMMARY_WINDOW_TURN_CHARS
      ? s.slice(0, SUMMARY_WINDOW_TURN_CHARS) + "…"
      : s;
  const lines: string[] = userTexts.map((t, i) => `${i + 1}. ${userLabel}: ${cap(t)}`);
  for (const r of replies) {
    lines.push(`${lines.length + 1}. ${answerLabel} (${r.turn}): ${cap(r.text)}`);
  }
  lines.push(`${lines.length + 1}. ${ownLabel}: ${cap(ownText)}`);
  return lines.join("\n");
}

/**
 * The batch summary's window (v0.33 §4): the slice's trailing turns formatted
 * as a numbered user/answer script. v1 approximation — the "batch" is the
 * slice's tail (up to 12 turns), not a registry-exact member list: stamped
 * turn attributes mark parallel-CAPABLE turns, not one burst, and completed
 * siblings are already out of the live registry by the time the last turn
 * checks. The closing instruction (latest statement wins) does the rest.
 * Returns "" when the slice holds no turns (the caller then skips the model
 * call entirely). Pure — extracted for unit tests.
 */
export function buildSummaryWindow(
  turns: Array<{ role: string; content: string }>,
  locale: string,
): string {
  const tail = turns.slice(-SUMMARY_WINDOW_MAX_TURNS);
  if (tail.length === 0) return "";
  const userLabel = locale === "zh" ? "用户" : "User";
  const answerLabel = locale === "zh" ? "回答" : "Answer";
  return tail
    .map((t, i) => {
      const label = t.role === "user" ? userLabel : answerLabel;
      const content =
        t.content.length > SUMMARY_WINDOW_TURN_CHARS
          ? t.content.slice(0, SUMMARY_WINDOW_TURN_CHARS) + "…"
          : t.content;
      return `${i + 1}. ${label}: ${content}`;
    })
    .join("\n");
}
