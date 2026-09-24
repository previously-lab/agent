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
 * coaxial cable standing in the room, human height, glowing.
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
  strandPointAt,
} from "@/lib/timeline3d/winding";

/* ------------------------------------------------------------------ */
/* Dimensions (world meters at construction scale 1)                  */
/* ------------------------------------------------------------------ */

/** Cable start above the emitter puck. */
export const HOLO_BOTTOM = 0.14;
/** Cable top — 人高: a human-height hologram beside the doorway. */
export const HOLO_TOP = 1.86;
/** ONE cylinder radius for the whole bundle (the winding never changes it). */
export const HOLO_RADIUS = 0.3;
/** Half-height of the knot window — the braid spans ±lambda around the slice. */
export const HOLO_KNOT_LAMBDA = 0.44;
/** Full turns across the knot — the band's TURNS, one twist per card. */
export const HOLO_TURNS = 3;
/** Vertical samples per line; 64 over 1.72 m is ~2.7 cm a segment, smooth
 *  for three turns without being greedy (every room owns one hologram). */
export const HOLO_SEGMENTS = 64;
/** The moiré cap on the thread bundle — see the header. */
export const HOLO_STRAND_MAX = 8;
/** Tube radii (world): the core is the spine, strands a hair under it,
 *  neighbors the lightest mark — the band's three line weights. */
export const HOLO_CORE_RADIUS = 0.018;
export const HOLO_STRAND_RADIUS = 0.011;
export const HOLO_NEIGHBOR_RADIUS = 0.009;
/** The rigid self-spin rate (rad/s) — one turn in ~52 s, 缓慢 by design.
 *  This is the ONLY quantity here the component animates, and it is a pure
 *  function of the clock; it never feeds back into the geometry. */
export const HOLO_SPIN_SPEED = 0.12;

/* ------------------------------------------------------------------ */
/* Ink                                                                */
/* ------------------------------------------------------------------ */

/** Strand-thread brightness bounds (multiplied into the accent by the
 *  material gain): near the band's quiet-bundle range, peaking just under
 *  the core so the spine stays the landmark. */
export const HOLO_STRAND_BRIGHTNESS: readonly [number, number] = [0.42, 0.95];
/** Neighbor threads are context, not doors — the band's backdrop-recede
 *  range: legible as threads, clearly dimmer than the strands. */
export const HOLO_NEIGHBOR_BRIGHTNESS: readonly [number, number] = [0.16, 0.38];
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
 * The bundle for one room: `strands.length` strand threads (capped), then
 * `neighborSlots` neighbor threads topping up to at most HOLO_STRAND_MAX.
 * Strands keep priority at the cap — a door outranks context. Pure,
 * order-stable, and data-dense in exactly the two quantities the room
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
  const nCount = Math.min(
    Math.max(0, Math.floor(neighborSlots)),
    HOLO_STRAND_MAX - sCount,
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

/** The knot's centre height — the middle of the cable, so the braid reads
 *  centred from the fixed 45° game camera. */
export const HOLO_CENTER_Y = (HOLO_BOTTOM + HOLO_TOP) / 2;

/**
 * The core: a straight vertical line on the axis — the spine the bundle
 * wraps around, exactly the band's core. Brightness is unused (the core's
 * ink rides on its material colour, as the band's core does).
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
 * range. The component multiplies these greys into the accent, so a far
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
  for (let i = 0; i < n; i++) {
    const y = HOLO_BOTTOM + (i / HOLO_SEGMENTS) * (HOLO_TOP - HOLO_BOTTOM);
    const p = strandPointAt(
      y,
      thread.seat,
      thread.count,
      HOLO_CENTER_Y,
      HOLO_KNOT_LAMBDA,
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
