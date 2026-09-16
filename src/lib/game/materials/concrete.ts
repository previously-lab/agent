/**
 * Board-formed concrete — the matte counterpoint to the glazed tile.
 *
 * The look: a mid-grey field that never sits still — a low-frequency tonal
 * drift (so no two regions of a wall read identically), a handful of large
 * soft stains, and fine speckle/grain on top. Roughness lives in the matte
 * band (≈ 0.7–0.9) with the stains and drift modulating it. The normal map
 * is near-flat: fine grain only, no board seams — polygon-level structure
 * belongs to geometry, not to this texture.
 *
 * Deterministic by contract: stain placement draws from a createRng stream;
 * every field reuses the seeded value-noise/fbm from src/lib/game/noise.ts.
 */

import { createValueNoise2D, fbm } from "../noise";
import { createRng, hashString, WORLD_SEED } from "../seed";
import type { MaterialMaps } from "./types";

export interface ConcreteOptions {
  /** Texture edge length in pixels (default 256). */
  size?: number;
  /** Defaults to a stream derived from WORLD_SEED. */
  seed?: number;
}

const DEFAULT_SIZE = 256;

/**
 * Mean albedo of the whole texture (the 0.6 base value with drift/stain
 * variation averaging out). Consumers pre-divide their base color by this
 * so the palette stays the AVERAGE and the texture adds variation around it.
 */
export const CONCRETE_ALBEDO_MEAN = 0.6;

/** Large soft stains per texture. */
const STAIN_COUNT = 7;
/** Roughness is clamped into this band so the material always reads matte. */
const ROUGHNESS_MIN = 0.71;
const ROUGHNESS_MAX = 0.89;
/** Fine-grain normal strength — deliberately weak. */
const NORMAL_STRENGTH = 0.6;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface Stain {
  cx: number;
  cy: number;
  radius: number; // as a fraction of the texture edge
  strength: number; // peak albedo darkening
}

export function buildConcreteMaps(opts: ConcreteOptions = {}): MaterialMaps {
  const size = opts.size ?? DEFAULT_SIZE;
  const seed = opts.seed ?? hashString(`${WORLD_SEED}:materials:concrete`);

  const driftNoise = createValueNoise2D(hashString(`${seed}:concrete:drift`));
  const speckleNoise = createValueNoise2D(hashString(`${seed}:concrete:speckle`));
  const grainNoise = createValueNoise2D(hashString(`${seed}:concrete:grain`));

  const rng = createRng(hashString(`${seed}:concrete:stains`));
  const stains: Stain[] = [];
  for (let s = 0; s < STAIN_COUNT; s++) {
    stains.push({
      cx: rng(),
      cy: rng(),
      radius: 0.12 + rng() * 0.26,
      strength: 0.05 + rng() * 0.09,
    });
  }

  const albedo = new Uint8ClampedArray(size * size * 4);
  const roughness = new Uint8ClampedArray(size * size * 4);
  const normal = new Float32Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Pass 1: albedo, roughness, and the fine-grain heightfield.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = i * 4;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // Low-frequency tonal drift, fine speckle, per-pixel-ish grain.
      const drift = fbm(driftNoise, u * 3, v * 3, 3);
      const speckle = fbm(speckleNoise, u * 60, v * 60, 2);
      const grain = fbm(grainNoise, u * 140, v * 140, 1);

      // Stains: smooth radial falloff, overlapping blobs of damp/age.
      let stain = 0;
      for (const s of stains) {
        const dx = u - s.cx;
        const dy = v - s.cy;
        const t = Math.max(0, 1 - (dx * dx + dy * dy) / (s.radius * s.radius));
        stain += s.strength * t * t;
      }

      const value = clamp01(0.6 + drift * 0.07 - stain + speckle * 0.025 + grain * 0.012);
      // Faint warm cast, slightly cooled inside stains.
      const cool = 1 - Math.min(1, stain * 6) * 0.03;
      albedo[p] = Math.round(clamp01(value * 1.02 * cool) * 255);
      albedo[p + 1] = Math.round(value * 255);
      albedo[p + 2] = Math.round(clamp01(value * 0.965 + (1 - cool) * 0.02) * 255);
      albedo[p + 3] = 255;

      // Matte throughout; stains read slightly rougher (damp residue),
      // drift and speckle keep the field from ever being flat.
      const r = Math.min(
        ROUGHNESS_MAX,
        Math.max(
          ROUGHNESS_MIN,
          0.8 + drift * 0.04 + stain * 0.35 + speckle * 0.02,
        ),
      );
      const rb = Math.round(r * 255);
      roughness[p] = rb;
      roughness[p + 1] = rb;
      roughness[p + 2] = rb;
      roughness[p + 3] = 255;

      height[i] = speckle * 0.6 + grain * 0.4;
    }
  }

  // Pass 2: near-flat normals from the grain heightfield.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = i * 4;
      const xm = x > 0 ? i - 1 : i;
      const xp = x < size - 1 ? i + 1 : i;
      const ym = y > 0 ? i - size : i;
      const yp = y < size - 1 ? i + size : i;
      const dhdx = ((height[xp] - height[xm]) / 2) * NORMAL_STRENGTH;
      const dhdy = ((height[yp] - height[ym]) / 2) * NORMAL_STRENGTH;
      const inv = 1 / Math.hypot(dhdx, dhdy, 1);
      normal[p] = -dhdx * inv;
      normal[p + 1] = -dhdy * inv;
      normal[p + 2] = inv;
      normal[p + 3] = 1;
    }
  }

  return { size, albedo, roughness, normal };
}
