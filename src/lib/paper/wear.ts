/**
 * Paper ageing — the wear descriptor (v0.30).
 *
 * Given a document's identity and its birth timestamp, return the sheet's
 * WEAR: which fold pattern it carries, which corner is dog-eared, how much
 * edge wear and mottling. The descriptor is:
 *
 *  - STABLE. Every random draw flows from a cyrb53/mulberry32 stream seeded
 *    by `hashString(identity + ":" + stamp)` — the same seed primitives the
 *    game builds its worlds from (src/lib/game/seed.ts). The same document
 *    at the same moment always yields the same descriptor, on any machine.
 *  - AGEING. Nothing about the AGE BAND is random: it is read straight off
 *    the clock (`now − bornAt`). As a document crosses a band boundary its
 *    wear intensifies — deeper folds, more edge, more mottle — but within a
 *    band its variant never re-rolls. A fold may GRADUATE (single → letter)
 *    as the paper is handled over months; it never flickers.
 *
 * The module is pure: no clock is read unless the caller passes `now`, so
 * tests can pin a moment. Rendering lives elsewhere (paper-wear.css) and is
 * driven entirely by the data-* attributes wearAttrs() emits — the
 * descriptor never carries pixels.
 *
 * Band map (owner's ruling — a few bands, mapped from the time):
 *   fresh  < 2d      days    2–14d
 *   weeks  14–56d    months  56–168d   older  ≥ 168d
 */

import { createRng, hashString, pick } from "@/lib/game/seed";

/** The age bands, youngest first. `fresh` paper takes no wear at all — the
 *  light model still applies (that is the "clean in an unreal way" cure),
 *  but folds and damage only start once the sheet has lived a little. */
export const WEAR_BANDS = [
  "fresh",
  "days",
  "weeks",
  "months",
  "older",
] as const;
export type WearBand = (typeof WEAR_BANDS)[number];

/** Fold patterns: a single crease, a letter fold (thirds), quarters. A fold
 *  is rendered as a SHADING across the sheet, never a drawn line. */
export const WEAR_FOLDS = ["none", "single", "letter", "quarters"] as const;
export type WearFold = (typeof WEAR_FOLDS)[number];

/** Where the single crease sits (only meaningful when fold === "single").
 *  The thirds/quarters patterns fix their own positions. */
export const WEAR_FOLD_AT = ["upper", "middle", "lower"] as const;
export type WearFoldAt = (typeof WEAR_FOLD_AT)[number];

/** Dog-ear corners. Only bottom corners are ever rolled: a pile cover's
 *  head stamps live in the TOP corners, and damage may sit only where the
 *  set text cannot reach (the owner's second principle). */
export const WEAR_EARS = ["none", "bl", "br"] as const;
export type WearEar = (typeof WEAR_EARS)[number];

/** Band boundaries in days. */
const FRESH_MAX_DAYS = 2;
const DAYS_MAX_DAYS = 14;
const WEEKS_MAX_DAYS = 56;
const MONTHS_MAX_DAYS = 168;

const DAY_MS = 86_400_000;

/** One document's wear, at one moment. */
export interface PaperWear {
  /** The age band the clock assigns right now. */
  band: WearBand;
  /** Whole days since the birth stamp (0 when the stamp is unparseable). */
  ageDays: number;
  /** The parsed birth stamp, ms epoch — null when unparseable. */
  bornAt: number | null;
  fold: WearFold;
  foldAt: WearFoldAt;
  ear: WearEar;
  /** Edge wear, 0–3. */
  edge: number;
  /** Mottling, 0–2. */
  mottle: number;
}

/** Neutral descriptor: an unparseable or absent stamp means the sheet's age
 *  is unknown, and unknown paper takes no wear — only the light model. */
const NO_WEAR: PaperWear = {
  band: "fresh",
  ageDays: 0,
  bornAt: null,
  fold: "none",
  foldAt: "middle",
  ear: "none",
  edge: 0,
  mottle: 0,
};

function bandForAge(ageDays: number): WearBand {
  if (ageDays < FRESH_MAX_DAYS) return "fresh";
  if (ageDays < DAYS_MAX_DAYS) return "days";
  if (ageDays < WEEKS_MAX_DAYS) return "weeks";
  if (ageDays < MONTHS_MAX_DAYS) return "months";
  return "older";
}

