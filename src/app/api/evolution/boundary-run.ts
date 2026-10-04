/**
 * Boundary run — the durable workflow entry (v0.19 §A.2.3-a).
 *
 * Fired ONCE per slice close by the scribe segment (序 5 posts the boundary
 * fact to the closed slice's mailbox, then starts this run fire-and-forget —
 * trigger/execution separation). The body is a deterministic controller:
 * all I/O and LLM calls live in the `"use step"` functions of
 * ./background-steps, imported here by reference only.
 *
 * Lives under src/app so the `withWorkflow` loader picks up the directive.
 */
import {
  executeBoundaryRun,
  type BoundaryRunInput,
} from "./background-steps";

export async function boundaryRun(input: BoundaryRunInput): Promise<void> {
  "use workflow";
  await executeBoundaryRun(input);
}
