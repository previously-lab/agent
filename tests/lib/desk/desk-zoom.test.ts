import { describe, expect, it } from "vitest";
import {
  DESK_ZOOM_MAX,
  DESK_ZOOM_MIN,
} from "@/lib/timeline3d/desk-camera";
import {
  deskZoomAtMax,
  deskZoomAtMin,
  formatDeskZoom,
} from "@/components/desk/desk-zoom";

/**
 * The zoom island's pure helpers (v0.28 zoom chrome). The island itself is
 * DOM; what deserves guarding is the contract the buttons and readout lean
 * on: the display string's fixed form, and the range-end predicates never
 * lying about the clamps.
 */
describe("formatDeskZoom", () => {
  it("renders two decimals and the fixed × sign", () => {
    expect(formatDeskZoom(1.45)).toBe("1.45×");
    expect(formatDeskZoom(1)).toBe("1.00×");
    expect(formatDeskZoom(2)).toBe("2.00×");
    expect(formatDeskZoom(0.7)).toBe("0.70×");
  });

  it("shows the damped ease, not just the targets", () => {
    // A frame mid-ease between 1.00× and 1.45×: the readout reflects what is
    // on screen, which is the whole point of a damped readout.
    expect(formatDeskZoom(1.23456)).toBe("1.23×");
  });
});

describe("deskZoomAtMax / deskZoomAtMin", () => {
  it("flags the exact clamp bounds", () => {
    expect(deskZoomAtMax(DESK_ZOOM_MAX)).toBe(true);
    expect(deskZoomAtMin(DESK_ZOOM_MIN)).toBe(true);
    expect(deskZoomAtMax(DESK_ZOOM_MAX - 0.15)).toBe(false);
    expect(deskZoomAtMin(DESK_ZOOM_MIN + 0.15)).toBe(false);
  });

  it("absorbs float noise at the bound without lying inside the range", () => {
    // clampZoom lands exactly on the bound, but a target one epsilon below
    // must still read as AT the max — and a genuinely reachable value must
    // stay enabled.
    expect(deskZoomAtMax(DESK_ZOOM_MAX - 1e-12)).toBe(true);
    expect(deskZoomAtMax(DESK_ZOOM_MAX - 0.001)).toBe(false);
    expect(deskZoomAtMin(DESK_ZOOM_MIN + 1e-12)).toBe(true);
    expect(deskZoomAtMin(DESK_ZOOM_MIN + 0.001)).toBe(false);
  });
});
