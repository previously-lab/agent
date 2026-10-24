/**
 * Low-contrast wood grain — the shared timber albedo for room furniture.
 *
 * The look the room-polish pass targets (visual study 02): soft, matte,
 * LAYERED wood — visible grain that stays quiet under the interior fill
 * light. The albedo is deliberately near-neutral (mean ≈ 0.97) so the
 * palette color stays the average and the grain adds variation around it
 * (the same monochrome discipline as surface.ts's ALBEDO COMPENSATION:
 * consumers pre-divide by WOOD_ALBEDO_MEAN). Grain runs along texture U:
 * stretched fbm streaks a few pixels wide, ±(4–10)/255 in luminance, with
 * rare slightly warmer streaks — at the game's orthographic distance this
 * reads as 木理, never as noise. Roughness carries a matching stripe field
 * around a matte nominal so raking key light breaks along the grain.
 *
 * No normal map is produced for furniture: the material language stays
 * matte low-poly (flat shading), and the roughness/albedo contrast is
 * enough. The returned `normal` is the library's required flat (0,0,1)
 * placeholder so the buffer set still satisfies MaterialMaps; consumers
 * simply do not attach it.
 *
 * Deterministic by contract (materials/types.ts): all entropy comes from
 * createRng/hashString streams keyed by (seed, pixel), so the same options
 * produce byte-identical buffers on every machine.
 */

import { createValueNoise2D, fbm } from "../noise";
import { hashString, WORLD_SEED } from "../seed";
import type { MaterialMaps } from "./types";

export interface WoodOptions {
  /** Texture edge length in pixels (default 256). */
  size?: number;
  /** Defaults to a stream derived from WORLD_SEED, like tile/concrete. */
  seed?: number;
}

const DEFAULT_SIZE = 256;

/**
 * Mean albedo of the whole texture: a near-white field (≈ 0.97) minus the
 * sparse darker streaks. Consumers pre-divide their base color by this so
 * the palette stays the AVERAGE and the grain varies around it.
 */
export const WOOD_ALBEDO_MEAN = 0.97;

/** Roughness nominal the grain varies around (matte oiled timber). */
export const WOOD_ROUGHNESS_BASE = 0.74;
/** ± amplitude of the grain's roughness stripes. */
export const WOOD_ROUGHNESS_VARIANCE = 0.1;

/** Peak luminance dip of a grain streak, in 0–1 (kept low-contrast). */
const GRAIN_STRENGTH = 0.045;
/** Frequency of the stretched grain field across one texture edge. */
const GRAIN_FREQ_U = 9;
const GRAIN_FREQ_V = 34;
/** Probability a pixel belongs to a sparse warmer/darker growth streak. */
const STREAK_DENSITY = 0.06;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function buildWoodMaps(options: WoodOptions = {}): MaterialMaps {
  const size = options.size ?? DEFAULT_SIZE;
  const seed = options.seed ?? hashString(`${WORLD_SEED}:materials:wood`);
  const grain = createValueNoise2D(seed);
  const streak = createValueNoise2D(seed ^ 0x9e3779b9);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const roughness = new Uint8ClampedArray(size * size * 4);
  const normal = new Float32Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x / size) * GRAIN_FREQ_U;
      // V is stretched: the grain runs along U, so the field varies slowly
      // across V and quickly along U — thin long streaks, not blotches.
      const v = (y / size) * GRAIN_FREQ_V;
      const g = fbm(grain, u, v, 4);
      // Sparse growth streaks: an independent field thresholded so only a
      // few percent of pixels carry the warmer, slightly darker dip.
      const s = streak(u * 0.5, v * 0.5) > 1 - STREAK_DENSITY ? 1 : 0;

      // Albedo: near-white with the grain dip; streaks lean warm (more red,
      // less blue) like cut timber's latewood lines.
      const dip = GRAIN_STRENGTH * (0.5 + 0.5 * g) + (s ? 0.035 : 0);
      const warm = s ? 0.015 : 0;
      albedo[i] = Math.round(255 * clamp01(1 - dip * 0.82 + warm));
      albedo[i + 1] = Math.round(255 * clamp01(1 - dip));
      albedo[i + 2] = Math.round(255 * clamp01(1 - dip * 1.18 - warm));
      albedo[i + 3] = 255;

      // Roughness: matte nominal with the same grain field breaking it.
      const r = clamp01(
        WOOD_ROUGHNESS_BASE + WOOD_ROUGHNESS_VARIANCE * g - (s ? 0.06 : 0),
      );
      const rb = Math.round(255 * r);
      roughness[i] = rb;
      roughness[i + 1] = rb;
      roughness[i + 2] = rb;
      roughness[i + 3] = 255;

      // Flat placeholder normal (library contract; furniture never attaches
      // it — no normal shader patch for the room props).
      normal[i] = 0;
      normal[i + 1] = 0;
      normal[i + 2] = 1;
      normal[i + 3] = 1;
    }
  }

  return { size, albedo, roughness, normal };
}
