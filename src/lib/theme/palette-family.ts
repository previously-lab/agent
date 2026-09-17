/**
 * The brand palette family — every accent in the product is derived from
 * #0066ff (design decision §11.1, doc/design/v0.11-room-interiors.md).
 *
 * THE SHAPE OF THE FAMILY. The brand hue (~260° in OKLCH) already carries a
 * semantic in the card view — "nothing is picked, the core timeline is the
 * view" — so the family does not span the colour wheel. It is an ARC: brand
 * hue ± 90°, i.e. 170° → 350°, covering cyan-blue, blue, indigo, violet,
 * magenta and rose. What it excludes is deliberate: the yellow-green and
 * teal bands read as impure next to the brand (the same constraint the
 * strand palette in globals.css is pinned to, see tests/lib/timeline3d/
 * ink.test.ts). Members are therefore recognisably "the same family" by
 * construction — no member can ever be a yellow, an orange or a green.
 *
 * DISTINGUISHABILITY. The arc is crossed with lightness: 16 hue steps
 * (12° apart) × 6 lightness bands = 96 members — enough that the ~93 real
 * strands each take one and the 14 room palettes still draw from the same
 * deck. The honest limit: the worst-case pair is ~1.8 JND apart (the test
 * measures it) — tellable side by side, not across a room. That is a
 * property of fitting ~93 accents into one hue family, not of this
 * particular spacing; the module's job is to make the spacing EVEN and
 * deterministic, which it does.
 *
 * GAMUT. OKLCH at fixed chroma is not uniformly displayable: the cyan
 * corner of the arc (h ≈ 200°) caps sRGB chroma hard at low lightness, and
 * clipping different members by different amounts silently compresses
 * their spacing (an earlier fixed-chroma draft lost half its worst-case
 * pair distance to exactly that). So each band's chroma is SET at the
 * arc-wide capacity for its lightness — measured, not guessed — and the
 * binary shrink below is kept only as a safety net for rounding. Members
 * of a band share one chroma; members of a hue share six lightnesses.
 *
 * THE BRAND ITSELF IS NOT A MEMBER. #0066ff (chroma ≈ 0.23, far above any
 * band chroma) stays reserved for the core timeline's own surfaces, so
 * "the core hotel wears the brand" remains distinguishable from every
 * family accent around it.
 */

import { fnv1a, normalizeStrandName } from "@/lib/timeline3d/ink";

/** The brand accent, reserved for the core timeline (never a family member). */
export const BRAND_HEX = "#0066ff";

/** Arc endpoints in OKLCH hue degrees: brand hue 260° ± 90°. */
export const FAMILY_HUE_MIN = 170;
export const FAMILY_HUE_MAX = 350;

/** 16 hue steps × 6 lightness bands = 96 members ≥ the ~93 real strands.
 *  Band chromas are the arc-wide sRGB capacity at that lightness (the cyan
 *  corner h ≈ 200° is the binding constraint up to L 0.70, the blue corner
 *  h ≈ 265° above it), measured and then rounded down — see the file
 *  header for why the chroma is not one constant. */
export const FAMILY_HUE_STEPS = 16;
export const FAMILY_BANDS: readonly { l: number; c: number }[] = [
  { l: 0.55, c: 0.09 },
  { l: 0.6, c: 0.1 },
  { l: 0.65, c: 0.11 },
  { l: 0.7, c: 0.115 },
  { l: 0.75, c: 0.12 },
  { l: 0.8, c: 0.095 },
];
export const FAMILY_SIZE = FAMILY_HUE_STEPS * FAMILY_BANDS.length;

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** A member's OKLCH spec, before gamut fitting. Index i maps to
 *  (band = floor(i / 16), step = i % 16): grouped by lightness band so a
 *  whole band can be eyeballed as one tonal row. The 16 hues span the arc
 *  INCLUSIVE of both endpoints — 170° and 350° are both members, 12°
 *  apart. */
export function familyOklch(index: number): Oklch {
  if (!Number.isInteger(index) || index < 0 || index >= FAMILY_SIZE) {
    throw new RangeError(`family index ${index} outside 0..${FAMILY_SIZE - 1}`);
  }
  const band = Math.floor(index / FAMILY_HUE_STEPS);
  const step = index % FAMILY_HUE_STEPS;
  return {
    ...FAMILY_BANDS[band],
    h:
      FAMILY_HUE_MIN +
      (step * (FAMILY_HUE_MAX - FAMILY_HUE_MIN)) / (FAMILY_HUE_STEPS - 1),
  };
}

/** OKLCH → linear sRGB (Björn Ottosson's matrices). Channels may leave
 *  [0, 1] — that is the signal the gamut fitter reads. */
function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((v) => v >= 0 && v <= 1);
}

function linearToSrgbChannel(v: number): number {
  const clamped = Math.min(1, Math.max(0, v));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** OKLCH → `#rrggbb`, chroma-shrunk (binary search, 24 halvings ≈ float
 *  precision) until displayable. Pure and deterministic. */
export function oklchToHex(spec: Oklch): string {
  let lo = 0;
  let hi = 1;
  if (inGamut(oklchToLinearSrgb(spec))) {
    lo = 1;
  } else {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearSrgb({ ...spec, c: spec.c * mid }))) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  const fitted = { ...spec, c: spec.c * lo };
  const [r, g, b] = oklchToLinearSrgb(fitted).map(linearToSrgbChannel);
  const byte = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** The i-th family accent as a hex string — the one value consumers read. */
export function familyMember(index: number): string {
  return oklchToHex(familyOklch(index));
}

/** `#rrggbb` → OKLab, for distance measurements (tests, clash audits). */
export function hexToOklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in OKLab — the module's distinguishability metric.
 *  ~0.01 ≈ one just-noticeable difference; documented in the test that
 *  pins the family's worst-case pair. */
export function oklabDistance(a: string, b: string): number {
  const [l1, a1, b1] = hexToOklab(a);
  const [l2, a2, b2] = hexToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Which family member a strand name draws, 0-based. Same hash discipline
 *  as the card view (`normalizeStrandName` + FNV-1a, see lib/timeline3d/
 *  ink.ts) so a strand's identity is hashed exactly once per product. With
 *  96 slots the real corpus (~93 strands) collides only by birthday
 *  accident, not by construction; the test measures both. */
export function familyIndexForName(name: string): number {
  const normalized = normalizeStrandName(name);
  if (normalized.length === 0) return 0;
  return fnv1a(normalized) % FAMILY_SIZE;
}

/** A strand name's family accent as a hex string. */
export function familyAccentForName(name: string): string {
  return familyMember(familyIndexForName(name));
}
