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
