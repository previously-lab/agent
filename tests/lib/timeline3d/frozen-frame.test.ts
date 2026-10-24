/** Frozen background rendering and finite field-layout scheduling. */
import { describe, expect, it } from "vitest";
import {
  createFrozenFrameRepaintPlanner,
  frozenFrameGeometryChanged,
  renderFrozenComposerOnce,
  requestFrozenLayoutFrames,
  type FrozenFrameComposer,
  type FrozenFrameGeometry,
  type FrozenFrameRenderer,
} from "@/lib/timeline3d/frozen-frame";

function geometry(
  width: number,
  height: number,
  dpr: number,
): FrozenFrameGeometry {
  return { width, height, dpr };
}

interface RendererCalls {
  target: unknown;
  scissorTest: boolean;
}

interface FakeRenderer extends FrozenFrameRenderer {
  calls: RendererCalls;
}

function makeRenderer(): FakeRenderer {
  const calls: RendererCalls = { target: null, scissorTest: false };
  return {
    calls,
    autoClear: false,
    getRenderTarget() {
      return calls.target;
    },
    setRenderTarget(target: unknown) {
      calls.target = target;
    },
    getScissorTest() {
      return calls.scissorTest;
    },
    setScissorTest(enabled: boolean) {
      calls.scissorTest = enabled;
    },
  };
}

interface ComposerCalls {
  sizes: Array<[number, number]>;
  deltas: number[];
}

interface FakeComposer extends FrozenFrameComposer {
  calls: ComposerCalls;
}

function makeComposer(): FakeComposer {
  const calls: ComposerCalls = { sizes: [], deltas: [] };
  return {
    calls,
    setSize(width: number, height: number) {
      calls.sizes.push([width, height]);
    },
    render(deltaTime: number) {
      calls.deltas.push(deltaTime);
    },
  };
}

/* A composer that dirties the renderer mid-render the way a real pass
 * chain can: flips autoClear, binds a target, enables scissor. The
 * one-shot must hand the renderer back clean. */
function makeMessyComposer(
  gl: FakeRenderer,
): FakeComposer & { calls: ComposerCalls & { autoClearDuringRender: boolean[] } } {
  const composer = makeComposer();
  const autoClearDuringRender: boolean[] = [];
  return {
    calls: { ...composer.calls, autoClearDuringRender },
    setSize: composer.setSize,
    render(deltaTime: number) {
      autoClearDuringRender.push(gl.autoClear);
      gl.autoClear = false;
      gl.setRenderTarget({ fake: true });
      gl.setScissorTest(true);
      composer.calls.deltas.push(deltaTime);
    },
  };
}

describe("frozenFrameGeometryChanged", () => {
  it("treats the first observed geometry as baseline, not a change", () => {
    expect(frozenFrameGeometryChanged(null, geometry(800, 600, 1))).toBe(false);
  });

  it("reports no change for an identical geometry", () => {
    const prev = geometry(800, 600, 1.5);
    expect(frozenFrameGeometryChanged(prev, geometry(800, 600, 1.5))).toBe(false);
  });

  it("reports a change for width, height, or dpr moves, each alone", () => {
    const prev = geometry(800, 600, 1.5);
    expect(frozenFrameGeometryChanged(prev, geometry(1024, 600, 1.5))).toBe(true);
    expect(frozenFrameGeometryChanged(prev, geometry(800, 800, 1.5))).toBe(true);
    expect(frozenFrameGeometryChanged(prev, geometry(800, 600, 2))).toBe(true);
  });
});

describe("renderFrozenComposerOnce", () => {
  it("sizes the composer in CSS pixels and renders with delta 0", () => {
    const gl = makeRenderer();
    const composer = makeComposer();
    renderFrozenComposerOnce(gl, composer, { width: 800, height: 600 });
    expect(composer.calls.sizes).toEqual([[800, 600]]);
    expect(composer.calls.deltas).toEqual([0]);
  });

  it("pins autoClear to true during the render and restores the prior value", () => {
    const gl = makeRenderer();
    gl.autoClear = false;
    const composer = makeMessyComposer(gl);
    renderFrozenComposerOnce(gl, composer, { width: 800, height: 600 });
    // The render ran under the wrapper's default autoClear (true)…
    expect(composer.calls.autoClearDuringRender).toEqual([true]);
    // …and the renderer is handed back exactly as it was found.
    expect(gl.autoClear).toBe(false);
  });

  it("leaves no bound render target or scissor test behind", () => {
    const gl = makeRenderer();
    const composer = makeMessyComposer(gl);
    renderFrozenComposerOnce(gl, composer, { width: 800, height: 600 });
    expect(composer.calls.deltas).toEqual([0]);
    expect(gl.getRenderTarget()).toBeNull();
    expect(gl.getScissorTest()).toBe(false);
  });

  it("disables inherited clipping and restores renderer state even if a pass throws", () => {
    const gl = makeRenderer();
    const target = { id: "previous-target" };
    gl.setRenderTarget(target);
    gl.setScissorTest(true);
    const composer = makeComposer();
    composer.render = () => {
      expect(gl.autoClear).toBe(true);
      expect(gl.getScissorTest()).toBe(false);
      gl.setRenderTarget({ id: "temporary-target" });
      throw new Error("pass failed");
    };
    expect(() => renderFrozenComposerOnce(gl, composer, { width: 800, height: 600 }))
      .toThrow("pass failed");
    expect(gl.autoClear).toBe(false);
    expect(gl.getRenderTarget()).toBe(target);
    expect(gl.getScissorTest()).toBe(true);
  });
});

