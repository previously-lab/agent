/**
 * Tiling ripple normal maps for the poolroom's shallow water.
 *
 * The consumer (a later task's water material) scrolls N of these layers at
 * different speeds/directions and blends the normals; this module only owns
 * generation. EVERY layer must wrap seamlessly in both axes — a visible seam
 * on a scrolling water surface is the one defect the eye catches instantly.
 *
 * WHY A LOCAL NOISE FIELD. src/lib/game/noise.ts has no periodic mode: its
 * permutation wraps at 256 lattice cells, so the only seamless sample
 * window would be exactly 256 cells wide — far too coarse a base frequency
 * for ripples. Modifying that module is out of scope, so this file carries
 * its own toroidal value noise: lattice values live on a `period × period`
 * grid indexed with modulo, which tiles exactly at any base frequency. It
 * is still seeded through createRng, so determinism matches the rest of the
 * game. fbm over it also tiles, because every octave's frequency is an
 * integer multiple of the base period.
 */

import { createRng, hashString, WORLD_SEED } from "../seed";

export interface WaterNormalOptions {
  /** Texture edge length in pixels (default 256). */
  size?: number;
  /** Layer count (default 3). Layers differ in seed and base frequency. */
  layers?: number;
  /** Defaults to a stream derived from WORLD_SEED. */
  seed?: number;
}

export interface WaterNormalMaps {
  size: number;
  /** One Float32Array (RGBA size*size*4, RGB in [-1,1], A = 1) per layer. */
  layers: Float32Array[];
}

const DEFAULT_SIZE = 256;
const DEFAULT_LAYERS = 3;
/** fbm octaves per layer; each octave doubles an integer period, so the sum still tiles. */
const OCTAVES = 4;
/** Height → normal slope multiplier (flat, period-independent). */
const NORMAL_STRENGTH = 1;

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Toroidal value noise: a `period × period` lattice of seeded random values
 * indexed with modulo in both axes, so the field has an exact period of
 * `period` lattice cells in x and y. Output in [-1, 1]. Exported for the
 * other seamless builders in this library (caustics.ts); not part of the
 * public index.ts API.
 */
export function createTilingValueNoise2D(
  seed: number,
  period: number,
): (x: number, y: number) => number {
  const rng = createRng(seed);
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng() * 2 - 1;
  const at = (ix: number, iy: number): number => {
    const wx = ((ix % period) + period) % period;
    const wy = ((iy % period) + period) % period;
    return lattice[wy * period + wx];
  };
  return (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const v00 = at(x0, y0);
    const v10 = at(x0 + 1, y0);
    const v01 = at(x0, y0 + 1);
    const v11 = at(x0 + 1, y0 + 1);
    const bottom = v00 + (v10 - v00) * fx;
    const top = v01 + (v11 - v01) * fx;
    return bottom + (top - bottom) * fy;
  };
}

/** fbm over the tiling field; every octave is an integer-period multiple. */
export function tilingFbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

export function buildWaterNormalMaps(
  opts: WaterNormalOptions = {},
): WaterNormalMaps {
  const size = opts.size ?? DEFAULT_SIZE;
  const layerCount = opts.layers ?? DEFAULT_LAYERS;
  const seed = opts.seed ?? hashString(`${WORLD_SEED}:materials:water`);

  const layers: Float32Array[] = [];

  for (let layer = 0; layer < layerCount; layer++) {
    // Each layer gets its own stream and its own base frequency (6, 9, 12,
    // … cells across the texture) so scrolled layers never correlate.
    const period = 6 + layer * 3;
    const noise = createTilingValueNoise2D(
      hashString(`${seed}:water:${layer}`),
      period,
    );

    // Pass 1: ripple heightfield. u/v span exactly one lattice period
    // across the texture, so opposite edges sample identical values.
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * period;
        const v = (y / size) * period;
        height[y * size + x] = tilingFbm(noise, u, v, OCTAVES);
      }
    }

    // Pass 2: normals via WRAPPING central differences — the torus has no
    // edges, so the normal field is as seamless as the heightfield.
    const normals = new Float32Array(size * size * 4);
    // Flat multiplier on the per-pixel finite difference. Deliberately NOT
    // scaled by `period`: higher-frequency layers would otherwise get
    // steeper slopes and a larger per-pixel step, which is exactly what the
    // seamless-wrap budget cannot afford at the texture edges.
    const heightScale = NORMAL_STRENGTH;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const p = i * 4;
        const xp = y * size + ((x + 1) % size);
        const xm = y * size + ((x - 1 + size) % size);
        const yp = ((y + 1) % size) * size + x;
        const ym = ((y - 1 + size) % size) * size + x;
        const dhdx = ((height[xp] - height[xm]) / 2) * heightScale;
        const dhdy = ((height[yp] - height[ym]) / 2) * heightScale;
        const inv = 1 / Math.hypot(dhdx, dhdy, 1);
        normals[p] = -dhdx * inv;
        normals[p + 1] = -dhdy * inv;
        normals[p + 2] = inv;
        normals[p + 3] = 1;
      }
    }
    layers.push(normals);
  }

  return { size, layers };
}
