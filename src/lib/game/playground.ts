/**
 * Room playground (/{locale}/playground) — the DIRECT single-room render the
 * acceptance pass asked for: one URL renders one standard room, no corridor
 * walk, no HUD. This module is the page's PURE half: URL params → the debug
 * slice id the existing pipeline parses (debug-slice.ts), plus the static
 * camera framing math. The render/readdout lanes both consume the slice id
 * through their EXISTING entries (SpaceScene + describeRoom), so a screenshot
 * and its data panel can never disagree.
 *
 * THE SLICE-ID SHAPE. `dbg-m:<moduleId>` pins the standard room (the gallery
 * force, debug-slice.ts); `dbg-skin:<skinId>+…` prefixes the biome skin; and
 * the playground adds ONE new optional segment, `dbg-seed:<tag>`, between the
 * skin and the module pin:
 *
 *     dbg-skin:dune+dbg-seed:7+dbg-m:living
 *
 * parseDebugSlice strips the skin AND the seed segments before matching the
 * unit prefix, so the module pin survives any seed; debugSliceIdWithoutSkin
 * strips ONLY the skin, so the seed RIDES the room's own seeded streams
 * (layout/furniture/plan derive from the slice id — a different tag stages a
 * different arrangement of the same room). 皮肤是视图力、seed 是房间自身
 * 的力，与既有约定一致。 A room without a seed segment is byte-for-byte the
 * gallery's room; every real memory slice starts with a date, never `dbg-`,
 * so the default paths cannot see this mode.
 *
 * Pure module: no three.js, no React, no wall clock.
 */
import { ROOM_MODULES } from "./room-modules";
import { SKINS } from "./skins";

/** The room the page opens with — no/invalid `m` falls back here. */
export const PLAYGROUND_DEFAULT_MODULE = "living";

/** The `m` param's vocabulary: the thirteen standard room module ids. */
export const PLAYGROUND_MODULE_IDS: readonly string[] = ROOM_MODULES.map(
  (m) => m.id,
);

/** Skin ids the `skin` param accepts. "temperate" IS the baseline
 * (无皮肤 ≡ 温带), so the page maps it — and an absent param — to no skin
 * segment at all; the dropdown never emits it. */
export const PLAYGROUND_SKIN_IDS: readonly string[] = SKINS.map((s) => s.id);

/** The seed segment's grammar: a short opaque tag (kept in the id, so it
 * feeds every seeded derivation — restrict it to url-safe, non-+ characters
 * or a stale param would corrupt the slice id's segmentation). */
const SEED_TAG_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;

export interface PlaygroundParams {
  /** A ROOM_MODULES id (validated; default when absent/unknown). */
  moduleId: string;
  /** A SKINS id, or null = the temperate baseline (no skin segment). */
  skinId: string | null;
  /** The `dbg-seed:<tag>` body, or null = the seedless (gallery-identical)
   * room. */
  seedTag: string | null;
}

function firstParam(value: string | string[] | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Validate + normalize one raw param set (`useSearchParams` entries, a
 * URLSearchParams, or a plain record — all shapes the tests can build). */
export function parsePlaygroundParams(input: {
  m?: string | string[] | null;
  skin?: string | string[] | null;
  seed?: string | string[] | null;
}): PlaygroundParams {
  const rawModule = firstParam(input.m);
  const moduleId =
    rawModule !== null && PLAYGROUND_MODULE_IDS.includes(rawModule)
      ? rawModule
      : PLAYGROUND_DEFAULT_MODULE;

  const rawSkin = firstParam(input.skin);
  const skinId =
    rawSkin !== null &&
    PLAYGROUND_SKIN_IDS.includes(rawSkin) &&
    rawSkin !== "temperate"
      ? rawSkin
      : null;

  const rawSeed = firstParam(input.seed);
  const seedTag =
    rawSeed !== null && SEED_TAG_PATTERN.test(rawSeed) ? rawSeed : null;

  return { moduleId, skinId, seedTag };
}

/** The debug slice id one param set builds — the single identity the recipe
 * compiler, the renderer's skin lane, and the describer all read. Skin
 * segment FIRST (parseDebugSkin reads only the leading segment), then the
 * seed, then the module pin. */
export function playgroundSliceId(p: PlaygroundParams): string {
  const pin = `dbg-m:${p.moduleId}`;
  const seed = p.seedTag !== null ? `dbg-seed:${p.seedTag}+` : "";
  return p.skinId !== null
    ? `dbg-skin:${p.skinId}+${seed}${pin}`
    : `${seed}${pin}`;
}

/* ------------------------------------------------------------------ */
/* Camera framing (pure)                                               */
/* ------------------------------------------------------------------ */

/** The playground camera keeps the game's look — the fixed 45° dollhouse
 * angle (CAM_OFFSET's direction, tuning/room.ts) — parked on the room's
 * footprint center, far enough that the WHOLE plan fits at any aspect. */
const CAM_DIR = { x: -12, y: 16, z: 12 };
const CAM_DIR_LEN = Math.hypot(CAM_DIR.x, CAM_DIR.y, CAM_DIR.z);
/** sin/cos of the camera's elevation above the ground plane. */
export const PLAYGROUND_CAM_SIN_ELEV = CAM_DIR.y / CAM_DIR_LEN;
export const PLAYGROUND_CAM_COS_ELEV = Math.hypot(CAM_DIR.x, CAM_DIR.z) / CAM_DIR_LEN;

/** Frame margin: breathing room around the footprint + walls (×1.0 = flush). */
export const PLAYGROUND_FRAME_PAD = 1.12;

export interface PlaygroundFrame {
  /** World-space ground point the camera looks at: the plan's footprint
   * center (door at x=0, z=doorZ; the plan runs z ∈ [doorZ, doorZ+extent]). */
  centerX: number;
  centerZ: number;
  /** Half of the ground footprint's bounding diagonal (m). */
  groundRadius: number;
  /** The ortho frustum's required half-height in WORLD meters: the frame
   * must show this much vertically (and at least as much horizontally after
   * the aspect correction) or some wall/floor corner leaves the picture. */
  halfHeight: number;
}

/**
 * The static whole-room frame for one scaled plan. `aspect` is the canvas's
 * width/height in CSS px (portrait < 1 needs the wider horizontal fit).
 * Conservative on purpose: the room always lands fully inside the frame with
 * the pad to spare — acceptance screenshots never crop a corner.
 */
export function playgroundFrameFor(o: {
  width: number;
  extent: number;
  doorZ: number;
  wallHeight: number;
  aspect: number;
  pad?: number;
}): PlaygroundFrame {
  const pad = o.pad ?? PLAYGROUND_FRAME_PAD;
  const groundRadius = Math.hypot(o.width / 2, o.extent / 2);
  // Worst-case projection of the ground radius onto EITHER view axis, plus
  // the wall top reaching UP toward the camera (a colossal room's 10m wall
  // must stay in frame too).
  const span =
    (groundRadius + o.wallHeight) *
    (PLAYGROUND_CAM_SIN_ELEV + PLAYGROUND_CAM_COS_ELEV) *
    pad;
  const aspect = o.aspect > 0 ? o.aspect : 1;
  const halfHeight = span * Math.max(1, 1 / aspect);
  return {
    centerX: 0,
    centerZ: o.doorZ + o.extent / 2,
    groundRadius,
    halfHeight,
  };
}
