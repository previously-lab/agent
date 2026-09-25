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
 * as a volume and the core stays the landmark. On top of that sits the
 * DISSOLVE ENVELOPE (reader decision): every thread keeps an equal radius
 * along its whole length and instead fades out as LIGHT — a brightness
 * envelope brightest at the knot (HOLO_CENTER_Y) that falls smoothly to
 * zero at both ends. Because the post chain's bloom threshold is 1.0, a
 * brightness ramp IS a glow ramp: the ends stop glowing, they do not stop
 * existing, and dissipation never touches line width. The component's
 * materials are all ADDITIVE (black adds nothing), so a zeroed segment
 * contributes no light at all — the dissolve ends in nothing, never in a
 * black tube.
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
/** The rigid self-spin rate (rad/s) — one turn in ~105 s, 缓慢 by design.
 *  This is the ONLY quantity here the component animates, and it is a pure
 *  function of the clock; it never feeds back into the geometry. */
export const HOLO_SPIN_SPEED = 0.06;

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
 *  per-segment brightness, into an ADDITIVE material). The threads sum:
 *  seven strands each near full brightness stack to several times the
 *  single-thread value where the coil overlaps on screen, so this gain is
 *  set for the STACK, not the single wire — ~0.9 lets the denser bundles
 *  graze the bloom threshold where the threads pile up (the strands pick
 *  up a soft halo and the whole cradle glows) while a single quiet
 *  neighbour stays matte and the core keeps the landmark. Past ~1.3 a
 *  seven-strand lobby bundle blows out to flat white. */
export const HOLO_BUNDLE_GLOW = 0.9;
/* Dissolve envelope — the new "fade" (reader decision). The threads keep
 * an EQUAL radius along their whole length (thinning to hairs at the top
 * was rejected); instead every thread's brightness is multiplied by a
 * smooth envelope, brightest at the knot and falling to zero at both
 * ends. Because the post chain blooms at luminance ≥ 1.0, a brightness
 * ramp IS a glow ramp: near the ends the line is still there, it just
 * stops glowing — dissipation comes from light, not from line width. */
/** Upward decay length above the knot: the glow is gone ~0.8 m above
 *  HOLO_CENTER_Y (y ≈ 1.95), so the top of every thread dissolves into
 *  the fog well before HOLO_THREAD_TOP (2.4) instead of stopping at a
 *  visible edge. */
export const HOLO_FADE_UP_SPAN = 0.8;
/** Downward decay length below the knot: shorter than the upward one, so
 *  the column is bottom-heavy — the glow sinks into the plinth over the
 *  last ~0.45 m instead of ending at a bright line above the base. */
export const HOLO_FADE_DOWN_SPAN = 0.45;
/** Envelope curve exponent (both ends): >1 bows the decay so the fall is
 *  gradual at the knot and steep near the tip — the glow lingers through
 *  the braid's middle, then lets go quickly. 1.6 reads as a long smooth
 *  exhale rather than a linear ramp (which would cut at a hard line). */
export const HOLO_FADE_CURVE = 1.6;
/** The CORE's own top fade — kept from the old look but redrawn as LIGHT
 *  instead of radius: the core bake writes brightness scalars (1 for
 *  nearly all of the spine, easing to 0 over the last span below
 *  HOLO_TOP) and the component seeds them as grey instance colours — a
 *  scalar only ever SCALES the blue ink, it never squares it. The spine
 *  keeps its full height AND its dissolving tip; the tube itself is an
 *  equal-radius cylinder. */
export const HOLO_CORE_FADE_SPAN = 0.5;

/* ------------------------------------------------------------------ */
/* Blur shells and the fog column                                     */
/* ------------------------------------------------------------------ */

/** The halo pass: each thread is re-drawn as ONE fatter, dimmer shell —
 *  a glow tube around the wire that reads as a soft edge from every
 *  viewing angle (a pure light scatter, the object never widens). The
 *  shell's radius is the line's own radius times this factor: 3× puts
 *  the glow 2–5 cm off a 1–2.2 mm thread, far inside HOLO_RADIUS (0.3),
 *  so the footprint never grows. */
export const HOLO_HALO_RADIUS_FACTOR = 3;
/** The shell's brightness as a fraction of the thread's own baked
 *  brightness (which already carries the dissolve envelope, so the
 *  shells dissolve with the threads). ~0.15 keeps every shell under the
 *  bloom threshold: the edge reads as haze, never as a second wire —
 *  lowered from 0.25 when the threads themselves went additive, since
 *  the haze now sums on top of a bundle that already glows. */
export const HOLO_HALO_GAIN = 0.15;
/** The fog column's quad width: ~3.7× the bundle radius, wide enough to
 *  read as a VOLUME the braid floats inside, still half the old floor
 *  pool's spread. Quads are additive light, not solid geometry, so this
 *  does not touch the anchor's footprint (the clearance resolver only
 *  cares about the cable's own radius). */
export const HOLO_FOG_WIDTH = 1.1;
/** The fog's colour gain, multiplied into the radial texture at draw.
 *  The texture peaks at 1, so alone the fog stays under the bloom
 *  threshold — it glows only where it stacks additively over the
 *  bundle and the core, which is what pools the light around the knot.
 *  0.35 (was 0.5): the bundle beneath it is now additive light itself,
 *  so the fog needs less of its own gain to read as one volume. */