/**
 * The fold pattern for one band and one RNG draw. Thresholds shift with the
 * band so older paper is likelier to carry the heavier patterns — the
 * VARIANT for a given document is still a pure function of its seed and its
 * band, never of the wall clock directly.
 */
function foldForBand(bandIndex: number, r: number): WearFold {
  switch (bandIndex) {
    case 0:
      return "none";
    case 1:
      return r < 0.55 ? "none" : "single";
    case 2:
      if (r < 0.25) return "none";
      if (r < 0.65) return "single";
      if (r < 0.9) return "letter";
      return "quarters";
    case 3:
      if (r < 0.1) return "none";
      if (r < 0.45) return "single";
      if (r < 0.8) return "letter";
      return "quarters";
    default:
      if (r < 0.05) return "none";
      if (r < 0.3) return "single";
      if (r < 0.7) return "letter";
      return "quarters";
  }
}

/** The probability a corner is dog-eared, per band. */
const EAR_CHANCE = [0, 0.15, 0.35, 0.55, 0.7] as const;
/** Edge-wear floor per band; the seeded bump can raise it one step. */
const EDGE_FLOOR = [0, 1, 1, 2, 3] as const;
/** Mottling floor per band. */
const MOTTLE_FLOOR = [0, 0, 1, 1, 2] as const;

/**
 * The wear descriptor for one document at one moment.
 *
 * @param identity  The document's stable identity (a case ref, a record
 *                  ref) — distinguishes two sheets born the same day.
 * @param stamp     The birth timestamp: YYYY-MM-DD, an ISO string, or ""
 *                  (dateless). Unparseable → the neutral descriptor.
 * @param now       The moment to measure age at, ms epoch. OMITTED IN
 *                  PRODUCT CODE (defaults to Date.now()); tests pin it.
 */
export function paperWear(
  identity: string,
  stamp: string,
  now?: number,
): PaperWear {
  if (!stamp) return NO_WEAR;
  const bornAt = Date.parse(stamp);
  if (Number.isNaN(bornAt)) return NO_WEAR;
  const at = now ?? Date.now();
  const ageDays = Math.max(0, (at - bornAt) / DAY_MS);
  const bandIndex = WEAR_BANDS.indexOf(bandForAge(ageDays));

  // One stream per document+stamp; the draw ORDER is fixed forever, so no
  // later change can perturb earlier draws (the seed.ts discipline).
  const rng = createRng(hashString(`paper-wear:${identity}:${stamp}`));

  const fold = foldForBand(bandIndex, rng());
  const foldAt = pick(rng, WEAR_FOLD_AT);
  const ear: WearEar = rng() < EAR_CHANCE[bandIndex] ? pick(rng, ["bl", "br"] as const) : "none";
  // The seeded bump is fresh-only-suppressed, not fresh-only-skipped: the
  // draw is always consumed so the stream stays stable across bands.
  const bump = rng() < 0.35 ? 1 : 0;
  const edge = Math.min(3, EDGE_FLOOR[bandIndex] + (bandIndex > 0 ? bump : 0));
  const mottle = Math.min(
    2,
    MOTTLE_FLOOR[bandIndex] + (bandIndex > 0 && rng() < 0.3 ? 1 : 0),
  );

  return {
    band: WEAR_BANDS[bandIndex],
    ageDays,
    bornAt,
    fold,
    foldAt,
    ear,
    edge,
    mottle,
  };
}

/** The data-attribute map the renderer keys off. Every value is one of a
 *  small closed set — CSS sees only these, never a raw number to style
 *  with (no per-element inline literals anywhere downstream). */
export interface PaperWearAttrs {
  "data-wear-band": WearBand;
  "data-wear-fold": WearFold;
  "data-wear-fold-at": WearFoldAt;
  "data-wear-ear": WearEar;
  "data-wear-edge": string;
  "data-wear-mottle": string;
}

export function wearAttrs(wear: PaperWear): PaperWearAttrs {
  return {
    "data-wear-band": wear.band,
    "data-wear-fold": wear.fold,
    "data-wear-fold-at": wear.foldAt,
    "data-wear-ear": wear.ear,
    "data-wear-edge": String(wear.edge),
    "data-wear-mottle": String(wear.mottle),
  };
}
