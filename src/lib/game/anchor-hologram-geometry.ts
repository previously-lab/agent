/**
 * AnchorHologramGeometry — the pure layer behind the room anchor's
 * holographic form (the §13.1 machine, redrawn as a miniature of the
 * left band's braid).
 *
 * THE MODEL IS THE BAND'S MODEL. The timeline3d winding layer
 * (`@/lib/timeline3d/winding.ts`) is the only geometry this module knows:
 * one cylinder around a straight core, every thread on that cylinder at
 * every height, `angle(y) = seat(i, count) + spin(y)`, with ONE knot —
 * the room's own slice — swept by `strandPointAt`. There is no second
 * configuration and nothing here re-derives the braid; the hologram is the
 * coaxial cable standing in the room: the braid at eye height, the core
 * climbing above the walls, threads few enough to stay a braid.
 *
 * WHAT THE THREADS ARE (data → braid, the whole reason the shape varies):
 *  - The CORE line is the room's own timeline — a straight vertical tube,
 *    the spine the band's core is.
 *  - Each STRAND thread is one strand (线索) passing through this slice —
 *    the same list the room's strand doors resolve from
 *    (`RoomDoor.strands`, activity-ordered by the strand-doors lane). A
 *    strand thread winds the knot like any band strand: straight at its
 *    seat above and below, braided through this slice's window.
 *  - Each NEIGHBOR thread is one newer slice of the same corridor window.
 *    A room knows exactly the slices NEWER than its own (flat indices are
 *    dense below the newest one): `neighborSlots = door.index %
 *    WINDOW_SLICES`. Older slots may not exist (a partial last window), so
 *    they are never claimed — the count is what the data can prove. More
 *    neighbors or more strands ⇒ more seats ⇒ a denser ring, which is the
 *    "形状随数据疏密变化" requirement, kept honest.
 *
 * SEAT ORDER IS STRANDS FIRST. Strands are the meaningful doors, so they
 * claim the low seats; neighbors top the bundle up. The total is capped at
 * HOLO_STRAND_MAX — the same moiré discipline the band's narrow tier
 * follows (evenly-spaced seats under one shared spin cross on a regular
 * rhythm; past a handful of lines the eye reads the beat pattern, not the
 * threads).
 *
 * EVERYTHING HERE IS A PURE FUNCTION OF THE INPUT DATA. No clock, no RNG,
 * no seeds: the same (strands, neighborSlots) always bakes the identical
 * bytes (axiom A6 — the layout is data, only the spin in the component is
 * time). The shading is the band's fake light, computed in the cable's own
 * frame: per-sample `sinT` depth modulated by the seat's lane depth
 * (`laneDepthFor`), brightness bounded per thread kind so the bundle reads
 * as a volume and the core stays the landmark.
 */

import {
  laneDepthFor,
  strandPointAtKnots,
} from "@/lib/timeline3d/winding";

/* ------------------------------------------------------------------ */
/* Dimensions (world meters at construction scale 1)                  */
/* ------------------------------------------------------------------ */

/** Cable start above the emitter base. */
export const HOLO_BOTTOM = 0.14;
/** Cable top — TALL ON PURPOSE: 2.9 m clears the cutaway sills (1.1 m)
 *  and even a full-height wall in the 45° top-down camera, so the
 *  hologram's crown is never eaten by the masonry. The braid itself
 *  stays at human height (HOLO_CENTER_Y); only the straight column
 *  tail rises above the walls. */
export const HOLO_TOP = 2.9;
/** ONE cylinder radius for the whole bundle (the winding never changes it). */
export const HOLO_RADIUS = 0.3;
/** The knot's centre — the face of the old machine (its screen sat at
 *  1.06 m), so the braid reads at eye height while the column tail
 *  climbs to HOLO_TOP above the walls. */
export const HOLO_CENTER_Y = 1.15;
/** Half-height of ONE knot window. Two of them, blended, spread the twist
 *  over the object's whole height (see HOLO_KNOT_SPREAD) — a knot confined
 *  to a short window left the threads straight for two thirds of their
 *  length and coiling in the middle, which reads as a spring spliced into
 *  two straight rods. Each knot still eases at its own edges, and the wide
 *  window keeps the blended rate flat through the middle. */
export const HOLO_KNOT_LAMBDA = 1.4;
/** The two knot centres sit this far above and below the slice
 *  (`HOLO_CENTER_Y ± HOLO_KNOT_SPREAD`), equally weighted. Two smoothsteps
 *  one radius apart sum to a trapezoid: eased at both ends, and a nearly
 *  CONSTANT pitch between them — what a real coil's twist rate looks like. */
export const HOLO_KNOT_SPREAD = 0.55;
/** Full turns across the whole knot blend. Integral, so the coil's lower end
 *  still sits close to the threads' own seats (the bottom ring is visible and
 *  the base disc anchors it). TWO over the threads' 2.26 m is a pitch of
 *  ~1.1 m ≈ 3.8× the bundle radius: a relaxed spiral, which is what the reader
 *  asked for after seeing three and four. (Note how the earlier cage read:
 *  three turns inside a 0.88 m window — the count was never the problem, the
 *  cramming was.) */
