/**
 * Window-view images — the layered OUTSIDE seen through a room's window or
 * clerestory band (design §11.2: 「窗户要有景色，而且要跟房间同色」).
 * Not a glowing plate: a vertical sky gradient with a soft sun halo, then
 * one or two flat silhouette layers (a hazy far skyline, a darker near
 * tree/roof line) — depth by strata and value steps only, because the
 * camera is orthographic and parallax is impossible.
 *
 * Every color derives from the room's own palette (sky / fog / ground /
 * sunColor), so a blue room admits pale-blue daylight. The baked image is
 * the DAY state; the night state (darker, cooler) is applied by the
 * consumer as a material tint, so one texture serves both themes.
 *
 * Pure and node-safe: the builder returns an RGBA byte buffer (sRGB-
 * encoded — the DataTexture wrapper marks SRGBColorSpace, matching the
 * glow.ts canvas idiom); only createWindowViewTexture touches three.
 * Deterministic per seed: same seed, same view.
 */

import { DataTexture, LinearFilter, RepeatWrapping, SRGBColorSpace } from "three";
import { createRng } from "../seed";
import type { SkinSilhouette } from "../skins";

export interface WindowViewOptions {
  /** Stream seed — the consumer passes the room's recipe lightSeed. */
  seed: number;
  sky: string;
  fog: string;
  ground: string;
  sunColor: string;
  /** Pixel size (defaults 256×192 — a 4:3 pane). */
  width?: number;
  height?: number;
  /** The biome skin's silhouette mix (v0.12 P3, skins.ts): which
   *  authored far/near strata the bake layers. Omitted = the legacy
   *  soft-hills pair — the default bake is byte-for-byte unchanged. */
  silhouette?: SkinSilhouette;
}

export interface WindowViewImage {
  width: number;
  height: number;
  /** RGBA bytes, row 0 = BOTTOM of the view (DataTexture convention). */
  data: Uint8ClampedArray;
}

export const WINDOW_VIEW_WIDTH = 256;
export const WINDOW_VIEW_HEIGHT = 192;

/* ------------------------------------------------------------------ */
/* sRGB hex helpers (local: this module stays three-free above the     */
/* texture wrapper).                                                    */
/* ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const WHITE: Rgb = [255, 255, 255];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/* ------------------------------------------------------------------ */
/* Silhouette skylines. A skyline is one height per pixel column in    */
/* [0, 1] (fraction of image height, measured from the BOTTOM).        */
/* ------------------------------------------------------------------ */

/**
 * Far layer: a calm rolling skyline — smooth control points every
 * `step` columns, eased between. Hazy and low-contrast by construction
 * (the consumer colors it toward the fog).
 */
function rollingSkyline(
  rng: () => number,
  width: number,
  step: number,
  lo: number,
  hi: number,
): Float32Array {
  const points: number[] = [];
  for (let x = 0; x <= width + step; x += step) {
    points.push(lo + rng() * (hi - lo));
  }
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const i = Math.floor(x / step);
    out[x] = points[i] + (points[i + 1] - points[i]) * smooth((x % step) / step);
  }
  return out;
}

/**
 * Near layer: a chunked tree/roof line — per span a coin flip picks a
 * smooth run, a flat block (rooftop), or a peaked bump (tree/gable).
 * Reads as THINGS, not noise, at window size.
 */
function chunkedSkyline(
  rng: () => number,
  width: number,
  step: number,
  lo: number,
  hi: number,
): Float32Array {
  const out = new Float32Array(width);
  for (let start = 0; start < width; start += step) {
    const kind = rng();
    const h = lo + rng() * (hi - lo);
    const end = Math.min(width, start + step);
    if (kind < 0.34) {
      // Flat rooftop with a small lip.
      for (let x = start; x < end; x++) out[x] = h;
    } else if (kind < 0.67) {
      // Peaked gable / conifer: triangle over the span.
      const mid = (start + end) / 2;
      for (let x = start; x < end; x++) {
        out[x] = h * (1 - Math.abs(x - mid) / (step / 2));
      }
    } else {
      // Smooth shrub run: half-cosine bump.
      for (let x = start; x < end; x++) {
        out[x] = h * (0.55 + 0.45 * Math.sin(((x - start) / step) * Math.PI));
      }
    }
  }
  return out;
}

/**
 * The silhouette strata per mix (v0.12 P3). "soft-hills" is EXACTLY
 * today's pair — same builders, same parameters — so the default bake
 * stays byte-for-byte what it was. Every mix draws AFTER the sun halo
 * draws, so the sun keeps its seeded spot in every skin's sky (the
 * silhouettes never perturb it). open-water is horizon-only: both
 * strata read −1 (below every pixel) so nothing paints over the sky
 * gradient and the sun.
 */
interface SilhouettePair {
  far: (rng: () => number, width: number) => Float32Array;
  near: (rng: () => number, width: number) => Float32Array;
}

