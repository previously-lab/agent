"use client";

/**
 * ThreadlineScene (v0.11) — the timeline view's LEFT band: the strand field
 * (doc/design/v0.11-strand-field.md §2).
 *
 * A perspective R3F canvas fills the narrow band. A blue brand core runs the
 * full height, with a companion hairline beside it. The band is a COAXIAL
 * CABLE: the core is the centre conductor, the band's lines are the shield
 * braid. Each line runs the WHOLE height — no start, no end — and every line
 * lives ON A CYLINDER around the core at every height. There is no second
 * configuration and nothing to blend between: the only variable is how far a
 * strand has rotated around that cylinder, `angle(y) = seat + spin(y)`.
 * `winding.ts` owns that geometry (pure, tested); this file only binds it to
 * the frame.
 *
 * TWO STATES, ONE FORMULA: away from the active card the SHARED rotation
 * `spin(y)` is zero, so every strand is a straight vertical line at its own
 * seat — from the side the bundle reads as parallel vertical lines at
 * DIFFERENT DEPTHS (some in front, some behind), because the seats put them at
 * different `z`. Across the card's knot `spin` sweeps `TURNS` full turns, so
 * the bundle becomes a helix — the braid — and, because a whole number of turns
 * lands every strand back on its OWN seat, the line above the card is once
 * again the straight line it was below. The rotation is SHARED: the bundle
 * turns as one and no strand ever turns on its own, which is what makes it read
 * as a braid instead of as loose threads.
 *
 * ONE CYLINDER: the radius is ONE constant for the whole bundle
 * (`RING_RADIUS_FACTOR`, read against the live band width each frame). No
 * strand ever comes closer to the core or reaches further out than any other —
 * the old model's flat row and its pinch toward the core (`radiusEnvelopeAt`)
 * are both gone. What used to be depth travelling through space is now simply
 * the strand's seat: same radius, different angle, therefore different `z`.
 *
 * THE GROUP SPIN (`rotation.y`) turns the whole cable about the vertical axis:
 * a slow drift, plus a small turn toward a fixed angle when a strand is
 * focused. On a cylinder that is a RIGID rotation — it re-deals which seat
 * faces the viewer and cannot deform the cross-section or move a strand off the
 * cylinder, which is the only thing the user rejected in the old model
 * (every strand sharing one depth). The shading is computed in the cable's own
 * frame, so the spin never drags the light around with it. It stays: it is what
 * makes the focus gesture read as a physical turn of the bundle rather than a
 * colour change.
 *
 * WHAT IS DRAWN (§2.4): the current view's top strands —
 * `topStrands(anchors, limit)` over the screen-Y anchors the right pane
 * publishes (CardField's row starts in timeline view, the chat stream's slice
 * seams in chat view). The count is a responsive quantity
 * (`strandLimitForBandWidth`). A strand with no activity in the window still
 * draws its full-height line: straight, because nothing happened there (§2.2).
 *
 * REGISTRATION (§2.3): the ACTIVE CARD is the anchor nearest the middle of the
 * viewport, and the knot heights come straight from those same anchors, so a
 * knot sits where its slice sits on the right and scrolls out of the band with
 * the content — the band is never a parallel view of the timeline. `lambda`,
 * the world length of one knot, is the active card's half-height on screen
 * (`knotLambda` halves the on-screen row pitch) so a turn is exactly as tall as
 * the row it marks and the two sides stay in step when the viewport resizes.
 *
 * PER FRAME the scene rewrites each line's segment positions and vertex
 * colours. The braid's volume is a fake upper-left directional light
 * modulating each strand's OWN colour (§2.7) — the cylinder puts every strand
 * at one radius, so a line's depth is its angle around the core, and the
 * shading reads that angle: a strand on the near side of the cable catches more
 * of the light than one on the far side. Strand selection straightens one line
 * — it stops carrying the shared spin for as long as the focus lasts and runs
 * up its own seat — and brightens it, then sends a pulse up it. Reduced motion
 * snaps the focus tween and stills the light drift.
 *
 * THE LINE-UP JOINT (§2.5): scrolling into a different region changes the top-N
 * set the band draws, and that change is animated rather than cut — a strand
 * that left unwinds and fades, one that joined fades in and winds up, and one
 * that stayed keeps its index in the line-up (hence its seat around the
 * cylinder and the lane it shades) and only slides to a new seat.
 * The lines live in a fixed pool,
 * each entry holding one React key for the canvas's life, so a strand that
 * stays drawn is never remounted. `strand-transition.ts` owns the
 * reconciliation and the ramps (pure, tested); a frame whose set is unchanged
 * skips the machinery entirely.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { useTheme } from "@teispace/next-themes";
import { oklchToHex, strandColor } from "@/lib/timeline3d/layout";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import { screenFractionToWorldY } from "@/lib/timeline3d/convergence";
import {
  laneDepthFor,
  strandPointAt,
  topStrands,
  type FieldAnchor,
} from "@/lib/timeline3d/winding";
import {
  anchorWorldYs,
  knotLambda,
  NARROW_BAND_PX,
  strandLimitForBandWidth,
  WIDE_STRAND_LIMIT,
} from "@/lib/timeline3d/strand-band";
import {
  joinStrandSets,
  strandEnvelope,
} from "@/lib/timeline3d/strand-transition";

const FOV = 30;
const BASE_Z = 9;
/** The strand cylinder's radius — ONE value for the WHOLE bundle: every strand
 *  sits exactly this far from the core at every height, so the cross-section is
 *  a circle and the winding only ever moves a line AROUND it (never in or out).
 *  Expressed as a fraction of the band's half-width and read against the LIVE
 *  band width each frame, so the cable is a true miniature on a slim strip
 *  (chat view, phone) and swells with the view-switch width transition for
 *  free — the band's CSS width IS the bloom.
 *
 *  0.84 spans the cable's silhouette (diameter 2R) across 84% of the band — the
 *  exact footprint the previous model's flat rest row covered (2 · 2.8 · 0.30
 *  of the half-width). The band therefore keeps the visual weight it had; only
 *  the cross-section it draws changed, which is the point of this model. This
 *  is the one number to tune if the cable reads too fat or too thin. */
