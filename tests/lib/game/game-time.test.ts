/**
 * Tests for the game clock (src/components/game/game-time.ts) and its
 * compatibility view GAME_SIM_FREEZE (src/components/game/sim-freeze.ts).
 *
 * The contract under test:
 *
 *  - The R3F shared clock resets across the shell's always↔demand
 *    frameloop flips, so the game keeps its own: advanceGameClock is the
 *    ONE writer (GameTimeOwner each frame), everyone else reads
 *    gameDelta()/gameElapsed().
 *  - Normal frames: delta = rawDelta, elapsed accumulates.
 *  - Frozen frames: delta 0, elapsed untouched — no matter how many
 *    demand frames arrive.
 *  - The FIRST raw delta after a thaw is discarded (it spans the paused
 *    stretch / a restarted shared clock), and the discard mark survives
 *    frozen frames — it lands on the first THAWED frame, exactly once per
 *    thaw. Idempotent setGameFrozen calls never arm or consume anything.
 *  - GAME_SIM_FREEZE.frozen is a delegated view: reading answers
 *    GAME_TIME.frozen, writing drives setGameFrozen — one source of truth.
 *
 * Written but NOT RUN in this lane (no test execution allowed) — the
 * suite is the regression for the follow-up wiring lanes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceGameClock,
  GAME_TIME,
  gameDelta,
  gameElapsed,
  resetGameTimeForTests,
  setGameFrozen,
} from "@/components/game/game-time";
import { GAME_SIM_FREEZE } from "@/components/game/sim-freeze";

beforeEach(() => {
  resetGameTimeForTests();
});

describe("GAME_TIME cold boot", () => {
  it("starts unfrozen at zero, with the singleton readable both ways", () => {
    expect(GAME_TIME.frozen).toBe(false);
    expect(GAME_TIME.elapsed).toBe(0);
    expect(GAME_TIME.delta).toBe(0);
    expect(gameDelta()).toBe(0);
    expect(gameElapsed()).toBe(0);
  });
});

describe("advanceGameClock (normal frames)", () => {
  it("publishes the raw delta and accumulates elapsed", () => {
    advanceGameClock(0.016);
    expect(gameDelta()).toBe(0.016);
    expect(gameElapsed()).toBe(0.016);
    advanceGameClock(0.008);
    expect(gameDelta()).toBe(0.008);
    expect(gameElapsed()).toBe(0.024);
  });

  it("accumulates across a freeze/thaw cycle minus the discarded frame", () => {
    advanceGameClock(0.016);
    setGameFrozen(true);
    advanceGameClock(0.016); // frozen: nothing moves
    setGameFrozen(false);
    advanceGameClock(0.5); // the thaw frame: discarded
    advanceGameClock(0.016); // real again
    expect(gameElapsed()).toBeCloseTo(0.032, 6);
    expect(gameDelta()).toBe(0.016);
  });
});

describe("setGameFrozen(true)", () => {
  it("forces delta to 0 immediately, before any frame runs", () => {
    advanceGameClock(0.016);
    setGameFrozen(true);
    expect(gameDelta()).toBe(0);
    expect(gameElapsed()).toBe(0.016);
  });

  it("holds every frozen frame at delta 0 with elapsed untouched", () => {
    setGameFrozen(true);
    advanceGameClock(0.016);
    advanceGameClock(0.3);
    advanceGameClock(0.05);
    expect(gameDelta()).toBe(0);
    expect(gameElapsed()).toBe(0);
  });

  it("is idempotent — a second freeze does not stack state", () => {
    setGameFrozen(true);
    setGameFrozen(true);
    advanceGameClock(0.016);
    expect(gameDelta()).toBe(0);
    expect(gameElapsed()).toBe(0);
  });
});

describe("the thaw discard", () => {
  it("discards exactly the first raw delta after a thaw, once", () => {
    advanceGameClock(0.016);
    setGameFrozen(true);
    setGameFrozen(false);
    advanceGameClock(0.5); // discarded: the pause-straddling artifact
    expect(gameDelta()).toBe(0);
    expect(gameElapsed()).toBe(0.016);
    advanceGameClock(0.016); // the next frame is real
    expect(gameDelta()).toBe(0.016);
    expect(gameElapsed()).toBeCloseTo(0.032, 6);
  });

  it("survives frozen frames — the mark lands on the first THAWED frame", () => {
    setGameFrozen(true);
    setGameFrozen(false); // armed…
    setGameFrozen(true); // …but the pause returns before a frame runs
    advanceGameClock(0.3); // frozen: must NOT consume the mark
    expect(gameDelta()).toBe(0);
    setGameFrozen(false);
    advanceGameClock(0.5); // the thaw frame: discarded
    expect(gameElapsed()).toBe(0);
    advanceGameClock(0.016);
    expect(gameElapsed()).toBe(0.016);
  });

  it("does not arm when the clock was already running", () => {
    advanceGameClock(0.016);
    setGameFrozen(false); // no-op: already unfrozen
    advanceGameClock(0.016); // must NOT be discarded
    expect(gameElapsed()).toBeCloseTo(0.032, 6);
  });

  it("drops one frame per thaw across repeated pause cycles", () => {
    for (let i = 0; i < 3; i++) {
      setGameFrozen(true);
      advanceGameClock(0.4);
      setGameFrozen(false);
      advanceGameClock(9.9); // discarded each thaw
      advanceGameClock(0.01); // real
    }
    expect(gameElapsed()).toBeCloseTo(0.03, 6);
  });
});

describe("resetGameTimeForTests", () => {
  it("returns to the cold boot and clears an armed discard", () => {
    advanceGameClock(0.016);
    setGameFrozen(true);
    setGameFrozen(false); // armed
    resetGameTimeForTests();
    expect(GAME_TIME.frozen).toBe(false);
    expect(GAME_TIME.elapsed).toBe(0);
    expect(GAME_TIME.delta).toBe(0);
    // The thaw-discard flag died with the reset: the next frame is real.
    advanceGameClock(0.016);
    expect(gameDelta()).toBe(0.016);
    expect(gameElapsed()).toBe(0.016);
  });
});

describe("GAME_SIM_FREEZE (the delegated compatibility view)", () => {
  it("reads GAME_TIME.frozen", () => {
    expect(GAME_SIM_FREEZE.frozen).toBe(false);
    setGameFrozen(true);
    expect(GAME_SIM_FREEZE.frozen).toBe(true);
    expect(GAME_TIME.frozen).toBe(true);
  });

  it("writing true freezes the game clock", () => {
    GAME_SIM_FREEZE.frozen = true;
    expect(GAME_TIME.frozen).toBe(true);
    advanceGameClock(0.016);
    expect(gameDelta()).toBe(0);
    expect(gameElapsed()).toBe(0);
  });

  it("writing false thaws with the one-frame discard", () => {
    GAME_SIM_FREEZE.frozen = true;
    GAME_SIM_FREEZE.frozen = false;
    advanceGameClock(0.5); // discarded
    expect(gameElapsed()).toBe(0);
    advanceGameClock(0.016);
    expect(gameElapsed()).toBe(0.016);
  });
});