const SILHOUETTE_PAIRS: Record<SkinSilhouette, SilhouettePair> = {
  "soft-hills": {
    far: (rng, w) => rollingSkyline(rng, w, 26, 0.3, 0.5),
    near: (rng, w) => chunkedSkyline(rng, w, 18, 0.14, 0.34),
  },
  dunes: {
    // Smooth low ridges both strata — sand reads as long calm runs.
    far: (rng, w) => rollingSkyline(rng, w, 30, 0.26, 0.4),
    near: (rng, w) => rollingSkyline(rng, w, 12, 0.06, 0.16),
  },
  treeline: {
    // Dense conifer spikes crowding a soft far ridge.
    far: (rng, w) => rollingSkyline(rng, w, 22, 0.3, 0.46),
    near: (rng, w) => chunkedSkyline(rng, w, 9, 0.18, 0.44),
  },
  "mist-forest": {
    // Both strata chunked and tall — a crowded wet wall of growth.
    far: (rng, w) => chunkedSkyline(rng, w, 20, 0.26, 0.44),
    near: (rng, w) => chunkedSkyline(rng, w, 12, 0.16, 0.38),
  },
  "open-water": {
    far: (_rng, w) => new Float32Array(w).fill(-1),
    near: (_rng, w) => new Float32Array(w).fill(-1),
  },
};

/**
 * Bake the day view. Layout bottom → top: near silhouette (darkest) →
 * far silhouette (hazed toward the fog) → horizon haze → sky gradient
 * with a soft sun halo. A column is painted back-to-front: sky first,
 * then whichever silhouette layers reach that column overwrite it.
 */
export function buildWindowViewImage(opts: WindowViewOptions): WindowViewImage {
  const width = opts.width ?? WINDOW_VIEW_WIDTH;
  const height = opts.height ?? WINDOW_VIEW_HEIGHT;
  const rng = createRng(opts.seed);

  const sky = hexToRgb(opts.sky);
  const fog = hexToRgb(opts.fog);
  const ground = hexToRgb(opts.ground);
  const sun = hexToRgb(opts.sunColor);

  // Sky stops: the zenith leans toward the sun's hue, the horizon is the
  // palette's fog lifted toward white (the haze band every distance cue
  // in this world melts into).
  const zenith = mix(mix(sky, sun, 0.22), WHITE, 0.18);
  const horizon = mix(fog, WHITE, 0.32);
  // Silhouette colors: far = the ground's hue dissolved ~60% into the
  // haze; near = the ground halved, a touch of fog so it never goes
  // black (the anti-pattern list forbids unreadable dark).
  const farColor = mix(mix(ground, fog, 0.6), horizon, 0.35);
  const nearColor = mix(mix(ground, [0, 0, 0], 0.48), fog, 0.18);

  // Sun halo: seeded position in the upper half, soft quadratic falloff.
  const sunX = 0.2 + rng() * 0.6;
  const sunY = 0.6 + rng() * 0.25;
  const sunR = 0.34 + rng() * 0.12;
  const sunColor = mix(sun, WHITE, 0.45);

  const pair = SILHOUETTE_PAIRS[opts.silhouette ?? "soft-hills"];
  const far = pair.far(rng, width);
  const near = pair.near(rng, width);

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1); // 0 bottom → 1 top
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      // Sky gradient, eased so the haze band hugs the horizon.
      const t = smooth((v - 0.18) / 0.82);
      let r = horizon[0] + (zenith[0] - horizon[0]) * t;
      let g = horizon[1] + (zenith[1] - horizon[1]) * t;
      let b = horizon[2] + (zenith[2] - horizon[2]) * t;
      // Sun halo (additive in byte space, clamped).
      const d = Math.hypot(u - sunX, (v - sunY) * (height / width)) / sunR;
      if (d < 1) {
        const glow = (1 - d) * (1 - d) * 0.6;
        r += sunColor[0] * glow;
        g += sunColor[1] * glow;
        b += sunColor[2] * glow;
      }
      // Silhouettes, far then near (nearer overwrites — it is in front).
      const vf = far[x];
      const vn = near[x];
      if (v <= vf) {
        r = farColor[0];
        g = farColor[1];
        b = farColor[2];
      }
      if (v <= vn) {
        r = nearColor[0];
        g = nearColor[1];
        b = nearColor[2];
      }
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * three adapter: wrap a baked view in a DataTexture. `repeatX` > 1 tiles
 * the view horizontally (the clerestory band repeats one window-unit of
 * outside per mullion bay) — wrapS becomes RepeatWrapping.
 */
export function createWindowViewTexture(
  image: WindowViewImage,
  repeatX = 1,
): DataTexture {
  const texture = new DataTexture(
    image.data,
    image.width,
    image.height,
  );
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  if (repeatX > 1) {
    texture.wrapS = RepeatWrapping;
    texture.repeat.x = repeatX;
  }
  texture.needsUpdate = true;
  return texture;
}
