/**
 * The anchor terminal (v0.11 §13.1/§14.4 step ④) — pure module.
 *
 * Every room grows ONE terminal (the 锚定物): a floor-standing machine with
 * a slowly breathing screen. Walk up, interact, and the view switches to
 * the 2.5D catalog focused on the room's slice — the game → catalog
 * direction of the shared slice address (shell-nav.ts's `focusSlice`). The
 * lobby's terminal is one size bigger and shows the whole-window index
 * (buildLobbyRegister's data, rendered as DOM per §13's 文字走 DOM rule).
 *
 * THE OPEN FIELD. The room's machine stands in the room's open area,
 * mid-depth — a floor lamp, not a wall fixture (the placement note lives
 * with the resolver below). The seeded scan and the degenerate fallback
 * resolve deterministically (A6: same inputs, same spot).
 *
 * TWO CALL SITES, ONE ANSWER. space.tsx renders the terminal from this
 * resolver, and game-canvas.tsx resolves the SAME anchor through the same
 * pure call to drive the proximity prompt and the interaction — the same
 * A6 double-call-site discipline as roomGeometryForSpace: the thing the
 * player walks to is the thing the loop measures, with no scene-graph
 * hand-off between them.
 */
import { LOBBY_CLEAR } from "./clamps";
import { LOBBY_LENGTH } from "./hotel";
import {
  distToPath,
  planContains,
  type Composition,
  type RoomPlan,
} from "./room-plan";
import { createRng, hashString } from "./seed";
import { ENTRANCE_CLEAR_RADIUS, HERO_CLEAR } from "./tuning/room";

/* ------------------------------------------------------------------ */
/* Terminal proportions (human scale, factor 1)                       */
/* ------------------------------------------------------------------ */

/** Body width — a chunky but believable terminal, not a wall. */
export const TERMINAL_W = 0.78;
/** Body depth (front bezel proud of this). */
export const TERMINAL_D = 0.52;
/** Overall height (plinth → bezel top). */
export const TERMINAL_H = 1.42;
/** Screen size (the emissive plane inside the bezel). */
export const TERMINAL_SCREEN_W = 0.56;
export const TERMINAL_SCREEN_H = 0.38;

/** Body/pedestal finish — the hotel's dark trim register (PLATE_BG's
 *  family); the bezel is near-black so the screen reads as the source. */
export const TERMINAL_BODY = "#38322b";
export const TERMINAL_PLINTH = "#2a251f";
export const TERMINAL_BEZEL = "#0f0d0b";
/** The screen's deep standby base — tinted per room by the palette
 *  accent at texture-build time. */
export const TERMINAL_SCREEN_BASE = "#0a0d0c";

/* ------------------------------------------------------------------ */
/* Screen motion — 待机, never a glitch                                */
/* ------------------------------------------------------------------ */

/** Breathing period (s) — one slow inhale/exhale, sinuous, no flicker. */
export const TERMINAL_BREATH_PERIOD_S = 4.4;
/** Emissive intensity base/amplitude: peak crosses the bloom threshold
 *  (1.0) for the upper half of the cycle, so the glow SWELLS rather than
 *  blinks. */
export const TERMINAL_BREATH_BASE = 0.85;
export const TERMINAL_BREATH_AMP = 0.45;
/** Scanline drift rate (texture wraps/second) — barely perceptible. */
export const TERMINAL_SCAN_DRIFT = 0.012;
/** The departure flare: on interact the screen brightens over this long
 *  (ms) while the view dissolves to the catalog — §13.2's "屏幕亮起"
 *  beat, kept inside the game world so the switch stays cheap. */
export const TERMINAL_FLARE_MS = 700;
export const TERMINAL_FLARE_GAIN = 4;

/* ------------------------------------------------------------------ */
/* Interaction                                                        */
/* ------------------------------------------------------------------ */

/** Proximity radius (m, world) at which the prompt appears — a relaxed
 *  arm's reach plus the terminal's own depth. */
export const TERMINAL_REACH_ROOM = 1.7;
export const TERMINAL_REACH_LOBBY = 2.0;

/** Module-level depart flare clock — set by the integrator on interact,
 *  read by every mounted terminal's frame loop. `intensity` is written
 *  back by the frame loop each frame (probes read the live value; visual
 *  motion only — A6 governs LAYOUT, not motion). */
export const TERMINAL_DEPART = { t0: -1, intensity: 0 };

/* ------------------------------------------------------------------ */
/* Room placement (pure)                                              */
/* ------------------------------------------------------------------ */

