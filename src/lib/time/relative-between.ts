/**
 * The app's ONE interval humanizer: how far apart two instants are, in the
 * vocabulary every relative-time surface shares — the travel clock, the slice
 * seam's gap marker, and the home dateline.
 *
 * It lives in `lib` rather than beside those faces because the HOME is a server
 * component and decides its dateline with the same thresholds; a ladder that
 * only the client could reach would have to be grown a second time there, which
 * is exactly what this module exists to prevent. Pure, no I/O, never throws —
 * unparseable input returns null and each caller says its own fallback.
 */

export type RelativeUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

export type RelativeResult =
  | { kind: "moments"; dir: "before" | "after" }
  | { kind: "count"; dir: "before" | "after"; unit: RelativeUnit; count: number }
  | null;

/**
 * The delta FROM `fromIso` TO `toIso`, for the label. Anchored to `fromIso` —
 * the slice the viewer is currently ON — so traveling from a past slice back
 * to "now" reads as "1 year later", not "moments ago".
 */
export function relativeBetween(fromIso: string, toIso: string): RelativeResult {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  const diff = b - a;
  const abs = Math.abs(diff);
  const dir = diff < 0 ? "before" : "after";
  if (abs < 5 * 60_000) return { kind: "moments", dir };
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return { kind: "count", dir, unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "count", dir, unit: "hour", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { kind: "count", dir, unit: "day", count: days };
  if (days < 35) return { kind: "count", dir, unit: "week", count: Math.floor(days / 7) };
  if (days < 365) return { kind: "count", dir, unit: "month", count: Math.floor(days / 30) };
  return { kind: "count", dir, unit: "year", count: Math.floor(days / 365) };
}

/**
 * Does this reading still belong in prose? True while the ladder counts
 * moments, minutes, hours or days — its `day` bucket ends at a week — and false
 * for anything it would measure in weeks, months or years, which the date
 * itself serves better than "7 周前".
 *
 * A destination in the FUTURE is false too: `dir` is then `after`, which means
 * a skewed clock rather than an interval, and the honest thing to show for a
 * timestamp recorded tomorrow is the timestamp.
 */
export function isRecentInterval(rel: RelativeResult): boolean {
  return (
    rel !== null &&
    rel.dir === "before" &&
    (rel.kind === "moments" ||
      (rel.kind === "count" &&
        (rel.unit === "minute" || rel.unit === "hour" || rel.unit === "day")))
  );
}
