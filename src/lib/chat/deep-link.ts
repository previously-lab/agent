/**
 * Deep links for the single-route shell.
 *
 * WHAT CHANGED AND WHY THIS FILE IS RENAMED. It used to be `mode-switch.ts`,
 * and it encoded a VIEW: `/` meant chat and `?view=timeline` meant the
 * timeline. Those were never two places — they are one field at four zooms
 * (`units.ts`), and the view param was the coarser half of the same axis the
 * lens switcher already offered. So the view became a RUNG: `?z=slice` is the
 * rung, and `/` is the default one. A module named for a mode switch that no
 * longer exists is a trap for whoever reads it next, hence the rename.
 *
 * WHAT IS STILL HERE. `?at=<sliceId>` is unchanged and still means "dock at
 * this slice" — the one deep link that addresses a POINT in the memory rather
 * than a zoom. `?atStart=` still rides along with it, saving the jump handler a
 * catalog fetch to learn the travel clock's target.
 *
 * Pure — no React, no browser. Unit-tested in `tests/lib/chat/deep-link.test.ts`.
 */
import { RUNG_ORDER, type FieldRung } from "@/lib/timeline3d/units";

/**
 * The rung `/` opens at — the conversation, so a bare visit lands exactly where
 * it always has: on the live conversation. (The card field's own default is
 * `day`; that is the right default for someone who asked for the timeline by
 * clicking a card, and the wrong one for someone who just opened the app.)
 */
export const DEFAULT_RUNG: FieldRung = "conversation";

/** The rung's query param. Short because it is rewritten on every zoom. */
const RUNG_PARAM = "z";

/**
 * The rung named by a query string, or null when absent/unrecognised. Null is
 * the caller's signal to use `DEFAULT_RUNG` — an unknown `z` is a stale or
 * hand-edited link, and answering it with a valid rung would silently ignore
 * what the URL said.
 */
export function parseRungParam(search: string): FieldRung | null {
  const raw = new URLSearchParams(search).get(RUNG_PARAM)?.trim();
  if (!raw) return null;
  return (RUNG_ORDER as readonly string[]).includes(raw)
    ? (raw as FieldRung)
    : null;
}

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

/** The query string for a rung, with an optional reading-position anchor. The
 *  default rung is written as NO param, so the common case has a clean URL. */
export function rungHref(rung: FieldRung, at?: string | null): string {
  const params = new URLSearchParams();
  if (rung !== DEFAULT_RUNG) params.set(RUNG_PARAM, rung);
  if (at) params.set("at", at);
  const q = params.toString();
  return q ? `/?${q}` : "/";
}
