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
 * The result is a regular diamond lattice, because evenly-spaced seats under
 * one shared spin cross on a perfectly even rhythm. That is what an ideal
 * braid looks like and it is left alone: a per-strand phase offset was tried
 * as a way to break the regularity and made no visible difference, so the
 * model keeps the simpler, exact form.
 *
 * TWO STATES, ONE FORMULA — only `spin` differs:
 *
 *   spin = 0        a straight vertical line on the cylinder. From the side the
 *                   bundle reads as parallel vertical lines at DIFFERENT
 *                   DEPTHS — some in front, some behind.
 *   spin = 0 → 2π·turns   a helix on the cylinder: the braid, and only across
 *                   the knot.
 *
 * THE TWIST IS CONSERVED, AND HANDED OFF (`spinAtKnots`). A rope's twist
 * cannot be created or destroyed, only moved along it, so the knot is not one
 * card's property. A single knot would have to teleport when the card nearest
 * the viewport centre changes — a whole row pitch in one frame, which reads as
 * the braid snapping back to the start and re-winding at the next card. So the
 * band blends TWO: the nearest card at or above the centre, and the nearest at
 * or below it, weighted `1 - t` and `t`. `t` is the SCRUB parameter — how far
 * the centre has travelled from the first card to the second, a pure function
 * of the scroll position and never a timer. The weights sum to 1, so the total
 * is `turns` WHOLE turns at every `t`: the twist migrates down the cable
 * instead of being remade, and no strand ever leaves its seat.
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
  /**
   * How tall the slice this anchor marks is, as a screen-Y fraction — the
   * anchor's own extent.
   *
   * This is what lets the band size the knot to the CONTENT rather than to
   * the average: lambda is half of this, so the twist spans exactly its slice
   * and is back to 0 at the slice's boundaries. Without it the band has only
   * the pitch between neighbouring anchors, which is the slice height PLUS the
   * gap after it — close, but it pushes the release past the boundary and the
   * seam stops being the clean straight region it is supposed to be.
   *
   * Optional: an anchor may publish only a position, in which case the band
   * falls back to the median pitch.
   */
  span?: number;
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
 * The monotone height profile of ONE knot, 0..1: 0 at and below
 * `centerY - lambda`, 1 at and above `centerY + lambda`, a smoothstep between —
 * C¹ at both edges, so two of them can tile edge to edge without a crease.
 *
 * This is the shape `spinAt` sweeps its turns across, factored out because the
 * two-knot handoff (`spinAtKnots`) needs the same profile knot by knot, and
 * because "how far this knot has wound at this height" is a question other
 * consumers of a knot window legitimately ask.
 *
 * `lambda <= 0` is no knot at all: the profile is 0 everywhere, exactly at the
 * centre included. A zero-length knot is not a step — it is nothing.
 */
export function knotProgress(
  worldY: number,
  centerY: number,
  lambda: number,
): number {
  if (lambda <= 0) return 0;
  return smoothstep01(((worldY - centerY) / lambda + 1) / 2);
}

/** One knot of the shared rotation, for a blend of several: where it sits (in
 *  world units), how long it is, and how much of the twist belongs to it. */
export interface SpinKnot {
  centerY: number;
  lambda: number;
  weight: number;
}

