"use client";

/**
 * ThreadlineScene (v0.11) — the timeline view's LEFT band: the strand field
 * (doc/design/v0.11-strand-field.md §2).
 *
 * A perspective R3F canvas fills the narrow band. The brand-blue core runs the
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
 * WHAT IS DRAWN (§2.4): the strands of the anchor the reader is centred on —
 * the same anchor the knot is wound around — over the screen-Y anchors the
 * right pane publishes (CardField's row starts in timeline view, the chat
 * stream's slice seams in chat view). That anchor LEADS the line-up and its
 * neighbours top it up to the band's count (`bundleFor`), which is a responsive
 * quantity (`strandLimitForBandWidth`) the bundle now actually reaches instead
 * of merely being capped by. The selection is merged in and never dropped
 * (`lineUpFor`), and the picks are spaced evenly around the cylinder
 * (`spreadSelection`) so two of them flank the core rather than bunching on one
 * side. A strand with no activity elsewhere still draws its full-height line:
 * straight, because nothing happened there (§2.2).
 *
 * REGISTRATION (§2.3): the ACTIVE CARD is the anchor nearest the middle of the
 * viewport, and the knot heights come straight from those same anchors, so a
 * knot sits where its slice sits on the right and scrolls out of the band with
 * the content — the band is never a parallel view of the timeline. `lambda`,
 * the world length of one knot, is the active card's half-height on screen
 * (`knotLambda` halves the on-screen row pitch) so a turn is exactly as tall as
 * the row it marks and the two sides stay in step when the viewport resizes.
 *
 * THE TWIST IS CONSERVED, AND HANDED OFF. A rope's twist cannot be created or
 * destroyed, only moved along it, so the knot is not one card's property. A
 * single knot would have to teleport the moment the nearest card changes — a
 * whole row pitch in one frame, the braid snapping back to the start and
 * re-winding at the next card. Each frame therefore blends TWO knots (§2.2,
 * `spinAtKnots`): A, the nearest anchor at or above the viewport centre, and B,
 * the nearest at or below, weighted `1 - t` and `t`. `t` is the SCRUB
 * parameter — how far the centre has travelled from A down to B — a pure
 * function of the scroll position, never a timer. The weights sum to 1, so the
 * total twist is always `TURNS` whole turns and the twist migrates down the
 * cable as the user scrolls, with no strand ever leaving its seat.
 *
 * COLOUR IS A HIGHLIGHT, NOT AN IDENTITY. The bundle rests GREY: a strand
 * wears its palette entry (globals.css `--strand-1` … `-10`, a single arc from
 * blue to rose, picked by hashing the name — see `ink.ts`) ONLY while the
 * reader has singled it out. Everything else is the resting grey.
 *
 * THE CORE WEARS THE BRAND BLUE ONLY WHILE IT IS THE ANSWER. 「核心时间线」 is
 * the unfiltered timeline — the state with nothing picked — so the core is
 * #0066ff when nothing is picked and the resting grey when something is, and
 * the strip never has more than one thing claiming to be the selection. Its
 * WEIGHT is constant regardless: same tube, same opacity, so it stays the spine
 * either way and the reader keeps their landmark. Both earlier versions got one
 * half of this wrong — one faded it for the wrong reason, the next made it
 * constant — so the reasoning lives at the frame loop, where the value is
 * actually decided.
 *
 * That is what makes a whole bundle of threads legible at once. Colour asked to
 * say "which strand is this" for every line simultaneously has no answer — ten
 * hues in a 32 px braid is a colour chart with no reading order, which is what
 * this strip used to be. Asked to say "these ones, not those" it works, and
 * multi-select becomes a natural reading of the gesture rather than a second
 * feature.
 *
 * The canvas cannot resolve a CSS variable, so this file reads each strand's
 * `var()` reference back off the document (`resolveCssHex`). That is what keeps
 * the palette in exactly one place — a designer edits globals.css and the WebGL
 * band follows.
 *
 * DARK QUIETENS THE BRAID, and it does so HERE rather than in the palette: the
 * ink range below is bounded at BOTH ends, so on a near-black page the resting
 * strands settle into soft greys rather than a fence of bright threads.
 *
 * PER FRAME the scene rewrites each line's segment positions and vertex
 * colours. The braid's volume is a fake upper-left directional light
 * modulating each strand's OWN colour (§2.7) — the cylinder puts every strand
 * at one radius, so a line's depth is its angle around the core, and the
 * shading reads that angle: a strand on the near side of the cable catches more
 * of the light than one on the far side. A highlighted line keeps the shared
 * spin and simply changes INK — a palette colour against the resting grey — and
 * sends a pulse up it. It is not straightened and not lifted out of the depth
 * sort: the whole gesture is "one of these threads, not those", and a thread
 * that leaves the helix or renders on top of the cable stops being one of them
 * and becomes a second line drawn beside the core. Reduced motion snaps the
 * focus tween and stills the light drift.
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
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTheme } from "@teispace/next-themes";
import { oklchToHex } from "@/lib/timeline3d/layout";
import {
  normalizeStrandName,
  STRAND_IDLE_INK,
  strandColor,
} from "@/lib/timeline3d/ink";
import {
  COMPANION_TUBE_DIAMETER_CSS_PX,
  CORE_TUBE_DIAMETER_CSS_PX,
  STRAND_TUBE_DIAMETER_CSS_PX,
  tubeRadiusWorld,
} from "@/lib/timeline3d/tube";
import { TubeLine } from "./tube-line";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import { screenFractionToWorldY } from "@/lib/timeline3d/convergence";
import {
  activeAnchorIndex,
  laneDepthFor,
  strandPointAtKnots,
  type FieldAnchor,
  type SpinKnot,
} from "@/lib/timeline3d/winding";
import type { FieldFeed } from "@/lib/timeline3d/field-feed";
import {
  anchorWorldYs,
  knotLambdaForAnchor,
  NARROW_BAND_PX,
  NARROW_STRAND_LIMIT,
  strandLimitForBandWidth,
} from "@/lib/timeline3d/strand-band";
import {
  bundleFor,
  joinStrandSets,
  lineUpFor,
  spreadSelection,
  strandEnvelope,
} from "@/lib/timeline3d/strand-transition";

const FOV = 30;
const BASE_Z = 9;
/** The strand cylinder's radius — ONE value for the WHOLE bundle: every strand
 *  sits exactly this far from the core at every height, so the cross-section is
 *  a circle and the winding only ever moves a line AROUND it (never in or out).
 *  Expressed as a fraction of the band's half-width and read against the LIVE
 *  band width each frame, so the cable stays a true miniature of whatever strip
 *  it is drawn in rather than tracking a hard-coded pixel size.
 *
 *  This is also the lever for how much air the cable has either side of it:
 *  at 0.78 the silhouette fills 78% of the strip and the outer strands sit
 *  ~3.5 px from the edge. It is deliberately NOT lowered to buy a gutter —
 *  a smaller radius packs the strands closer together in x, which is exactly
 *  the direction the braid's moiré gets worse. The gutter comes from the
 *  band's own margin instead (see `AxisBand`).
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
/** Narrow bands sample denser: 12 px steps read as polyline facets in a ~32 px
 *  band, so the step tightens to keep the weave smooth. */
