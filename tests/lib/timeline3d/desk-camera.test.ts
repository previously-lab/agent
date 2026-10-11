import { describe, expect, it } from "vitest";
import {
  DESK_CAMERA_DAMP_LAMBDA,
  DESK_ZOOM_DEFAULT,
  DESK_ZOOM_MAX,
  DESK_ZOOM_MIN,
  DESK_ZOOM_RESET,
  DESK_ZOOM_STEP,
  advanceDeskCamera,
  clampViewCentre,
  clampZoom,
  createDeskCamera,
  dragPanBy,
  panBoundsFor,
  resetDeskCamera,
  stepZoom,
  zoomBy,
  type DeskCameraState,
} from "@/lib/timeline3d/desk-camera";

/** An A4 sheet at the desk's own scale: ~86vh tall on an 800 px viewport. */
const SHEET = { w: 487, h: 688 }; // 688·(210/297)
const VIEW = { w: 1280, h: 800 };

/** Advances the state at 60 fps until it settles (or the cap trips). */
function settle(state: DeskCameraState, seconds = 2): DeskCameraState {
  let s = state;
  const frames = Math.ceil(seconds * 60);
  for (let i = 0; i < frames; i++) s = advanceDeskCamera(s, 1 / 60);
  return s;
}

describe("the zoom range", () => {
  it("clamps to 0.7×–2×", () => {
    expect(clampZoom(0.5)).toBe(DESK_ZOOM_MIN);
    expect(clampZoom(1.45)).toBe(1.45);
    expect(clampZoom(3)).toBe(DESK_ZOOM_MAX);
    expect(DESK_ZOOM_MIN).toBe(0.7);
    expect(DESK_ZOOM_MAX).toBe(2);
  });

  it("opens at B = 1.45×, centred — the reader's ruling", () => {
    const cam = createDeskCamera();
    expect(DESK_ZOOM_DEFAULT).toBe(1.45);
    expect(cam.zoom).toBe(1.45);
    expect(cam.zoomTarget).toBe(1.45);
    expect(cam.pan).toEqual({ x: 0, y: 0 });
    expect(cam.panTarget).toEqual({ x: 0, y: 0 });
  });
});

describe("stepZoom", () => {
  it("steps ±0.15 from the TARGET, so key repeats accumulate mid-damp", () => {
    expect(DESK_ZOOM_STEP).toBe(0.15);
    let cam = createDeskCamera();
    cam = stepZoom(cam, 1);
    expect(cam.zoomTarget).toBeCloseTo(1.6, 12);
    // The current value has not moved — damping is advance's job.
    expect(cam.zoom).toBe(1.45);
    cam = stepZoom(cam, -1);
    cam = stepZoom(cam, -1);
    expect(cam.zoomTarget).toBeCloseTo(1.3, 12);
  });

  it("clamps at both ends of the range and never overshoots", () => {
    let cam = createDeskCamera();
    for (let i = 0; i < 20; i++) cam = stepZoom(cam, 1);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_MAX);
    for (let i = 0; i < 30; i++) cam = stepZoom(cam, -1);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_MIN);
  });
});

describe("zoomBy", () => {
  it("is multiplicative and clamped (pinch / ctrl-wheel)", () => {
    let cam = createDeskCamera();
    cam = zoomBy(cam, 1.1);
    expect(cam.zoomTarget).toBeCloseTo(1.45 * 1.1, 12);
    cam = zoomBy(cam, 100);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_MAX);
    cam = zoomBy(cam, 0.001);
    expect(cam.zoomTarget).toBe(DESK_ZOOM_MIN);
  });
});

describe("resetDeskCamera", () => {
  it("returns to the whole page (1.0×) and centres the pan", () => {
    let cam = createDeskCamera();
    cam = stepZoom(cam, 1);
    cam = dragPanBy(cam, 300, -200);
    cam = resetDeskCamera(cam);
    expect(DESK_ZOOM_RESET).toBe(1);
    expect(cam.zoomTarget).toBe(1);
    expect(cam.panTarget).toEqual({ x: 0, y: 0 });
    // …and the damped values catch up within a beat.
    const settled = settle(cam);
    expect(settled.zoom).toBe(1);
    expect(settled.pan).toEqual({ x: 0, y: 0 });
  });
});

