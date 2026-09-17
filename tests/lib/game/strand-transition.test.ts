/**
 * Strand-door wormhole state machine (doc 附录 B.11) — the pure reducer
 * behind the room→room crossing in game-canvas.tsx. The reducer owns every
 * accept/drop decision, so these tests pin the latch semantics: which
 * crossings start a transition, which are ignored, and how the latch
 * releases.
 */
import { describe, expect, it, vi } from "vitest";

// game-canvas.tsx is a client component: its import chain pulls next-themes,
// which imports next/navigation and cannot resolve under the node test
// environment. The reducer under test never touches it — stub it so the
// module loads.
vi.mock("@teispace/next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

import {
  reduceStrandTransition,
  type StrandTransition,
  type StrandTransitionEvent,
} from "@/components/game/game-canvas";

const IDLE: StrandTransition = { phase: "idle" };

function cross(overrides: Partial<Extract<StrandTransitionEvent, { type: "cross" }>> = {}) {
  return {
    type: "cross" as const,
    key: "strand: Kafka",
    lit: true,
    destinationIndex: 7,
    doorCount: 10,
    currentIndex: 3,
    ...overrides,
  };
}

describe("reduceStrandTransition — cross", () => {
  it("latches a valid crossing from idle", () => {
    expect(reduceStrandTransition(IDLE, cross())).toEqual({
      phase: "fadingOut",
      key: "strand: Kafka",
      destinationIndex: 7,
    });
  });

  it("drops an unlit door", () => {
    expect(reduceStrandTransition(IDLE, cross({ lit: false }))).toBe(IDLE);
  });

  it("drops a null destination (strand has no next slice)", () => {
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: null }))).toBe(IDLE);
  });

  it("drops destinations outside the rendered corridor", () => {
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: 10 }))).toBe(IDLE);
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: -1 }))).toBe(IDLE);
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: 2.5 }))).toBe(IDLE);
  });

  it("drops a crossing whose destination is the room the player is in", () => {
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: 3 }))).toBe(IDLE);
  });

  it("drops a crossing when no room is active (mid-exit to the corridor)", () => {
    expect(reduceStrandTransition(IDLE, cross({ currentIndex: null }))).toBe(IDLE);
  });

  it("accepts the boundary destinations of the rendered corridor", () => {
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: 0 })).phase).toBe("fadingOut");
    expect(reduceStrandTransition(IDLE, cross({ destinationIndex: 9 })).phase).toBe("fadingOut");
  });

  it("drops a crossing while one is already in flight (the latch)", () => {
    const inFlight: StrandTransition = {
      phase: "fadingOut",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(inFlight, cross({ key: "other", destinationIndex: 4 }))).toBe(
      inFlight,
    );
    const mounting: StrandTransition = {
      phase: "mounting",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(mounting, cross())).toBe(mounting);
  });
});

describe("reduceStrandTransition — fade handshake", () => {
  it("fadedOut advances fadingOut → mounting, keeping the destination", () => {
    const inFlight: StrandTransition = {
      phase: "fadingOut",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(inFlight, { type: "fadedOut" })).toEqual({
      phase: "mounting",
      key: "strand: Kafka",
      destinationIndex: 7,
    });
  });

  it("fadedOut is a no-op outside fadingOut (ordinary corridor exit)", () => {
    expect(reduceStrandTransition(IDLE, { type: "fadedOut" })).toBe(IDLE);
    const mounting: StrandTransition = {
      phase: "mounting",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(mounting, { type: "fadedOut" })).toBe(mounting);
  });
});

describe("reduceStrandTransition — latch release", () => {
  const mounting: StrandTransition = {
    phase: "mounting",
    key: "strand: Kafka",
    destinationIndex: 7,
  };

  it("releases when the destination room becomes the active space", () => {
    expect(
      reduceStrandTransition(mounting, { type: "activated", destinationIndex: 7 }),
    ).toEqual({ phase: "idle" });
  });

  it("stays latched when a different room reports active", () => {
    expect(
      reduceStrandTransition(mounting, { type: "activated", destinationIndex: 4 }),
    ).toBe(mounting);
  });

  it("ignores activation outside mounting", () => {
    expect(reduceStrandTransition(IDLE, { type: "activated", destinationIndex: 7 })).toBe(IDLE);
    const fading: StrandTransition = {
      phase: "fadingOut",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(fading, { type: "activated", destinationIndex: 7 })).toBe(
      fading,
    );
  });
});

describe("reduceStrandTransition — abort", () => {
  it("drops the latch from either in-flight phase", () => {
    const fading: StrandTransition = {
      phase: "fadingOut",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(fading, { type: "abort" })).toEqual({ phase: "idle" });
    const mounting: StrandTransition = {
      phase: "mounting",
      key: "strand: Kafka",
      destinationIndex: 7,
    };
    expect(reduceStrandTransition(mounting, { type: "abort" })).toEqual({ phase: "idle" });
  });

  it("is a no-op from idle", () => {
    expect(reduceStrandTransition(IDLE, { type: "abort" })).toBe(IDLE);
  });
});

describe("reduceStrandTransition — full crossing", () => {
  it("walks idle → fadingOut → mounting → idle and drops a mid-flight re-cross", () => {
    let state: StrandTransition = IDLE;
    state = reduceStrandTransition(state, cross());
    expect(state.phase).toBe("fadingOut");
    // A second crossing during the dissolve is dropped, not queued.
    const latched = reduceStrandTransition(state, cross({ key: "other", destinationIndex: 1 }));
    expect(latched).toBe(state);
    state = reduceStrandTransition(state, { type: "fadedOut" });
    expect(state.phase).toBe("mounting");
    state = reduceStrandTransition(state, { type: "activated", destinationIndex: 7 });
    expect(state).toEqual({ phase: "idle" });
    // The machine is reusable: the next crossing latches normally.
    expect(reduceStrandTransition(state, cross({ destinationIndex: 2 })).phase).toBe("fadingOut");
  });
});