const NARROW_SAMPLE_PX_STEP = 6;
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

/**
 * The core line's ink — the brand blue, PINNED as a literal instead of being
 * read from `--primary`.
 *
 * The core is a decorative spine, not a themed surface: it has to be the same
 * line in both themes and across the view switch, and while it is showing it is
 * the only saturated thing on the strip (the strands gave their chroma up — see
 * `ink.ts`), so it can afford to be this definite. Reading it from the theme
 * would let it drift with the token, which is exactly what a fixed landmark
 * must not do.
 *
 * It is NOT always showing — see the frame-loop note. Once the reader picks
 * strands the core settles to the resting grey, and the picks are then the only
 * colour on the strip.
 */
const CORE_INK = "#0066ff";

/** The core line's opacity — CONSTANT, for the reason the frame loop gives:
 *  the core is the strip's fixed landmark and every other line is read against
 *  it, so it must not change when the reader selects something. It used to dip
 *  to 0.55 under a selection to let the highlight pop; the highlight does not
 *  need the help (it is the only colour on the strip either way) and the dip
 *  cost the reader the thing they were navigating by. */
const CORE_OPACITY = 0.8;
/** How far the companion hairline is mixed toward white from the core. */
const COMPANION_WHITEN = 0.45;
/** The mix target for the companion hairline, and only that — see
 *  `COMPANION_WHITEN`. Allocated once; it is read every frame and never
 *  written. */
const WHITE_INK = new THREE.Color("#ffffff");
/** The pulse that runs up the focused strand: a lightened core in the light
 *  theme, and cyan on black where a lighter BLUE would just read as more blue. */
const PULSE_INK_DARK = "#22d3ee";

/**
 * NO LIGHT. The band is drawn unlit — the colour of every line is decided here,
 * on the CPU, and handed to three as an instance colour. There is no light
 * source in the scene and no shading model to tune, which is deliberate: this
 * strip's whole ink language is "the line fades toward the page", and a lit
 * material cannot say that (it darkens the far side of a surface toward BLACK,
 * which on a white page rings every thread in a hard dark rim).
 *
 * The geometry is still a real cylinder (`tube-line.tsx`), so the day a lit
 * braid is wanted, it is one light and one material swap.
 */
/** How far a RESTING line's ink is carried from the page background. The fake
 *  light modulates it, but it is bounded at BOTH ends: a string has no gaps, so
 *  it never fades out, and it never runs to full ink either — that second bound
 *  is what stops the bundle reading as a fence.
 *
 *  These bound the GREY now, not the palette (`ink.ts` gave the strands their
 *  chroma up). That is why dark's ceiling could come back up from the 0.26 it
 *  needed when every line was a saturated hue: greys have no chroma to shout
 *  with, so the same fraction of the same lightness reads as a quiet thread
 *  where a colour read as neon wire. The floor still drops in dark so the unlit
 *  flank of each line recedes into the page rather than hovering above it. */
const STRAND_VISIBILITY_FLOOR_LIGHT = 0.3;
const STRAND_VISIBILITY_CEILING_LIGHT = 0.8;
const STRAND_VISIBILITY_FLOOR_DARK = 0.16;
const STRAND_VISIBILITY_CEILING_DARK = 0.5;
/** How far a HIGHLIGHTED line is carried toward its own palette colour — in
 *  ABSOLUTE units, not relative to the theme's ceiling, because these are the
 *  only lines still allowed real colour. It has to clear the grey bundle by a
 *  wide margin: the whole gesture is "this one, not those", and a highlight you
 *  have to hunt for is not a highlight. */
const SELECTED_FOCUS_VISIBILITY = 0.92;
/** How far the unhighlighted lines recede into the background under focus.
 *  Held well short of 1: the highlight has to dominate, not erase. The rest of
 *  the bundle is the CONTEXT the picked threads run through — a selection that
 *  left an empty strip would tell the reader nothing about where those threads
 *  sit relative to everything else.
 *
 *  RE-TUNED when the resting grey went quiet (globals.css `--strand-idle`). At
 *  0.6 it was chosen against a bundle that rendered around #7c7c7c, where
 *  pulling 60% of the way to the page still left a legible thread. The resting
 *  peak is now #353535 — only ~1.7:1 against the page — and 60% of a value that
 *  small IS the page: the context vanished, which is the one outcome this
 *  constant's own note rules out. The budget for dimming is set by the resting
 *  contrast, and that budget shrank. */
