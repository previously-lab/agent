/**
 * The anchor terminal (v0.11 §13.1/§14.4 step ④) — pure module.
 *
 * Every room grows ONE terminal (the 锚定物): a floor-standing machine with
 * a slowly breathing screen. Walk up, interact, and the view switches to
 * the 2.5D catalog focused on the room's slice — the game → catalog
 * direction of the shared `?slice=` address. The lobby's terminal is one
 * size bigger and shows the whole-window index (buildLobbyRegister's data,
 * rendered as DOM per §13's 文字走 DOM rule).
 *
 * WHY THE ENTRANCE WALL. The resolver always places the terminal beside
 * the doorway on the ENTRANCE wall: the strand doors never hang there
 * (room-doors.ts guarantees it), the doorway clear strip is a known circle,
 * and the walk path starts at the door center — so a spot computed from
 * the strip radius, the path distance, and the hero clearing can never
 * block a passage and is the first thing seen on entry (显眼, never a
 * corner). A seeded draw picks WHICH side of the door; feasibility pulls
 * the machine toward the wall and then outward until every clearance
 * passes, so colossal paths and miniature plans both resolve
 * deterministically (A6: same inputs, same spot).
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
import { distToPath, type Composition, type RoomPlan } from "./room-plan";
import { createRng, hashString } from "./seed";
import { ENTRANCE_CLEAR_RADIUS, HERO_CLEAR } from "./tuning/room";
import { parseRungParam } from "@/lib/chat/deep-link";

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
 * Resolve the room terminal's anchor. Deterministic in (sliceId, plan,
 * comp, width, wallThick, propScale, water). The seeded draw is only the
 * SIDE of the doorway; every adjustment after that is feasibility-driven
 * (wall hug → path/hero/water clearance → plan containment), so the same
 * memory always grows the machine in the same spot.
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
  const side = rng() < 0.5 ? -1 : 1;

  const halfRoom = width / 2 - wallThick / 2;
  // The machine rides the prop scale like every other piece of furniture,
  // bounded so a colossal room gets a big console, not a billboard.
  let scale = Math.min(2.2, Math.max(0.35, propScale));
  // Miniature fallback floor — below this the dollhouse machine is a toy.
  const SCALE_FLOOR = 0.16;
  // Fit: the final |x| is min(need, xCap) with need = strip + half-width +
  // walk gap and xCap = halfRoom − half-width − pad; keeping need ≤ xCap
  // rearranges to width·scale ≤ halfRoom − (strip + gap + pad).
  const fitScale = (): number => {
    const byWidth = (halfRoom - (ENTRANCE_CLEAR_RADIUS + 0.3)) / TERMINAL_W;
    return Math.max(SCALE_FLOOR, Math.min(scale, byWidth));
  };
  scale = fitScale();

  let w = TERMINAL_W * scale;
  let x = side * (ENTRANCE_CLEAR_RADIUS + w / 2 + 0.26);
  let z = wallThick / 2 + (TERMINAL_D * scale) / 2 - 0.02;
  const zMin = wallThick / 2 + (TERMINAL_D * scale) / 2 - 0.06;
  const xCap = halfRoom - w / 2 - 0.04;
  x = Math.min(Math.abs(x), xCap) * side;

  const heroClear = HERO_CLEAR * propScale;
  const clearOfHero = (): boolean =>
    heroClear <= 0 ||
    Math.hypot(x - comp.hero.x, z - comp.hero.z) >= heroClear + w / 2;
  const clearOfWater = (): boolean => {
    if (!water) return true;
    const dx = Math.max(0, Math.abs(x - water.cx) - water.halfX);
    const dz = Math.max(0, Math.abs(z - water.cz) - water.halfZ);
    return Math.hypot(dx, dz) >= w / 2 + 0.1;
  };
  const clearOfPath = (): boolean =>
    distToPath(comp, x, z) >= comp.pathHalf + w / 2 + 0.12;
  const inside = (): boolean =>
    terminalInsidePlan(plan, width, plan.extent, wallThick, {
      x0: x - w / 2,
      x1: x + w / 2,
      z0: z - (TERMINAL_D * scale) / 2,
      z1: z + (TERMINAL_D * scale) / 2,
    });

  // Feasibility passes, applied in place and bounded: first hug the wall
  // (z down), then slide outward along it (x up). Both moves only ever
  // INCREASE clearance, so the loop terminates at the first fully-clear
  // spot; a machine that fits nowhere degrades to the wall at xCap,
  // never outside the plan.
  for (let i = 0; i < 24; i++) {
    if (inside() && clearOfPath() && clearOfHero() && clearOfWater()) break;
    if (z > zMin) {
      z = Math.max(zMin, z - 0.08 * scale);
    } else if (Math.abs(x) + 0.2 * scale <= xCap) {
      x += side * 0.2 * scale;
    } else {
      break;
    }
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

/* ------------------------------------------------------------------ */
/* The catalog jump (§13: navigation IS the address)                  */
/* ------------------------------------------------------------------ */

export type AnchorNav =
  | { readonly mode: "push"; readonly href: string }
  | { readonly mode: "assign"; readonly href: string };

/**
 * Where the anchor interaction navigates. Two paths, both through the
 * app's existing URL contract (`?at=` is the field's own slice-jump
 * address; the shell clears an in-session game override when one lands):
 *
 *  - The shell's rung is a card rung (`z` param live in the URL — the
 *    shell mirrors rung → URL on every change): a soft navigation to
 *    `?at=<id>` through Next's patched History API (an external pushState
 *    is picked up by the app router, so `useSearchParams` re-renders —
 *    no router import, which keeps game-canvas importable from node-side
 *    unit tests). The query-only URL keeps the locale path; the field
 *    remounts, focuses and flashes the slice's card, and the conversation
 *    jump stays suppressed — the panel tiers keep their existing
 *    defaults.
 *  - The rung is the conversation default (`z` absent — a cold boot at
 *    `/?view=game`, or the island button pressed from the conversation):
 *    the rung state cannot be lifted from the URL post-mount (the shell
 *    owns it; `z` only seeds the initial state), so a soft push would
 *    land on the conversation, not the catalog. A full navigation to
 *    `/<locale>?z=slice&at=<id>` re-seeds everything and lands exactly
 *    where a shared link would.
 *
 * Pure — unit-tested in tests/lib/game/anchor.test.ts.
 */
export function anchorNavPlan(
  currentSearch: string,
  locale: string,
  sliceId: string,
): AnchorNav {
  const enc = encodeURIComponent(sliceId);
  const rung = parseRungParam(currentSearch);
  if (rung !== null && rung !== "conversation") {
    // Query-only: pushState resolves it against the current locale path.
    return { mode: "push", href: `?at=${enc}` };
  }
  return { mode: "assign", href: `/${locale}?z=slice&at=${enc}` };
}
