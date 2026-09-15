/**
 * Pure deterministic 2D value noise — the terrain generator for space
 * ground heightfields.
 *
 * WHY THIS EXISTS. Rolling ground (plains, forest) and every other
 * heightfield must rebuild identically from seeds alone: a player who walks
 * out of a space and returns must see the exact same terrain. That is only
 * possible if the noise is a pure function of (seed, x, y) — no state, no
 * I/O, no Math.random(). Every call with the same arguments returns the
 * same value, on any machine, at any time.
 *
 * Implementation: classic value noise. A mulberry32-seeded Fisher–Yates
 * shuffle builds a 256-entry permutation (doubled to 512 so index lookups
 * never need a second modulo); each lattice corner hashes through the
 * permutation to a value in [-1, 1], and the four corner values are blended
 * with the smoothstep (Perlin) fade. Output is in [-1, 1] — not full
 * amplitude everywhere, but bounded and continuous everywhere.
 */

import { createRng } from "./seed";

/** Permutation table size; lattice coords are hashed mod 256. */
const PERIOD = 256;

/**
 * Build the doubled permutation table for one seed. The shuffle draws from
 * a createRng stream so the table is itself a pure function of the seed.
 */
function buildPermutation(seed: number): Uint8Array {
  const rng = createRng(seed);
  const base = new Uint8Array(PERIOD);
  for (let i = 0; i < PERIOD; i++) base[i] = i;
  for (let i = PERIOD - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  const perm = new Uint8Array(PERIOD * 2);
  for (let i = 0; i < PERIOD * 2; i++) perm[i] = base[i & (PERIOD - 1)];
  return perm;
}

/**
 * Smoothstep fade: 3t² − 2t³. Zero slope at both ends, so value noise has
 * no creases at cell boundaries.
 */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic 2D value noise field for one seed.
 *
 * Pure and deterministic by contract: `noise(x, y)` always returns the same
 * value for the same seed and coordinates — terrain built from it rebuilds
 * identically on every visit. Output lies in [-1, 1] and is continuous in
 * both inputs.
 *
 * @param seed Sub-seed identifying the space/concern this field belongs to.
 */
export function createValueNoise2D(
  seed: number,
): (x: number, y: number) => number {
  const perm = buildPermutation(seed);
  const lattice = (ix: number, iy: number): number => {
    const h = perm[perm[ix & 0xff] + (iy & 0xff)];
    // h ∈ [0, 255] → [-1, 1] (255 maps to 1, 0 maps to ≈ -1).
    return h / 127.5 - 1;
  };
  return (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const v00 = lattice(x0, y0);
    const v10 = lattice(x0 + 1, y0);
    const v01 = lattice(x0, y0 + 1);
    const v11 = lattice(x0 + 1, y0 + 1);
    const bottom = v00 + (v10 - v00) * fx;
    const top = v01 + (v11 - v01) * fx;
    return bottom + (top - bottom) * fy;
  };
}

/**
 * Fractal Brownian motion over a value-noise field: `octaves` layers of
 * noise at doubling frequency and halving amplitude, normalized by the
 * total amplitude so the result stays in [-1, 1]. Pure in (noise, x, y).
 */
export function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  const count = Math.max(1, Math.floor(octaves));
  for (let i = 0; i < count; i++) {
    sum += noise(x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}