const BACKDROP_RECEDE = 0.3;
/** How much of its opacity the unhighlighted bundle keeps under focus. The
 *  second half of the same mistake: this used to fade to 0.12, and stacked on
 *  top of `BACKDROP_RECEDE` it left the context at nothing. Kept high now —
 *  the highlight separates itself by CHROMA (a saturated palette entry against
 *  neutral grey), not by being the only thing still lit. */
const BACKDROP_KEEP_OPACITY = 0.55;
/** Depth maps onto a brightness multiplier — nearer lanes read brighter. */
const LANE_BRIGHTNESS_MIN = 0.75;
const LANE_BRIGHTNESS_SPAN = 0.5;

/**
 * The most strands drawn in one frame, and therefore the size the slot pool is
 * built from.
 *
 * Sized for the NARROW tier, not the widest one the tier table supports: the
 * band is a fixed 32 px strip (`AxisBand`), so `strandLimitForBandWidth` can
 * only ever return `NARROW_STRAND_LIMIT` here, and sizing the pool for the
 * wide tier mounted twice the `Line2` objects with half of them always empty.
 * IF THE BAND'S WIDTH EVER BECOMES VARIABLE AGAIN, this must follow it — a too
 * small pool degrades gracefully (`claimStrandSlot` evicts), but it would drop
 * strands that should be on screen.
 */
const MAX_STRAND_SLOTS = NARROW_STRAND_LIMIT;
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

/** theme + strand name → its three.js ink (see `strandInkRgb` for the key). */
const INK_CACHE = new Map<string, { r: number; g: number; b: number }>();

/** The direction a `CylinderGeometry` stands along before any rotation, so
 *  orienting one onto a segment is a single `setFromUnitVectors`. */
const CYLINDER_AXIS = new THREE.Vector3(0, 1, 0);

/** A segment with no direction: its tube is collapsed rather than given an
 *  arbitrary axis. Shared, and never written to. */
const ZERO_SCALE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Scratch for `writeStraightLine` — one set, reused, because it runs for every
 *  straight line on every frame. */
const straightQuat = new THREE.Quaternion();
const straightMid = new THREE.Vector3();
const straightDir = new THREE.Vector3();
const straightScale = new THREE.Vector3();
const straightMatrix = new THREE.Matrix4();

/**
 * Place one tube instance per segment of a FIXED polyline — the core line and
 * its companion, whose paths never change and whose only live input is their
 * thickness.
 *
 * It is a separate path from the strand bundle because the strands' points are
 * recomputed every frame from the winding, while these are baked once: writing
 * their matrices from the baked points each frame costs a scan and nothing
 * else, and keeps the thickness live.
 */
function writeStraightLine(
  mesh: THREE.InstancedMesh | null,
  points: readonly THREE.Vector3Tuple[],
  radius: number,
): void {
  if (!mesh) return;
  let placed = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dir = straightDir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const length = dir.length();
    if (length < 1e-6) {
      mesh.setMatrixAt(placed++, ZERO_SCALE_MATRIX);
      continue;
    }
    dir.divideScalar(length);
    straightQuat.setFromUnitVectors(CYLINDER_AXIS, dir);
    straightMid.set(
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      (a[2] + b[2]) / 2,
    );
    straightScale.set(radius, length, radius);
    mesh.setMatrixAt(
      placed++,
      straightMatrix.compose(straightMid, straightQuat, straightScale),
    );
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
}

export interface ThreadlineSceneProps {
  /** Strand names (display order) — the band's fallback set when the view has
   *  published no anchors yet, and the initial bake's line-up. */
  strands: string[];
  /** The filter's selection — an EMPTY list is no focus. A list rather than a
   *  single name because the highlight is the only thing colour does on the
   *  strip now, and "these ones, not those" is the whole gesture: multi-select
   *  is a natural reading of it, not a second feature bolted on. */
  selected: readonly string[];
  /** Card-field scroll progress 0..1 (0 = oldest/top, 1 = now/bottom). */
  feed: FieldFeed;
  /** Visible date range of the catalog. */
  range: { oldest: string; now: string };
  /** Current zoom level, written by `CardField`. */

  /** The current view's nodes as screen-Y fractions (0=top, 1=bottom) plus
   *  the strands each carries — written by the card field (row starts) in
   *  timeline view and by the chat stream (slice seam rows) in chat view. The
   *  band winds them at these heights, and draws the strands of whichever one
   *  sits at the centre. */

  /** Whether to skip motion. */
  reducedMotion: boolean;
}

interface SlotBake {
  /** Initial straight-line bake — the frame loop overwrites every instance. */
  points: THREE.Vector3Tuple[];
  /** The ink every instance starts at. One colour, not one per point: an
   *  instance is a whole segment now, and the loop rewrites them all before the
   *  first paint anyway. */
  ink: THREE.Color;
}

interface BuildData {
  /** One bake per drawable slot; live strands are assigned to slots per frame. */
  slots: SlotBake[];
  /** Shared vertical sample positions, top (+y) → bottom (−y). */
  ys: Float32Array;
  viewportWorldHeight: number;
  /** Theme-bounded ink range for a line's colour — see the visibility note. */
  inkFloor: number;
  inkCeiling: number;
  bgR: number;
  bgG: number;
  bgB: number;
  core: THREE.Color;
  companion: THREE.Color;
  /** The resting strand ink, as a three.js colour — see `ink.ts`. */
  idleColor: THREE.Color;
  corePoints: THREE.Vector3Tuple[];
  companionPoints: THREE.Vector3Tuple[];
  pulseColorR: number;
  pulseColorG: number;
  pulseColorB: number;
}

