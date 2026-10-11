/**
 * Room papers — where the slice's loose sheets lie on its room's floor
 * (v0.25a §五 B②). The room's own record and the documents that stamped it
 * ((refs:) — see archive/actions.ts getRoomPapers) rest as scattered A4s in
 * the entrance's open band; the reader walks up to one and reads it in the
 * original manuscript (the desk).
 *
 * THE SPOTS ARE PURE. The renderer's sheets must stand where the movement
 * clamp and the proximity prompt believe they stand, so placement is a
 * deterministic function of the SAME inputs the terminal resolver takes
 * (A6 — lib/game/anchor.ts): plan, composition, scaled width, wall
 * thickness, water, the terminal anchor, and the slice id for the seed.
 * The caller asks for the MAXIMUM count (ROOM_PAPER_LIMIT) at geometry
 * time — before the async document list arrives — and renders a prefix;
 * prefix stability is a tested contract, so a room whose papers resolve
 * late never relocates the sheets already drawn.
 *
 * WHAT A SHEET NEVER DOES: stand outside the plan, inside the doorway
 * clearing (the door swing stays free), on the walk path's cleared
 * corridor, in the water, or under the terminal. Two more gates keep a
 * sheet where the reader can actually use it: OUTSIDE the composition's
 * cluster circles (the same furniture-footprint proxy the terminal
 * resolver consumes — anchor.ts — grouped scatter and kit staging anchor
 * around comp.clusters, so a candidate outside every circle avoids the
 * furniture by construction), and INSIDE the movement clamp's walkable
 * box (clamps.ts clampToSpace itself is the oracle — the module's own
 * contract is that a sheet stands where the movement clamp believes it
 * stands, so a candidate the clamp would relocate is rejected outright
 * rather than guessed at with copied margins). Sheets keep a finger of
 * air between one another — the scatter reads as dropped, not stacked.
 */
import { createRng, hashString } from "./seed";
import {
  distToPath,
  planContains,
  type Composition,
  type RoomPlan,
} from "./room-plan";
import { clampToSpace, WALL_Z } from "./clamps";
import type { DoorRef } from "./hotel";
import { terminalFootprint, type TerminalAnchor } from "./anchor";
import { ENTRANCE_CLEAR_RADIUS } from "./tuning/room";

/** One loose sheet on the floor: room-local center + facing. */
export interface RoomPaperSpot {
  x: number;
  z: number;
  /** Y-rotation of the sheet on the floor (the scatter's facing). */
  rotY: number;
}

export interface RoomPaperSpotsInput {
  sliceId: string;
  plan: RoomPlan;
  comp: Composition;
  /** Scaled plan width (the renderer's own). */
  width: number;
  /** Scaled wall thickness (the renderer's own). */
  wallThick: number;
  /** The room's water rectangle (scaled, local frame) or null when dry. */
  water: { cx: number; cz: number; halfX: number; halfZ: number } | null;
  terminal: TerminalAnchor;
  /** Sheets to place. The caller passes the MAXIMUM it may ever show and
   *  renders a prefix of the result. */
  count: number;
}

/** Footprint margin: an A4's half-diagonal at floor scale, plus a finger. */
export const PAPER_MARGIN = 0.22;
/** Two sheets never touch — center distance, meters. */
export const PAPER_SPACING = 0.5;
/** How close the reader must stand before a sheet answers the interact key
 *  (the terminal's own reach discipline — anchor.ts TERMINAL_REACH_*). */
export const PAPER_REACH = 1.1;
/** The doorway clearing plus the door swing's air. */
export const PAPER_DOOR_CLEAR = ENTRANCE_CLEAR_RADIUS + 0.3;
/** Clearance from the walk path's cleared corridor, beyond its half-width. */
export const PAPER_PATH_CLEAR = 0.2;
/** Seeded scan budget per room. */
const SCAN_ATTEMPTS = 64;

/** The standability oracle's synthetic door: the plan frame's own — the
 *  doorway is at the local origin by construction (terrain.ts's frame),
 *  so door.x = 0 with a north wall reproduces the room's local clamp
 *  exactly. The clamp's margins are symmetric across the side sign, and
 *  passing NO strand doors makes the box the conservative superset of
 *  every real relaxation (a door window only widens the box). */