describe("FrozenFrameRepaintPlanner", () => {
  const initial = geometry(800, 600, 1);
  const resized = geometry(1024, 800, 1.5);

  it("keeps an unchanged painted frame when pausing", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    expect(planner.planSuspended(initial, true)).toBe("none");
  });

  it("does not mistake an observed active resize for a successful paint", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    planner.syncActive(resized);
    // The loop can pause after setSize cleared the buffer, before render.
    expect(planner.planSuspended(resized, true)).toBe("paint");
    planner.markPainted(resized);
    expect(planner.planSuspended(resized, true)).toBe("none");
  });

  it("does not consume a planned repaint until the caller reports success", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    expect(planner.planSuspended(resized, true)).toBe("paint");
    expect(planner.planSuspended(resized, true)).toBe("paint");
    planner.markPainted(resized);
    expect(planner.planSuspended(resized, true)).toBe("none");
  });

  it("repairs a DPR-only change", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    const highDpr = { ...initial, dpr: 2 };
    expect(planner.planSuspended(highDpr, true)).toBe("paint");
    planner.markPainted(highDpr);
    expect(planner.planSuspended(highDpr, true)).toBe("none");
  });

  it("retains the debt when a resize returns to the original geometry", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    planner.syncActive(resized);
    planner.syncActive(initial);
    expect(planner.planSuspended(initial, true)).toBe("paint");
  });

  it("defers through missing composer and paints at the latest geometry", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    expect(planner.planSuspended(resized, false)).toBe("defer");
    const latest = geometry(1280, 720, 2);
    expect(planner.planSuspended(latest, false)).toBe("defer");
    expect(planner.planSuspended(latest, true)).toBe("paint");
    planner.markPainted(latest);
    expect(planner.planSuspended(latest, true)).toBe("none");
  });

  it("resume alone cannot erase an unpaid resize", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    expect(planner.planSuspended(resized, false)).toBe("defer");
    planner.syncActive(resized);
    expect(planner.planSuspended(resized, true)).toBe("paint");
  });

  it("a real resumed paint satisfies the debt without a duplicate manual paint", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.markPainted(initial);
    expect(planner.planSuspended(resized, false)).toBe("defer");
    planner.markPainted(resized);
    expect(planner.planSuspended(resized, true)).toBe("none");
  });

  it("cold suspended mount waits for static setup, then paints exactly once", () => {
    const planner = createFrozenFrameRepaintPlanner();
    expect(planner.planSuspended(initial, false, false)).toBe("defer");
    expect(planner.planSuspended(initial, true, false)).toBe("defer");
    expect(planner.planSuspended(initial, true, true)).toBe("paint");
    planner.markPainted(initial);
    expect(planner.planSuspended(initial, true)).toBe("none");
  });

  it("also initializes when suspension lands before the first active paint", () => {
    const planner = createFrozenFrameRepaintPlanner();
    planner.syncActive(initial);
    expect(planner.planSuspended(initial, true)).toBe("paint");
  });

  it("waits for a nonzero canvas size without dropping the first paint", () => {
    const planner = createFrozenFrameRepaintPlanner();
    expect(planner.planSuspended(geometry(0, 0, 1), true)).toBe("defer");
    expect(planner.planSuspended(initial, true)).toBe("paint");
  });

  it("copies paint geometry instead of retaining mutable caller state", () => {
    const planner = createFrozenFrameRepaintPlanner();
    const mutable = { ...initial };
    planner.markPainted(mutable);
    mutable.width = resized.width;
    expect(planner.planSuspended(mutable, true)).toBe("paint");
  });
});

describe("requestFrozenLayoutFrames", () => {
  it("wakes the range calculation and one later Html projection, then stops", () => {
    let count = 0;
    const scheduled: Array<() => void> = [];
    const cancel = requestFrozenLayoutFrames(
      () => { count++; },
      (callback) => { scheduled.push(callback); return 7; },
      () => undefined,
    );
    expect(count).toBe(1);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(count).toBe(2);
    expect(scheduled).toHaveLength(1);
    cancel();
  });

  it("cancels an obsolete resize or unmounted field's queued frame", () => {
    let count = 0;
    const scheduled: Array<() => void> = [];
    const cancelled: number[] = [];
    const cancel = requestFrozenLayoutFrames(
      () => { count++; },
      (callback) => { scheduled.push(callback); return 9; },
      (handle) => { cancelled.push(handle); },
    );
    cancel();
    scheduled[0]!(); // Even a scheduler that already dequeued it is harmless.
    expect(cancelled).toEqual([9]);
    expect(count).toBe(1);
  });
});