const RING_RADIUS_FACTOR = 0.78;
/** The weave always lays itself out for a band at least this wide — a slim
 *  strip (chat view, phone timeline) renders a true miniature of the wide
 *  bundle instead of squeezing the companion hairline into invisibility. */
const VIRTUAL_MIN_BAND_PX = 120;
/** The turn the whole cable takes when a strand is focused, as a lateral
 *  offset in units of the cylinder radius: the group eases to the angle whose
 *  cosine is `2 · this / RING_RADIUS_FACTOR` (≈ 84°), scaled by the camera
 *  distance so the gesture reads the same at every zoom level. A rigid spin —
 *  see the group-spin note in the file header. */
const SELECTED_OFFSET_FACTOR = 0.04;
const ANGLE_EASE_SPEED = 5;
const FOCUS_SMOOTH_SPEED = 5;
const CAMERA_SMOOTH_SPEED = 6;
const ZOOM_Z_MULTIPLIER = 0.18;
/** The furthest the camera ever pulls back (the coarsest StackLevel, 2). The
 *  baked line span must cover the viewport at that zoom — a straight string
 *  must never show its end inside the band. */
const MAX_ZOOM_Z_MULTIPLIER = 1 + ZOOM_Z_MULTIPLIER * 2;
const FOCUS_CAMERA_MULT = 0.55;
const SAMPLE_PX_STEP = 12;
/** Narrow bands sample denser: 12 px steps read as polyline facets in a
 *  ~56 px-wide band, so the step tightens to keep the weave smooth. */
const NARROW_SAMPLE_PX_STEP = 8;
const ROTATION_SPEED = 0.04;
const LIGHT_DRIFT_PERIOD = 25;
const PULSE_DURATION = 1.2;
const PULSE_WIDTH_FACTOR = 0.35;
/** Viewport margin above and below the widest possible view: the lines always
 *  overshoot the visible band, so a straight string never shows an end at the
 *  canvas edge (§2.2 — no start, no end). */
const VERTICAL_MARGIN_FRACTION = 0.12;

/**
 * How many full turns the SHARED rotation makes across one knot (the ±`lambda`
 * window either side of the active card). One, to start — the braid reads as one
 * twist per card it passes. This is the tuning knob for how tightly the bundle
 * winds: because the rotation is shared, raising it speeds the whole bundle up
 * together and never lets one strand outrun the others.
 */
const TURNS = 3;

const AMBIENT = 0.22;
const DIFFUSE = 0.78;
const CROSSING_DARKEN = 0.18;
const CROSSING_SHARPNESS = 4.0;
/** Floor on a line's visibility: the fake light modulates the strand's colour
 *  but never drops the string out of sight — a string has no gaps. */
const STRAND_MIN_VISIBILITY = 0.3;
/** The selected line brightens to this share of its own colour under focus. */
const SELECTED_FOCUS_VISIBILITY = 0.8;
/** How far the unselected lines recede into the background under focus. */
const BACKDROP_RECEDE = 0.82;
/** Depth maps onto a brightness multiplier — nearer lanes read brighter. */
const LANE_BRIGHTNESS_MIN = 0.75;
const LANE_BRIGHTNESS_SPAN = 0.5;

/** The most strands drawn in one frame (the widest band's set). */
const MAX_STRAND_SLOTS = WIDE_STRAND_LIMIT;
/** The fixed pool the per-frame loop fills. Twice a full set, because a joint
 *  (§2.5) has one set unwinding while the next winds up — both are on screen at
 *  once, so the pool has to hold both. The pool is allocated once and never
 *  resized, and each entry keeps its React key for the canvas's life, so a
 *  strand that stays drawn is never remounted. */
const STRAND_SLOT_POOL = MAX_STRAND_SLOTS * 2;
/** Separator for the line-up key — unit separator, cannot appear in a
 *  strand name, and written explicitly so it is never an invisible source byte. */
const SET_KEY_SEP = String.fromCharCode(1);
/** One line-up joint, start to finish (§2.5). Matches the view-switch bloom's
 *  order of magnitude; the doc leaves the exact pacing to be tuned on device. */
const STRAND_JOIN_DURATION_S = 0.62;
/** How fast a line slides to a new seat when the joint re-seats it. */
const STRAND_LANE_EASE_SPEED = 6;
/** Below this, a lane has reached its seat and the joint can go idle. */
const LANE_SETTLE_EPSILON = 1e-3;

/** strand name → its three.js ink, cached (the palette has five entries). */
const INK_CACHE = new Map<string, { r: number; g: number; b: number }>();

