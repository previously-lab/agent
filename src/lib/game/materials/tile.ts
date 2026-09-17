/**
 * White glazed ceramic tile — the poolroom flagship material.
 *
 * The look: near-white glazed faces with a faint per-tile tone drift, light
 * grey grout seated EXACTLY on a `cells × cells` grid (so a caller can map
 * one texture cell to one real-world tile), a narrow beveled groove in the
 * normal map along every grout line, and subtle grime accumulating just
 * beside the grout. Physically the glaze is nearly glossy
 * (roughness ≈ 0.05–0.15) while the grout is matte (≈ 0.7–0.9) — that
 * contrast is what sells "wet ceramic" under correct lighting.
 *
 * Deterministic by contract: every per-tile decision comes from a
 * createRng/hashString stream keyed by (seed, cellX, cellY); the mottling
 * reuses the value-noise/fbm fields from src/lib/game/noise.ts.
 */

import { smoothstep } from "../math";
import { createValueNoise2D, fbm } from "../noise";
import { createRng, hashString, WORLD_SEED } from "../seed";
import type { MaterialMaps } from "./types";

export interface TileOptions {
  /** Texture edge length in pixels (default 256). Should be divisible by `cells`. */
  size?: number;
  /** Tiles per edge; grout lands exactly on this grid (default 8). */
  cells?: number;
  /** Defaults to a stream derived from WORLD_SEED, so the default poolroom tile is stable across builds. */
  seed?: number;
}

const DEFAULT_SIZE = 256;
const DEFAULT_CELLS = 8;

/**
 * Mean albedo of the whole texture (white glaze faces ≈ 0.95 with ~3.5%
 * grout coverage at ≈ 0.78, minus a couple of points of grime darkening
 * beside the joints). Consumers pre-divide their base color by this so the
 * palette stays the AVERAGE and the texture adds variation around it.
 */
export const TILE_ALBEDO_MEAN = 0.94;

/**
 * Grout half-width as a fraction of one cell: full joint ≈ 3.5% of a tile.
 * Real pool joints are 2–3 mm on a 30 cm tile (~1%), but at the game's
 * fixed camera 1 screen px ≈ 1.15 cm, so a joint that survives as a clean
 * "1px line" on screen is ≈ 3.5% of a cell. At the default 256px / 8-cell
 * grid that is ≈ 1.1 texture px, so the joint also survives the first mip
 * instead of aliasing into moiré. (The old 9% read as thick dark diamonds.)
 */
export const TILE_GROUT_HALF = 0.0175;
/** Grout bottom half-width: inside this the groove is at full depth. */
export const TILE_GROUT_BOTTOM = 0.006;
/**
 * Bevel run from grout bottom back up to the face, in cell units. The whole
 * groove-shaded band (grout + bevel, both sides) is ≈ 6% of a cell; the old
 * 23% looked like a wide chamfer around every tile, not a joint.
 */
export const TILE_BEVEL = 0.0125;
/** How far grime reaches from the grout edge into the face, in cell units. */
const GRIME_REACH = 0.16;
/**
 * Normal strength: groove slope multiplier (height is in cell units). 1.4
 * lit the shallow seam like a deep channel; 0.5 keeps a soft shading that
 * matches the hairline joint.
 */
export const TILE_NORMAL_STRENGTH = 0.5;
/**
 * Base grout albedo: clean, maintained pool joints read light grey, not
 * black (the grime beside them supplies the contrast instead).
 */
export const TILE_GROUT_ALBEDO = 0.78;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Groove height profile: 0 at the grout centre, rising through a smooth
 * bevel to 1 on the tile face. `d` is the distance to the nearest grout
 * centreline in cell units.
 */
function grooveHeight(d: number): number {
  return smoothstep(TILE_GROUT_BOTTOM, TILE_GROUT_BOTTOM + TILE_BEVEL, d);
}

