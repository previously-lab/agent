"use client";

/**
 * useGameFrame + GameTimeOwner (v0.28 step 2) — the game world's frame
 * subscription, on the game's own clock.
 *
 * WHY NOT useFrame. The shared R3F clock resets whenever the shell flips
 * the canvas's frameloop between "always" and "demand" (the document
 * pause), so raw `delta` is not a time the game can integrate (see
 * game-time.ts). useGameFrame hands subscribers the GAME_CLOCK readings
 * instead: `meta.delta` / `meta.elapsed` hold THIS frame's game values,
 * identical for every game subscriber in the same frame.
 *
 * THE ONE WRITER. GameTimeOwner — mounted ONCE inside the game canvas —
 * is the only subscriber that ever calls advanceGameClock. It runs at
 * priority -100 (GAME_TIME_OWNER_PRIORITY), ahead of every ordinary game
 * subscriber, so by the time any other useGameFrame callback fires the
 * clock already holds this frame's delta/elapsed. Game subscribers must
 * not pass a priority at or below the owner's: anything ≤ -100 would read
 * the clock BEFORE it advances (and priority > 0 would take the renderer
 * away from R3F's auto-render, which is the field world's deliberate
 * choice, not the game's).
 *
 * THE ONE-SHOT INITIALIZE. `meta.initialize` is true on the subscriber's
 * FIRST invocation only — whatever the clock says, even cold-suspended
 * with delta 0 — so a component can run its static setup (seed a phase,
 * measure a pose) exactly once. It is a per-subscriber flag, never
 * re-armed per frame; suspended demand frames do not flip it back.
 */
import { useRef } from "react";
import { useFrame, type RootState } from "@react-three/fiber";
import { advanceGameClock, gameDelta, gameElapsed } from "./game-time";

/** The frame info handed to every game subscriber — the game clock's
 *  readings plus the one-shot initialization flag. */
export interface GameFrameMeta {
  /** This frame's game delta, seconds — 0 while frozen and on the
   *  resume frame (game-time.ts). Never the raw R3F delta. */
  readonly delta: number;
  /** Accumulated game time, seconds — continuous across suspends. */
  readonly elapsed: number;
  /** True on THIS subscriber's first invocation only — the static
   *  initialization beat, delivered even cold-suspended at delta 0. */
  readonly initialize: boolean;
}

/** The game frame subscription: same shape as useFrame, but `delta` and
 *  `elapsed` come from the game clock and the callback gets the one-shot
 *  `initialize` flag. `priority` defaults to 0 (the ordinary game band);
 *  keep it above GAME_TIME_OWNER_PRIORITY so the clock is already
 *  advanced when the callback runs. */
export function useGameFrame(
  callback: (state: RootState, meta: GameFrameMeta) => void,
  priority = 0,
): void {
  const firstRef = useRef(true);
  useFrame((state) => {
    const initialize = firstRef.current;
    firstRef.current = false;
    callback(state, {
      delta: gameDelta(),
      elapsed: gameElapsed(),
      initialize,
    });
  }, priority);
}

/** The owner priority — the most negative game subscription. R3F runs
 *  lower priorities first, so GameTimeOwner advances the game clock
 *  before any ordinary (priority-0) game subscriber reads it. */
export const GAME_TIME_OWNER_PRIORITY = -100;

/**
 * The game clock's single writer. Mount ONCE inside the game canvas;
 *  every rendered frame it feeds the raw frame delta into
 *  advanceGameClock. Renders nothing itself.
 */
export function GameTimeOwner(): null {
  useFrame((_state, rawDelta) => {
    advanceGameClock(rawDelta);
  }, GAME_TIME_OWNER_PRIORITY);
  return null;
}