export interface ThreadlineSceneProps {
  /** Strand names (display order) — the band's fallback set when the view has
   *  published no anchors yet, and the initial bake's line-up. */
  strands: string[];
  /** The filter's selection — null = no focus. */
  selected: string | null;
  /** Card-field scroll progress 0..1 (0 = oldest/top, 1 = now/bottom). */
  progressRef: React.MutableRefObject<number>;
  /** Visible date range of the catalog. */
  range: { oldest: string; now: string };
  /** Current zoom level, written by `CardField`. */
  levelRef: React.MutableRefObject<StackLevel>;
  /** The current view's nodes as screen-Y fractions (0=top, 1=bottom) plus
   *  the strands each carries — written by the card field (row starts) in
   *  timeline view and by the chat stream (slice seam rows) in chat view. The
   *  band draws its top strands and winds them at these heights. */
  anchorsRef: React.MutableRefObject<FieldAnchor[]>;
  /** Whether to skip motion. */
  reducedMotion: boolean;
}

interface SlotBake {
  /** Initial straight-line bake — the frame loop overwrites every vertex. */
  points: THREE.Vector3Tuple[];
  colors: THREE.Color[];
}

interface BuildData {
  /** One bake per drawable slot; live strands are assigned to slots per frame. */
  slots: SlotBake[];
  /** Shared vertical sample positions, top (+y) → bottom (−y). */
  ys: Float32Array;
  viewportWorldHeight: number;
  baseOpacity: number;
  bgR: number;
  bgG: number;
  bgB: number;
  primary: THREE.Color;
  companion: THREE.Color;
  corePoints: THREE.Vector3Tuple[];
  companionPoints: THREE.Vector3Tuple[];
  pulseColorR: number;
  pulseColorG: number;
  pulseColorB: number;
}

function getCssHex(variable: string): string {
  if (typeof window === "undefined") return "";
  // Resolve through a probe element so var() chains (Tailwind v4 `@theme
  // inline` defines --primary as a var reference) come out fully resolved.
  const el = document.createElement("div");
  el.style.display = "none";
  el.style.color = `var(${variable})`;
  document.body.appendChild(el);
  const value = getComputedStyle(el).color.trim();
  el.remove();
  if (!value) return "";
  if (value.startsWith("oklch")) return oklchToHex(value);
  if (value.startsWith("#") || value.startsWith("rgb")) return value;
  return "";
}

function readPrimaryAndBg(dark: boolean): {
  primary: string;
  bg: string;
} {
  const primary =
    getCssHex("--primary") || (dark ? "#3b82f6" : "#2563eb");
  const bg =
    getCssHex("--background") || (dark ? "#242426" : "#ffffff");
  return { primary, bg };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
}

/** A strand's ink — `strandColor` (§2.7), resolved to the RGB three.js needs. */
function strandInk(name: string): { r: number; g: number; b: number } {
  const hit = INK_CACHE.get(name);
  if (hit) return hit;
  const ink = hexToRgb(oklchToHex(strandColor(name)));
  INK_CACHE.set(name, ink);
  return ink;
}

function buildData(
  names: string[],
  width: number,
  height: number,
  dark: boolean,
): BuildData | null {
  if (width <= 0 || height <= 0) return null;

  const { primary: primaryHex, bg: bgHex } = readPrimaryAndBg(dark);
  const primary = new THREE.Color(primaryHex);
  const bg = hexToRgb(bgHex);
  const companion = new THREE.Color(primaryHex).lerp(
    new THREE.Color("#ffffff"),
    0.45,
  );
  const pulseColor = hexToRgb(dark ? "#22d3ee" : primaryHex);
  const baseOpacity = dark ? 0.35 : 0.55;

  const worldHeight = 2 * BASE_Z * Math.tan((FOV * Math.PI) / 360);
  const viewportWorldHeight = worldHeight;
  const narrow = width < NARROW_BAND_PX;
  const samplePx = narrow ? NARROW_SAMPLE_PX_STEP : SAMPLE_PX_STEP;
  const sampleStepWorld = (worldHeight / height) * samplePx;
  // The lines span the viewport (plus a margin, at the furthest zoom the
  // camera can reach) instead of tiling a period: a knot's height is the
  // SCREEN height of the slice it belongs to, so the geometry has to live in
  // the viewport's own frame — a scrolling texture period would carry the
  // knots away from their content.
  const spanWorld =
    worldHeight * MAX_ZOOM_Z_MULTIPLIER * (1 + 2 * VERTICAL_MARGIN_FRACTION);
  const nPoints = Math.max(2, Math.ceil(spanWorld / sampleStepWorld));
  const ys = new Float32Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    ys[i] = spanWorld / 2 - t * spanWorld;
  }

  // Initial bake: straight lines in the current fallback line-up, inked in
  // their own strand colour. The frame loop rewrites positions and colours
  // before the first paint; this only has to be a sane shape.
  const slots: SlotBake[] = [];
  for (let s = 0; s < STRAND_SLOT_POOL; s++) {
    const name = names[s];
    const ink = name ? strandInk(name) : bg;
    const points: THREE.Vector3Tuple[] = [];
    const colors: THREE.Color[] = [];
    for (let j = 0; j < nPoints; j++) {
      points.push([0, ys[j], 0]);
      colors.push(new THREE.Color(ink.r, ink.g, ink.b));
    }
    slots.push({ points, colors });
  }

  const corePoints: THREE.Vector3Tuple[] = [];
  const companionPoints: THREE.Vector3Tuple[] = [];
  const companionOffset =
    (worldHeight *
      Math.max(width, VIRTUAL_MIN_BAND_PX) *
      0.006) /
    height;
  for (let i = 0; i < nPoints; i++) {
    const y = ys[i];
    corePoints.push([0, y, 0]);
    companionPoints.push([companionOffset, y, 0]);
  }

  return {
    slots,
    ys,
    viewportWorldHeight,
    baseOpacity,
    bgR: bg.r,
    bgG: bg.g,
    bgB: bg.b,
    primary,
    companion,
    corePoints,
    companionPoints,
    pulseColorR: pulseColor.r,
    pulseColorG: pulseColor.g,
    pulseColorB: pulseColor.b,
  };
}

