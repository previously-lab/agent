/**
 * HQ contract — what the wake channel's two sides share (v0.30 §2).
 *
 * Pure by construction: one token constant and two payload/outcome types.
 * `hq-run.ts` is a WORKFLOW file, and the Workflow SDK bundles a workflow
 * file's static import graph into the sandbox — which has no Node modules
 * (docs/errors/node-js-module-in-workflow). So this module must stay free of
 * imports; anything impure belongs in `hq-steps.ts` behind "use step".
 */

/**
 * The one global HQ hook token (§4 裁决 9: globally unique, need not be
 * hard-guaranteed — a re-start simply claims it again).
 */
export const HQ_TOKEN = "hq:main";

/**
 * The mechanical wake (v0.30 §2.1 机械铃): a PURE POINTER, nothing else.
 * Nobody briefs the reflection unit — the turn tail rings this after the
 * turn lands on disk, and the unit reads the record itself. Every field is
 * optional: the pointer is a hint (the unit's range is everything since its
 * last look), and a bare wake is legal — the cancel route holds only a runId
 * and rings with `{}` so a "question without an answer" still gets seen.
 */
export interface ReflectionWakePayload {
  /** The slice the finished turn landed in. */
  sliceId?: string;
  /** The finished turn's id. */
  turnId?: string;
  /**
   * The field's USER-LOCAL calendar date (YYYY-MM-DD) — the unit's write
   * stamps ride the user's clock. Absent on bare wakes; consumers fall back
   * to the UTC date.
   */
  date?: string;
}

export type HQRunOutcome =
  | { kind: "claimed"; handled: number }
  | { kind: "dedupedTo"; runId: string };