const STAND_PROBE_DOOR: DoorRef = {
  index: 0,
  side: "north",
  sliceId: "",
  x: 0,
  z: WALL_Z,
};

/**
 * Resolve the sheets' floor spots. Deterministic in the input (the rng is
 * seeded from the slice id alone); the result for a smaller `count` is
 * always a prefix of the result for a larger one.
 */
export function roomPaperSpotsFor(input: RoomPaperSpotsInput): RoomPaperSpot[] {
  const { sliceId, plan, comp, width, wallThick, water, terminal, count } =
    input;
  if (count <= 0) return [];
  const rng = createRng(hashString(`${sliceId}@papers`));

  const tfp = terminalFootprint(terminal);
  const terminalBox = {
    x0: tfp.x0 - 0.3,
    x1: tfp.x1 + 0.3,
    z0: tfp.z0 - 0.3,
    z1: tfp.z1 + 0.3,
  };

  const clear = (x: number, z: number): boolean => {
    if (!planContains(plan, x, z, PAPER_MARGIN)) return false;
    if (Math.hypot(x, z) < PAPER_DOOR_CLEAR) return false;
    if (distToPath(comp, x, z) < comp.pathHalf + PAPER_PATH_CLEAR) return false;
    if (
      water !== null &&
      Math.abs(x - water.cx) < water.halfX + 0.25 &&
      Math.abs(z - water.cz) < water.halfZ + 0.25
    )
      return false;
    if (
      x > terminalBox.x0 &&
      x < terminalBox.x1 &&
      z > terminalBox.z0 &&
      z < terminalBox.z1
    )
      return false;
    // FURNITURE: outside every cluster circle by the sheet's own margin —
    // the terminal resolver's documented footprint proxy (anchor.ts).
    if (
      comp.clusters.some(
        (c) => Math.hypot(x - c.x, z - c.z) < c.radius + PAPER_MARGIN,
      )
    )
      return false;
    // STANDABLE where the sheet lies: run the movement clamp on the spot
    // (world = door + local·dir — the integrator's own mirror) and reject
    // any candidate the clamp would relocate (a wall margin, an l-shape
    // step, a seam). A spot that survives stands byte-exact where it was
    // dropped, so the reader settles on the sheet, not beside it.
    const probe = { x, z: z + WALL_Z };
    clampToSpace(probe, STAND_PROBE_DOOR, width, plan.extent, [], plan, []);
    if (probe.x !== x || probe.z !== z + WALL_Z) return false;
    return true;
  };

  const spots: RoomPaperSpot[] = [];
  const spaced = (x: number, z: number): boolean =>
    spots.every((s) => Math.hypot(s.x - x, s.z - z) >= PAPER_SPACING);

  // The scan band: the room's open NEAR half — papers lie where the reader
  // first walks, never past the hero's third. rot is drawn with the spot
  // (accepted or not) so the stream stays count-independent.
  const halfW = Math.max(0.3, width / 2 - wallThick / 2 - PAPER_MARGIN);
  const zLo = Math.max(PAPER_MARGIN, 0.6);
  const zHi = Math.max(zLo + 0.3, plan.extent * 0.5);
  for (let i = 0; i < SCAN_ATTEMPTS && spots.length < count; i++) {
    const x = (rng() * 2 - 1) * halfW;
    const z = zLo + rng() * (zHi - zLo);
    const rotY = (rng() - 0.5) * Math.PI;
    if (!clear(x, z) || !spaced(x, z)) continue;
    spots.push({ x, z, rotY });
  }

  // The degenerate-room fallback: a fan just outside the doorway clearing —
  // placeable in any plan that contains the door at all. The gates still
  // apply (a sheet never lands in the water); the arc's adjacent chord
  // (≥ 2·r·sin(9°) ≈ 0.58) keeps the spacing by construction.
  const r = PAPER_DOOR_CLEAR + 0.05;
  for (let i = 0; spots.length < count && i < 8; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const angle = ((25 + Math.floor(i / 2) * 18) * Math.PI) / 180;
    const x = side * r * Math.sin(angle);
    const z = r * Math.cos(angle);
    const rotY = (rng() - 0.5) * Math.PI;
    if (!clear(x, z) || !spaced(x, z)) continue;
    spots.push({ x, z, rotY });
  }

  return spots;
}