export const HOLO_TURNS = 2;
/** Vertical samples per line. 96 over the THREADS' span (2.26 m) is 2.4 cm a
 *  segment, so the coil is drawn with ~60 chords per turn instead of ~23 —
 *  the facets stop reading as a polygon. */
export const HOLO_SEGMENTS = 96;
/** Where the THREADS stop. The knot blend eases out at both extremes (that is
 *  what keeps the pitch even through the middle), which means the last stretch
 *  of every thread is nearly vertical — four straight antennae above a coil,
 *  which the reader rejected on sight. So the bundle is cut where it is still
 *  winding (a coil sawn off mid-turn, like a real spring's end), and only the
 *  CORE climbs to HOLO_TOP: the spine is the straight line that is supposed to
 *  peek over the walls and say where the hologram is. */
export const HOLO_THREAD_TOP = 2.4;
/** The two knots the bake blends, in the winding's own vocabulary. */
export const HOLO_KNOTS = [
  { centerY: 0, lambda: HOLO_KNOT_LAMBDA, weight: 0.5 },
  { centerY: 0, lambda: HOLO_KNOT_LAMBDA, weight: 0.5 },
] as const;
/** How many NEIGHBOUR lines the bare case draws. The count of strands is the
 *  data now (one line per strand — a hub wears a dense braid, a solitary
 *  moment almost none), so neighbours are only a floor: a slice that touches
 *  nothing at all still gets a few context lines instead of a bare pole. */
export const HOLO_NEIGHBOR_FALLBACK_MAX = 3;
/** The line cap — SEVEN, matching the timeline's own bundle (the band's narrow
 *  tier reads at most this many strand lines before the eye starts reading the
 *  beat pattern instead of the threads). Strands claim the lines in order; a
 *  slice touching more than seven wears the busiest braid the language has. */
export const HOLO_STRAND_MAX = 7;
/** Tube radii (world): the core is the spine (a touch heavier, it is
 *  the one line allowed to bloom), threads are hairlines that must not
 *  compete with it. */
export const HOLO_CORE_RADIUS = 0.022;
export const HOLO_STRAND_RADIUS = 0.01;
export const HOLO_NEIGHBOR_RADIUS = 0.0085;
/** The rigid self-spin rate (rad/s) — one turn in ~52 s, 缓慢 by design.
 *  This is the ONLY quantity here the component animates, and it is a pure
 *  function of the clock; it never feeds back into the geometry. */
export const HOLO_SPIN_SPEED = 0.12;

/* ------------------------------------------------------------------ */
/* Ink                                                                */
/* ------------------------------------------------------------------ */

/** Strand-thread brightness bounds (multiplied into the bundle grey by
 *  the material): mid grey, clearly under the core — the threads inform,
 *  the core landmarkes. */
export const HOLO_STRAND_BRIGHTNESS: readonly [number, number] = [0.65, 1.0];
/** Neighbor threads are context, not doors — the quiet half of the
 *  bundle's range. */
export const HOLO_NEIGHBOR_BRIGHTNESS: readonly [number, number] = [0.3, 0.6];
/** The bundle's overall gain (multiplied into the grey ON TOP of the
 *  per-segment brightness). Above 1 it pushes the brighter threads past
 *  the bloom threshold — the strands pick up a soft halo and the whole
 *  cradle glows, while the neighbours (0.3–0.6 of the range) stay matte
 *  and keep the core the landmark. Measured against the grey's linear
 *  blue (0.72): 1.45 just grazes the threshold at full brightness, 1.65
 *  gives the strands a halo you can actually see, and past ~2 the bundle
 *  lights the room like a lamp of its own. */
export const HOLO_BUNDLE_GLOW = 1.65;
/** The band's lane-light constants — nearer lanes read brighter, with the
 *  alternation that keeps a narrow bundle reading as a volume. */
export const HOLO_LANE_BRIGHTNESS_MIN = 0.75;
export const HOLO_LANE_BRIGHTNESS_SPAN = 0.5;
/** The band's per-sample depth shading floor (a thread never goes black). */
export const HOLO_DEPTH_FLOOR = 0.2;

/* ------------------------------------------------------------------ */
/* Thread selection                                                   */
/* ------------------------------------------------------------------ */

export type HoloThreadKind = "strand" | "neighbor";

/** One thread of the bundle: its seat in the line-up and the line-up's
 *  size (both feed `laneAngleFor`/`laneDepthFor`, exactly as the band's
 *  line-up does). */
export interface HoloThread {
  readonly kind: HoloThreadKind;
  /** Seat index 0..count-1 — the ONLY per-thread term in the model. */
  readonly seat: number;
  /** Total threads drawn this bake — the count every seat is measured in. */
  readonly count: number;
}