export function buildTileMaps(opts: TileOptions = {}): MaterialMaps {
  const size = opts.size ?? DEFAULT_SIZE;
  const cells = opts.cells ?? DEFAULT_CELLS;
  const seed = opts.seed ?? hashString(`${WORLD_SEED}:materials:tile`);

  const pxPerCell = size / cells;
  // Independent noise streams per concern so one can be tuned without
  // perturbing the others (same discipline as seed.ts's SeedKey).
  const mottle = createValueNoise2D(hashString(`${seed}:tile:mottle`));
  const glaze = createValueNoise2D(hashString(`${seed}:tile:glaze`));
  const groutNoise = createValueNoise2D(hashString(`${seed}:tile:grout`));

  // Per-tile tone is a function of (cellX, cellY) only; cache per cell so
  // we pay for one rng stream per tile, not per pixel.
  const toneCache = new Float32Array(cells * cells);
  const glossCache = new Float32Array(cells * cells);
  const cached = new Uint8Array(cells * cells);
  const cellParams = (cx: number, cy: number): { tone: number; gloss: number } => {
    const i = cy * cells + cx;
    if (!cached[i]) {
      const rng = createRng(hashString(`${seed}:tile:cell:${cx}:${cy}`));
      toneCache[i] = rng() * 2 - 1; // albedo drift
      glossCache[i] = rng(); // face roughness offset
      cached[i] = 1;
    }
    return { tone: toneCache[i], gloss: glossCache[i] };
  };

  const albedo = new Uint8ClampedArray(size * size * 4);
  const roughness = new Uint8ClampedArray(size * size * 4);
  const normal = new Float32Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Pass 1: albedo, roughness, and the groove heightfield.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = i * 4;

      // Cell-space position: u/v in [0, cells), f in [0,1) inside the cell.
      const u = ((x + 0.5) / size) * cells;
      const v = ((y + 0.5) / size) * cells;
      const cx = Math.min(cells - 1, Math.floor(u));
      const cy = Math.min(cells - 1, Math.floor(v));
      const fx = u - cx;
      const fy = v - cy;
      // Distance to the nearest grout centreline, in cell units. Grout sits
      // exactly on the integer grid of u/v.
      const d = Math.min(fx, 1 - fx, fy, 1 - fy);

      const { tone, gloss } = cellParams(cx, cy);

      // Grout mask with a ~1px anti-aliased edge, clamped to the grout
      // half-width so the hairline joint still reaches full strength on its
      // centreline instead of being blurred away by its own AA ramp.
      const aa = Math.min(1 / pxPerCell, TILE_GROUT_HALF);
      const groutMask =
        1 - smoothstep(TILE_GROUT_HALF - aa, TILE_GROUT_HALF + aa, d);

      // Grime: strongest right at the grout edge, fading into the face.
      const grime =
        (1 - groutMask) *
        (1 - smoothstep(TILE_GROUT_HALF, TILE_GROUT_HALF + GRIME_REACH, d)) *
        (0.6 + 0.4 * fbm(mottle, u * 3, v * 3, 3));

      // Face albedo: near-white, faint cool glaze, per-tile tone drift,
      // low-frequency mottling, darkened by grime near the grout.
      const face =
        0.955 +
        tone * 0.02 +
        fbm(mottle, u * 1.5, v * 1.5, 3) * 0.015 +
        fbm(glaze, u * 24, v * 24, 2) * 0.008;
      const grimeDarken = 1 - 0.13 * Math.max(0, grime);
      const faceR = (face - 0.012) * grimeDarken;
      const faceG = (face - 0.004) * grimeDarken;
      const faceB = (face + 0.006) * (1 - 0.16 * Math.max(0, grime)); // grime kills the cool tint first

      // Grout albedo: light grey (clean joints read light, not black), with
      // its own unevenness.
      const g = TILE_GROUT_ALBEDO + fbm(groutNoise, u * 6, v * 6, 3) * 0.05;
      const groutR = g * 0.985;
      const groutG = g;
      const groutB = g * 1.015;

      albedo[p] = Math.round(clamp01(faceR + (groutR - faceR) * groutMask) * 255);
      albedo[p + 1] = Math.round(clamp01(faceG + (groutG - faceG) * groutMask) * 255);
      albedo[p + 2] = Math.round(clamp01(faceB + (groutB - faceB) * groutMask) * 255);
      albedo[p + 3] = 255;

      // Roughness: glaze nearly glossy, grout matte. Grime is slightly
      // rougher than the glaze around it.
      const faceRough = clamp01(
        0.08 + gloss * 0.05 + fbm(glaze, u * 12 + 40, v * 12 + 40, 2) * 0.015 +
          Math.max(0, grime) * 0.1,
      );
      const groutRough = clamp01(
        0.8 + fbm(groutNoise, u * 9 + 80, v * 9 + 80, 2) * 0.07,
      );
      const r = faceRough + (groutRough - faceRough) * groutMask;
      const rb = Math.round(clamp01(r) * 255);
      roughness[p] = rb;
      roughness[p + 1] = rb;
      roughness[p + 2] = rb;
      roughness[p + 3] = 255;

      height[i] = grooveHeight(d);
    }
  }

  // Pass 2: normals from the groove heightfield (central differences,
  // clamped at the texture edges — this map is not required to tile).
  const heightScale = pxPerCell * TILE_NORMAL_STRENGTH;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = i * 4;
      const xm = x > 0 ? i - 1 : i;
      const xp = x < size - 1 ? i + 1 : i;
      const ym = y > 0 ? i - size : i;
      const yp = y < size - 1 ? i + size : i;
      const dhdx = ((height[xp] - height[xm]) / 2) * heightScale;
      const dhdy = ((height[yp] - height[ym]) / 2) * heightScale;
      const inv = 1 / Math.hypot(dhdx, dhdy, 1);
      normal[p] = -dhdx * inv;
      normal[p + 1] = -dhdy * inv;
      normal[p + 2] = inv;
      normal[p + 3] = 1;
    }
  }

  return { size, albedo, roughness, normal };
}
