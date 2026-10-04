/**
 * The field↔HQ channel's Node-side steps (v0.21 §4).
 *
 * `hq-run.ts` (the workflow file) imports this module, and the SDK splits
 * "use step" bodies out of the workflow bundle — so the impure work below
 * stays on the Node side. Two imports are dynamic on purpose: the workflow
 * plugin still traces a *static* edge out of a workflow-reachable module, and
 * `@/lib/docs/docs-query` reaches `next` / `fs` / `path` (data-cache, demo-fs,
 * local-git, client-config) — that is exactly what broke the dev server with
 * node-js-module-in-workflow errors.
 * (docs/errors/node-js-module-in-workflow)
 */
import { resumeHook } from "workflow/api";
import { HQ_TOKEN, type HQBriefPayload } from "./hq-contract";

/** At most this many slice pointers per brief are handed to the bridge. */
const MAX_BRIEF_SLICES = 3;

/**
 * Conflict handoff. `resumeHook` is a runtime function that MUST be called
 * outside a workflow function (SDK contract) — hence this "use step". It
 * durably writes `hook_received` and only then wakes the primary run, so a
 * duplicate HQ that loses the claim hands its brief over instead of dropping
 * it (§11 ③).
 */
export async function handoffBriefToPrimary(payload: HQBriefPayload): Promise<void> {
  "use step";
  await resumeHook(HQ_TOKEN, payload);
}

/**
 * Handle ONE brief ("use step"). P2 bridge: pointer extraction is purely
 * mechanical — slice ids mentioned in the brief prose, falling back to the
 * slice id inside the mechanical replyToken; with no pointer at all HQ idles
 * and writes nothing (§5 只存结果). Each pointer runs the EXISTING background
 * execution entry so behavior stays available; P4 replaces this body with the
 * HQ agent (hq-agent.ts) — the signature is the seam.
 *
 * The `background-steps` import stays dynamic for a second reason: a static
 * edge would close a module cycle (tool-executors → hq-run → hq-steps →
 * background-steps → models/registry → byok-sync → turn-workflow → agent →
 * tools → tool-executors).
 */
export async function handleHQBrief(payload: HQBriefPayload): Promise<void> {
  "use step";
  const { extractSliceIds } = await import("@/lib/docs/docs-query");
  const fromText = extractSliceIds(payload.brief);
  const fromToken = payload.replyToken.startsWith("field:")
    ? (payload.replyToken.split(":")[1] ?? "")
    : "";
  const targets = (fromText.length > 0 ? fromText : fromToken ? [fromToken] : [])
    .slice(0, MAX_BRIEF_SLICES);
  if (targets.length === 0) {
    console.log("[HQRun] brief names no slice pointer — idle (HQ agent arrives in P4)");
    return;
  }
  const { executeBoundaryRun } = await import("./background-steps");
  // HQ has no user-timezone context; the date is only a write stamp here.
  const date = new Date().toISOString().slice(0, 10);
  for (const sliceId of targets) {
    try {
      await executeBoundaryRun({ sliceId, date });
    } catch (e) {
      console.warn(`[HQRun] boundary run for ${sliceId} failed:`, e);
    }
  }
}
