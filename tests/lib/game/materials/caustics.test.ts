/**
 * Tests for the tiling caustics web maps (src/lib/game/materials/caustics.ts).
 * The contract the pool-floor patch relies on: determinism, exact buffer
 * shapes, intensities in [0, 1], seamless wrapping in both axes (the shader
 * scrolls the layers forever), and — the characteristic look — a THIN bright
 * web on a dark field, whose two-layer product is darker still except at
 * filament crossings.
 *
 * The thresholds below were measured on the seeded maps (size 256):
 * per layer mean ≈0.19, std ≈0.25, ≈13-15% of pixels > 0.5, ≈4-5% > 0.8,
 * max = 1; product mean ≈0.037, <1% of pixels > 0.5. They pin the shaping
 * exponent (RIDGE_POWER): a lower power fails the web ceilings, a higher
 * one fails the variance floor and the bright-peak check.
 */
import { describe, it, expect } from "vitest";
import { buildCausticsMaps } from "@/lib/game/materials/caustics";
import { sameBytes } from "./helpers";

/** Mean per-pixel intensity difference between two rows of a layer. */
function meanRowDiff(
  layer: Float32Array,
  size: number,
  y0: number,
  y1: number,
): number {
  let sum = 0;
  for (let x = 0; x < size; x++) {
    sum += Math.abs(layer[(y0 * size + x) * 4] - layer[(y1 * size + x) * 4]);
  }
  return sum / size;
}

/** Mean per-pixel intensity difference between two columns of a layer. */
function meanColDiff(
  layer: Float32Array,
  size: number,
  x0: number,
  x1: number,
): number {
  let sum = 0;
  for (let y = 0; y < size; y++) {
    sum += Math.abs(layer[(y * size + x0) * 4] - layer[(y * size + x1) * 4]);
  }
  return sum / size;
}

/** Largest one-pixel step anywhere in the interior of a layer. */
function maxInteriorStep(layer: Float32Array, size: number): number {
  let max = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = layer[(y * size + x) * 4];
      max = Math.max(max, Math.abs(v - layer[(y * size + x + 1) * 4]));
      max = Math.max(max, Math.abs(v - layer[((y + 1) * size + x) * 4]));
    }
  }
  return max;
}

function layerStats(layer: Float32Array, size: number) {
  const n = size * size;
  let min = 1;
  let max = 0;
  let sum = 0;
  let sum2 = 0;
  let bright = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = layer[i * 4];
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    sum2 += v * v;
    if (v > 0.5) bright++;
    if (v > 0.8) peak++;
  }
  const mean = sum / n;
  return {
    min,
    max,
    mean,
    std: Math.sqrt(sum2 / n - mean * mean),
    brightFrac: bright / n,
    peakFrac: peak / n,
  };
}