export interface TerminalAnchor {
  /** Room-local center (the component's floor origin). */
  x: number;
  z: number;
  /** Y-rotation facing into the room (+z local front). */
  rotY: number;
  /** Construction scale (rides the room's prop scale, feasibility-clamped). */
  scale: number;
}

/** The machine's footprint rectangle in the frame the anchor lives in
 *  (rooms: the plan frame; the lobby uses its own blocker constant). */
export interface TerminalFootprint {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function terminalFootprint(a: TerminalAnchor): TerminalFootprint {
  const hw = (TERMINAL_W * a.scale) / 2;
  const hd = (TERMINAL_D * a.scale) / 2;
  return { x0: a.x - hw, x1: a.x + hw, z0: a.z - hd, z1: a.z + hd };
}

/**
 * Footprint containment in the plan — the resolver's own acceptance test,
 * exported so unit tests assert the same rule instead of a copy. The back
 * edge may sink 8cm into the entrance wall (the dado/prop convention) and
 * the far edge may kiss its wall line; an l-shape's abandoned quadrant
 * takes no machine.
 */
export function terminalInsidePlan(
  plan: RoomPlan,
  width: number,
  extent: number,
  wallThick: number,
  fp: TerminalFootprint,
): boolean {
  if (fp.x1 > width / 2 - 0.04) return false;
  if (fp.z0 < wallThick / 2 - 0.08) return false;
  if (fp.z1 > extent - wallThick / 2 + 0.02) return false;
  if (plan.id === "l-shape" && fp.z1 > plan.stepZ) {
    return plan.lSide > 0 ? fp.x0 >= 0.02 : fp.x1 <= -0.02;
  }
  return true;
}

export interface RoomTerminalInput {
  sliceId: string;
  plan: RoomPlan;
  comp: Composition;
  /** Scaled plan width. */
  width: number;
  /** Scaled wall thickness (wallThick the renderer built). */
  wallThick: number;
  /** The room's prop scale (scaleFactor^PROP_SCALE_EXP). */
  propScale: number;
  /** The room's water rectangle (scaled, local frame) or null when dry. */
  water: { cx: number; cz: number; halfX: number; halfZ: number } | null;
}

/**
 * HERO-CLEARANCE FEASIBILITY CEILING — the largest hero distance this
 * room's own geometry can honestly offer the machine. A pure function of
 * the resolver's inputs: every parameter beyond (plan, width, wallThick,
 * propScale, hero) is itself a deterministic derivation of them (hw is
 * the resolved machine half-width), so A6 holds — same inputs, same
 * ceiling, no clock and no draw.
 *
 * WHERE THE BOUND COMES FROM. The hero stands in the far third (≥68%
 * depth, near the axis) and the machine only ever stands in the open
 * field's mid-depth band (30–70% of depth, the seeded scan below) or —
 * degenerately — at the entrance wall, which is FARTHER from a far-third
 * hero than the band's near edge. So the band's far corner — the scan's
 * own lateral reach at the band's near edge — is the conservative
 * farthest spot the resolver can actually use, and any spot the fallback
 * walk can reach lies beyond it. From that corner's distance come off
 * the machine's half-extent (the hero boundary is measured to the body,
 * not the center) and the wall-furniture band the score already reserves
 * along the walls — the corner itself is inside the furniture strip, so
 * a machine standing its reserve-distance inward is the honest reach.
 *
 * A room that can truly host HERO_CLEAR (every standard multi-module
 * room) gets a ceiling above it and the clamp `min(heroClear, ceiling)`
 * is a NO-OP — effectiveHeroClear === heroClear, scores and anchors
 * unchanged. A 6×6 single-module room (bath / storage) gets what it can
 * actually offer (~2.1–2.4m) instead of an unreachable 3m: the soft
 * score stops demanding the impossible and the degenerate fallback's
 * feasibility walk becomes satisfiable by construction.
 */
export function heroClearCeilingFor(
  plan: RoomPlan,
  width: number,
  wallThick: number,
  propScale: number,
  hero: { x: number; z: number },
  hw: number,
): number {
  const halfRoom = width / 2 - wallThick / 2;
  // The scan's own lateral reach (its draw expression, mirrored). Corners
  // outside the walkable footprint — an l-shape's abandoned quadrant past
  // the step — do not count: the machine can never stand there.
  const reachX = Math.max(0.5, halfRoom - hw - 0.15);
  // WALL_FURNITURE_BAND (below), restated: the wall strip the score
  // reserves for wall-anchored kits.
  const band = 1.2 * Math.max(propScale, 0.35);
  let farthest = 0;
  for (const sx of [-1, 1]) {
    for (const z of [plan.extent * 0.3, plan.extent * 0.7]) {
      const x = sx * reachX;
      if (!planContains(plan, x, z, 0)) continue;
      farthest = Math.max(farthest, Math.hypot(x - hero.x, z - hero.z));
    }
  }
  return Math.max(0, farthest - hw - band);
}

/**
 * Resolve the room terminal's anchor. Deterministic in (sliceId, plan,
 * comp, width, wallThick, propScale, water) (A6 — the two call sites
 * resolve the SAME anchor through the same pure call).
 *
 * THE OPEN FIELD, NOT THE WALL. The machine stands in the room's open
 * area, mid-depth — a floor lamp with a holographic timeline for a
 * shade, 显眼 without ever blocking anything. The resolver samples
 * seeded candidates across the middle band (30–70% depth), keeps the
 * ones that cannot be in the way (inside the plan, clear of the doorway
 * strip, the walk path and the water), and picks the survivor with the
 * most clearance from the soft constraints — the hero's clearing, the
 * composition's cluster circles and the side walls. The hero's clearing
 * is asked only at what the room can actually offer: heroClearCeilingFor
 * clamps HERO_CLEAR to the open field's geometric reach, a no-op in every
 * room big enough to host the raw clearance.
 *
 * WHY CLUSTERS ARE THE FURNITURE PROXY. This layer's input is the plan
 * and the composition; the kit layer's authored keep-empty zones and
 * module floors live above it (they need the template/composition data
 * RoomTerminalInput does not carry). What the planning layer DOES know:
 * grouped scatter and kit staging anchor around comp.clusters, so a
 * candidate outside every cluster circle avoids the furniture footprints
 * by construction; and wall-anchored kits hug the walls, so the score
 * rewards standing away from them. The hard filters cover what the
 * modules' entrance aprons and hall spines protect — those zones sit on
 * the walk path's corridor, and the path filter is stricter than any of
 * them. Sparse open-field dressing (§8.2, 0–3 pieces per field, itself
 * path-avoiding) may still rarely graze the machine — accepted as
 * best-effort at this layer.
 *
 * DEGENERATE ROOMS. A room too small to clear the path anywhere in the
 * band (the dollhouse scales) degrades to the entrance-wall spot beside
 * the doorway — the v0.11 placement, feasibility-nudged, proven to stay
 * inside the plan and out of the passage. Its hero gate reads the same
 * clamped clearance, so the nudge walk always terminates on a spot that
 * passed every gate it returned with (see the walk's own comment).
 */
export function roomTerminalFor({
  sliceId,
  plan,
  comp,
  width,
  wallThick,
  propScale,
  water,
}: RoomTerminalInput): TerminalAnchor {
  const rng = createRng(hashString(`${sliceId}@terminal`));

  const halfRoom = width / 2 - wallThick / 2;
  // The machine rides the prop scale like every other piece of furniture,
  // bounded so a big room gets a big console, not a billboard (at v0.13's
  // single ×1 tier the clamp is the identity; the rails stay).
  let scale = Math.min(2.2, Math.max(0.35, propScale));
  // Small-room fallback floor — below this the dollhouse machine is a toy.
  const SCALE_FLOOR = 0.16;
  // Fit: the final |x| is min(need, xCap) with need = strip + half-width +
  // walk gap and xCap = halfRoom − half-width − pad; keeping need ≤ xCap
  // rearranges to width·scale ≤ halfRoom − (strip + gap + pad).
  const fitScale = (): number => {
    const byWidth = (halfRoom - (ENTRANCE_CLEAR_RADIUS + 0.3)) / TERMINAL_W;
    return Math.max(SCALE_FLOOR, Math.min(scale, byWidth));
  };
  scale = fitScale();

  const hw = (TERMINAL_W * scale) / 2;
  const hd = (TERMINAL_D * scale) / 2;
  const heroClear = HERO_CLEAR * propScale;
  // CLAMPED TO WHAT THE ROOM CAN OFFER. The hero clearing is a SOFT
  // requirement, and in a 6×6 single-module room (bath / storage) the raw
  // 3m is more than the open field can ever reach — demanding it anyway
  // only distorts the worst-of score (every candidate reads as equally
  // "crowding the hero") and leaves the degenerate fallback's hero gate
  // unsatisfiable. effectiveHeroClear is the feasibility ceiling wherever
  // the room is genuinely small and the identity wherever it is not —
  // see heroClearCeilingFor. Both hero checks below read THIS value.
  const effectiveHeroClear = Math.min(
    heroClear,
    heroClearCeilingFor(plan, width, wallThick, propScale, comp.hero, hw),
  );

  const inside = (x: number, z: number): boolean =>
    terminalInsidePlan(plan, width, plan.extent, wallThick, {
      x0: x - hw,
      x1: x + hw,
      z0: z - hd,
      z1: z + hd,
    });
  // THE DOORWAY STRIP: an unscaled circle at the door centre (A4) — the
  // entrance apron the modules keep empty lives inside it, and the walk
  // path starts there, but the strip is the hard guarantee.
  const clearOfDoor = (x: number, z: number): boolean =>
    Math.hypot(x, z) >= ENTRANCE_CLEAR_RADIUS + hw + 0.1;
  const clearOfPath = (x: number, z: number): boolean =>
    distToPath(comp, x, z) >= comp.pathHalf + hw + 0.12;
  const clearOfWater = (x: number, z: number): boolean => {
    if (!water) return true;
    const dx = Math.max(0, Math.abs(x - water.cx) - water.halfX);
    const dz = Math.max(0, Math.abs(z - water.cz) - water.halfZ);
    return Math.hypot(dx, dz) >= hw + 0.1;
  };
  // Soft clearances, as BOUNDARY distances (≥0 means clear with margin).
  // The score is the WORST of them, so the picked spot is the one that
  // least crowds anything — hero content, furniture clusters, walls. The
  // hero boundary asks only for what the room can offer (the clamped
  // clearance); with the clamp exhausted it still reads as a raw distance,
  // so the scan keeps preferring the far spots rather than going blind.
  const heroBoundary = (x: number, z: number): number =>
    heroClear <= 0
      ? Number.POSITIVE_INFINITY
      : Math.hypot(x - comp.hero.x, z - comp.hero.z) - effectiveHeroClear - hw;
  const clusterBoundary = (x: number, z: number): number =>
    comp.clusters.reduce(
      (min, c) => Math.min(min, Math.hypot(x - c.x, z - c.z) - c.radius - hw),
      Number.POSITIVE_INFINITY,
    );
  // Wall-anchored furniture hugs every wall (kits.ts: origins stand off
  // the wall by the wall clear + the kit's back offset, bodies between).
  // The band keeps the machine out of that strip — the walls are where
  // the furniture IS; the middle of the room is the open field. 1.2 m at
  // prop scale covers the convention's deepest typical reach (clear 0.35
  // + back offset up to 0.8 + body ~0.4 for racks and shelves); the band
  // is SOFT — a cramped room scores lower rather than failing.
  const WALL_FURNITURE_BAND = 1.2 * Math.max(propScale, 0.35);
  const sideWallBoundary = (x: number): number =>
    halfRoom - Math.abs(x) - hw - WALL_FURNITURE_BAND;
  const farWallBoundary = (z: number): number =>
    plan.extent - z - hd - WALL_FURNITURE_BAND;

  // The seeded scan: the middle band of the plan — the open field a
  // floor lamp would stand in. Every draw is tested; hard filters are
  // gates, the soft boundaries pick the winner. Bounded (48 draws) and
  // total: same inputs, same spot.
  //
  // THE CLAMPED HERO CLEARING PROMOTES TO A GATE. In a room too small for
  // the raw clearing (effectiveHeroClear < heroClear — only ever the
  // single-module dollhouse rooms) the soft score alone cannot keep the
  // promise the clamp makes: the worst-of winner can land a draw's
  // granularity short of the ceiling. The ceiling exists precisely
  // because the band CAN satisfy it, so the clamped clearing is enforced
  // as a hard gate. Rooms that host the raw clearing are untouched — the
  // gate condition is false there and every draw scores exactly as
  // before (the regression guarantee).
  const heroGated = effectiveHeroClear < heroClear;
  let best: { x: number; z: number; score: number } | null = null;
  for (let i = 0; i < 48; i++) {
    const x = (rng() * 2 - 1) * Math.max(0.5, halfRoom - hw - 0.15);
    const z = plan.extent * (0.3 + rng() * 0.4);
    if (!inside(x, z) || !clearOfDoor(x, z) || !clearOfPath(x, z)) continue;
    if (!clearOfWater(x, z)) continue;
    if (heroGated && heroBoundary(x, z) < 0) continue;
    const score = Math.min(
      heroBoundary(x, z),
      clusterBoundary(x, z),
      sideWallBoundary(x),
      farWallBoundary(z),
    );
    if (!best || score > best.score) best = { x, z, score };
  }
  if (best) return { x: best.x, z: best.z, rotY: 0, scale };

  // DEGENERATE FALLBACK (the dollhouse scales): no open-field spot clears
  // the path, so the machine stands beside the doorway on the entrance
  // wall — the strand doors never hang there (room-doors.ts guarantees
  // it), and the feasibility nudges below only ever INCREASE clearance.
  const side = rng() < 0.5 ? -1 : 1;
  let w = TERMINAL_W * scale;
  let x = side * (ENTRANCE_CLEAR_RADIUS + w / 2 + 0.26);
  let z = wallThick / 2 + (TERMINAL_D * scale) / 2 - 0.02;
  const zMin = wallThick / 2 + (TERMINAL_D * scale) / 2 - 0.06;
  const xCap = halfRoom - w / 2 - 0.04;
  x = Math.min(Math.abs(x), xCap) * side;
  // The hero gate reads the SAME clamped clearance as the scan. It is
  // satisfiable at the initial spot by construction: the entrance wall is
  // farther from a far-third hero than the ceiling's own basis (the scan
  // band's far corner), and every nudge below walks deeper into the
  // corner — z down toward the wall, then x outward — which only ever
  // grows the hero distance, so once the gate holds it keeps holding.
  const clearOfHeroFb = (): boolean =>
    effectiveHeroClear <= 0 ||
    Math.hypot(x - comp.hero.x, z - comp.hero.z) >= effectiveHeroClear + w / 2;
  const insideFb = (): boolean =>
    terminalInsidePlan(plan, width, plan.extent, wallThick, {
      x0: x - w / 2,
      x1: x + w / 2,
      z0: z - (TERMINAL_D * scale) / 2,
      z1: z + (TERMINAL_D * scale) / 2,
    });
  // The walk never returns an unchecked spot: it stops at the first
  // position passing every gate, and if none does it returns the
  // hero-farthest position among those that passed the HARD gates (inside
  // / path / water) — best effort against the one soft requirement, never
  // a silent violation of a gate the room could have honoured. (No known
  // room needs that last resort: the clamp makes the hero gate reachable
  // wherever the hard gates pass at all.)
  let fbBest: { x: number; z: number; heroDist: number } | null = null;
  for (let i = 0; i < 24; i++) {
    if (insideFb() && clearOfPath(x, z) && clearOfWater(x, z)) {
      const heroDist = Math.hypot(x - comp.hero.x, z - comp.hero.z);
      if (clearOfHeroFb()) {
        fbBest = { x, z, heroDist };
        break;
      }
      if (!fbBest || heroDist > fbBest.heroDist) fbBest = { x, z, heroDist };
    }
    if (z > zMin) {
      z = Math.max(zMin, z - 0.08 * scale);
    } else if (Math.abs(x) + 0.2 * scale <= xCap) {
      x += side * 0.2 * scale;
    } else {
      break;
    }
  }
  if (fbBest) {
    x = fbBest.x;
    z = fbBest.z;
  }
  return { x, z, rotY: 0, scale };
}

/* ------------------------------------------------------------------ */
/* Lobby terminal (per-hotel, constant in the re-based lobby frame)   */
/* ------------------------------------------------------------------ */

export const LOBBY_TERMINAL_SCALE = 1.5;
/** South of the east arrival door's approach, north of the SE corner
 *  plant — mid-wall, facing the leg's walk; the first thing seen when a
 *  page-door hop lands through the east door. */
const LOBBY_TERMINAL_Z = -6;
const LOBBY_TERMINAL_S = LOBBY_TERMINAL_SCALE;

/** Center of the lobby terminal group (lobby-local frame). */
export const LOBBY_TERMINAL_X =
  LOBBY_LENGTH -
  LOBBY_CLEAR -
  (TERMINAL_D * LOBBY_TERMINAL_S) / 2 -
  0.02;

/** The lobby terminal's solid box — pushed out in clampToHotel like the
 *  desk and armchairs (game-canvas owns the clamp wrapper). */
export const LOBBY_TERMINAL_BLOCKER = {
  x0: LOBBY_TERMINAL_X - (TERMINAL_D * LOBBY_TERMINAL_S) / 2 - 0.06,
  x1: LOBBY_LENGTH - LOBBY_CLEAR + 0.02,
  z0: LOBBY_TERMINAL_Z - (TERMINAL_W * LOBBY_TERMINAL_S) / 2 - 0.08,
  z1: LOBBY_TERMINAL_Z + (TERMINAL_W * LOBBY_TERMINAL_S) / 2 + 0.08,
} as const;

/** The lobby terminal's anchor record (world = lobby-local). */
export const LOBBY_TERMINAL_ANCHOR: TerminalAnchor = {
  x: LOBBY_TERMINAL_X,
  z: LOBBY_TERMINAL_Z,
  rotY: -Math.PI / 2,
  scale: LOBBY_TERMINAL_S,
};