/**
 * The bundle for one room: ONE THREAD PER STRAND — as many lines as the slice
 * really touches, up to HOLO_STRAND_MAX (seven, the timeline's own ceiling) —
 * so the count is data, not decoration and you can read the room's place in
 * the network off its machine. Neighbours are a floor only: when the slice
 * touches nothing at all, a few context threads stand in for the empty bundle.
 * Pure, order-stable, and data-dense in exactly the two quantities the room
 * actually knows.
 */
export function holoThreadsFor(
  strands: readonly string[],
  neighborSlots: number,
): HoloThread[] {
  const sCount = Math.min(
    HOLO_STRAND_MAX,
    Math.max(0, Math.floor(strands.length)),
  );
  const nCount =
    sCount > 0
      ? 0
      : Math.min(
          Math.max(0, Math.floor(neighborSlots)),
          HOLO_NEIGHBOR_FALLBACK_MAX,
        );
  const count = sCount + nCount;
  const out: HoloThread[] = [];
  for (let i = 0; i < sCount; i++) {
    out.push({ kind: "strand", seat: i, count });
  }
  for (let i = 0; i < nCount; i++) {
    out.push({ kind: "neighbor", seat: sCount + i, count });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Line bakes                                                         */
/* ------------------------------------------------------------------ */

/**
 * One baked line: the polyline samples (segments + 1 points, x/y/z
 * interleaved) and one grey brightness per segment. Positions are written
 * in the cable's own frame — the component places cylinder instances on
 * them once, then only ever spins the whole group.
 */
export interface HoloLineBake {
  readonly kind: "core" | HoloThreadKind;
  readonly points: Float32Array;
  readonly brightness: Float32Array;
}

/** The core: a straight vertical line on the axis — the spine the bundle
 *  wraps around, exactly the band's core. Brightness is unused (the core's
 *  ink rides on its material colour, as the band's core does).
 */
export function holoCoreBake(): HoloLineBake {
  const n = HOLO_SEGMENTS + 1;
  const points = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / HOLO_SEGMENTS;
    points[i * 3] = 0;
    points[i * 3 + 1] = HOLO_BOTTOM + t * (HOLO_TOP - HOLO_BOTTOM);
    points[i * 3 + 2] = 0;
  }
  return {
    kind: "core",
    points,
    brightness: new Float32Array(HOLO_SEGMENTS),
  };
}

/**
 * Bake one bundle thread through the room's knot — `strandPointAt` with
 * the thread's own seat, one cylinder, HOLO_TURNS whole turns across
 * ±HOLO_KNOT_LAMBDA. Because TURNS is integral every thread leaves the
 * knot back on its own seat: straight above, straight below, braided in
 * between — the band's two-states-one-formula, frozen into bytes.
 *
 * Per-segment brightness is the band's volume shading read in the cable
 * frame: how far forward the sample sits (`sinT` of its cylinder angle)
 * scaled by the seat's lane depth, mapped into the kind's brightness
 * range. The component multiplies these into the bundle grey, so a far
 * flank recedes while the bundle still reads as one object.
 */
export function holoThreadBake(thread: HoloThread): HoloLineBake {
  const n = HOLO_SEGMENTS + 1;
  const points = new Float32Array(n * 3);
  const brightness = new Float32Array(HOLO_SEGMENTS);
  const [floor, ceiling] =
    thread.kind === "strand"
      ? HOLO_STRAND_BRIGHTNESS
      : HOLO_NEIGHBOR_BRIGHTNESS;
  const laneBrightness =
    HOLO_LANE_BRIGHTNESS_MIN +
    HOLO_LANE_BRIGHTNESS_SPAN * laneDepthFor(thread.seat, thread.count);
  const knots = HOLO_KNOTS.map((k) => ({
    centerY: HOLO_CENTER_Y + k.centerY,
    lambda: k.lambda,
    weight: k.weight,
  }));
  for (let i = 0; i < n; i++) {
    const y =
      HOLO_BOTTOM + (i / HOLO_SEGMENTS) * (HOLO_THREAD_TOP - HOLO_BOTTOM);
    const p = strandPointAtKnots(
      y,
      thread.seat,
      thread.count,
      knots,
      HOLO_RADIUS,
      HOLO_TURNS,
    );
    points[i * 3] = p.x;
    points[i * 3 + 1] = p.y;
    points[i * 3 + 2] = p.z;
    if (i < HOLO_SEGMENTS) {
      const axisDistance = Math.hypot(p.x, p.z);
      const sinT = axisDistance > 0 ? p.z / axisDistance : 0;
      const depthFactor = HOLO_DEPTH_FLOOR + (1 - HOLO_DEPTH_FLOOR) * ((sinT + 1) / 2);
      const strength = Math.min(1, depthFactor * laneBrightness);
      brightness[i] = floor + (ceiling - floor) * strength;
    }
  }
  return { kind: thread.kind, points, brightness };
}
