import { describe, expect, it } from "vitest";
import {
  FIELD_FOV,
  LEGACY_CAM_Z,
  camZFor,
  clipPlanesFor,
  worldPerPxFor,
  worldScaleFor,
} from "@/lib/timeline3d/camera";

/** Field heights the app actually renders at (phone through a tall desktop
 *  window), plus the two the plan calls out. */
const HEIGHTS = [600, 720, 800, 900, 1080, 1440];

/** The height the camera sees at z=0: what `wpp` divides the viewport by. */
function focalHeightFor(viewH: number): number {
  const halfTan = Math.tan((FIELD_FOV * Math.PI) / 360);
  return 2 * camZFor(viewH) * halfTan;
}

describe("camZFor", () => {
  it("derives the distance from the viewport height, not a constant", () => {
    expect(camZFor(600)).toBeCloseTo(600 / (2 * Math.tan((15 * Math.PI) / 180)), 9);
    expect(camZFor(1200)).toBeCloseTo(2 * camZFor(600), 9);
    // Not the old fixed distance at any real viewport — that is the point.
    for (const h of HEIGHTS) expect(camZFor(h)).not.toBeCloseTo(LEGACY_CAM_Z, 1);
  });

  it("makes the focal plane 1 world unit per CSS px", () => {
    for (const h of HEIGHTS) {
      expect(worldPerPxFor(h)).toBeCloseTo(1, 12);
      // The same identity stated in world units: the z=0 plane measures `h`
      // world units tall.
      expect(focalHeightFor(h)).toBeCloseTo(h, 9);
    }
  });

  it("is scale-invariant in the ratio the depth cue depends on", () => {
    // A world depth `d` loses `d/camZ` of a sheet's size. With camZ derived,
    // a depth that scales with the viewport keeps that fraction identical at
    // every height — which is what `worldScaleFor` is for.
    const authoredDepth = 0.1; // SHEET_GAP_WORLD
    const shrink = (h: number) =>
      camZFor(h) / (camZFor(h) + authoredDepth * worldScaleFor(h));
    for (const h of HEIGHTS) {
      expect(shrink(h)).toBeCloseTo(shrink(800), 12);
    }
    expect(shrink(800)).toBeCloseTo(LEGACY_CAM_Z / (LEGACY_CAM_Z + authoredDepth), 9);
  });
});

describe("worldScaleFor", () => {
  it("preserves the old on-screen size at every viewport height", () => {
    // An authored world literal `L` rendered `L / wpp` px under the old fixed
    // camera, where `wpp = 2·9·tan(fov/2) / viewH`. Scaled by `worldScaleFor`
    // and rendered under the derived camera (1 world unit = 1 px) it must land
    // on the same px.
    const oldWorldPerPx = (viewH: number) =>
      (2 * LEGACY_CAM_Z * Math.tan((FIELD_FOV * Math.PI) / 360)) / viewH;
    for (const h of HEIGHTS) {
      for (const literal of [0.42, 0.14, 0.45, 0.1, 0.05]) {
        const oldPx = literal / oldWorldPerPx(h);
        const newPx = literal * worldScaleFor(h);
        expect(newPx).toBeCloseTo(oldPx, 9);
      }
    }
  });

  it("preserves the drift's YAW ANGLE, not its px offset", () => {
    // The drift's ±0.42 world units are a turn of atan(0.42/9) = 2.67°. It is
    // that angle — not the 0.42 — that must survive, because what it is worth
    // on screen is proportional to the viewport height (≈0.001·viewH px of
    // parallax across the first backing sheet). Baking in px would make the
    // drift smaller on a phone and larger on a desktop.
    const oldYaw = Math.atan(0.42 / LEGACY_CAM_Z);
    for (const h of HEIGHTS) {
      const yaw = Math.atan((0.42 * worldScaleFor(h)) / camZFor(h));
      expect(yaw).toBeCloseTo(oldYaw, 12);
    }
    expect((oldYaw * 180) / Math.PI).toBeCloseTo(2.6718, 3);
    // …and the px it produces do scale with the height.
    const parallaxPx = (h: number) => 0.1 * worldScaleFor(h) * Math.tan(oldYaw);
    expect(parallaxPx(1600) / parallaxPx(800)).toBeCloseTo(2, 9);
  });

  it("is 1 at the legacy camera's own viewport, and grows with the field", () => {
    // camZFor(H) = 9 exactly at H = 2·9·tan(15°) ≈ 4.823 px — the "viewport"
    // the old fixed camera was correct for.
    const legacyViewH = 2 * LEGACY_CAM_Z * Math.tan((FIELD_FOV * Math.PI) / 360);
    expect(worldScaleFor(legacyViewH)).toBeCloseTo(1, 12);
    expect(worldScaleFor(1600)).toBeGreaterThan(worldScaleFor(800));
  });
});

describe("clipPlanesFor", () => {
  it("brackets the camera distance at every viewport height", () => {
    for (const h of HEIGHTS) {
      const { near, far } = clipPlanesFor(h);
      const camZ = camZFor(h);
      expect(near).toBeLessThan(camZ);
      expect(camZ).toBeLessThan(far);
      expect(near).toBeGreaterThan(0);
    }
  });

  it("scales with the viewport, so it can never fall behind the camera", () => {
    // R3F's default `far = 1000` is in front of the camera from ~536 px tall
    // up; the derived planes stay a fixed fraction of camZ instead.
    for (const h of HEIGHTS) {
      const { near, far } = clipPlanesFor(h);
      expect(far).toBeCloseTo(2 * camZFor(h), 9);
      expect(near).toBeCloseTo(camZFor(h) / 2, 9);
    }
    expect(clipPlanesFor(1080).far).toBeGreaterThan(1000);
  });

  it("keeps the field's own depths inside the frustum", () => {
    // The deepest things the field draws are authored literals scaled by
    // `worldScaleFor` (the deal's z arc, the leaving-card pile), so they are a
    // fraction of camZ rather than a constant number of world units.
    const deepestOldUnits = 0.45; // the deal's z arc
    for (const h of HEIGHTS) {
      const { near, far } = clipPlanesFor(h);
      const depth = deepestOldUnits * worldScaleFor(h);
      expect(depth).toBeLessThan(near);
      // A card at the top of the viewport is at most ~viewH px from the camera
      // axis, i.e. sqrt(camZ² + viewH²) — inside `far`.
      const worstDist = Math.hypot(camZFor(h), h);
      expect(worstDist).toBeLessThan(far);
    }
  });
});