describe("panBoundsFor", () => {
  it("is zero while the sheet fits inside the visible window", () => {
    // At reset the sheet (688) is shorter than the window (800 / 1.0).
    expect(panBoundsFor(SHEET.w, SHEET.h, VIEW.w, VIEW.h, 1)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("is the excess half-extent once the zoomed sheet outgrows the window", () => {
    // At 1.45× the window shows 800/1.45 ≈ 551.7 of the 688-tall sheet.
    const b = panBoundsFor(SHEET.w, SHEET.h, VIEW.w, VIEW.h, 1.45);
    expect(b.y).toBeCloseTo((688 - 800 / 1.45) / 2, 9);
    expect(b.y).toBeGreaterThan(0);
    // The sheet is still narrower than the window: no horizontal roam.
    expect(b.x).toBe(0);
    // At 2× it outgrows both axes on a smaller viewport (the window shows
    // 400×400 world px against the 487×688 sheet).
    const b2 = panBoundsFor(SHEET.w, SHEET.h, 800, 800, 2);
    expect(b2.x).toBeCloseTo((487 - 800 / 2) / 2, 9);
    expect(b2.y).toBeCloseTo((688 - 800 / 2) / 2, 9);
    expect(b2.x).toBeGreaterThan(0);
  });
});

describe("clampViewCentre", () => {
  it("keeps the sheet covering the viewport — it can never be dragged out", () => {
    const b = { x: 100, y: 60 };
    expect(clampViewCentre({ x: 500, y: -500 }, b)).toEqual({ x: 100, y: -60 });
    expect(clampViewCentre({ x: -500, y: 500 }, b)).toEqual({ x: -100, y: 60 });
    expect(clampViewCentre({ x: 40, y: -20 }, b)).toEqual({ x: 40, y: -20 });
    // Zero bounds pin the centre.
    expect(clampViewCentre({ x: 9, y: 9 }, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("dragPanBy", () => {
  it("moves the view centre AGAINST the drag (grab-the-paper feel)", () => {
    // Drag right → the paper follows the pointer right → the view centre
    // moves left. Drag down → the paper moves down → the centre moves up
    // (screen y is down, world y is up).
    const cam = dragPanBy(createDeskCamera(), 145, 145);
    expect(cam.panTarget.x).toBeCloseTo(-100, 9); // 145 px / 1.45
    expect(cam.panTarget.y).toBeCloseTo(100, 9);
  });

  it("converts px to world units through the zoom", () => {
    let cam = createDeskCamera();
    cam = { ...cam, zoomTarget: 2 };
    const dragged = dragPanBy(cam, 200, 0);
    expect(dragged.panTarget.x).toBeCloseTo(-100, 12); // 200 px / 2
  });
});

describe("advanceDeskCamera", () => {
  it("converges on the targets within a beat (λ=12, 60 fps)", () => {
    expect(DESK_CAMERA_DAMP_LAMBDA).toBe(12);
    let cam = createDeskCamera();
    cam = stepZoom(cam, 1);
    cam = dragPanBy(cam, -72.5, 72.5); // 72.5 px at the 1.6 target = 45.3125
    const settled = settle(cam);
    expect(settled.zoom).toBeCloseTo(1.6, 12);
    expect(settled.pan.x).toBeCloseTo(72.5 / 1.6, 9);
    expect(settled.pan.y).toBeCloseTo(72.5 / 1.6, 9);
  });

  it("snaps to the targets on the reduced-motion path", () => {
    let cam = createDeskCamera();
    cam = stepZoom(cam, 1);
    cam = dragPanBy(cam, -72.5, 72.5);
    const snapped = advanceDeskCamera(cam, 1 / 60, true);
    expect(snapped.zoom).toBeCloseTo(1.6, 12);
    expect(snapped.pan.x).toBeCloseTo(72.5 / 1.6, 12);
    expect(snapped.pan.y).toBeCloseTo(72.5 / 1.6, 12);
  });

  it("holds still once settled (no drift creep)", () => {
    const cam = settle(createDeskCamera());
    const again = advanceDeskCamera(cam, 1 / 60);
    expect(again.zoom).toBe(cam.zoom);
    expect(again.pan).toEqual(cam.pan);
  });
});