/**
 * The SHARED rotation at a height, radians, for ONE knot — the single-knot case
 * of `spinAtKnots`, and exactly what `spinAtKnots` returns for a lone weight-1
 * knot.
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
  return Math.PI * 2 * turns * knotProgress(worldY, centerY, lambda);
}

/**
 * The SHARED rotation at a height, radians, for a BLEND of knots:
 *
 *   spin(y) = 2π·turns · Σ_k weight_k · knotProgress(y; centerY_k, lambda_k)
 *
 * This is the handoff that lets the twist travel with the observer. One knot
 * would have to teleport when the card nearest the viewport centre changes —
 * a whole row pitch in a single frame, the twist destroyed at the old card and
 * created at the new one. Two knots, weighted `1 - t` and `t` (see the file
 * header), MOVE it instead: as the centre scrubs from one card to the next the
 * twist migrates down the cable, and because the weights sum to 1 the total is
 * ALWAYS `2π·turns` — a whole number of turns — at every `t`. Nothing is
 * created or destroyed, and the strands land back on their own seats above the
 * knots whatever the handoff is doing.
 *
 * Weights are NORMALISED by their own sum, so a caller may pass raw
 * proportions (`{1, 3}` is 0.25 / 0.75) and the conservation above still holds.
 * A weight that is zero or less carries no knot and is SKIPPED — it takes no
 * part in the sum either, because a knot already at weight 0 (the far side of
 * a handoff) must not dilute the live one into a fractional number of turns.
 * The same goes for a knot with no length (`lambda <= 0`): it is not a knot, so
 * it takes neither twist nor weight. A negative or non-finite weight is treated
 * as 0, and a knot whose progress cannot be computed is skipped, so a caller
 * can never invert the profile or poison the vertex buffer with NaN. With no
 * weight left at all (an empty blend) the rotation is 0 everywhere — the same
 * as a bundle with nothing to wind.
 */
export function spinAtKnots(
  worldY: number,
  knots: readonly SpinKnot[],
  turns: number,
): number {
  let weighted = 0;
  let total = 0;
  for (const knot of knots) {
    const weight = knot.weight;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (!(knot.lambda > 0)) continue;
    const progress = knotProgress(worldY, knot.centerY, knot.lambda);
    if (!Number.isFinite(progress)) continue;
    total += weight;
    weighted += weight * progress;
  }
  if (!(total > 0) || !Number.isFinite(total)) return 0;
  return Math.PI * 2 * turns * (weighted / total);
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
 * The cylinder position of a strand whose shared rotation at this height is
 * already known: the seat, the winding clamp and the trig, in the one place
 * both entry points below share — so a two-knot frame is the same geometry as
 * a one-knot frame, not a second implementation of it.
 */
function strandPointForSpin(
  worldY: number,
  index: number,
  count: number,
  spin: number,
  radius: number,
  winding: number,
): StrandPoint {
  const w = Number.isFinite(winding) ? Math.min(1, Math.max(0, winding)) : 1;
  const angle = laneAngleFor(index, count) + spin * w;
  return {
    x: radius * Math.cos(angle),
    y: worldY,
    z: radius * Math.sin(angle),
  };
}

/**
 * The position of strand `index` of `count` at height `worldY` — the cylinder
 * model, whole, for ONE knot. See the file header for the formula.
 *
 * - `radius` is the ONE cylinder the whole bundle lives on. It is a caller
 *   constant (the band's own width decides it), never derived per strand: every
 *   strand is at EXACTLY this distance from the axis at every height, so the
 *   cross-section is a circle and the winding only ever moves a line around it.
 * - `lambda` and `centerY` define the knot: the active card's half-height and
 *   its world centre (unchanged semantics). Away from that window the shared
 *   spin is 0 and every strand is a straight vertical line at its own seat.
 *   For the band's two-knot handoff use `strandPointAtKnots`, which is this
 *   same geometry with a blended spin.
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
  return strandPointForSpin(
    worldY,
    index,
    count,
    spinAt(worldY, centerY, lambda, turns),
    radius,
    winding,
  );
}

/**
 * The position of strand `index` of `count` at height `worldY` under a BLEND of
 * knots — `strandPointAt` with `spinAtKnots` in place of `spinAt`, and the same
 * everything else: one radius, one seat per strand, the same clamped `winding`.
 *
 * This is the band's per-frame call while it hands the twist from one card to
 * the next (see `spinAtKnots`): the line is on the same cylinder at the same
 * seat, and only the shared rotation under it is a blend of two knots rather
 * than one.
 */
export function strandPointAtKnots(
  worldY: number,
  index: number,
  count: number,
  knots: readonly SpinKnot[],
  radius: number,
  turns: number,
  winding = 1,
): StrandPoint {
  return strandPointForSpin(
    worldY,
    index,
    count,
    spinAtKnots(worldY, knots, turns),
    radius,
    winding,
  );
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
