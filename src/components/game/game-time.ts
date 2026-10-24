/**
 * The game clock (v0.28 step 2) — the game's OWN owner of time.
 *
 * WHY NOT THE R3F CLOCK. The shared canvas's frameloop flips between
 * "always" and "demand" (canvasPolicy in world-contract.ts): the shell
 * drops the loop to "demand" for the document pause and "never" for a
 * fullscreen pause, and R3F RESETS clock.elapsedTime when the loop
 * restarts — the shared clock is meaningless across a suspend/resume.
 * Anything in the game that integrates over time (movement, the bob
 * phase, the door lerp, the atmosphere easing) would jump or rewind at
 * every pause boundary. So the game keeps its own clock: ONE owner
 * (GameTimeOwner, use-game-frame.ts) writes it each frame from the raw
 * frame delta; every game subscriber reads gameDelta()/gameElapsed().
 *
 * THE CONTRACT.
 *  - Frozen (the document tier's GAME_SIM_FREEZE, which delegates its
 *    flag here): delta is 0 and elapsed does not move — the world holds
 *    still no matter how many demand frames the field's <Html> portals
 *    ask for.
 *  - The resume frame: the FIRST raw delta after a thaw is DISCARDED.
 *    The always↔demand flip makes that delta span the paused stretch (or
 *    a restarted shared clock), so integrating it would teleport the
 *    player the moment the blur lifts. Discarding keeps elapsed
 *    continuous; the dropped frame is invisible in the resume beat.
 *    Dropped exactly once per thaw, on the first THAWED frame — frozen
 *    frames never consume the mark.
 *  - Otherwise delta = rawDelta and elapsed accumulates it.
 *
 * Pure module — no three.js, no React. The mutable singleton is
 * deliberate, the same idiom as WORLD_TRANSITION (world-transition.ts):
 * the shell writes the freeze flag from React; frame loops read it
 * without re-rendering.
 */

/** The live game-clock state. Mutated ONLY by advanceGameClock and
 *  setGameFrozen — readers go through gameDelta()/gameElapsed() so the
 *  write path stays the single source of truth. */
export interface GameTimeState {
  /** True while the document tier freezes the simulation
   *  (GAME_SIM_FREEZE delegates its frozen flag here). */
  frozen: boolean;
  /** Accumulated game time, seconds — survives always↔demand restarts. */
  elapsed: number;
  /** This frame's game delta, seconds — 0 while frozen and on the
   *  resume frame. */
  delta: number;
}

export const GAME_TIME: GameTimeState = {
  frozen: false,
  elapsed: 0,
  delta: 0,
};

/** Armed by a thaw: the first raw delta after it is a pause-straddling
 *  artifact (the R3F clock restarted), never real motion. Consumed by
 *  exactly one advanceGameClock call. */
let discardNextRawDelta = false;

/** Freeze or thaw the game clock. Freezing forces delta to 0
 *  immediately; thawing arms the next raw delta for discard (see the
 *  file note). Repeated calls with the same value are a no-op, so a
 *  double-thaw never drops a real frame. The shell drives this through
 *  GAME_SIM_FREEZE (sim-freeze.ts), not directly. */
export function setGameFrozen(frozen: boolean): void {
  if (frozen === GAME_TIME.frozen) return;
  GAME_TIME.frozen = frozen;
  if (frozen) {
    GAME_TIME.delta = 0;
  } else {
    discardNextRawDelta = true;
  }
}

/** The ONE writer. Called every rendered frame by GameTimeOwner
 *  (use-game-frame.ts) — and ONLY by it; game subscribers read the
 *  clock. Frozen: delta 0, elapsed untouched. First frame after a thaw:
 *  the raw delta is discarded, elapsed untouched. Otherwise delta =
 *  rawDelta and elapsed accumulates. */
export function advanceGameClock(rawDelta: number): void {
  if (GAME_TIME.frozen) {
    GAME_TIME.delta = 0;
    return;
  }
  if (discardNextRawDelta) {
    discardNextRawDelta = false;
    GAME_TIME.delta = 0;
    return;
  }
  GAME_TIME.delta = rawDelta;
  GAME_TIME.elapsed += rawDelta;
}

/** This frame's game delta, seconds — the value game subscribers
 *  integrate by. */
export function gameDelta(): number {
  return GAME_TIME.delta;
}

/** Accumulated game time, seconds — continuous across suspends. */
export function gameElapsed(): number {
  return GAME_TIME.elapsed;
}

/** TEST-ONLY: back to the cold-boot state. Product code must never call
 *  this — a mid-run reset would rewind every animation under the
 *  world's feet; it exists purely so unit tests get a deterministic
 *  clock. */
export function resetGameTimeForTests(): void {
  GAME_TIME.frozen = false;
  GAME_TIME.elapsed = 0;
  GAME_TIME.delta = 0;
  discardNextRawDelta = false;
}
