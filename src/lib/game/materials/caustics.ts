/**
 * Tiling caustics light-web maps — the refracted-sunlight pattern on the
 * pool floor that is the single biggest "swimming pool" cue (research pass;
 * design doc §2 lists drei's Caustics as the signature, which costs two
 * extra scene renders plus two fullscreen passes per frame — this module is
 * the fake that replaces it).
 *
 * THE CLASSIC TRICK. Each layer is RIDGED fbm (1 - |fbm|) sharpened by a
 * power: value noise's zero crossings become thin bright filaments on a dark
 * field — the characteristic caustic web. The consumer samples TWO layers at
 * counter-scrolling offsets and multiplies the samples in the shader; where
 * both webs' filaments cross, the product flares — the slow boiling drift of
 * real caustics with zero texture re-uploads. The maps are static; all
 * motion is UV offsets (see caustics-surface.ts).
 *
 * SEAMLESS BY CONSTRUCTION. The ridged field reuses water.ts's toroidal
 * value noise / tiling fbm: u/v span exactly one lattice period across the
 * texture and every octave is an integer multiple of it, so opposite edges
 * match and the consumer may scroll the UVs freely forever.
 *
 * Output: one Float32Array (RGBA size*size*4) per layer. The web intensity
 * lives in R (G/B replicate it so the map also works sampled as .rgb),
 * A = 1. Values in [0, 1] — LINEAR light energy, so no SRGBColorSpace.
 */

import { createRng, hashString, WORLD_SEED } from "../seed";
import { createTilingValueNoise2D, tilingFbm } from "./water";

export interface CausticsMapsOptions {
  /** Texture edge length in pixels (default 256). */
  size?: number;
  /** Layer count (default 2 — the multiplier pair). Layers differ in seed
   *  and base frequency so their filaments never correlate. */
  layers?: number;
  /** Defaults to a stream derived from WORLD_SEED. */
  seed?: number;
}

export interface CausticsMaps {
  size: number;
  /** One Float32Array (RGBA size*size*4, intensity in [0,1], A = 1) per layer. */
  layers: Float32Array[];
}

const DEFAULT_SIZE = 256;
const DEFAULT_LAYERS = 2;
/** fbm octaves per layer; each octave doubles an integer period, so the sum still tiles. */
const OCTAVES = 4;
/**
 * Sharpening exponent on 1 - |fbm|. Normalized fbm hugs zero, so the raw
 * ridge field sits high (median ≈ 0.78) and a low power reads as broad
 * cloud, not a web. ^12 leaves ≈14% of pixels above 0.5 and ≈4-5% above
 * 0.8 (mean ≈0.18, peaks ≈1 — pinned by
 * tests/lib/game/materials/caustics.test.ts); the shader multiplies two
 * independent layers, so the composited light is dark except where both
 * webs' filaments cross. Lower powers read as fog, higher as specks.
 */
const RIDGE_POWER = 12;

export function buildCausticsMaps(opts: CausticsMapsOptions = {}): CausticsMaps {
  const size = opts.size ?? DEFAULT_SIZE;
  const layerCount = opts.layers ?? DEFAULT_LAYERS;
  const seed = opts.seed ?? hashString(`${WORLD_SEED}:materials:caustics`);

  const layers: Float32Array[] = [];

  for (let layer = 0; layer < layerCount; layer++) {
    // Base period 5, 8, 11, … cells across the texture: offset from the
    // water ripples' 6/9/12 and mutually incommensurate enough that two
    // counter-scrolled layers take many repeats to re-align.
    const period = 5 + layer * 3;
    const noise = createTilingValueNoise2D(
      hashString(`${seed}:caustics:${layer}`),
      period,
    );

    const data = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // u/v span exactly one lattice period across the texture, so
        // opposite edges sample identical values (see water.ts pass 1).
        const u = (x / size) * period;
        const v = (y / size) * period;
        const ridge = 1 - Math.abs(tilingFbm(noise, u, v, OCTAVES));
        const web = Math.pow(Math.min(Math.max(ridge, 0), 1), RIDGE_POWER);
        const p = (y * size + x) * 4;
        data[p] = web;
        data[p + 1] = web;
        data[p + 2] = web;
        data[p + 3] = 1;
      }
    }
    layers.push(data);
  }

  return { size, layers };
}