/**
 * Resolve ANY CSS colour value — a `var()` reference included — to a concrete
 * `#rrggbb`. This is how the canvas gets at the CSS-side palette: three.js
 * cannot resolve a variable or parse `oklch()`, but the document can, and
 * doing it here keeps the palette in exactly one place (globals.css).
 *
 * TWO STEPS, and the second is not optional. The browser first computes the
 * value (`var()` and all); then the result is RASTERISED onto a 1×1 canvas and
 * the pixel read back. Reading the computed colour as a STRING does not work:
 * Chrome echoes it back in whatever space it was written in (`lab(66.49
 * 7.95 -41.58)` for an oklch declaration), so a string reader needs a parser
 * per colour space and quietly returns nothing for the ones it does not know —
 * which is exactly how this first shipped, and three.js turned the empty
 * string into WHITE lines. The canvas has no such problem: it converts any
 * space to sRGB bytes, which is what the renderer wants anyway.
 *
 * Returns "" when there is no DOM, no 2D context, or the value resolves to
 * nothing. Callers must treat "" as "no colour" and NOT paint, never as black
 * or white.
 */
function resolveCssHex(cssValue: string): string {
  if (typeof window === "undefined") return "";
  const probe = document.createElement("div");
  probe.style.display = "none";
  probe.style.color = cssValue;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color.trim();
  probe.remove();
  if (!computed) return "";

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = computed;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * The band's backdrop, read from the theme token. Every line's colour is a
 * blend AWAY from this, so it has to be the page's real background and not a
 * guess. The literals are the fallbacks for a probe that cannot resolve the
 * token (no DOM, or a stylesheet that has not loaded); they are the values
 * globals.css sets `--background` to in each theme.
 */
function readBackground(dark: boolean): string {
  return resolveCssHex("var(--background)") || (dark ? "#0a0a0a" : "#ffffff");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
}

/**
 * A strand's ink, resolved to the RGB three.js needs. `ink.ts` hands back a
 * `var(--strand-N)` reference — the palette itself lives in globals.css — so
 * this resolves it off the document and converts oklch → sRGB, then caches.
 *
 * Keyed PER THEME even though the palette is currently theme-independent: the
 * resolution goes through the live document, so if a `.dark` override of the
 * palette is ever added the cache must not serve the other theme's colour.
 */
function strandInkRgb(
  name: string,
  dark: boolean,
): { r: number; g: number; b: number } {
  const key = (dark ? "d" : "l") + SET_KEY_SEP + name;
  const hit = INK_CACHE.get(key);
  if (hit) return hit;
  const hex = resolveCssHex(strandColor(name));
  // A palette entry that will not resolve means the STYLESHEET is wrong, not
  // this strand. Fall back to the page background so the line quietly
  // disappears — an unresolved colour must never become the loudest thing on
  // the strip, which is what a white fallback does.
  const ink = hex ? hexToRgb(hex) : hexToRgb(readBackground(dark));
  INK_CACHE.set(key, ink);
  return ink;
}

function buildData(
  names: string[],
  width: number,
  height: number,
  dark: boolean,
): BuildData | null {
  if (width <= 0 || height <= 0) return null;

  const bgHex = readBackground(dark);
  const bg = hexToRgb(bgHex);
  const core = new THREE.Color(CORE_INK);
  const companion = new THREE.Color(CORE_INK).lerp(
    new THREE.Color("#ffffff"),
    COMPANION_WHITEN,
  );
  const pulseColor = hexToRgb(dark ? PULSE_INK_DARK : CORE_INK);
  // The resting ink every unhighlighted line wears. Same resolution path as a
  // palette entry — a CSS var read off the document — so the theme owns it.
  const idleHex = resolveCssHex(STRAND_IDLE_INK) || readBackground(dark);
  const idle = hexToRgb(idleHex);
  const inkFloor = dark
    ? STRAND_VISIBILITY_FLOOR_DARK
    : STRAND_VISIBILITY_FLOOR_LIGHT;
  const inkCeiling = dark
    ? STRAND_VISIBILITY_CEILING_DARK
    : STRAND_VISIBILITY_CEILING_LIGHT;

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
    // The bake is a placeholder the frame loop overwrites before the first
    // paint, so it wears the RESTING ink: a slot that somehow survived to the
    // screen would be a grey thread, not an unexplained coloured one.
    const name = names[s];
    const ink = name ? idle : bg;
    const points: THREE.Vector3Tuple[] = [];
    for (let j = 0; j < nPoints; j++) points.push([0, ys[j], 0]);
    slots.push({ points, ink: new THREE.Color(ink.r, ink.g, ink.b) });
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
    inkFloor,
    inkCeiling,
    bgR: bg.r,
    bgG: bg.g,
    bgB: bg.b,
    core,
    companion,
    idleColor: new THREE.Color(idle.r, idle.g, idle.b),
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
 * The two knots the shared spin blends: A (the card at or above the viewport
 * centre) and B (the one at or below). Allocated ONCE — the frame loop mutates
 * these in place, because it runs sixty times a second and a per-frame array
 * would be pure garbage. A knot the frame has no use for (no anchors at all,
 * only one side of the centre, a zero-length handoff) is simply left at weight
 * 0, which the blend skips and takes no share of the twist from.
 */
function createSpinKnots(): SpinKnot[] {
  return [
    { centerY: 0, lambda: 0, weight: 1 },
    { centerY: 0, lambda: 0, weight: 0 },
  ];
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
    feed,
    reducedMotion,
    dark,
  } = props;
  const { size } = useThree();
  const camera = useThree((s) => s.camera);

  const groupRef = useRef<THREE.Group>(null);
  const cameraZRef = useRef(BASE_Z);
  const rotationYRef = useRef(0);
  const prevProgressRef = useRef(feed.progress);
  // The highlight set for this frame, put through `normalizeStrandName` — the
  // SAME normalisation the line-up dedupes by and `strandColor` hashes by, so
  // all three agree on which spellings are one strand. A selection therefore
  // matches the names the anchor published even if the two sides were cased
  // differently.
  const highlight = useMemo(
    () => new Set(selected.map((n) => normalizeStrandName(n))),
    [selected],
  );
  const selectedKey = useMemo(() => selected.join(SET_KEY_SEP), [selected]);
  const selectedRef = useRef<string>("");
  const pulseStartRef = useRef<number | null>(null);

  const coreLineRef = useRef<THREE.InstancedMesh | null>(null);
  const companionLineRef = useRef<THREE.InstancedMesh | null>(null);
  const threadLineRefs = useRef<(THREE.InstancedMesh | null)[]>([]);

  // The line-up joint (§2.5). `slots` is the fixed pool's state, `order` the
  // present strands' draw order (retained seats first — see `joinStrandSets`),
  // `setKey` the last reconciled line-up so an unchanged frame does no work.
  const slotsRef = useRef<StrandSlotState[] | null>(null);
  if (slotsRef.current === null) slotsRef.current = createStrandSlots();
  const orderRef = useRef<string[]>([]);
  const lastSetKeyRef = useRef<string | null>(null);
  const jointActiveRef = useRef(false);
  const seededRef = useRef(false);

  // The two knots of this frame's twist handoff — allocated once, rewritten in
  // place every frame (see `createSpinKnots`).
  const knotsRef = useRef<SpinKnot[] | null>(null);
  if (knotsRef.current === null) knotsRef.current = createSpinKnots();

  // The initial bake's line-up: the ambient strand set, capped at the widest
  // band's slot count. The frame loop replaces it with the active anchor's.
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
  // Scratch colours for the per-frame core/companion lerp — allocating a
  // THREE.Color per frame would hand the GC a job it does not need.
  const coreColor = useRef(new THREE.Color());
  const companionColor = useRef(new THREE.Color());
  // Scratch for placing an instance: one matrix, one quaternion and one scale
  // vector, reused for every segment of every line rather than allocated per
  // instance per frame.
  const instanceMatrix = useRef(new THREE.Matrix4());
  const instanceQuat = useRef(new THREE.Quaternion());
  const instanceScale = useRef(new THREE.Vector3());
  const instanceMid = useRef(new THREE.Vector3());
  const instanceDir = useRef(new THREE.Vector3());
  const instanceColor = useRef(new THREE.Color());

  /** The page, as a three colour — every strand's ink is a blend away from it. */
  const bgColor = useMemo(
    () =>
      build
        ? new THREE.Color(build.bgR, build.bgG, build.bgB)
        : new THREE.Color(0, 0, 0),
    [build],
  );
  const pulseColor = useMemo(
    () =>
      build
        ? new THREE.Color(
            build.pulseColorR,
            build.pulseColorG,
            build.pulseColorB,
          )
        : new THREE.Color(0, 0, 0),
    [build],
  );

  /** One instance per segment: the frame loop writes `ys.length` samples and
   *  therefore one fewer span between them. */
  const segments = Math.max(1, (build?.ys.length ?? 2) - 1);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    if (!build) return;

    const targetF = highlight.size > 0 ? 1 : 0;
    const nextF = reducedMotion
      ? targetF
      : focusRef.current +
        (targetF - focusRef.current) * Math.min(1, dt * FOCUS_SMOOTH_SPEED);
    focusRef.current = nextF;

    if (selectedKey !== selectedRef.current) {
      selectedRef.current = selectedKey;
      if (highlight.size > 0) {
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

    const level = feed.level;
    const zoomMult = 1 + ZOOM_Z_MULTIPLIER * level;
    const focusMult = THREE.MathUtils.lerp(1, FOCUS_CAMERA_MULT, nextF);
    const targetZ = BASE_Z * zoomMult * focusMult;
    cameraZRef.current +=
      (targetZ - cameraZRef.current) *
      Math.min(1, dt * CAMERA_SMOOTH_SPEED);
    camera.position.z = cameraZRef.current;

    if (groupRef.current) {
      const progress = feed.progress;
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

    // THE CORE IS BLUE ONLY WHILE IT IS THE ANSWER.
    //
    // 「核心时间线」 is the unfiltered timeline — the state with NOTHING picked
    // — so the reader's rule is simply that the core wears its colour when it
    // IS the selection and the resting grey when it is not:
    //
    //     nothing picked  →  核心时间线 is the view     →  #0066ff
    //     something picked →  线索时间线 is the view     →  resting grey
    //
    // An earlier revision made it constant instead, after a version that faded
    // it for the wrong reason (to hand colour to the highlight, which read as
    // the landmark dissolving). Constant overcorrected: with two threads picked
    // the strip has three saturated things on it, and the two the reader chose
    // are competing with a spine that is supposed to be the thing they are
    // measured against. Blue marks "you are looking at everything"; grey marks
    // "you are looking at these".
    //
    // The WEIGHT never changes — same tube, same opacity. Only the ink moves,
    // and it moves by `nextF`, the same eased focus value every other transition
    // here rides, so the change is a tween rather than a cut.
    coreColor.current.copy(build.core).lerp(build.idleColor, nextF);
    const coreOpacity = CORE_OPACITY;
    // The core and its companion carry ONE colour for the whole line, so it
    // rides on the material rather than on per-instance colours (which stay
    // white and multiply through harmlessly).
    const coreMat = coreLineRef.current?.material as
      | THREE.MeshBasicMaterial
      | undefined;
    if (coreMat) {
      coreMat.color.copy(coreColor.current);
      coreMat.opacity = coreOpacity;
    }
    // The companion rides with the core and rides the same way — it is the
    // second half of the spine, so it takes the core's ink and whitens it by
    // the same fraction, whether that ink is the brand blue or the resting
    // grey. Derived here rather than baked, because the core's colour is no
    // longer a constant (see above).
    companionColor.current.copy(coreColor.current).lerp(WHITE_INK, COMPANION_WHITEN);
    const companionMat = companionLineRef.current?.material as
      | THREE.MeshBasicMaterial
      | undefined;
    if (companionMat) {
      companionMat.color.copy(companionColor.current);
      companionMat.opacity = coreOpacity * 0.55;
    }

    // ── The strand set for this frame (§2.4) ─────────────────────────────
    // The right pane owns the heights; the band draws the strands of the ONE
    // anchor the reader is centred on — the same anchor the knot is wound
    // around — so the braid says "what this moment is made of" and the
    // highlight always has a bundle to stand against. With no anchors published
    // yet (a view that has not measured), fall back to the ambient set, all of
    // them straight.
    const anchors = feed.anchors;
    const limit = strandLimitForBandWidth(size.width);
    const activeIndex = activeAnchorIndex(anchors);
    // The centred anchor LEADS and its neighbours top the bundle up to the
    // band's limit, so "seven threads" is a number the strip actually draws
    // rather than a ceiling most moments fall short of. See `bundleFor`.
    const base = bundleFor(anchors, activeIndex, strands, limit);
    // Guarantees the selection survives the cap; see `lineUpFor`.
    const liveNames = spreadSelection(
      lineUpFor(base, selected, limit),
      selected,
    );

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

    // ── The tubes' thickness ──────────────────────────────────────────────
    // Every line in the band is a cylinder (`tube-line.tsx`), and a cylinder's
    // radius is a WORLD length — how wide it looks depends on the camera, so it
    // is recomputed here every frame from the distance the camera is actually
    // at. That is what keeps a "1 px line" one CSS pixel wide on screen at
    // every zoom level. The DPR is not part of this: 1 CSS px is 1 CSS px, and
    // how many device pixels the browser spends on it is the browser's business.
    const strandRadius = tubeRadiusWorld(
      STRAND_TUBE_DIAMETER_CSS_PX,
      visibleWorldHeight,
      size.height,
    );
    const coreRadius = tubeRadiusWorld(
      CORE_TUBE_DIAMETER_CSS_PX,
      visibleWorldHeight,
      size.height,
    );
    const companionRadius = tubeRadiusWorld(
      COMPANION_TUBE_DIAMETER_CSS_PX,
      visibleWorldHeight,
      size.height,
    );

    // ── The twist's two knots (the observer) ──────────────────────────────
    // The knot belongs to the cards nearest the middle of the viewport. The
    // anchors are the observer: each one already carries its row's on-screen
    // position and the right pane rewrites them every frame, so there is no
    // DOM IntersectionObserver to fall out of date and the band can never be a
    // frame behind the scene it registers against.
    //
    // A rope's twist is conserved — it cannot be created or destroyed, only
    // moved — so the knot is not one card's property. One knot would have to
    // flip from card to card with the centre, handing the whole twist over in a
    // single frame (a whole row pitch: the braid snaps back to the start and
    // re-winds). The band blends TWO instead: A, the nearest anchor at or above
    // the centre, and B, the nearest at or below, weighted `1 - t` and `t`. `t`
    // is the SCRUB parameter — how far the centre has travelled from A to B —
    // a pure function of the scroll position (v0.10 §5.0: everything is a
    // continuous function of scroll/zoom progress, never a triggered
    // animation). Because the weights sum to 1 the total is always `TAU·TURNS`,
    // a whole number of turns, at every t: the twist migrates down the cable
    // and no strand ever leaves its seat.
    const knots = knotsRef.current ?? createSpinKnots();
    const knotA = knots[0];
    const knotB = knots[1];

    // The centre and the anchors are all screen fractions here, so the scan
    // needs no world conversion — only the two winners get converted.
    let aAnchor: FieldAnchor | null = null;
    let aFraction = 0;
    let aDist = Infinity;
    let bAnchor: FieldAnchor | null = null;
    let bFraction = 0;
    let bDist = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const fraction = anchors[i].y;
      if (!Number.isFinite(fraction)) continue;
      if (fraction <= 0.5) {
        const dist = 0.5 - fraction;
        if (dist < aDist) {
          aDist = dist;
          aAnchor = anchors[i];
          aFraction = fraction;
        }
      } else {
        const dist = fraction - 0.5;
        if (dist < bDist) {
          bDist = dist;
          bAnchor = anchors[i];
          bFraction = fraction;
        }
      }
    }

    let centerA = 0;
    let weightA = 1;
    let centerB = 0;
    let weightB = 0;
    if (aDist === Infinity && bDist === Infinity) {
      // Nothing published yet: the viewport centre stands in, so the band still
      // renders a knot (as it always has).
    } else if (bDist === Infinity) {
      // Everything in view is above the centre (the top of the memory): one
      // knot, at A. The B slot is left weightless.
      centerA = screenFractionToWorldY(aFraction, visibleWorldHeight);
    } else if (aDist === Infinity) {
      // Everything in view is below the centre (the bottom): one knot, at the
      // only anchor there is — the A slot carries it, the B slot is left
      // weightless.
      centerA = screenFractionToWorldY(bFraction, visibleWorldHeight);
    } else {
      // A and B straddle the centre. `t` is how far the centre has travelled
      // from A (t = 0) to B (t = 1). A span of zero — the two anchors landed on
      // top of each other, which the f>=0.5 split should make impossible — is
      // read as t = 0 rather than dividing by zero.
      const span = bFraction - aFraction;
      const scrub =
        span > 0 ? Math.min(1, Math.max(0, (0.5 - aFraction) / span)) : 0;
      centerA = screenFractionToWorldY(aFraction, visibleWorldHeight);
      centerB = screenFractionToWorldY(bFraction, visibleWorldHeight);
      weightA = 1 - scrub;
      weightB = scrub;
    }

    // Each knot is sized from ITS OWN anchor's span, not from one shared
    // number: that is what makes the twist span exactly its slice and be back
    // to 0 at the slice's edges, so the seam between two slices is the place
    // the bundle is reliably unwound. One lambda for both knots would let the
    // release drift off the seam wherever the two slices differ in height.
    knotA.centerY = centerA;
    knotA.lambda = knotLambdaForAnchor(
      aAnchor?.span,
      publishedWorldYs,
      visibleWorldHeight,
    );
    knotA.weight = weightA;
    knotB.centerY = centerB;
    knotB.lambda = knotLambdaForAnchor(
      bAnchor?.span,
      publishedWorldYs,
      visibleWorldHeight,
    );
    knotB.weight = weightB;

    // ── The band's cross-section for this frame ───────────────────────────
    // ONE cylinder for the whole bundle, sized from the band's OWN live
    // half-width: the cable is a true miniature of the wide band on a slim
    // strip (chat view, phone) and swells smoothly as the 500 ms width
    // transition runs. The winding never touches it — the radius is the same
    // at every height for every strand, and only the angle moves.
    // The radius is sized from the height visible at the CURRENT camera
    // distance, not the baked one — exactly like the anchors and `lambda`
    // above. That is what keeps the cable the same size ON SCREEN at every
    // zoom level. Sizing it from the un-zoomed height instead makes the cable
    // shrink as the camera pulls back (level 2 draws it at ~74 % of level 0),
    // which packs the strands into fewer pixels than the lines are wide and is
    // what turns the braid into a grating — the moiré is worst exactly when
    // the content is zoomed out. The band is a fixed 32 px strip; how much
    // TIME is in view is the camera's business and must not resize the cable.
    const halfBandWorld = (visibleWorldHeight * size.width) / size.height / 2;
    const radius = halfBandWorld * RING_RADIUS_FACTOR;

    const groupY = groupRef.current?.position.y ?? 0;
    // Pulse travels from NOW (bottom) upward: y is positive-up, so the
    // center starts below the viewport and climbs.
    const pulseCenterWorldY = (pulseProgress - 0.5) * visibleWorldHeight;
    const pulseWidthWorldY = visibleWorldHeight * PULSE_WIDTH_FACTOR;

    const bgR = build.bgR;
    const bgG = build.bgG;
    const bgB = build.bgB;
    const inkFloor = build.inkFloor;
    const inkCeiling = build.inkCeiling;
    const pulseR = build.pulseColorR;
    const pulseG = build.pulseColorG;
    const pulseB = build.pulseColorB;
    const ys = build.ys;
    const n = ys.length;

    for (let s = 0; s < STRAND_SLOT_POOL; s++) {
      const line = threadLineRefs.current[s];
      if (!line) continue;
      const mat = (line as any).material;
      const slot = slots[s];
      const name = slot?.name ?? null;
      if (!slot || !name) {
        // A slot outside the live set holds no strand: no line at all.
        // `visible = false` and not merely opacity 0 — a transparent material
        // is still submitted, so an opaque pool would spend a draw call per
        // empty slot every frame. Only the slots actually carrying a strand
        // should reach the renderer at all.
        (line as any).visible = false;
        if (mat) {
          mat.opacity = 0;
          if (mat.uniforms?.opacity) mat.uniforms.opacity.value = 0;
        }
        continue;
      }
      (line as any).visible = true;

      const isHighlighted = highlight.has(normalizeStrandName(name));
      const pulseActive = isHighlighted && pulseActiveGlobal;
      // THE HIGHLIGHT IS A MEMBER OF THE BRAID, NOT A LINE DRAWN OVER IT.
      //
      // A picked strand used to render last with depth testing off, so the grey
      // threads could not chop it into pieces. That was right for a highlight
      // that had left the helix — a straight line crossing the braid gets
      // shredded by it — and it is wrong for one that has not. Lifting it out
      // of the depth sort is the second half of the same mistake the straightening
      // made: it pastes the thread ON TOP of the cable instead of lighting one
      // of its threads, which is precisely what the reader asked not to see.
      // Now it obeys the same occlusion as everything else, so it passes behind
      // the threads nearer the camera and in front of the ones behind it — as a
      // thread wound around a core does.
      (line as any).renderOrder = 1;
      if (mat) mat.depthTest = true;

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
        const targetOpacity = isHighlighted
          ? 1
          : THREE.MathUtils.lerp(1, BACKDROP_KEEP_OPACITY, nextF);
        const opacity =
          (pulseActive ? 1 : targetOpacity) * (joint ? joint.opacity : 1);
        mat.opacity = opacity;
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

      // COLOUR IS THE HIGHLIGHT. A strand carries its palette entry only while
      // it is singled out; the resting bundle is grey (see `ink.ts`). This is
      // the whole reason the band can show ten threads at once without reading
      // as a colour chart — colour is doing one job here, not ten.
      const ink = isHighlighted ? strandInkRgb(name, dark) : build.idleColor;
      const inkR = ink.r;
      const inkG = ink.g;
      const inkB = ink.b;

      // THE HIGHLIGHT DOES NOT STRAIGHTEN.
      //
      // It used to: focusing a strand scaled its share of the shared spin to
      // zero, so the picked thread left the helix and ran straight up its own
      // seat for as long as the focus lasted. The idea was that a straight line
      // is easier to follow than a winding one. What it actually did was put a
      // NEW line on the strip — a second straight vertical, parallel to the
      // core and beside it, which is not one of the threads the reader was
      // looking at and does not read as one. The reader's words: highlight one
      // of the grey curves, do not draw another line.
      //
      // So the picked strand keeps the spin, exactly like every other strand,
      // and stays on the cylinder through the knot. It is singled out by INK
      // alone — a palette colour against the resting grey — which is the whole
      // language the strip already states (see the header, and the note on
      // `BACKDROP_RECEDE`: the highlight separates itself by CHROMA, not by
      // being the only thing still lit or the only thing still curved).
      //
      // The joint amplitude stays: a joining line winds UP while it fades in
      // and a leaving one winds down (§2.5), which is motion the strand is
      // entitled to because it is arriving or departing, not because it was
      // picked.
      const unwind = jointAmp;

      // One instance per segment: placed on the polyline, inked with what that
      // point of the strand is worth. Position and colour are computed in the
      // same pass because they need the same sample.
      //
      // NOTHING HERE IS A LIGHT. The ink is a blend from the page to the
      // strand's own colour, and the only thing that moves it along the strand
      // is how far FORWARD that point sits on the cable — the near flank
      // brighter than the far one. That is volume, not illumination, and it is
      // the same term the flat ribbons carried.
      //
      // `CROSSING_DARKEN` is gone with it. It dimmed a line by up to 18%
      // wherever `|cos| → 0` — the centre of the strip, which is exactly where
      // the braid's strands cross each other — and the user read it, correctly,
      // as crossings going dirty. The tubes do not need the fake: they are real
      // surfaces at real depths, so they OCCLUDE each other and a crossing
      // reads as one thread passing in front of another.
      const recede = isHighlighted ? 0 : nextF * BACKDROP_RECEDE;

      for (let i = 0; i < n - 1; i++) {
        const y0 = ys[i] + groupY;
        const y1 = ys[i + 1] + groupY;
        // The cylinder (§2.2): one radius for the whole bundle, one shared
        // spin per height. Away from the knots the spin is 0, so the line is
        // straight at its own seat; through them it winds and comes back onto
        // that same seat. The two knots hand the twist from A to B as the
        // centre scrubs between them, and `unwind` folds the line-up joint in
        // as a scale on the spin (a joining line winds up, a leaving one down —
        // the FOCUS no longer scales it; see the `unwind` note above).
        const p0 = strandPointAtKnots(
          y0,
          seat,
          count,
          knots,
          radius,
          TURNS,
          unwind,
        );
        const p1 = strandPointAtKnots(
          y1,
          seat,
          count,
          knots,
          radius,
          TURNS,
          unwind,
        );

        // ── Place the tube on this segment ──────────────────────────────
        // The base cylinder stands one unit tall about +Y, so a segment is one
        // rotation onto its own direction, one move to its midpoint, and one
        // scale: the line's radius across, the segment's length along.
        const dir = instanceDir.current.set(
          p1.x - p0.x,
          ys[i + 1] - ys[i],
          p1.z - p0.z,
        );
        const segLength = dir.length();
        if (segLength < 1e-6) {
          // A degenerate segment has no direction to orient to. Collapsing it
          // to zero size is the only honest answer: it is a point, and a tube
          // drawn along an undefined axis would be an artefact.
          line.setMatrixAt(i, ZERO_SCALE_MATRIX);
          continue;
        }
        dir.divideScalar(segLength);
        instanceQuat.current.setFromUnitVectors(CYLINDER_AXIS, dir);
        instanceMid.current.set(
          (p0.x + p1.x) / 2,
          (ys[i] + ys[i + 1]) / 2,
          (p0.z + p1.z) / 2,
        );
        instanceScale.current.set(strandRadius, segLength, strandRadius);
        line.setMatrixAt(
          i,
          instanceMatrix.current.compose(
            instanceMid.current,
            instanceQuat.current,
            instanceScale.current,
          ),
        );

        // ── Ink that segment ────────────────────────────────────────────
        // How far forward this point of the cable sits, read off its angle
        // from the core: the direction of the strand's own position.
        const axisDistance = Math.hypot(p0.x, p0.z);
        const sinT = axisDistance > 0 ? p0.z / axisDistance : 0;
        const depthFactor = 0.2 + 0.8 * ((sinT + 1) / 2);
        const strength = Math.min(1, depthFactor * laneBrightness);
        const visibility = inkFloor + (inkCeiling - inkFloor) * strength;

        let r: number;
        let g: number;
        let b: number;
        if (isHighlighted) {
          // A singled-out strand is carried near its own colour, out of the
          // band's ink range entirely — it has to clear the grey bundle.
          const selVisibility =
            SELECTED_FOCUS_VISIBILITY +
            (1 - SELECTED_FOCUS_VISIBILITY) * strength;
          r = bgR + (inkR - bgR) * selVisibility;
          g = bgG + (inkG - bgG) * selVisibility;
          b = bgB + (inkB - bgB) * selVisibility;
        } else {
          r = bgR + (inkR - bgR) * visibility;
          g = bgG + (inkG - bgG) * visibility;
          b = bgB + (inkB - bgB) * visibility;
          // The rest recede into the backdrop under focus — hue kept, so the
          // dimmed bundle still reads as its strands.
          r += (bgR - r) * recede;
          g += (bgG - g) * recede;
          b += (bgB - b) * recede;
        }

        if (pulseActive) {
          const envelope = Math.exp(
            -Math.pow((y0 - pulseCenterWorldY) / pulseWidthWorldY, 2),
          );
          r += (pulseR - r) * envelope;
          g += (pulseG - g) * envelope;
          b += (pulseB - b) * envelope;
        }

        line.setColorAt(i, instanceColor.current.setRGB(r, g, b));
      }

      line.instanceMatrix.needsUpdate = true;
      if (line.instanceColor) line.instanceColor.needsUpdate = true;
    }

    // The core and its companion are straight by construction, so they are
    // placed from their baked points and only their THICKNESS is live.
    writeStraightLine(coreLineRef.current, build.corePoints, coreRadius);
    writeStraightLine(
      companionLineRef.current,
      build.companionPoints,
      companionRadius,
    );
  });

  if (!build) return null;

  return (
    <group ref={groupRef}>
      {/* The core and its companion are the spine the braid wraps around, so
          they neither depth-test against it nor write depth: they stay legible
          THROUGH the bundle rather than being occluded by it, which is what
          they did as ribbons and what the strip's whole reading order depends
          on. The frame loop hands them their colour. */}
      <TubeLine
        segments={segments}
        onObject={(el) => {
          coreLineRef.current = el;
        }}
        depthTest={false}
        depthWrite={false}
        renderOrder={2}
      />
      <TubeLine
        segments={segments}
        onObject={(el) => {
          companionLineRef.current = el;
        }}
        depthTest={false}
        depthWrite={false}
        renderOrder={2}
      />
      {build.slots.map((slot, s) => (
        <TubeLine
          key={`strand-slot-${s}`}
          segments={segments}
          onObject={(el) => {
            threadLineRefs.current[s] = el;
          }}
          renderOrder={1}
          initialColor={slot.ink}
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
