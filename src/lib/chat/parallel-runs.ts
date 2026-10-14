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
  attributes?: Record<string, string> | null;
}

/** A run that still has work ahead of it (the local world's live statuses). */
export function isLiveRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
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
/** Trailing-turn cap for the summary window: the burst is the slice's TAIL;
 *  older turns are earlier conversation, not this batch. */
const SUMMARY_WINDOW_MAX_TURNS = 12;

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
