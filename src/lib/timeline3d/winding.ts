/**
 * Winding geometry — the pure layer behind the left band's strand lines
 * (v0.11, doc/design/v0.11-strand-field.md §2.2).
 *
 * THE MODEL IS A COAXIAL CABLE. The core timeline is the centre conductor; the
 * strand lines are the shield braid. A strand runs the WHOLE height of the band
 * — it has no beginning and no end, so a line never starts or stops; a strand
 * that has not come up in a year still has its line, it is simply straight
 * there.
 *
 * ONE CYLINDER, ALWAYS. Every strand lies ON A CYLINDER around the core at
 * every height. There is NO second configuration and nothing to blend between:
 * the flat row of the previous model is gone. The only variable is HOW FAR the
 * strand has rotated around that cylinder at a given height:
 *
 *   angle(y) = seat(i, count) + spin(y)
 *   x(y)     = radius · cos(angle)
 *   z(y)     = radius · sin(angle)
 *   y        = y
 *
 * `seat(i, count)` (`laneAngleFor`) is the strand's own seat, evenly spaced
 * around the circumference — the only per-strand term in the whole model.
 * `spin(y)` (`spinAt`) is the SHARED rotation: ONE scalar for the entire
 * bundle at that height, 0 away from the active card and a full `turns` around
 * it to form the braid.
 *
 * TWO STATES, ONE FORMULA — only `spin` differs:
 *
 *   spin = 0        a straight vertical line on the cylinder. From the side the
 *                   bundle reads as parallel vertical lines at DIFFERENT
 *                   DEPTHS — some in front, some behind.
 *   spin = 0 → 2π·turns   a helix on the cylinder: the braid, and only across
 *                   the knot.
 *
 * THE REST STATE IS NOT A FLAT PLANE. Every strand sits at the SAME radius but
 * a DIFFERENT angle, hence a different `z`. That is the whole point of the
 * model: the earlier "flat row at rest, ring at the knot" version put every
 * strand at the same depth away from the card and the user rejected exactly
 * that ("等于 z 轴距离都是一样的").
 *
 * NOTHING GATHERS INWARD and nothing moves in or out: the radius is FIXED, the
 * same for every strand at every height. The old pinch toward the core at the
 * knot (`radiusEnvelopeAt`) and the row that lay further out than the ring
 * (`restPoint` / `REST_SPREAD_RATIO`) are both gone — the cross-section is one
 * circle and the winding only ever changes the ANGLE.
 *
 * THE ROTATION IS SHARED — the bundle turns as one and no strand ever turns on
 * its own account. That is what makes it read as a braid instead of as loose
 * threads, and it is why `spinAt` takes no strand index.
 */

/**
 * One on-screen slice, as the right pane sees it: where it sits vertically,
 * and which strands it carries.
 *
 * The right pane is the single source of truth for WHERE things are — the band
 * never re-derives the layout. It receives these, groups them by strand, and
 * draws each strand's line winding at the heights its slices occupy. That is
 * what keeps the two sides registered (doc §2.3): the band is not a parallel
 * visualization, it is the same layout seen as threads.
 */
export interface FieldAnchor {
  /** Screen-Y fraction, 0 = top of the shared viewport, 1 = bottom. */
  y: number;
  /** Strands carried by the slice rendered at this anchor. */
  strands: readonly string[];
}

/** Every anchor's height, grouped by the strand carried there. */
export function activityYsByStrand(
  anchors: readonly FieldAnchor[],
): Map<string, number[]> {
  const byStrand = new Map<string, number[]>();
  for (const a of anchors) {
    for (const s of a.strands) {
      const list = byStrand.get(s);
      if (list) list.push(a.y);
      else byStrand.set(s, [a.y]);
    }
  }
  return byStrand;
}

/**
 * The strands to draw: the `limit` carried by the most anchors in view.
 *
 * Ranking is purely by how present a strand is here — a strand the user is
 * swimming in outranks one mentioned once. Ties break on the name so the set
 * is deterministic: without a stable tiebreak the line-up would reshuffle on
 * every frame as counts drift by one, and the band would flicker.
 *
 * A `limit` of <= 0 means "no limit" (callers that want everything).
 */
