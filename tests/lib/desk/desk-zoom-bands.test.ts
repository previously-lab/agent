import { describe, expect, it } from "vitest";
import {
  createDeskCamera,
  DESK_ZOOM_BANDS,
  DESK_ZOOM_DEFAULT,
  DESK_ZOOM_MAX,
  DESK_ZOOM_MIN,
  DESK_ZOOM_RESET,
  deskZoomBandIndex,
  stepDeskZoomBand,
} from "@/lib/timeline3d/desk-camera";
import {
  deskZoomAtMax,
  deskZoomAtMin,
  formatDeskZoom,
} from "@/components/desk/desk-zoom";

/**
 * The banded zoom (v0.30, the owner's ruling): a few discrete stops instead
 * of the continuous 0.15× stepping. The contract the reader leans on:
 * buttons, `+`/`−`/`0` keys and ctrl-wheel all land ONLY on stops; the
 * opening and reset values are stops; the range ends are the first and last
 * stops; and the JS state jumps with the target (the CSS transition is the
 * damping, so there is no damped value to mirror any more).
 */
describe("DESK_ZOOM_BANDS", () => {
  it("spans the ruled range with the default and reset as stops", () => {
    expect(DESK_ZOOM_BANDS[0]).toBe(DESK_ZOOM_MIN);
    expect(DESK_ZOOM_BANDS[DESK_ZOOM_BANDS.length - 1]).toBe(DESK_ZOOM_MAX);
    expect(DESK_ZOOM_BANDS).toContain(DESK_ZOOM_DEFAULT);
    expect(DESK_ZOOM_BANDS).toContain(DESK_ZOOM_RESET);
    // Sorted ascending — stepping never jumps backwards.
    for (let i = 1; i < DESK_ZOOM_BANDS.length; i++) {
      expect(DESK_ZOOM_BANDS[i]).toBeGreaterThan(DESK_ZOOM_BANDS[i - 1]);
    }
  });
});

describe("deskZoomBandIndex", () => {
  it("resolves every band to itself", () => {
    DESK_ZOOM_BANDS.forEach((band, i) => {
      expect(deskZoomBandIndex(band)).toBe(i);
    });
  });

  it("resolves a value mid-flight between stops to the nearest band", () => {
    // Only reachable from a legacy continuous gesture — it must still pick
    // a stop, never throw, never invent a value.
    expect(deskZoomBandIndex(1.3)).toBe(DESK_ZOOM_BANDS.indexOf(1.2));
    expect(deskZoomBandIndex(1.34)).toBe(DESK_ZOOM_BANDS.indexOf(1.45));
  });
});

describe("stepDeskZoomBand", () => {
  it("steps one stop from the current band", () => {
    let cam = createDeskCamera(); // 1.45× — the opening default
    const i = DESK_ZOOM_BANDS.indexOf(DESK_ZOOM_DEFAULT);
    cam = stepDeskZoomBand(cam, 1);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_BANDS[i + 1]);
    cam = stepDeskZoomBand(cam, -1);
    cam = stepDeskZoomBand(cam, -1);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_BANDS[i - 1]);
  });

  it("jumps the current value WITH the target — the CSS transition is the damping", () => {
    const cam = stepDeskZoomBand(createDeskCamera(), 1);
    expect(cam.zoom).toBe(cam.zoomTarget);
  });

  it("clamps at both ends of the band table", () => {
    let cam = createDeskCamera();
    for (let n = 0; n < 20; n++) cam = stepDeskZoomBand(cam, 1);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_MAX);
    for (let n = 0; n < 40; n++) cam = stepDeskZoomBand(cam, -1);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_MIN);
  });
});

describe("the island's helpers against the bands", () => {
  it("reads every stop in the fixed display form", () => {
    for (const band of DESK_ZOOM_BANDS) {
      expect(formatDeskZoom(band)).toBe(`${band.toFixed(2)}×`);
    }
  });

  it("disables the buttons exactly at the table's ends", () => {
    expect(deskZoomAtMin(DESK_ZOOM_BANDS[0])).toBe(true);
    expect(deskZoomAtMax(DESK_ZOOM_BANDS[DESK_ZOOM_BANDS.length - 1])).toBe(
      true,
    );
    expect(deskZoomAtMin(DESK_ZOOM_BANDS[1])).toBe(false);
    expect(deskZoomAtMax(DESK_ZOOM_BANDS[DESK_ZOOM_BANDS.length - 2])).toBe(
      false,
    );
  });
});
