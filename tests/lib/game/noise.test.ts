/**
 * Tests for the noise module (src/lib/game/noise.ts) — the deterministic
 * terrain field the space renderer builds rolling ground from. These lock
 * down the contract the renderer relies on: same seed + coordinates always
 * yield the same height, different seeds yield different fields, output
 * stays in [-1, 1], and the field is continuous enough that terrain never
 * creases between neighboring vertices.
 */
import { describe, it, expect } from "vitest";
import { createValueNoise2D, fbm } from "@/lib/game/noise";

describe("createValueNoise2D", () => {
  it("returns identical values across separate fields with the same seed", () => {
    const a = createValueNoise2D(12345);
    const b = createValueNoise2D(12345);
    for (const [x, y] of [
      [0, 0],
      [1.5, -2.25],
      [37.125, 4.875],
      [-512.5, 999.75],
    ]) {
      expect(a(x, y)).toBe(b(x, y));
    }
  });

  it("yields a different field for a different seed", () => {
    const a = createValueNoise2D(1);
    const b = createValueNoise2D(2);
    let differences = 0;
    for (let x = -8; x <= 8; x += 0.5) {
      for (let y = -8; y <= 8; y += 0.5) {
        if (a(x, y) !== b(x, y)) differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(0);
  });

  it("stays within [-1, 1] over a grid sweep", () => {
    const noise = createValueNoise2D(42);
    for (let x = -16; x <= 16; x += 0.125) {
      for (let y = -16; y <= 16; y += 0.125) {
        const v = noise(x, y);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("changes by less than 0.5 between neighboring points (continuity)", () => {
    const noise = createValueNoise2D(777);
    const step = 0.05;
    for (let x = -8; x <= 8; x += step) {
      for (let y = -8; y <= 8; y += step) {
        const here = noise(x, y);
        expect(Math.abs(noise(x + step, y) - here)).toBeLessThan(0.5);
        expect(Math.abs(noise(x, y + step) - here)).toBeLessThan(0.5);
      }
    }
  });

  it("is deterministic for negative and fractional coordinates", () => {
    const noise = createValueNoise2D(99);
    expect(noise(-3.7, 1.2)).toBe(noise(-3.7, 1.2));
  });
});

describe("fbm", () => {
  it("stays within [-1, 1] over a grid sweep", () => {
    const noise = createValueNoise2D(2024);
    for (let x = -16; x <= 16; x += 0.25) {
      for (let y = -16; y <= 16; y += 0.25) {
        const v = fbm(noise, x, y, 4);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reproduces the same field across separate calls", () => {
    const noise = createValueNoise2D(31337);
    expect(fbm(noise, 3.25, 8.5, 4)).toBe(fbm(noise, 3.25, 8.5, 4));
  });
});