export const HOLO_FOG_GAIN = 0.35;
/** Fog edge profile: the radial falloff is a Hann window (zero slope at
 *  both the axis and the rim) raised to this exponent — >1 concentrates
 *  the light toward the middle, so the quads meet the background with no
 *  hard silhouette edge and no visible rim. */
export const HOLO_FOG_EDGE_CURVE = 1.7;
/** A second, tighter bright lane hugging the axis (gain) — the cable's
 *  own glow inside the fog, so the volume reads as brightest exactly
 *  where the braid is instead of as a flat tube. */
export const HOLO_FOG_CORE_LANE_GAIN = 0.75;
/** How much tighter the core lane is: the lane's Hann window is sampled
 *  at r × this, so ~2.4× makes it roughly half the quad's half-width. */
export const HOLO_FOG_CORE_LANE_TIGHTNESS = 2.4;
/** Faint bands travelling slowly up inside the fog (a dimmer cousin of
 *  the core's scanlines) — a static fog reads as a solid tube, drifting
 *  bands read as weather. Count over the column's full height. */
export const HOLO_COLUMN_BANDS = 7;
/** How strong the travelling bands modulate the fog: 0.3 of the fog's
 *  brightness goes up and down the column, 0.7 stays as the steady
 *  body. */
export const HOLO_COLUMN_BAND_DEPTH = 0.3;
/** The bands' drift speed in texture heights per second (upward) — one
 *  band-height every ~50 s, barely perceptible, the scanline drift's
 *  slower cousin. */
export const HOLO_FOG_BAND_SPEED = 0.02;
/** The fog's breathing period (s) — a slow swell of the column's whole
 *  intensity, out of step with the core's 4.4 s breath so the two never
 *  pulse in lockstep. */
export const HOLO_FOG_BREATH_PERIOD_S = 7;
/** How much of the fog's gain the breathing swings: ±25% around the base
 *  gain — a presence, not a lighthouse. */
export const HOLO_FOG_BREATH_AMOUNT = 0.25;
/** The dimmest the column ever reads: a slice with no strands at all
 *  (the neighbour-fallback bundle) still gets a fog at this fraction of
 *  full density — a solitary moment is a thin, dim wisp of light, a busy
 *  slice a full column. Density scales linearly in strand count from
 *  here to 1 at HOLO_STRAND_MAX. */
export const HOLO_FOG_DENSITY_MIN = 0.55;
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
 *  wraps around, exactly the band's core. An equal-radius tube over the
 *  whole span; the brightness array now carries the core's own TOP FADE
 *  as scalars (1 up to HOLO_TOP − HOLO_CORE_FADE_SPAN, easing to 0 at
 *  HOLO_TOP) — the component seeds them as grey instance colours, which
 *  only scales the ink: the spine keeps its height and its dissolving
 *  tip, redrawn as light instead of the old radius taper.
 */
export function holoCoreBake(): HoloLineBake {
  const n = HOLO_SEGMENTS + 1;
  const points = new Float32Array(n * 3);
  const brightness = new Float32Array(HOLO_SEGMENTS);
  for (let i = 0; i < n; i++) {
    const t = i / HOLO_SEGMENTS;
    points[i * 3] = 0;
    points[i * 3 + 1] = HOLO_BOTTOM + t * (HOLO_TOP - HOLO_BOTTOM);
    points[i * 3 + 2] = 0;
    if (i < HOLO_SEGMENTS) {
      const midY =
        HOLO_BOTTOM + (i + 0.5) / HOLO_SEGMENTS * (HOLO_TOP - HOLO_BOTTOM);
      const fadeStart = HOLO_TOP - HOLO_CORE_FADE_SPAN;
      const k = Math.min(1, Math.max(0, (midY - fadeStart) / HOLO_CORE_FADE_SPAN));
      brightness[i] = 1 - k * k * (3 - 2 * k);
    }
  }
  return {
    kind: "core",
    points,
    brightness,
  };
}

/**
 * The dissolve envelope — the bake's pure "how much light is left at
 * height y" curve: 1 at the knot (HOLO_CENTER_Y), easing smoothly to 0
 * over HOLO_FADE_UP_SPAN above it and HOLO_FADE_DOWN_SPAN below it. The
 * fall is a smoothstep shaped by HOLO_FADE_CURVE: gradual at the knot,
 * steep near the tip, so a thread lets go as light over a long run
 * instead of stopping at an edge. Exported so tests can pin its shape.
 */
export function holoDissolveAt(y: number): number {
  const d = y - HOLO_CENTER_Y;
  const span = d >= 0 ? HOLO_FADE_UP_SPAN : HOLO_FADE_DOWN_SPAN;
  const t = Math.min(1, Math.abs(d) / span);
  return Math.pow(1 - t * t * (3 - 2 * t), HOLO_FADE_CURVE);
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
 * range — then multiplied by the dissolve envelope, a smooth fall from
 * 1 at the knot (HOLO_CENTER_Y) to 0 at both ends (see HOLO_FADE_UP_SPAN
 * / HOLO_FADE_DOWN_SPAN). The component multiplies these into the bundle
 * grey, so a far flank recedes while the bundle still reads as one
 * object, and every thread lets go as light: near the tips the lines are
 * still there, they just no longer glow (bloom threshold 1.0).
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
      const nextY =
        HOLO_BOTTOM + ((i + 1) / HOLO_SEGMENTS) * (HOLO_THREAD_TOP - HOLO_BOTTOM);
      brightness[i] =
        (floor + (ceiling - floor) * strength) * holoDissolveAt((y + nextY) / 2);
    }
  }
  return { kind: thread.kind, points, brightness };
}