/** Wrap delta to (-π, π] and return the target angle nearest to current. */
function nearestAngle(current: number, target: number): number {
  let delta = target - current;
  delta = ((delta + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return current + delta;
}

/**
 * The seat nearest `current` that is `target` modulo the cylinder's seats, so a
 * strand re-seated by a joint takes the short way round the core instead of
 * sliding all the way around it. Seats are indices, so the "shortest way" is the
 * angle the seat maps to — `laneAngleFor`.
 */
function nearestSeat(current: number, target: number, count: number): number {
  if (count <= 0) return target;
  return target + Math.round((current - target) / count) * count;
}

/** What one pool entry is doing right now (§2.5). */
type StrandSlotPhase = "free" | "present" | "joining" | "leaving";

/**
 * One entry of the fixed line pool. The pool is indexed by SLOT, but nothing
 * the eye can see is derived from the slot number: a strand's seat around the
 * cylinder and the shading that seat carries all come from its index in the
 * CURRENT line-up, and those must stay put for as long as the strand is drawn
 * or the line would jump on a re-seat.
 */
interface StrandSlotState {
  /** The strand drawn in this slot, or null while the slot is free. */
  name: string | null;
  phase: StrandSlotPhase;
  /** 0..1 progress through the joint (1 when settled). */
  progress: number;
  /**
   * Eased SEAT — the strand's index in the line-up, allowed to be fractional
   * while a re-seat is in flight, so it slides around the cylinder instead of
   * popping. Its angle is continuous in it (`laneAngleFor`), so a fractional
   * seat is a seat between two strands.
   */
  seat: number;
  /** The seat a leaving strand holds onto while it unwinds. */
  releaseSeat: number;
  /** The strand's whole-number seat in the current line-up — the lane it
   *  shades. Held (not cleared) by a leaving strand, so it unwinds in the depth
   *  it was drawn in instead of jumping lanes on the way out. */
  laneIndex: number;
  /** False until the seat has been seeded — a strand must appear at its own
   *  seat and wind up there, not slide in from the last occupant's seat. */
  seatSeeded: boolean;
}

function createStrandSlots(): StrandSlotState[] {
  const slots: StrandSlotState[] = [];
  for (let i = 0; i < STRAND_SLOT_POOL; i++) {
    slots.push({
      name: null,
      phase: "free",
      progress: 1,
      seat: 0,
      releaseSeat: 0,
      laneIndex: 0,
      seatSeeded: false,
    });
  }
  return slots;
}

/**
 * The pool entry a joining strand should take: its own slot if it is still
 * unwinding there (a strand that re-enters the set reverses in place instead of
 * leaving a ghost line behind), else the first free slot, else — pool
 * exhausted, which needs a full swap plus a strand that never finishes — the
 * departure that is furthest along.
 */
function claimStrandSlot(
  slots: StrandSlotState[],
  name: string,
): StrandSlotState | null {
  const own = slots.find((slot) => slot.name === name);
  if (own) return own;
  const free = slots.find((slot) => slot.phase === "free");
  if (free) return free;
  let evicted: StrandSlotState | null = null;
  for (const slot of slots) {
    if (slot.phase !== "leaving") continue;
    if (!evicted || slot.progress > evicted.progress) evicted = slot;
  }
  return evicted;
}

interface ThreadlineRigProps extends ThreadlineSceneProps {
  dark: boolean;
}

function ThreadlineRig(props: ThreadlineRigProps) {
  const {
    strands,
    selected,
    progressRef,
    levelRef,
    anchorsRef,
    reducedMotion,
  } = props;
  const { size } = useThree();
  const camera = useThree((s) => s.camera);

  const groupRef = useRef<THREE.Group>(null);
  const cameraZRef = useRef(BASE_Z);
  const rotationYRef = useRef(0);
  const prevProgressRef = useRef(progressRef.current);
  const selectedRef = useRef<string | null>(selected);
  const pulseStartRef = useRef<number | null>(null);

  const coreLineRef = useRef<THREE.Object3D | null>(null);
  const companionLineRef = useRef<THREE.Object3D | null>(null);
  const threadLineRefs = useRef<(THREE.Object3D | null)[]>([]);

  // The line-up joint (§2.5). `slots` is the fixed pool's state, `order` the
  // present strands' draw order (retained seats first — see `joinStrandSets`),
  // `setKey` the last reconciled line-up so an unchanged frame does no work.
  const slotsRef = useRef<StrandSlotState[] | null>(null);
  if (slotsRef.current === null) slotsRef.current = createStrandSlots();
  const orderRef = useRef<string[]>([]);
  const lastSetKeyRef = useRef<string | null>(null);
  const jointActiveRef = useRef(false);
  const seededRef = useRef(false);

  // The initial bake's line-up: the ambient strand set, capped at the widest
  // band's slot count. The frame loop replaces it with the view's top strands.
  const bakeNames = useMemo(
    () => strands.slice(0, MAX_STRAND_SLOTS),
    [strands],
  );
  // Width quantized for the rebuild: during the view-switch CSS width
  // transition `size.width` changes every frame, and a full geometry rebuild
  // per frame would churn allocations. The lane radius follows the live width
  // per frame in useFrame instead; the baked geometry only needs it coarsely.
  const buildWidth = Math.round(size.width / 16) * 16;
  const build = useMemo(
    () => buildData(bakeNames, buildWidth, size.height, props.dark),
    [bakeNames, buildWidth, size.height, props.dark],
  );

  const focusRef = useRef(0);

  // One-time material setup: transparent, no depth write, no per-frame shader
  // recompilation. Line2 materials expose opacity through uniforms.opacity.
  useEffect(() => {
    const setup = (obj: THREE.Object3D | null) => {
      const mat = (obj as any)?.material;
      if (!mat) return;
      mat.transparent = true;
      mat.depthWrite = false;
    };
    setup(coreLineRef.current);
    setup(companionLineRef.current);
    threadLineRefs.current.forEach((obj) => setup(obj));
  }, [build]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    if (!build) return;

    const targetF = selected ? 1 : 0;
    const nextF = reducedMotion
      ? targetF
      : focusRef.current +
        (targetF - focusRef.current) * Math.min(1, dt * FOCUS_SMOOTH_SPEED);
    focusRef.current = nextF;

    if (selected !== selectedRef.current) {
      selectedRef.current = selected;
      if (selected) {
        pulseStartRef.current = performance.now() / 1000;
      }
    }
    const pulseProgress =
      pulseStartRef.current != null
        ? Math.min(
            1,
            (performance.now() / 1000 - pulseStartRef.current) /
              PULSE_DURATION,
          )
        : 1;
    const pulseActiveGlobal = pulseProgress < 1;

    const level = levelRef.current ?? 1;
    const zoomMult = 1 + ZOOM_Z_MULTIPLIER * level;
    const focusMult = THREE.MathUtils.lerp(1, FOCUS_CAMERA_MULT, nextF);
    const targetZ = BASE_Z * zoomMult * focusMult;
    cameraZRef.current +=
      (targetZ - cameraZRef.current) *
      Math.min(1, dt * CAMERA_SMOOTH_SPEED);
    camera.position.z = cameraZRef.current;

    const lightAngle = reducedMotion
      ? 0
      : state.clock.elapsedTime * ((Math.PI * 2) / LIGHT_DRIFT_PERIOD);
    const lightDirX = -Math.cos(lightAngle);
    const lightDirZ = -Math.sin(lightAngle);
    const lightDirY = 0.35;
    const lightLen = Math.sqrt(
      lightDirX * lightDirX + lightDirY * lightDirY + lightDirZ * lightDirZ,
    );
    const lx = lightDirX / lightLen;
    const ly = lightDirY / lightLen;
    const lz = lightDirZ / lightLen;

    if (groupRef.current) {
      const progress = progressRef.current;
      const scrollVel =
        (progress - prevProgressRef.current) / Math.max(dt, 0.001);
      prevProgressRef.current = progress;

      // The focus turn. The whole cable rotates rigidly about the vertical
      // axis, so this re-deals which seat faces the viewer and can never
      // deform the cross-section — see the group-spin note in the header.
      const cosTarget = Math.max(
        -1,
        Math.min(
          1,
          ((SELECTED_OFFSET_FACTOR * 2) / RING_RADIUS_FACTOR) *
            (cameraZRef.current / BASE_Z),
        ),
      );
      const posTarget = Math.acos(cosTarget);
      const negTarget = -Math.acos(cosTarget);
      let targetAngle = posTarget;
      let minDelta = Math.abs(
        nearestAngle(rotationYRef.current, posTarget) -
          rotationYRef.current,
      );
      const negDelta = Math.abs(
        nearestAngle(rotationYRef.current, negTarget) -
          rotationYRef.current,
      );
      if (negDelta < minDelta) {
        targetAngle = negTarget;
        minDelta = negDelta;
      }

      if (reducedMotion) {
        rotationYRef.current = selected
          ? nearestAngle(rotationYRef.current, targetAngle)
          : 0;
      } else {
        rotationYRef.current +=
          dt * ROTATION_SPEED * (1 - nextF) +
          scrollVel * 0.0005 * (1 - nextF);
        rotationYRef.current +=
          (nearestAngle(rotationYRef.current, targetAngle) -
            rotationYRef.current) *
          Math.min(1, dt * ANGLE_EASE_SPEED * nextF);
      }
      groupRef.current.rotation.y = rotationYRef.current;
    }

    const coreOpacity = THREE.MathUtils.lerp(0.8, 0.5, nextF);
    const coreMat = (coreLineRef.current as any)?.material;
    if (coreMat) {
      coreMat.opacity = coreOpacity;
      if (coreMat.uniforms?.opacity)
        coreMat.uniforms.opacity.value = coreOpacity;
    }
    const companionMat = (companionLineRef.current as any)?.material;
    if (companionMat) {
      const companionOpacity = coreOpacity * 0.55;
      companionMat.opacity = companionOpacity;
      if (companionMat.uniforms?.opacity)
        companionMat.uniforms.opacity.value = companionOpacity;
    }

    // ── The strand set for this frame (§2.4) ─────────────────────────────
    // The right pane owns the heights; the band ranks the strands by how
    // present they are here and draws the top ones. With no anchors published
    // yet (a view that has not measured), fall back to the ambient set — the
    // same ranking rule, all of them straight.
    const anchors = anchorsRef.current;
    const limit = strandLimitForBandWidth(size.width);
    let liveNames: string[];
    if (anchors.length > 0) {
      liveNames = topStrands(anchors, limit);
    } else {
      liveNames = strands.slice(0, limit);
    }
    // The focused strand is always drawn, so selecting a line never makes it
    // vanish from the band. It takes the last ranked seat — never a seat more.
    if (selected && !liveNames.includes(selected)) {
      liveNames =
        liveNames.length >= limit
          ? [...liveNames.slice(0, Math.max(0, limit - 1)), selected]
          : [...liveNames, selected];
    }

    // ── The line-up joint (§2.5) ─────────────────────────────────────────
    // Scrolling into a different region changes which strands are in the set.
    // That change is a joint, not a cut: a strand that left unwinds and then
    // fades, a strand that joined fades in and winds up, and a strand that
    // stayed keeps its seat and just re-positions. The common frame — the set
    // unchanged, which is most frames while scrolling — does no work here.
    const slots = slotsRef.current ?? createStrandSlots();
    // Separator is explicit (never an invisible character in source): a bare
    // concat collides (["a","bc"] === ["ab","c"]) and would silently swallow
    // a real line-up change, leaving the set stuck.
    const setKey = liveNames.join(SET_KEY_SEP);
    const setChanged = setKey !== lastSetKeyRef.current;
    if (setChanged) {
      lastSetKeyRef.current = setKey;
      // The band's very first line-up opens already settled: the strings are
      // simply there, rather than every strand winding up from nothing.
      const seeded = !seededRef.current;
      seededRef.current = true;
      const join = joinStrandSets(orderRef.current, liveNames);
      for (const name of join.departed) {
        const slot = slots.find((s) => s.name === name);
        if (!slot) continue;
        slot.phase = "leaving";
        slot.progress = 0;
        slot.releaseSeat = slot.seat; // hold the seat it unwinds in
      }
      for (const name of join.joined) {
        const slot = claimStrandSlot(slots, name);
        if (!slot) continue;
        // A slot already unwinding this strand reverses in place; its amplitude
        // is mirrored (`strandEnvelope`), so the clock flips with it.
        const reversed = slot.name === name && slot.phase === "leaving";
        if (!reversed) slot.seatSeeded = false;
        slot.name = name;
        slot.phase = seeded ? "present" : "joining";
        slot.progress = reversed ? 1 - slot.progress : seeded ? 1 : 0;
      }
      orderRef.current = join.order;
      jointActiveRef.current = true;
    }

    const order = orderRef.current;
    const count = Math.max(1, order.length);
    // Advance the joint only while one is running (or a seat is still sliding
    // to its place). Once everything has settled this block is skipped, so a
    // frame in an unchanged region costs nothing but the draw itself.
    if (setChanged || jointActiveRef.current) {
      let busy = false;
      for (const slot of slots) {
        const name = slot.name;
        if (!name) continue;
        if (slot.phase === "joining" || slot.phase === "leaving") {
          const leaving = slot.phase === "leaving";
          // Reduced motion snaps the joint: the set changes, the animation
          // does not run.
          slot.progress = reducedMotion
            ? 1
            : Math.min(1, slot.progress + dt / STRAND_JOIN_DURATION_S);
          if (strandEnvelope(slot.progress, leaving).done) {
            if (leaving) {
              slot.name = null;
              slot.phase = "free";
              slot.progress = 1;
              continue;
            }
            slot.phase = "present";
          } else {
            busy = true;
          }
        }
        const seat = order.indexOf(name);
        // The seat index is the strand's index for the whole braid — its seat
        // around the cylinder and the lane its depth shades. A leaving strand
        // (seat < 0) keeps the last one it held, so it unwinds where it was
        // drawn.
        if (seat >= 0) slot.laneIndex = seat;
        const targetSeat =
          slot.phase === "leaving" || seat < 0 ? slot.releaseSeat : seat;
        if (!slot.seatSeeded) {
          slot.seat = targetSeat;
          slot.seatSeeded = true;
        } else {
          const delta =
            nearestSeat(slot.seat, targetSeat, count) - slot.seat;
          if (Math.abs(delta) > LANE_SETTLE_EPSILON) busy = true;
          slot.seat = reducedMotion
            ? slot.seat + delta
            : slot.seat + delta * Math.min(1, dt * STRAND_LANE_EASE_SPEED);
        }
      }
      jointActiveRef.current = busy;
    }

    // The anchors arrive as fractions of the shared viewport height, and the
    // band's camera pulls back with the zoom level — so the fraction→world
    // conversion has to use the height actually visible at the CURRENT camera
    // distance, or the knots would drift off the content they belong to.
    const visibleWorldHeight =
      build.viewportWorldHeight * (cameraZRef.current / BASE_Z);
    const publishedWorldYs = anchorWorldYs(anchors, visibleWorldHeight);

    // ── The active card (the observer) ────────────────────────────────────
    // The knot belongs to the card nearest the middle of the viewport. The
    // anchors are the observer: each one already carries its row's on-screen
    // position and the right pane rewrites them every frame, so there is no
    // DOM IntersectionObserver to fall out of date and the band can never be a
    // frame behind the scene it registers against. With nothing published yet
    // the viewport centre stands in, so the band still renders.
    let activeCenterY = 0;
    if (anchors.length > 0) {
      let nearest = anchors[0];
      let nearestDist = Math.abs(nearest.y - 0.5);
      for (let i = 1; i < anchors.length; i++) {
        const dist = Math.abs(anchors[i].y - 0.5);
        if (dist < nearestDist) {
          nearest = anchors[i];
          nearestDist = dist;
        }
      }
      activeCenterY = screenFractionToWorldY(nearest.y, visibleWorldHeight);
    }

    const lambda = knotLambda(publishedWorldYs, visibleWorldHeight);
    // `knotLambda` halves the on-screen row pitch — so lambda is the active
    // card's half-height in world units — and floors it at a positive fraction
    // of the viewport, so the knot always has real height.

    // ── The band's cross-section for this frame ───────────────────────────
    // ONE cylinder for the whole bundle, sized from the band's OWN live
    // half-width: the cable is a true miniature of the wide band on a slim
    // strip (chat view, phone) and swells smoothly as the 500 ms width
    // transition runs. The winding never touches it — the radius is the same
    // at every height for every strand, and only the angle moves.
    const halfBandWorld = (build.viewportWorldHeight * size.width) / size.height / 2;
    const radius = halfBandWorld * RING_RADIUS_FACTOR;

    const groupY = groupRef.current?.position.y ?? 0;
    // Pulse travels from NOW (bottom) upward: y is positive-up, so the
    // center starts below the viewport and climbs.
    const pulseCenterWorldY = (pulseProgress - 0.5) * visibleWorldHeight;
    const pulseWidthWorldY = visibleWorldHeight * PULSE_WIDTH_FACTOR;

    const bgR = build.bgR;
    const bgG = build.bgG;
    const bgB = build.bgB;
    const pulseR = build.pulseColorR;
    const pulseG = build.pulseColorG;
    const pulseB = build.pulseColorB;
    const ys = build.ys;
    const n = ys.length;

    // Line2 geometry uses INTERLEAVED buffers (start/end share one array with
    // stride 6) — always write through setXYZ, never raw .array indexing, and
    // flag the backing buffer dirty.
    const markDirty = (attr: any) => {
      if (attr?.data) attr.data.needsUpdate = true;
      else if (attr) attr.needsUpdate = true;
    };

    for (let s = 0; s < STRAND_SLOT_POOL; s++) {
      const line = threadLineRefs.current[s];
      if (!line) continue;
      const mat = (line as any).material;
      const slot = slots[s];
      const name = slot?.name ?? null;
      if (!slot || !name) {
        // A slot outside the live set holds no strand: no line at all.
        if (mat) {
          mat.opacity = 0;
          if (mat.uniforms?.opacity) mat.uniforms.opacity.value = 0;
        }
        continue;
      }

      const isSelected = name === selected;
      const pulseActive = isSelected && pulseActiveGlobal;
      (line as any).renderOrder = isSelected ? 3 : 1;

      // The joint envelope (§2.5): a joining line is still winding up and a
      // leaving line is unwinding and thinning out; a settled line is at 1.
      const joint =
        slot.phase === "present"
          ? null
          : strandEnvelope(slot.progress, slot.phase === "leaving");
      const jointAmp = joint ? joint.amplitude : 1;

      if (mat) {
        // Solid at rest: transparency was making the bundle read as a smudge
        // and hiding whether the twist shape is actually right. Only the
        // focus state dims the others.
        const targetOpacity = isSelected
          ? 1
          : THREE.MathUtils.lerp(1, 0.12, nextF);
        const opacity =
          (pulseActive ? 1 : targetOpacity) * (joint ? joint.opacity : 1);
        mat.opacity = opacity;
        if (mat.uniforms?.opacity) {
          mat.uniforms.opacity.value = opacity;
        }
      }

      // Seat + depth: the strand's seat in the line-up (which is its angle
      // around the cylinder) and how far forward its lane sits (the band's
      // volume, §2.6). The seat is the SLOT's EASED one, so a re-seat slides
      // instead of snapping. The depth comes
      // from the strand's index in the CURRENT line-up — N is the live line-up
      // length, never the fixed slot pool. Measuring it against the pool
      // mismatched the seats: the depth and the position were shading two
      // different line-ups.
      const seat = slot.seat;
      const laneIndex = slot.laneIndex;
      const depth = laneDepthFor(laneIndex, count);
      const laneBrightness =
        LANE_BRIGHTNESS_MIN + LANE_BRIGHTNESS_SPAN * depth;

      const ink = strandInk(name);
      const inkR = ink.r;
      const inkG = ink.g;
      const inkB = ink.b;

      // Focus straightens the selected line — it stops carrying the shared
      // spin, so it runs up its own seat while the rest of the bundle keeps the
      // knot; the joint amplitude winds a joining line up and a leaving line
      // down (§2.5). Both are a scale on the SHARED spin, never a per-strand
      // rotation of its own, so the line stays on the cylinder throughout.
      const unwind = (isSelected ? 1 - nextF : 1) * jointAmp;

      const geom = (line as any).geometry;
      if (!geom) continue;

      const startPos = geom.attributes.instanceStart;
      const endPos = geom.attributes.instanceEnd;
      if (startPos && endPos) {
        for (let i = 0; i < n - 1; i++) {
          const y0 = ys[i] + groupY;
          const y1 = ys[i + 1] + groupY;
          // The cylinder (§2.2): one radius for the whole bundle, one shared
          // spin per height. Away from the knot the spin is 0, so the line is
          // straight at its own seat; through the knot it winds and comes back
          // onto that same seat. `unwind` folds the focus and joint transitions
          // in as a scale on the spin.
          const p0 = strandPointAt(
            y0,
            seat,
            count,
            activeCenterY,
            lambda,
            radius,
            TURNS,
            unwind,
          );
          const p1 = strandPointAt(
            y1,
            seat,
            count,
            activeCenterY,
            lambda,
            radius,
            TURNS,
            unwind,
          );
          startPos.setXYZ(i, p0.x, ys[i], p0.z);
          endPos.setXYZ(i, p1.x, ys[i + 1], p1.z);
        }
        markDirty(startPos);
        markDirty(endPos);
      }

      const startCol = geom.attributes.instanceColorStart;
      const endCol = geom.attributes.instanceColorEnd;
      if (!startCol || !endCol) continue;

      // Per-POINT colours, computed once: point i supplies the start of
      // segment i and the end of segment i-1. The fake directional light
      // modulates the strand's OWN colour, so the weave keeps its volume
      // without washing every line to the same grey (§2.7).
      for (let i = 0; i < n; i++) {
        const y = ys[i] + groupY;
        // The shading needs the strand's direction from the core, which is the
        // direction of its position: (x, z) normalised. On the cylinder that is
        // exactly the strand's angle — cos/sin of `seat + spin` — so the light
        // falls on the NEAR side of the cable and leaves the far side dark.
        const p = strandPointAt(
          y,
          seat,
          count,
          activeCenterY,
          lambda,
          radius,
          TURNS,
          unwind,
        );
        const axisDistance = Math.hypot(p.x, p.z);
        const cosT = axisDistance > 0 ? p.x / axisDistance : 0;
        const sinT = axisDistance > 0 ? p.z / axisDistance : 0;

        const lit = AMBIENT + DIFFUSE * Math.max(0, cosT * lx + sinT * lz);
        const depthFactor = 0.2 + 0.8 * ((sinT + 1) / 2);
        const crossing = Math.exp(-CROSSING_SHARPNESS * Math.abs(cosT));
        const strength = Math.max(
          0,
          Math.min(
            1,
            lit * depthFactor * (1 - CROSSING_DARKEN * crossing) * laneBrightness,
          ),
        );
        const visibility =
          STRAND_MIN_VISIBILITY + (1 - STRAND_MIN_VISIBILITY) * strength;

        let r = bgR + (inkR - bgR) * visibility;
        let g = bgG + (inkG - bgG) * visibility;
        let b = bgB + (inkB - bgB) * visibility;

        if (isSelected) {
          const selVisibility =
            SELECTED_FOCUS_VISIBILITY +
            (1 - SELECTED_FOCUS_VISIBILITY) * strength;
          r = bgR + (inkR - bgR) * selVisibility;
          g = bgG + (inkG - bgG) * selVisibility;
          b = bgB + (inkB - bgB) * selVisibility;
        } else {
          // The rest recede into the backdrop under focus — hue kept, so the
          // dimmed bundle still reads as its strands.
          const recede = nextF * BACKDROP_RECEDE;
          r = r + (bgR - r) * recede;
          g = g + (bgG - g) * recede;
          b = b + (bgB - b) * recede;
        }

        if (pulseActive) {
          const envelope = Math.exp(
            -Math.pow((y - pulseCenterWorldY) / pulseWidthWorldY, 2),
          );
          r = r + (pulseR - r) * envelope;
          g = g + (pulseG - g) * envelope;
          b = b + (pulseB - b) * envelope;
        }

        if (i < n - 1) startCol.setXYZ(i, r, g, b);
        if (i > 0) endCol.setXYZ(i - 1, r, g, b);
      }
      markDirty(startCol);
      markDirty(endCol);
    }
  });

  if (!build) return null;

  return (
    <group ref={groupRef}>
      <Line
        ref={coreLineRef as any}
        points={build.corePoints}
        color={build.primary}
        lineWidth={1.5}
        transparent
        opacity={0.8}
        depthTest={false}
        renderOrder={2}
      />
      <Line
        ref={companionLineRef as any}
        points={build.companionPoints}
        color={build.companion}
        lineWidth={1}
        transparent
        opacity={0.56}
        depthTest={false}
        renderOrder={2}
      />
      {build.slots.map((slot, s) => (
        <Line
          key={`strand-slot-${s}`}
          ref={(el) => {
            threadLineRefs.current[s] = el as THREE.Object3D | null;
          }}
          points={slot.points}
          vertexColors={slot.colors}
          lineWidth={1}
          transparent
          opacity={0}
          renderOrder={1}
        />
      ))}
    </group>
  );
}

export default function ThreadlineScene(props: ThreadlineSceneProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, BASE_Z], fov: FOV }}
        gl={{ antialias: true, alpha: true }}
        onCreated={(state) => state.gl.setClearColor(0x000000, 0)}
        style={{ position: "absolute", inset: 0 }}
      >
        <ThreadlineRig {...props} dark={dark} />
      </Canvas>
    </div>
  );
}
