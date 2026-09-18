/**
 * Live game-state probe shared by the integrator and the space renderer.
 * WHY A MODULE. Both game-canvas (atmosphere/fog) and space (room fade)
 * write here, and both would otherwise import each other for a single
 * object — a circular import for no behavior. The shape is built
 * incrementally by each writer; readers (probes, e2e, the browser
 * console) see one flat bag of live values.
 */

/** Live player/atmosphere/fade state — preallocated, mutated in place. */
export const GAME_DEBUG = {
  x: 0,
  z: 0,
  space: null as string | null,
  /** The current hotel: "timelineId@windowIndex" (written by GameLoop). */
  hotel: "",
  /** Probe/e2e hook: teleport the player (clamps apply on the next frame). */
  teleport: undefined as undefined | ((x: number, z: number) => void),
  /** Probe/e2e hook: hop to a hotel (nav stack pushed, east-door arrival).
   *  `side` fakes the trip's side (§10.5) — default "east"; a lateral side
   *  lands by that wall's return door instead. */
  travel: undefined as
    | undefined
    | ((
        timelineId: string,
        windowIndex: number,
        side?: "north" | "south" | "east",
      ) => void),
  /** Live scene fog + background (written by Atmosphere every frame). */
  fogNear: 0,
  fogFar: 0,
  bg: "",
  /** Scene lights — the third candidate for a room-wide veil. */
  sunColor: "",
  sunIntensity: 0,
  ambient: 0,
  /** SpaceScene crossfade progress 0..1 and captured material count. */
  fadeT: -1,
  fadeMats: 0,
  /** Materials left transparent / below authored opacity after a fade. */
  matsTransparent: -1,
  matsFaded: -1,
  /** Probe/e2e mirror of the MOUNTED room's composition (§8) and its
   *  placed strand doors — written by SpaceScene whenever the room changes,
   *  null in the corridor. Probes assert §8/§10.5 facts (module growth by
   *  door load, axial door walls, sparse open fields) without reaching
   *  into the scene graph. */
  room: null as null | {
    sliceId: string;
    doorCount: number;
    /** The mounted recipe's own class/archetype/tier — probes diff the
     *  runtime recipe against the offline compile when fixtures are in
     *  play. */
    cls: string;
    modules: readonly string[];
    topology: string;
    width: number;
    extent: number;
    doorWalls: readonly string[];
    declaredCapacity: number;
    openFields: number;
    /** The open fields in the scaled plan's coordinates (§8.2 随机区域). */
    fieldRects: readonly (readonly [number, number, number, number])[];
    placedDoors: readonly { role: string; row: number; along: number }[];
    furniture: number;
    /** Every furnished piece's XZ (hero first) — probes count the pieces
     *  standing inside the open fields without entering the scene. */
    pieces: readonly (readonly [number, number])[];
    /** The kind of every entry in `pieces`, same order — probes identify
     *  a placed piece (e.g. which prop a trace rests on) by kind without
     *  entering the scene graph. */
    pieceKinds: readonly string[];
    /** The resolved template feature slots ACTUALLY built this mount
     *  (kind@role strings — e.g. "mezzanine@far", "water-rill@floor"):
     *  probes assert the N3/N4 features render where declared without
     *  entering the scene graph, and that a slot which failed every
     *  host rule is absent rather than clipped. */
    features: readonly string[];
    /** §4.4: the mounted room's one trace — its kind and XZ plus the host
     *  piece it rests on — or null when the room grew none (no eligible
     *  host, or an unfurnished room). Probes assert "exactly one, inside
     *  the path/hero visibility band" from data. */
    trace: null | {
      kind: string;
      x: number;
      z: number;
      host: string;
    };
  },
  /** Probe/e2e mirror of the MOUNTED room's water (written by the
   *  WaterSurface frame loop, null in the corridor and on unmount): the
   *  water rectangle in ROOM-LOCAL meters, the doorway's world position
   *  and orientation (world = door + local·dir), and the wave driver's
   *  awake flag — probes assert ripples/sleep without scene-graph access.
   *  The record is preallocated and mutated in place (no per-frame
   *  allocation). */
  water: null as null | {
    cx: number;
    cz: number;
    halfX: number;
    halfZ: number;
    doorX: number;
    doorZ: number;
    dir: 1 | -1;
    awake: boolean;
  },
  /** Probe/e2e: the current window's corridor doors — sliceId, wall-plane
   *  position, and which corridor side (north rooms sit at +z, south at
   *  −z). Newest first. Written by GameCanvas whenever the window changes. */
  windowDoors: [] as {
    sliceId: string;
    x: number;
    z: number;
    side: "north" | "south";
  }[],
  /** Probe/e2e: the data lane's strand-door count per slice id (the pure
   *  derivation the compositions freeze — §8.4). Empty map until the
   *  strand read resolves. */
  doorCounts: {} as Record<string, number>,
};

declare global {
  interface Window {
    __gameDebug?: typeof GAME_DEBUG;
  }
}

/** Preallocated record the WaterSurface frame loop mutates in place and
 *  hangs off GAME_DEBUG.water while a room with water is mounted (null
 *  again on unmount). One record is safe: at most one WaterSurface is
 *  mounted at a time. */
export const WATER_DEBUG_MIRROR = {
  cx: 0,
  cz: 0,
  halfX: 0,
  halfZ: 0,
  doorX: 0,
  doorZ: 0,
  dir: 1 as 1 | -1,
  awake: false,
};
