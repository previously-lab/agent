import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerSliceJumpHandler,
  requestSliceJump,
  takePendingSliceJump,
  resetSliceJumpForTests,
} from "@/lib/chat/slice-jump";

describe("slice-jump bus", () => {
  beforeEach(() => resetSliceJumpForTests());

  it("runs the registered handler synchronously and reports handled", () => {
    const handler = vi.fn();
    const unregister = registerSliceJumpHandler(handler);
    expect(requestSliceJump("2026-08-01-1000")).toBe(true);
    expect(handler).toHaveBeenCalledWith("2026-08-01-1000", undefined);
    // Nothing stashed when handled.
    expect(takePendingSliceJump()).toBeNull();
    unregister();
  });

  it("carries the producer-known ISO start to the handler", () => {
    const handler = vi.fn();
    registerSliceJumpHandler(handler);
    requestSliceJump("2026-08-01-1000", "2026-08-11T10:00:00.000Z");
    expect(handler).toHaveBeenCalledWith(
      "2026-08-01-1000",
      "2026-08-11T10:00:00.000Z",
    );
  });

  it("stashes the jump when no handler is registered (palette on another route)", () => {
    expect(requestSliceJump("2026-08-01-1000")).toBe(false);
    expect(takePendingSliceJump()).toEqual({
      sliceId: "2026-08-01-1000",
      start: undefined,
    });
    // The stash is consumed by the take.
    expect(takePendingSliceJump()).toBeNull();
  });

  it("the latest unhandled jump wins (start included)", () => {
    requestSliceJump("2026-08-01-1000");
    requestSliceJump("2026-08-02-1100", "2026-08-12T11:00:00.000Z");
    expect(takePendingSliceJump()).toEqual({
      sliceId: "2026-08-02-1100",
      start: "2026-08-12T11:00:00.000Z",
    });
  });

  it("unregistering detaches only its own handler", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregA = registerSliceJumpHandler(a);
    registerSliceJumpHandler(b);
    unregA(); // stale unregister must not detach b
    expect(requestSliceJump("2026-08-03-1200")).toBe(true);
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
});