describe("buildCausticsMaps", () => {
  it("is deterministic: same seed yields byte-identical layers", () => {
    const a = buildCausticsMaps({ size: 64, seed: 555 });
    const b = buildCausticsMaps({ size: 64, seed: 555 });
    expect(a.layers.length).toBe(b.layers.length);
    for (let i = 0; i < a.layers.length; i++) {
      expect(sameBytes(a.layers[i], b.layers[i])).toBe(true);
    }
  });

  it("produces different layers for a different seed", () => {
    const a = buildCausticsMaps({ size: 64, seed: 1 });
    const b = buildCausticsMaps({ size: 64, seed: 2 });
    expect(sameBytes(a.layers[0], b.layers[0])).toBe(false);
  });

  it("honours the requested layer count and defaults to 2 (the multiplier pair)", () => {
    expect(buildCausticsMaps({ size: 32, seed: 9 }).layers.length).toBe(2);
    expect(buildCausticsMaps({ size: 32, seed: 9, layers: 3 }).layers.length).toBe(3);
  });

  it("gives every layer exact dimensions and intensities in [0, 1] with A = 1", () => {
    const size = 64;
    const { layers } = buildCausticsMaps({ size, seed: 77 });
    for (const layer of layers) {
      expect(layer.length).toBe(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const p = i * 4;
        expect(Number.isFinite(layer[p])).toBe(true);
        expect(layer[p]).toBeGreaterThanOrEqual(0);
        expect(layer[p]).toBeLessThanOrEqual(1);
        // G/B replicate R so the map also works sampled as .rgb.
        expect(layer[p + 1]).toBe(layer[p]);
        expect(layer[p + 2]).toBe(layer[p]);
        expect(layer[p + 3]).toBe(1);
      }
    }
  });

  it("tiles seamlessly in both axes for every layer", () => {
    const size = 128;
    const { layers } = buildCausticsMaps({ size, seed: 314 });
    for (const layer of layers) {
      // A seam is a SYSTEMATIC edge defect: every pixel of the last row /
      // column jumping against the first. The sharpened web legitimately
      // has steep one-pixel steps near filaments ANYWHERE in the field
      // (interior adjacent-row maxima measure 0.2-0.5, global interior
      // steps up to ~0.9), so a bare max-diff threshold would false-positive
      // on the texture's own texture. Instead: the wrap edge's MEAN diff
      // must stay in the one-pixel-step band (interior adjacent pairs
      // measure 0.01-0.06; two independent fields would give ~0.2+), and no
      // wrap step may exceed the largest step the field makes internally.
      expect(meanRowDiff(layer, size, 0, size - 1)).toBeLessThan(0.1);
      expect(meanColDiff(layer, size, 0, size - 1)).toBeLessThan(0.1);
      const interiorMax = maxInteriorStep(layer, size);
      let wrapMax = 0;
      for (let x = 0; x < size; x++) {
        wrapMax = Math.max(
          wrapMax,
          Math.abs(layer[x * 4] - layer[((size - 1) * size + x) * 4]),
        );
      }
      for (let y = 0; y < size; y++) {
        wrapMax = Math.max(
          wrapMax,
          Math.abs(layer[y * size * 4] - layer[(y * size + size - 1) * 4]),
        );
      }
      expect(wrapMax).toBeLessThanOrEqual(interiorMax);
    }
  });

  it("makes the layers distinct from one another (independent frequencies)", () => {
    const { layers } = buildCausticsMaps({ size: 64, seed: 2718 });
    expect(sameBytes(layers[0], layers[1])).toBe(false);
  });

  it("is not constant: variance floor and bright peaks near 1", () => {
    const size = 128;
    const { layers } = buildCausticsMaps({ size, seed: 161 });
    for (const layer of layers) {
      const s = layerStats(layer, size);
      expect(s.std).toBeGreaterThan(0.15);
      expect(s.max).toBeGreaterThan(0.9);
    }
  });

  it("is a THIN web: most of the field is dark, bright filaments are rare", () => {
    const size = 256;
    const { layers } = buildCausticsMaps({ size, seed: 42 });
    for (const layer of layers) {
      const s = layerStats(layer, size);
      // Dark field: the average intensity is far below mid-grey…
      expect(s.mean).toBeLessThan(0.25);
      // …the web covers well under a fifth of the floor…
      expect(s.brightFrac).toBeLessThan(0.2);
      // …and the near-peak filaments are a small fraction of that.
      expect(s.peakFrac).toBeLessThan(0.08);
      // But it is a web, not specks: the bright fraction is not vanishing.
      expect(s.brightFrac).toBeGreaterThan(0.05);
    }
  });

  it("the two-layer product (what the shader adds) is darker still", () => {
    const size = 256;
    const { layers } = buildCausticsMaps({ size, seed: 42 });
    const n = size * size;
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < n; i++) {
      const v = layers[0][i * 4] * layers[1][i * 4];
      sum += v;
      if (v > 0.5) bright++;
    }
    // Filament crossings only: the composited light flares on ≪5% of the
    // floor and its mean is far below either layer's.
    expect(sum / n).toBeLessThan(0.08);
    expect(bright / n).toBeLessThan(0.05);
  });
});
