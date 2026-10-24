import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RootState } from "@react-three/fiber";
import {
  gameElapsed,
  resetGameTimeForTests,
  setGameFrozen,
} from "@/components/game/game-time";
import {
  GameTimeOwner,
  useGameFrame as subscribeToGameFrame,
  type GameFrameMeta,
} from "@/components/game/use-game-frame";

// Exercise the subscription contract without a WebGL renderer: callbacks
// run in R3F priority order and every reader shares the owner's frame time.
const subscriptions = vi.hoisted(() => [] as Array<{
  callback: (state: RootState, delta: number) => void;
  priority: number;
}>);
vi.mock("react", () => ({ useRef: <T>(value: T) => ({ current: value }) }));
vi.mock("@react-three/fiber", () => ({
  useFrame: (callback: (state: RootState, delta: number) => void, priority = 0) => {
    subscriptions.push({ callback, priority });
  },
}));

function frame(delta: number): void {
  for (const { callback } of [...subscriptions].sort((a, b) => a.priority - b.priority)) {
    callback({} as RootState, delta);
  }
}

beforeEach(() => {
  subscriptions.length = 0;
  resetGameTimeForTests();
});

describe("the game frame owner", () => {
  it("advances once before all readers regardless of registration order", () => {
    const first: GameFrameMeta[] = [];
    const second: GameFrameMeta[] = [];
    subscribeToGameFrame((_, meta) => first.push(meta));
    GameTimeOwner();
    subscribeToGameFrame((_, meta) => second.push(meta));
    frame(0.016);
    frame(0.02);
    expect(first).toEqual(second);
    expect(first.map((meta) => meta.delta)).toEqual([0.016, 0.02]);
    expect(gameElapsed()).toBeCloseTo(0.036);
  });

  it("delivers one cold static initialization while frozen demand frames never evolve", () => {
    const readings: GameFrameMeta[] = [];
    setGameFrozen(true);
    GameTimeOwner();
    subscribeToGameFrame((_, meta) => readings.push(meta));
    frame(0.02);
    frame(12);
    frame(0.02);
    expect(readings).toEqual([
      { delta: 0, elapsed: 0, initialize: true },
      { delta: 0, elapsed: 0, initialize: false },
      { delta: 0, elapsed: 0, initialize: false },
    ]);
  });

  it("keeps absolute animation phase across a pause and a restarted R3F clock", () => {
    const readings: GameFrameMeta[] = [];
    GameTimeOwner();
    subscribeToGameFrame((_, meta) => readings.push(meta));
    frame(2);
    setGameFrozen(true);
    frame(40);
    setGameFrozen(false);
    frame(0); // R3F restarted its clock on the frameloop change.
    frame(0.016);
    expect(readings.map((meta) => meta.elapsed)).toEqual([2, 2, 2, 2.016]);
    expect(readings.map((meta) => meta.initialize)).toEqual([true, false, false, false]);
  });
});
