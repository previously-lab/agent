/**
 * Pure helpers for the chat ⇄ timeline view switch (v0.11 shell refactor).
 *
 * The view is now a search param on the single `/` route:
 *   - absent `view` (or any value other than `timeline`) = chat view
 *   - `?view=timeline` = timeline view
 * `?at=<sliceId>` still carries the reading position both ways: chat → timeline
 * docks the 3D camera at that node; timeline → chat pages the slice into the
 * stream and scroll-lands on its seam.
 */

export type ViewMode = "chat" | "timeline";

const VIEW_PARAM = "view";
const TIMELINE_VIEW = "timeline";

/** Read the view mode from a query string (with or without the leading `?`). */
export function modeFromSearch(search: string): ViewMode {
  const view = new URLSearchParams(search).get(VIEW_PARAM);
  return view === TIMELINE_VIEW ? "timeline" : "chat";
}

/** Kept for call-sites that only have a pathname; the /timeline route is gone. */
export function modeFromPathname(_pathname: string): ViewMode {
  return "chat";
}

/**
 * Extract a valid `at` anchor from a query string (with or without the
 * leading `?`). Blank values and the sentinel "now" are no anchor at all —
 * "now" is the timeline's default camera position.
 */
export function parseAtParam(search: string): string | null {
  const at = new URLSearchParams(search).get("at")?.trim();
  return at && at !== "now" ? at : null;
}

/**
 * Remove the `at` param from a query string, returning the remaining query
 * (with leading `?`) or an empty string — the chat page consumes the anchor
 * once, then strips it so a refresh doesn't re-jump.
 */
export function stripAtParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("at");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Remove both `at` and `view` params from a query string, returning the
 * remaining query (with leading `?`) or an empty string.
 */
export function stripViewAndAt(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("at");
  params.delete(VIEW_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The chat href carrying an optional reading-position anchor. */
export function chatHref(at: string | null): string {
  return at ? `/?at=${encodeURIComponent(at)}` : "/";
}

/** The timeline href carrying an optional reading-position anchor. */
export function timelineHref(at: string | null): string {
  return at
    ? `/?${VIEW_PARAM}=${TIMELINE_VIEW}&at=${encodeURIComponent(at)}`
    : `/?${VIEW_PARAM}=${TIMELINE_VIEW}`;
}
