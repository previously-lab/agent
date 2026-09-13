/**
 * Strand-set transitions (v0.11, doc/design/v0.11-strand-field.md §2.5) — the
 * pure layer behind the band's line-up change.
 *
 * Scrolling into a different region changes WHICH strands the band draws. That
 * change must be a joint, not a cut: a strand that drops out of the set unwinds
 * into its lane and then fades; a strand that joins fades in and winds up; a
 * strand that stays keeps its seat, so the bundle never re-deals under the user.
 *
 * Three pure pieces, kept out of `winding.ts` (the geometry contract) so that
 * frozen module stays untouched:
 *  - `lineUpFor` decides WHICH strands one frame draws, and in what order.
 *  - `joinStrandSets` reconciles the previous draw order against the new set.
 *  - `strandEnvelope` is one strand's winding amplitude and opacity over the
 *    joint. For a LEAVING strand the amplitude reaches zero before the fade
 *    bites, so the line visibly unwinds and only then disappears.
 */
import { normalizeStrandName } from "./ink";
import { smoothstep01 } from "./winding";

/** How one line-up reconciles with the next. */
export interface StrandSetJoin {
  /**
   * The next draw order: retained strands first (in their existing order),
   * joined strands appended in their new rank order. A strand that stays
   * therefore keeps its index; only compaction of departed seats moves it.
   */
  order: string[];
  /** In both sets — keep their seats, no reshuffle. */
  retained: string[];
  /** Only in the next set — wind up from zero. */
  joined: string[];
  /** Only in the previous set — unwind, fade, then go. */
  departed: string[];
}

/**
 * Reconcile the previous draw order against the next set of strands.
 *
 * Retained strands keep their relative order — NOT the new set's — because the
 * band's whole promise is that a line is the same string from frame to frame:
 * re-ranking them would slide lines past each other under the user's eye. New
 * strands append in the order they ranked, so a strand that enters takes a free
 * seat at the end rather than displacing one that is already there.
 */
export function joinStrandSets(
  previousOrder: readonly string[],
  next: readonly string[],
): StrandSetJoin {
  const nextSet = new Set(next);
  const prevSet = new Set(previousOrder);
  const retained = previousOrder.filter((name) => nextSet.has(name));
  const joined = next.filter((name) => !prevSet.has(name));
  const departed = previousOrder.filter((name) => !nextSet.has(name));
  return { order: [...retained, ...joined], retained, joined, departed };
}

/**
 * The strands one frame draws, in order (v0.12).
 *
 * THE LINE-UP IS THE MOMENT, NOT THE WINDOW. It used to be `topStrands` — a
 * ranking over every anchor in view, i.e. "the threads you are currently
 * swimming in". That answered a different question from the one the strip is
 * actually asked, and it had a second, worse cost: with the right pane
 * filtered by a strand, the window collapses to the matching rows, so
 * selecting a thread EMPTIED the band down to that one line. The highlight had
 * nothing left to stand against — the gesture looked like it did nothing.
 *
 * The base is therefore the ACTIVE anchor's own strands: the anchor the knot
 * is wound around, so the braid and the twist agree about which moment the
 * strip is describing. `base` is passed in rather than derived here because
 * the caller owns the anchor list and the ambient fallback for a pane that has
 * published nothing yet.
 *
 * THE SELECTION IS MERGED IN AND NEVER DROPPED. With the right pane filtered
 * by it the active unit already carries it, so this is a safety net — but a
 * highlight that vanished mid-scroll would make the gesture look broken, and
 * that is the one outcome worth spending a few lines to make impossible.
 *
 * ORDER is the base's own (first-seen), selections appended. That matters less
 * than it looks: `joinStrandSets` keeps the previous frame's order for every
 * strand present in both sets, so this order only decides where a NEW line
 * appears, never where an established one sits.
 *
 * Two spellings of one strand are ONE line — the same `normalizeStrandName`
 * that `strandColor` hashes by, so the drawn set and the highlight set can
 * never disagree about which names are the same strand.
 *
 * A `limit` of <= 0 means "no limit".
 */
export function lineUpFor(
  base: readonly string[],
  selected: readonly string[],
  limit: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string): void => {
    const key = normalizeStrandName(name);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const name of base) push(name);
  for (const name of selected) push(name);
  if (limit <= 0 || out.length <= limit) return out;

  // Over the cap, the reader's own picks are the last to go: they are the only
  // lines carrying colour, and a strip that dropped one of them to keep a grey
  // would be lying about what is being followed.
  const picked = new Set(selected.map((n) => normalizeStrandName(n)));
  const kept = out.filter((name) => picked.has(normalizeStrandName(name)));
  if (kept.length >= limit) return kept.slice(0, limit);
  for (const name of out) {
    if (kept.length >= limit) break;
    if (!picked.has(normalizeStrandName(name))) kept.push(name);
  }
  return kept;
}

/**
 * Share of a leaving strand's joint that elapses before its fade begins. The
 * unwind leads the fade so the line is already back in its lane — straight and
 * in place — by the time it thins out; fading and unwinding at once reads as a
 * line being cut, which is precisely what §2.5 rules out.
 */
export const LEAVE_FADE_AFTER = 0.55;

/** One strand's joint state: how wound it is, and how visible. */
export interface StrandEnvelope {
  /** 0..1 multiplier on the winding amplitude (0 = straight in its lane). */
  amplitude: number;
  /** 0..1 multiplier on the line's opacity. */
  opacity: number;
  /** True once the joint has run its course (the caller then settles or frees
   *  the strand). */
  done: boolean;
}

/**
 * Amplitude and opacity at `progress` (0 = joint start, 1 = end) through a
 * joint. A joining strand fades in AS it winds up (both rise together — a line
 * that wound up while invisible would appear already knotted); a leaving strand
 * unwinds first and fades after `LEAVE_FADE_AFTER`. The two ramps are exact
 * mirrors, so reversing a departure mid-fade (a strand re-entering the set)
 * resumes from the amplitude it had.
 *
 * Out-of-range or non-finite progress is treated as "joint complete", so a
 * caller that never ticks the clock still ends up in a settled state.
 */
export function strandEnvelope(
  progress: number,
  leaving: boolean,
): StrandEnvelope {
  const t = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 1;
  if (!leaving) {
    const e = smoothstep01(t);
    return { amplitude: e, opacity: e, done: t >= 1 };
  }
  const amplitude = 1 - smoothstep01(t);
  const fade = (t - LEAVE_FADE_AFTER) / (1 - LEAVE_FADE_AFTER);
  return { amplitude, opacity: 1 - smoothstep01(fade), done: t >= 1 };
}
