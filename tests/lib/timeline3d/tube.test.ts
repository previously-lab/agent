/**
 * The one piece of arithmetic the band's cylinders cannot do for themselves:
 * turning a width stated in CSS pixels into a world radius.
 *
 * Everything else about a tube is three.js's own — a `CylinderGeometry`, an
 * `InstancedMesh`, an unlit material (see `tube-line.tsx`). Only this is ours,
 * because a cylinder's radius is a world length and how wide that looks depends
 * on where the camera is standing.
 */
import { describe, expect, it } from "vitest";
import { tubeRadiusWorld } from "@/lib/timeline3d/tube";

const VISIBLE = 4.82; // the baked viewport height at BASE_Z with a 30° fov
const HEIGHT = 800; // CSS px

describe("tubeRadiusWorld", () => {
  it("turns a CSS-pixel diameter into the world radius that draws it", () => {
    // The band is 800 CSS px tall for 4.82 world units of visible height, so
    // 1 CSS px is 0.006025 world units — and a radius is half a diameter.
    expect(tubeRadiusWorld(1, VISIBLE, HEIGHT)).toBeCloseTo(
      VISIBLE / HEIGHT / 2,
      9,
    );
    expect(tubeRadiusWorld(1, VISIBLE, HEIGHT) * 2).toBeCloseTo(
      VISIBLE / HEIGHT,
      9,
    );
  });

  it("is HALF the diameter, not the diameter", () => {
    // The one mistake that silently doubles the band's weight: the geometry
    // offsets by this value on BOTH sides of the axis.
    expect(tubeRadiusWorld(4, VISIBLE, HEIGHT)).toBeCloseTo(
      tubeRadiusWorld(2, VISIBLE, HEIGHT) * 2,
      9,
    );
  });

  it("grows with the visible world height, so the tube holds its size on screen", () => {
    // The camera pulls back at the coarse zoom levels and the visible world
    // height grows with it; without this the braid would visibly thin out as
    // the reader zooms away from the present.
    expect(tubeRadiusWorld(1, VISIBLE * 2, HEIGHT)).toBeCloseTo(
      tubeRadiusWorld(1, VISIBLE, HEIGHT) * 2,
      9,
    );
  });

  it("returns 0 rather than NaN for a degenerate viewport", () => {
    expect(tubeRadiusWorld(1, 0, HEIGHT)).toBe(0);
    expect(tubeRadiusWorld(1, VISIBLE, 0)).toBe(0);
    expect(tubeRadiusWorld(0, VISIBLE, HEIGHT)).toBe(0);
    expect(tubeRadiusWorld(-1, VISIBLE, HEIGHT)).toBe(0);
  });
});
