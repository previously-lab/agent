import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyEvolutionActivity,
  createEvolutionScanState,
  EVOLUTION_PRESENCE_IDLE,
  EvolutionToastDedupe,
  evolutionToastContent,
  nextEvolutionEvent,
  publishEvolutionActivity,
  resetEvolutionActivityForTests,
  subscribeEvolutionActivity,
  type EvolutionActivity,
} from "@/lib/chat/evolution-activity";
import type { EvolutionStepData } from "@/lib/chat/build-stream";

describe("evolution-activity bus", () => {
  beforeEach(() => resetEvolutionActivityForTests());

  const running: EvolutionActivity = {
    kind: "running",
    turnId: "msg-1",
    step: "reading",
  };

  it("delivers published events to subscribers synchronously", () => {
    const listener = vi.fn();
    subscribeEvolutionActivity(listener);
    publishEvolutionActivity(running);
    expect(listener).toHaveBeenCalledWith(running);
  });

  it("unsubscribing detaches only its own listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregA = subscribeEvolutionActivity(a);
    subscribeEvolutionActivity(b);
    unregA();
    publishEvolutionActivity(running);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it("publishing with no subscribers is a no-op, not an error", () => {
    expect(() => publishEvolutionActivity(running)).not.toThrow();
  });
});

describe("nextEvolutionEvent (producer scan)", () => {
  it("publishes a running frame once and marks the turn tracked", () => {
    const state = createEvolutionScanState();
    const frame: EvolutionStepData = { status: "running", step: "reading" };
    const event = nextEvolutionEvent(state, "msg-1", frame);
    expect(event).toEqual({
      kind: "running",
      turnId: "msg-1",
      step: "reading",
      live: undefined,
    });
    expect(state.running.has("msg-1")).toBe(true);
    // Same chunk object re-scanned (re-render) publishes nothing.
    expect(nextEvolutionEvent(state, "msg-1", frame)).toBeNull();
  });

  it("a done frame after a running one is fresh", () => {
    const state = createEvolutionScanState();
    nextEvolutionEvent(state, "msg-1", { status: "running", step: "reviewing" });
    const done: EvolutionStepData = {
      status: "done",
      hasChanges: true,
      summary: "It now remembers the reader's name.",
    };
    const event = nextEvolutionEvent(state, "msg-1", done);
    expect(event).toEqual({
      kind: "done",
      turnId: "msg-1",
      summary: "It now remembers the reader's name.",
      hasChanges: true,
      error: undefined,
      fresh: true,
    });
    // Re-scanning the SAME chunk object (React re-render, no new chunk)
    // publishes nothing.
    expect(nextEvolutionEvent(state, "msg-1", done)).toBeNull();
    // A replayed COPY (reconnect rebuilds the parts) republishes as history —
    // fresh:false keeps it toast-less; consumers treat it as idempotent.
    const replay = nextEvolutionEvent(state, "msg-1", { ...done });
    expect(replay?.kind).toBe("done");
    if (replay?.kind === "done") expect(replay.fresh).toBe(false);
  });

  it("a done frame that arrives already-terminal is not fresh (history)", () => {
    const state = createEvolutionScanState();
    const event = nextEvolutionEvent(state, "msg-1", {
      status: "done",
      hasChanges: true,
      summary: "restored from the stash",
    });
    expect(event?.kind).toBe("done");
    if (event?.kind === "done") expect(event.fresh).toBe(false);
  });

  it("legacy frames without `status` infer the lifecycle from `running`", () => {
    const state = createEvolutionScanState();
    const event = nextEvolutionEvent(state, "msg-1", { running: true, step: "reading" });
    expect(event?.kind).toBe("running");
  });

  it("turns are independent — a second run in sequence gets its own events", () => {
    const state = createEvolutionScanState();
    nextEvolutionEvent(state, "msg-1", { status: "running" });
    nextEvolutionEvent(state, "msg-1", { status: "done", hasChanges: true });
    const run2 = nextEvolutionEvent(state, "msg-2", { status: "running" });
    expect(run2).toEqual({
      kind: "running",
      turnId: "msg-2",
      step: undefined,
      live: undefined,
    });
  });
});

describe("applyEvolutionActivity (presence reducer)", () => {
  it("running lights the button; done settles it and seats the completion", () => {
    let presence = applyEvolutionActivity(EVOLUTION_PRESENCE_IDLE, {
      kind: "running",
      turnId: "msg-1",
    });
    expect(presence.working).toBe(true);
    expect(presence.latest).toBeNull();
    presence = applyEvolutionActivity(presence, {
      kind: "done",
      turnId: "msg-1",
      summary: "It now remembers the reader's name.",
      hasChanges: true,
      fresh: true,
    });
    expect(presence.working).toBe(false);
    expect(presence.latest).toEqual({
      turnId: "msg-1",
      summary: "It now remembers the reader's name.",
      failed: false,
    });
  });

  it("a new run keeps the last completion in the seat while it works", () => {
    const presence = applyEvolutionActivity(
      {
        working: false,
        latest: { turnId: "msg-1", summary: "older change", failed: false },
      },
      { kind: "running", turnId: "msg-2" },
    );
    expect(presence.working).toBe(true);
    expect(presence.latest?.turnId).toBe("msg-1");
  });

  it("a failed run settles as failed, with no summary claim", () => {
    const presence = applyEvolutionActivity(EVOLUTION_PRESENCE_IDLE, {
      kind: "done",
      turnId: "msg-1",
      error: "budget exhausted",
      fresh: true,
    });
    expect(presence.latest).toEqual({
      turnId: "msg-1",
      summary: undefined,
      failed: true,
    });
  });
});

describe("evolutionToastContent (achievement mapper)", () => {
  const copy = { title: "Previously evolved", fallback: "Something in its memory was updated." };

  it("a fresh, changing completion toasts with its summary", () => {
    expect(
      evolutionToastContent(
        { kind: "done", turnId: "m", summary: "It remembers the trip.", hasChanges: true, fresh: true },
        copy,
      ),
    ).toEqual({ title: "Previously evolved", description: "It remembers the trip." });
  });

  it("a fresh completion without a summary falls back to the generic line", () => {
    expect(
      evolutionToastContent(
        { kind: "done", turnId: "m", hasChanges: true, fresh: true },
        copy,
      ),
    ).toEqual({ title: "Previously evolved", description: copy.fallback });
  });

  it("a whitespace-only summary falls back too", () => {
    expect(
      evolutionToastContent(
        { kind: "done", turnId: "m", summary: "   ", hasChanges: true, fresh: true },
        copy,
      )?.description,
    ).toBe(copy.fallback);
  });

  it("not an achievement: no-change runs, failures, and history", () => {
    expect(
      evolutionToastContent(
        { kind: "done", turnId: "m", hasChanges: false, summary: "nothing to do", fresh: true },
        copy,
      ),
    ).toBeNull();
    expect(
      evolutionToastContent(
        { kind: "done", turnId: "m", error: "boom", fresh: true },
        copy,
      ),
    ).toBeNull();
    expect(
      evolutionToastContent(
        { kind: "done", turnId: "m", hasChanges: true, summary: "replay", fresh: false },
        copy,
      ),
    ).toBeNull();
  });
});

describe("EvolutionToastDedupe", () => {
  it("toasts a turn once — replays are skipped, other turns still fire", () => {
    const dedupe = new EvolutionToastDedupe();
    expect(dedupe.markToasted("msg-1")).toBe(true);
    expect(dedupe.markToasted("msg-1")).toBe(false);
    expect(dedupe.markToasted("msg-1")).toBe(false);
    expect(dedupe.markToasted("msg-2")).toBe(true);
  });
});