export function topStrands(
  anchors: readonly FieldAnchor[],
  limit: number,
): string[] {
  const byStrand = activityYsByStrand(anchors);
  const ranked = [...byStrand.entries()]
    .map(([name, ys]) => ({ name, count: ys.length }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  return (limit > 0 ? ranked.slice(0, limit) : ranked).map((r) => r.name);
}

/** Clamped smoothstep on [0, 1] — 0 below, 1 above, C¹ across. */
export function smoothstep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * How strongly the braid is wound at a height, 0..1 — the height profile of a
 * knot, independent of the strands.
 *
 * One bump, centred on the ACTIVE card: 1 at its centre, falling smoothly to
 * 0 at +/-`lambda`. `lambda` is tied to the active card's on-screen height, so
 * the knot is exactly as tall as the card it belongs to — and because that
 * height shrinks as the camera pulls back, the same number of turns is spent
 * over a shorter distance when zoomed out and a longer one when zoomed in.
 * The apparent rotation speed therefore follows the zoom for free; it is not
 * a separate mechanism.
 *
 * Kept as the band's shape-of-a-knot primitive (the cylinder model itself gets
 * its winding from `spinAt`); the tests pin the bump's exactness at the edges,
 * which is what any consumer of a knot window needs.
 */
export function wrapWeightAt(
  worldY: number,
  centerY: number,
  lambda: number,
): number {
  if (lambda <= 0) return worldY === centerY ? 1 : 0;
  const t = (worldY - centerY) / lambda;
  if (t <= -1 || t >= 1) return 0;
  const c = Math.cos((Math.PI / 2) * t);
  return c * c;
}

/**
 * The SHARED rotation at a height, radians: the one angle every strand at this
 * height is turned by.
 *
 * A single monotone sweep of `turns` full turns across the knot, built from
 * `smoothstep01` progress — exactly 0 below the knot, `turns` full turns at
 * its far edge. It takes no strand index: no strand can wind on its own.
 *
 * Because the sweep ends on a whole number of turns (the caller's `TURNS` is
 * an integer), the strand is back on its OWN seat above the knot: the helix
 * closes, and the line above the card is once again a straight vertical line
 * at that seat, indistinguishable from the line below it. That closure is what
 * lets one formula cover the whole height — the extra rotation is a whole turn,
 * so it is not an offset the rest of the band has to absorb.
 *
 * `lambda <= 0` means no knot at all: the rotation is 0 everywhere.
 */
export function spinAt(
  worldY: number,
  centerY: number,
  lambda: number,
  turns: number,
): number {
  if (lambda <= 0) return 0;
  const progress = smoothstep01(((worldY - centerY) / lambda + 1) / 2);
  return Math.PI * 2 * turns * progress;
}

/**
 * A strand's position at a height. `y` is echoed back so the point is a
 * complete position the caller can write straight into a buffer.
 */
export interface StrandPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * The position of strand `index` of `count` at height `worldY` — the cylinder
 * model, whole. See the file header for the formula.
 *
 * - `radius` is the ONE cylinder the whole bundle lives on. It is a caller
 *   constant (the band's own width decides it), never derived per strand: every
 *   strand is at EXACTLY this distance from the axis at every height, so the
 *   cross-section is a circle and the winding only ever moves a line around it.
 * - `lambda` and `centerY` define the knot: the active card's half-height and
 *   its world centre (unchanged semantics). Away from that window the shared
 *   spin is 0 and every strand is a straight vertical line at its own seat.
 * - `index` may be fractional: the line-up joint (§2.5) eases a strand between
 *   seats, and this slides it around the circumference rather than popping it
 *   across.
 * - `winding` (0..1) is the transient amplitude the two transitions need — the
 *   line-up joint (a line still winding up, or already unwinding, §2.5) and
 *   focus (the selected line runs straight up its own seat while the rest of
 *   the bundle keeps the knot). It scales the SHARED spin for that one strand
 *   during the transition and nothing else: the strand stays on the cylinder
 *   either way, and at 1 it is an ordinary member of the bundle. It is clamped,
 *   and a non-finite value is treated as 1, so a caller can never fling a line
 *   off the cylinder or poison the buffer with NaN.
 */
export function strandPointAt(
  worldY: number,
  index: number,
  count: number,
  centerY: number,
  lambda: number,
  radius: number,
  turns: number,
  winding = 1,
): StrandPoint {
  const w = Number.isFinite(winding) ? Math.min(1, Math.max(0, winding)) : 1;
  const angle =
    laneAngleFor(index, count) +
    spinAt(worldY, centerY, lambda, turns) * w;
  return {
    x: radius * Math.cos(angle),
    y: worldY,
    z: radius * Math.sin(angle),
  };
}

/**
 * The lane angle for strand `index` of `count` — its seat around the core.
 *
 * Strands are spread evenly so the bundle reads as a cross-section rather than
 * a stack. Order is stable for a given count, so a strand keeps its seat while
 * the set is unchanged and the lines do not shuffle under the user.
 *
 * This is the model's only per-strand term: the seats are what make two strands
 * at the same height sit at different angles — and therefore at different
 * depths — with no winding at all.
 */
export function laneAngleFor(index: number, count: number): number {
  if (count <= 0) return 0;
  return (index / count) * Math.PI * 2;
}

/**
 * Depth of strand `index`'s lane in 0..1 — how far forward its lane sits.
 *
 * The cylinder is at one radius for every strand, so this does not move a line
 * through space: it is the SHADING half of the volume. `laneBrightness` shades
 * a near lane brighter than a far one, which is what keeps a narrow band
 * reading as a volume instead of a flat set of lines. The alternation is
 * deliberate — a monotone ramp would shade as a flat fan.
 */
export function laneDepthFor(index: number, count: number): number {
  if (count <= 1) return 0.5;
  const spread = index / (count - 1) - 0.5; // -0.5 .. 0.5
  const side = index % 2 === 0 ? 1 : -1;
  const depth = 0.5 + side * 0.18 + spread * 0.18;
  return Math.max(0, Math.min(1, depth));
}
