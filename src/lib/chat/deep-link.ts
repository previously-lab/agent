/**
 * Deep links for the single-route shell — what little of them remains.
 *
 * WHAT CHANGED AND WHY THIS FILE SHRANK. It used to be `mode-switch.ts`,
 * then `deep-link.ts` carried the RUNG (`?z=`) beside the point anchor.
 * Both are gone: the shell's navigation — the world, the rung, the shared
 * slice address, the conversation jump — is IN-MEMORY state owned by
 * AppShell (see `shell-nav.ts` and app-shell.tsx's header). The URL no
 * longer names a rung and nothing in the session ever writes one.
 *
 * WHAT IS STILL HERE. `?at=<sliceId>&atStart=<iso>` remains a COLD-BOOT
 * conversation deep link — a shared link still lands on its slice.
 * ChatPage consumes it exactly once (replaceState-stripped, so a refresh
 * never re-jumps); nothing inside the session produces it. The debug
 * gallery (`?view=game&debug=rooms…`, game-shell.tsx) and the playground
 * route keep their own params, read by their own modules.
 *
 * Pure — no React, no browser. Unit-tested in `tests/lib/chat/deep-link.test.ts`.
 */
import type { FieldRung } from "@/lib/timeline3d/units";

/**
 * The rung `/` opens at — the conversation, so a bare visit lands exactly where
 * it always has: on the live conversation. (The card field's own default is
 * `day`; that is the right default for someone who asked for the timeline by
 * clicking a card, and the wrong one for someone who just opened the app.)
 */
export const DEFAULT_RUNG: FieldRung = "conversation";

/**
 * Extract a valid `at` anchor from a query string (with or without the
 * leading `?`). Blank values and the sentinel "now" are no anchor at all —
 * "now" is the default camera position.
 */
export function parseAtParam(search: string): string | null {
  const at = new URLSearchParams(search).get("at")?.trim();
  return at && at !== "now" ? at : null;
}

/**
 * Extract the `atStart` anchor — the target slice's ISO `start`, which the
 * timeline card click already knows. Handing it to the chat page saves the
 * jump handler a full catalog fetch just to learn the travel-clock target.
 * Anything that doesn't parse as a date is discarded (the caller falls back
 * to the catalog lookup).
 */
export function parseAtStartParam(search: string): string | null {
  const raw = new URLSearchParams(search).get("atStart")?.trim();
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * Remove the `at`/`atStart` params from a query string, returning the
 * remaining query (with leading `?`) or an empty string — the chat page
 * consumes the anchors once, then strips them so a refresh doesn't re-jump.
 */
export function stripAtParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("at");
  params.delete("atStart");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
