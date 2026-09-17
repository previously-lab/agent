/**
 * Strand-door hotel-hop state machine (doc 附录 B.11, HD4) — the pure
 * reducer behind the room→hotel crossing in game-canvas.tsx. The reducer
 * owns every accept/drop decision, so these tests pin the latch semantics:
 * which crossings start a transition, which are ignored, and how the latch
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
  type HotelRef,
  type StrandTransition,
  type StrandTransitionEvent,
} from "@/components/game/game-canvas";

const IDLE: StrandTransition = { phase: "idle" };

/** The hotel the player stands in (a strand timeline at some window). */
const CURRENT: HotelRef = { timelineId: "core", windowIndex: 0 };
/** A valid destination: a DIFFERENT hotel (the strand's own timeline). */
const DEST: HotelRef = { timelineId: "Kafka", windowIndex: 2 };

function cross(overrides: Partial<Extract<StrandTransitionEvent, { type: "cross" }>> = {}) {
  return {
    type: "cross" as const,
    key: "to:Kafka:2",
    lit: true,
    destination: DEST as HotelRef | null,
    current: CURRENT as HotelRef | null,
    ...overrides,
  };
}

const FADING: StrandTransition = {
  phase: "fadingOut",
  key: "to:Kafka:2",
  destination: DEST,
};
const MOUNTING: StrandTransition = {
  phase: "mounting",
  key: "to:Kafka:2",
  destination: DEST,
};

describe("reduceStrandTransition — cross", () => {
  it("latches a valid crossing from idle", () => {
    expect(reduceStrandTransition(IDLE, cross())).toEqual({
      phase: "fadingOut",
      key: "to:Kafka:2",
      destination: DEST,
    });
  });

  it("drops an unlit door", () => {
    expect(reduceStrandTransition(IDLE, cross({ lit: false }))).toBe(IDLE);
  });

  it("drops a null destination (the strand has no chapter to lead to)", () => {
    expect(reduceStrandTransition(IDLE, cross({ destination: null }))).toBe(IDLE);
  });

  it("drops a crossing whose destination is the hotel the player is in", () => {
    expect(reduceStrandTransition(IDLE, cross({ destination: CURRENT }))).toBe(IDLE);
  });

  it("accepts a destination on the same timeline at a different window", () => {
    const sameTimeline: HotelRef = { timelineId: "core", windowIndex: 1 };
    expect(
      reduceStrandTransition(IDLE, cross({ destination: sameTimeline })).phase,
    ).toBe("fadingOut");
  });

  it("drops a crossing when no room is active (mid-exit to the corridor)", () => {
    expect(reduceStrandTransition(IDLE, cross({ current: null }))).toBe(IDLE);
  });

  it("drops a crossing while one is already in flight (the latch)", () => {
    expect(
      reduceStrandTransition(
        FADING,
        cross({ key: "to:other:0", destination: { timelineId: "other", windowIndex: 0 } }),
      ),
    ).toBe(FADING);
    expect(reduceStrandTransition(MOUNTING, cross())).toBe(MOUNTING);
  });
});

describe("reduceStrandTransition — fade handshake", () => {
  it("fadedOut advances fadingOut → mounting, keeping the destination", () => {
    expect(reduceStrandTransition(FADING, { type: "fadedOut" })).toEqual(MOUNTING);
  });

  it("fadedOut is a no-op outside fadingOut (ordinary corridor exit)", () => {
    expect(reduceStrandTransition(IDLE, { type: "fadedOut" })).toBe(IDLE);
    expect(reduceStrandTransition(MOUNTING, { type: "fadedOut" })).toBe(MOUNTING);
  });
});

describe("reduceStrandTransition — latch release", () => {
  it("arrived releases mounting → idle (the player stands in the destination lobby)", () => {
    expect(reduceStrandTransition(MOUNTING, { type: "arrived" })).toEqual({ phase: "idle" });
  });

  it("ignores arrived outside mounting", () => {
    expect(reduceStrandTransition(IDLE, { type: "arrived" })).toBe(IDLE);
    expect(reduceStrandTransition(FADING, { type: "arrived" })).toBe(FADING);
  });
});

describe("reduceStrandTransition — abort", () => {
  it("drops the latch from either in-flight phase", () => {
    expect(reduceStrandTransition(FADING, { type: "abort" })).toEqual({ phase: "idle" });
    expect(reduceStrandTransition(MOUNTING, { type: "abort" })).toEqual({ phase: "idle" });
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
    const latched = reduceStrandTransition(
      state,
      cross({ key: "to:other:0", destination: { timelineId: "other", windowIndex: 0 } }),
    );
    expect(latched).toBe(state);
    state = reduceStrandTransition(state, { type: "fadedOut" });
    expect(state.phase).toBe("mounting");
    state = reduceStrandTransition(state, { type: "arrived" });
    expect(state).toEqual({ phase: "idle" });
    // The machine is reusable: the next crossing latches normally.
    expect(
      reduceStrandTransition(
        state,
        cross({ destination: { timelineId: "Proust", windowIndex: 0 } }),
      ).phase,
    ).toBe("fadingOut");
  });
});
