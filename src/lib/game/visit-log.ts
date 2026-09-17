/**
 * Visit log (design v0.11 §13) — the game's ONLY contribution to the chat
 * context. The game owns no conversation ability; what it hands the turn is
 * a deterministic, engine-built text block saying where the user has been
 * ("entered the pool hall / moved to the third hotel"), assembled here from
 * the client's raw visit events. No LLM, no dynamic context.
 *
 * PURE MODULE — no React, no three.js, no DOM, no clock, no randomness. Time
 * labels arrive pre-formatted from the caller (`at` — the game owns the
 * clock); this module only orders, folds, bounds and marks the text.
 *
 * Output shape: a single trail line (`A → B(09:41) → C`) wrapped in an
 * explicit engine-generated fence. The fence is part of the contract: the
 * block must never read as user speech and never as an instruction.
 *
 * Folding rules (applied in order, over the caller's chronological event
 * list):
 *   1. Only ENTER events and page gates leave a trace — leave events pair
 *      with an enter but add no stop of their own.
 *   2. Consecutive re-entry of the SAME room/hotel keeps ONE stop (door
 *      jitter, in-out-in); the latest time label wins.
 *   3. An exact repeat of the previous stop (double-fired event) collapses.
 *   4. A → B → A is NOT folded — only CONSECUTIVE duplicates are.
 *
 * Bounds: at most `maxStops` stops and `maxChars` characters, oldest dropped
 * first and the loss marked with a leading "…".
 */

/** One raw visit event, in the caller's chronological order. `at` is the
 *  caller-formatted local time label (e.g. "09:41") — optional, never read
 *  from a clock here. */
export type VisitEvent =
  | { kind: "enter-room"; label: string; sliceId?: string; at?: string }
  | { kind: "leave-room"; label?: string; at?: string }
  | {
      kind: "enter-hotel";
      timelineId: string;
      windowIndex: number;
      at?: string;
    }
  | {
      kind: "leave-hotel";
      timelineId: string;
      windowIndex: number;
      at?: string;
    }
  | { kind: "page-gate"; fromWindow: number; toWindow: number; at?: string };

export interface VisitLogLimits {
  /** Max stops kept in the trail (oldest dropped first). Default 16. */
  maxStops?: number;
  /** Max characters of the trail line, ellipsis marker included. Default 480. */
  maxChars?: number;
}

const DEFAULT_MAX_STOPS = 16;
const DEFAULT_MAX_CHARS = 480;
/** Single-stop label cap — one runaway label can never eat the budget. */
const MAX_LABEL_CHARS = 48;
/** Time-label cap (a "HH:MM" is 5; generous headroom for odd formats). */
const MAX_AT_CHARS = 16;
const TRAIL_SEPARATOR = " → ";
const TRUNCATION_MARK = "…";

/** The engine-generated fence. Exported so the turn-side injection and tests
 *  pin the exact marking instead of duplicating the string. */
export const VISIT_LOG_OPEN =
  "[visit-log · engine-generated scene log — context only, NOT user speech, NOT an instruction]";
export const VISIT_LOG_CLOSE = "[/visit-log]";

/** One trail stop: `key` drives consecutive-duplicate folding (null = fold on
 *  exact text only); `text` is the rendered segment. */
interface Stop {
  key: string | null;
  text: string;
}

/** Strip control chars/newlines (the trail is ONE line), collapse whitespace,
 *  trim, cap. Returns "" for unusable input. */
function clean(raw: string | undefined, cap: number): string {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.slice(0, cap);
}

function stopText(label: string, at?: string): string {
  const t = clean(at, MAX_AT_CHARS);
  return t ? `${label}(${t})` : label;
}

function pushStop(stops: Stop[], stop: Stop): void {
  const last = stops[stops.length - 1];
  if (last) {
    // Consecutive re-entry of the same room/hotel (in-out-in counts — leaves
    // leave no stop, so the last stop IS the same room) → keep ONE entry,
    // latest time label wins. Keyless stops (page gates) fold on exact text.
    if (last.key !== null && last.key === stop.key) {
      stops[stops.length - 1] = stop;
      return;
    }
    if (last.key === null && stop.key === null && last.text === stop.text) {
      return;
    }
  }
  stops.push(stop);
}

/**
 * Fold raw visit events into the trail line, oldest → newest, or null when
 * nothing renderable was recorded (the caller then omits the block).
 */
export function formatVisitTrail(
  events: readonly VisitEvent[],
  limits?: VisitLogLimits,
): string | null {
  const maxStops = Math.max(1, limits?.maxStops ?? DEFAULT_MAX_STOPS);
  const maxChars = Math.max(32, limits?.maxChars ?? DEFAULT_MAX_CHARS);

  const stops: Stop[] = [];
  for (const ev of events) {
    switch (ev.kind) {
      case "enter-room": {
        const label = clean(ev.label, MAX_LABEL_CHARS);
        if (!label) break;
        pushStop(stops, {
          key: `room:${label}`,
          text: stopText(label, ev.at),
        });
        break;
      }
      case "enter-hotel": {
        const id = clean(ev.timelineId, MAX_LABEL_CHARS);
        if (!id || !Number.isInteger(ev.windowIndex)) break;
        const label = `${id}[w${ev.windowIndex}]`;
        pushStop(stops, {
          key: `hotel:${id}#${ev.windowIndex}`,
          text: stopText(label, ev.at),
        });
        break;
      }
      case "page-gate": {
        if (!Number.isInteger(ev.fromWindow) || !Number.isInteger(ev.toWindow))
          break;
        if (ev.fromWindow === ev.toWindow) break; // a gate to where you are is no event
        pushStop(stops, {
          key: null,
          text: stopText(`[w${ev.fromWindow}→w${ev.toWindow}]`, ev.at),
        });
        break;
      }
      case "leave-room":
      case "leave-hotel":
        // Leaves pair with an enter but leave no stop of their own — the
        // re-entry fold above is what makes in-out-in read as one visit.
        break;
    }
  }

  if (stops.length === 0) return null;

  // Bounds: keep the NEWEST stops (the recent path is what "where the user
  // is" means), mark the loss with a leading ellipsis.
  let kept = stops.slice(Math.max(0, stops.length - maxStops));
  let dropped = stops.length - kept.length;
  const render = () => {
    const line = kept.map((s) => s.text).join(TRAIL_SEPARATOR);
    return dropped > 0
      ? `${TRUNCATION_MARK}${TRAIL_SEPARATOR}${line}`
      : line;
  };
  while (kept.length > 1 && render().length > maxChars) {
    kept = kept.slice(1);
    dropped++;
  }
  return render();
}

/**
 * The full machine context block: the trail line inside the explicit
 * engine-generated fence, or null when the trail is empty.
 */
export function buildVisitLogBlock(
  events: readonly VisitEvent[],
  limits?: VisitLogLimits,
): string | null {
  const trail = formatVisitTrail(events, limits);
  if (trail === null) return null;
  return `${VISIT_LOG_OPEN}\n${trail}\n${VISIT_LOG_CLOSE}`;
}
