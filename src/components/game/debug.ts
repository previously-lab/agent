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
};

declare global {
  interface Window {
    __gameDebug?: typeof GAME_DEBUG;
  }
}
