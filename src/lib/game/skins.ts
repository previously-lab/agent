/**
 * Biome skins (v0.12-room-realism §3 + §6.2) — the ENVIRONMENT layer as pure
 * DATA: WHAT a room is made of, decoupled from the structure layer (the
 * module/schematic decides WHAT ROOM it is — §2). One skin swaps all six
 * surface slots of any standard room — floor / walls / furnishing family /
 * light / the view outside the windows / the fog and far field — so the same
 * living room can stand on timber, on sand, on moss or under shallow water,
 * and composed rooms keep one structure while their worlds diverge (the
 * threshold-space promise of §3).
 *
 * THIS PHASE IS DATA + CATALOGUE ONLY. Nothing here renders: the renderer
 * lane (src/components/game/space.tsx) and the staging lane (kits.ts)
 * consume these declarations through the queries at the bottom of the file
 * — the wiring contract is written so those lanes can hook in without
 * redesigning anything (see the per-slot "Consumed by" notes).
 *
 * THE TRANSPARENCY BUDGET (hard rule, §3's 代价如实 + §5): ONLY water and
 * glass may carry alpha. Every other surface of every skin is opaque — the
 * type makes opacity optional-only-where-legal and the tests audit the
 * catalogue (ALPHA_FLOOR_KINDS / ALPHA_WALL_KINDS are the complete list of
 * kinds that may set opacity < 1; a skin declaring alpha anywhere else
 * fails the suite).
 *
 * CLEARANCE SEMANTICS (§3: 皮肤需要给每种地面/墙面写材质与净空语义).
 * Every floor declares its walk semantics — dry ground walks at full speed,
 * shallow water is wadeable but slower (speed < 1), and a skin never
 * declares an unwalkable floor: the doorway promise (the ≥1.4 m path) must
 * survive every skin. Walls are solid boundaries in every skin (a water
 * wall or glass wall is still a wall — the movement clamp never opens).
 *
 * SLOT OVERRIDES (§6.2 环境化槽位 — the user's pool-table ask). A skin may
 * replace WHAT a schematic slot draws: the ROLE keeps its authored anchor,
 * facing and clearance — the replacement piece rides the SAME staging
 * machinery (kits.ts pushKit: walkable footprint, doorway and strand-door
 * approaches, path clearance, coverage budget), so an overridden piece
 * cannot block the way or crush a neighbour by construction. The
 * replacement kind must already exist: `feature` is a KitKind the renderer
 * draws today (tests: closed set + the curated ENVIRONMENT_FEATURE_KINDS
 * whitelist — floor-standing, calm, non-blocking nature pieces).
 *
 * DEBUG FORCE (the P3 acceptance switch, debug-slice.ts): `dbg-skin:<id>`
 * in a slice id forces that skin — alone on the seeded room, or composed
 * with any unit pin, e.g. `dbg-skin:dune+dbg-m:living`.
 *
 * THE WORLD ASSIGNMENT (P3 step three — 皮肤成为"世界"): a REAL slice
 * resolves its skin from its world. skinForSlice compiles the slice's
 * recipe (space-recipe.ts — the same pure derivation the renderer builds
 * the room from) and reads THE ARCHETYPE → SKIN TABLE below. Who decides:
 * the ARCHETYPE decides — §3's 环境层 belongs to the world, the structure
 * layer never asks what skin it wears. Interior archetypes are ABSENT from
 * the table: an interior world IS the temperate baseline, and the baseline
 * ≡ no skin (无皮肤 ≡ 温带), so interior rooms answer null and every legacy
 * expression stays in force — zero change by construction, not by
 * convention. A6 holds two ways: the recipe is a pure function of the
 * slice id, and the table is data — same slice ⇒ same world ⇒ same skin,
 * on any machine. (compileSpaceRecipe is pure; this module stays free of
 * three.js, React, and the wall clock — the only seeding in the game.)
 *
 * Pure module: no three.js, no React, no wall clock.
 */

import type { KitKind } from "./kits";
import type { LightRegister } from "./room-modules";
import type { ArchetypeId } from "./space-types";
import { parseDebugSkin, debugSliceIdWithoutSkin } from "./debug-slice";
import { compileSpaceRecipe } from "./space-recipe";
import { MODULE_LIGHT_FIXTURES } from "./tuning/room";

/* ------------------------------------------------------------------ */
/* The six slot vocabularies (§3's table)                              */
/* ------------------------------------------------------------------ */

/** The five authored skins (v0.12 P3 第一步). Ids double as the debug
 *  force's vocabulary: `dbg-skin:<id>`. */
export type SkinId = "temperate" | "dune" | "grove" | "moss" | "shallows";

/** Floor surfaces. The first four are today's interior registers
 *  (room-modules FloorRole); the rest are the §3 additions. Only
 *  "shallow-water" may carry alpha (see ALPHA_FLOOR_KINDS). */
export type SkinFloorKind =
  | "timber"
  | "carpet"
  | "tile"
  | "deck"
  | "sand"
  | "grass"
  | "moss"
  | "gravel"
  | "snow"
  | "stone"
  | "shallow-water";

/** Wall surfaces. The first four are today's interior registers
 *  (room-modules WallRoleM); the rest are §3's rock / hedge / glass /
 *  water-wall. Only "glass" and "water-wall" may carry alpha. */
export type SkinWallKind =
  | "plaster"
  | "panelling"
  | "tile"
  | "shelf"
  | "rock"
  | "stone"
  | "hedge"
  | "glass"
  | "water-wall";

/** THE TRANSPARENCY BUDGET, as data — the ONLY floor kinds that may set
 *  opacity < 1. Every other kind renders fully opaque. */
export const ALPHA_FLOOR_KINDS: readonly SkinFloorKind[] = ["shallow-water"];

/** THE TRANSPARENCY BUDGET, as data — the ONLY wall kinds that may set
 *  opacity < 1 (water and glass; §5: 透明度只给水和玻璃). */
export const ALPHA_WALL_KINDS: readonly SkinWallKind[] = ["glass", "water-wall"];

/** How the floor is walked (§3's 净空语义). */
export type SkinWalk = "dry" | "wade";

/** Day/night albedo pair — the window-view convention: the DAY state is
 *  baked, the NIGHT state is applied as the consumer's tint. */
export interface SkinSurfaceColors {
  day: string;
  night: string;
}

/** Slot 1 — the ground underfoot. */
export interface SkinFloor {
  kind: SkinFloorKind;
  /** dry: walks at full speed. wade: walkable but slower (speed < 1 —
   *  浅水能走, §3's own example). No skin may declare an unwalkable
   *  floor — the doorway path survives every skin. */
  walk: SkinWalk;
  /** Walk-speed multiplier; 1 for dry floors, < 1 for wade. */
  speed: number;
  /** Ground albedo — coordinates with the room palette family (§11.2:
   *  the view outside matches the room's theme). */
  colors: SkinSurfaceColors;
}

/** Slot 2 — the perimeter walls. Every kind is a SOLID boundary for the
 *  movement clamp, alpha or not (glass is a wall, not a door). */
export interface SkinWall {
  kind: SkinWallKind;
  /** Wall surface colour pair. */
  colors: SkinSurfaceColors;
  /** Opacity < 1 is legal ONLY for ALPHA_WALL_KINDS (glass, water-wall)
   *  — the transparency budget; any other kind MUST stay opaque and
   *  leaves this unset (the tests audit the whole catalogue). */
  opacity?: number;
}

/** Slot 3 — the furnishing family: which kit vocabulary dresses the
 *  room's slots. "interior" is today's hand-written sets; "nature" is the
 *  §3.1 N4 outdoor set (fallen logs, stone circles, reeds…) — §3's
 *  允许自然套装作为槽位填充物. Consumed by the staging lane: the deck
 *  lists the kit ids a skin deals from (the module whitelists still own
 *  per-module character; the deck is the skin's WORLD). A skin that OMITS
 *  `decks` is the baseline: the room's own whitelists own the draw exactly
 *  as without a skin — 无皮肤 ≡ 温带. */
export interface SkinFurnishing {
  family: "interior" | "nature";
  /** Curated kit ids (kits.ts KITS) this skin's rooms draw from —
   *  validated by the tests against the catalogue. OMITTED = the
   *  baseline: the room keeps its own gating (module whitelist +
   *  archetype/world-class vocabulary), byte-for-byte the skinless path.
   *  A skin that owns its WORLD (dune / grove / moss / shallows) declares
   *  its decks and the staging draw runs inside them (REPLACE,
   *  kits.ts stageInteriorKits). */
  decks?: readonly string[];
}

/** Slot 4 — the light mood. Resolved against the EXISTING module-light
 *  register fixtures (tuning/room.ts MODULE_LIGHT_FIXTURES): a skin picks
 *  the register its fixtures answer to and may tint it — §3's new moods
 *  (dune-sun, dusk-grove, underwater…) are authored as register + tint +
 *  level, so the renderer needs no new fixture vocabulary. */
export interface SkinLight {
  /** One of the five existing module light registers. */
  register: LightRegister;
  /** Optional tint override on the register's fixture colour. */
  tint?: string;
  /** Optional level override (×scale² at render, the lamp's law). */
  intensity?: number;
  /** Optional floor-pool opacity override. */
  pool?: number;
}

/** The four colours of a window view — exactly materials/window-view.ts's
 *  WindowViewOptions minus the seed (the consumer keeps passing its own). */
export interface SkinWindowColors {
  sky: string;
  fog: string;
  ground: string;
  sun: string;
}

/** The far/near silhouette strata of the outside view — window-view.ts
 *  draws a calm rolling FAR layer and a chunked near tree/roof line; the
 *  skin picks which authored silhouette mix the view bakes. */
export type SkinSilhouette =
  | "soft-hills"
  | "dunes"
  | "treeline"
  | "mist-forest"
  | "open-water";

/** Slot 5 — what is outside the windows (§3: 皮肤决定窗外是什么). The
 *  day colours bake; the night colours are the consumer's tint (the
 *  WINDOW_VIEW_NIGHT_GAIN/TINT convention). */
export interface SkinWindow {
  day: SkinWindowColors;
  night: SkinWindowColors;
  silhouette: SkinSilhouette;
}

/** What the far field past the apron reads as — the 远景 half of slot 6. */
export type SkinHorizon =
  | "soft-hills"
  | "sand-haze"
  | "light-shafts"
  | "wet-mist"
  | "clear-depth";

/** Slot 6 — the fog and the far field (§3: 沙尘、湿雾、林间光柱). */
export interface SkinFog {
  day: string;
  night: string;
  /** Relative density multiplier for the renderer's fog falloff —
   *  1 is the palette-derived default; dune runs hazy, moss runs wet. */
  density: number;
  /** The far-field reading the horizon carries. */
  horizon: SkinHorizon;
}

/** §6.2 — one slot's drawn kind replaced by an environment piece. The
 *  ROLE keeps its authored anchor/facing/clearance (the staging machinery
 *  is untouched — the replacement cannot block or crush by construction);
 *  `feature` must be an existing KitKind the renderer already draws.
 *  `role` names a schematic slot role (room-schematic.ts) — the living
 *  room's is "coffeetable" (one word, the authored id), not the design
 *  doc's illustrative "coffee-table". */
export interface SkinSlotOverride {
  /** A role authored in some module's RoomSchematic (audited against the
   *  catalogue — an override for an unauthored role would stage nothing). */
  role: string;
  /** The environment kind drawn instead of the slot's seeded accepts —
   *  must be in ENVIRONMENT_FEATURE_KINDS (existing, floor-standing,
   *  non-blocking). */
  feature: KitKind;
}

/** The curated environment pieces a slot override may draw — existing
 *  KitKinds, all floor-standing, calm, non-blocking (§6's bans bind to
 *  replacements exactly as to any piece). */
export const ENVIRONMENT_FEATURE_KINDS: readonly KitKind[] = [
  "fountain",
  "standingstone",
  "boulder",
  "reeds",
  "firepit",
  "log",
  "mushroom",
  "cairn",
  "signpost",
  "ruinwall",
  "jettydeck",
  "moss",
];

/** One biome skin — the six slots + optional §6.2 overrides. */
export interface BiomeSkin {
  id: SkinId;
  /** Authoring label. */
  label: string;
  floor: SkinFloor;
  wall: SkinWall;
  furnishing: SkinFurnishing;
  light: SkinLight;
  window: SkinWindow;
  fog: SkinFog;
  slotOverrides?: readonly SkinSlotOverride[];
}

/* ------------------------------------------------------------------ */
/* The catalogue — five skins, one baseline plus four biomes, each     */
/* visually distinguishable (the tests pin the pairwise differences).  */
/* ------------------------------------------------------------------ */

/** The baseline: today's interior registers (timber / plaster / the
 *  interior kit sets / daylight) — the skin the debug pages' default
 *  vocabulary describes. No overrides: the interior stays furniture. No
 *  decks: a temperate room furnishes through its own module whitelists,
 *  byte-for-byte the skinless path (无皮肤 ≡ 温带). */
const TEMPERATE: BiomeSkin = {
  id: "temperate",
  label: "Temperate interior",
  floor: {
    kind: "timber",
    walk: "dry",
    speed: 1,
    colors: { day: "#9a7a58", night: "#5e4b38" },
  },
  wall: {
    kind: "plaster",
    colors: { day: "#ddd6ca", night: "#8b857a" },
  },
  // The baseline declares NO decks (see SkinFurnishing.decks): the deck
  // takeover in kits.ts binds only on a skin that declares its world.
  furnishing: {
    family: "interior",
  },
  light: { register: "daylight" },
  window: {
    day: { sky: "#b7cfec", fog: "#c9d6e8", ground: "#8e9aa8", sun: "#fff3de" },
    night: { sky: "#31405e", fog: "#3d4c6a", ground: "#4a5568", sun: "#a9bde4" },
    silhouette: "soft-hills",
  },
  fog: { day: "#c9d6e8", night: "#3d4c6a", density: 1, horizon: "soft-hills" },
};

/** The dune: a room the desert grew over — sand underfoot, rock walls,
 *  dry-stone where the bookshelf stood, waymark cairns by the plants.
 *  Hazy sand-coloured far field, a hard pale sun. */
const DUNE: BiomeSkin = {
  id: "dune",
  label: "Dune",
  floor: {
    kind: "sand",
    walk: "dry",
    speed: 1,
    colors: { day: "#d9b87e", night: "#87704b" },
  },
  wall: {
    kind: "rock",
    colors: { day: "#c39b72", night: "#7a6248" },
  },
  furnishing: {
    family: "nature",
    decks: [
      "stone-circle",
      "campfire",
      "path-marker",
      "boulder-cluster",
      "fence-ruin",
    ],
  },
  // dune-sun: the daylight register pushed hot and bright.
  light: { register: "daylight", tint: "#ffe2b0", intensity: 6 },
  window: {
    day: { sky: "#f0d9ac", fog: "#e6d3a8", ground: "#cfa96f", sun: "#ffedc4" },
    night: { sky: "#413c58", fog: "#4e4862", ground: "#5a4e60", sun: "#cbb9e6" },
    silhouette: "dunes",
  },
  fog: { day: "#e6d3a8", night: "#4e4862", density: 1.35, horizon: "sand-haze" },
  slotOverrides: [
    // 石砌残墙代替书架——dry-stone where the bookcase stood.
    { role: "bookshelf", feature: "ruinwall" },
    // 石标代替盆栽——a waymark cairn where a plant would stand.
    { role: "plant", feature: "cairn" },
  ],
};

/** The grove: a room the forest took back — grass floor, hedge walls,
 *  a moss bed for the rug, a fallen log where the shelf ran. Light
 *  arrives as dusk-grove shafts through the fog. */
const GROVE: BiomeSkin = {
  id: "grove",
  label: "Grove",
  floor: {
    kind: "grass",
    walk: "dry",
    speed: 1,
    colors: { day: "#74a058", night: "#465f3a" },
  },
  wall: {
    kind: "hedge",
    colors: { day: "#7aa862", night: "#4a663e" },
  },
  furnishing: {
    family: "nature",
    decks: [
      "fallen-log",
      "stone-circle",
      "campfire",
      "path-marker",
      "boulder-cluster",
    ],
  },
  // dusk-grove: the quiet register tinted green-gold, low and pooled.
  light: { register: "quiet", tint: "#d8ecc0", intensity: 3 },
  window: {
    day: { sky: "#c2e2bc", fog: "#d2e6cc", ground: "#7ba466", sun: "#f6ffe2" },
    night: { sky: "#2c4638", fog: "#39553f", ground: "#3f5a42", sun: "#cfe8c2" },
    silhouette: "treeline",
  },
  fog: { day: "#d2e6cc", night: "#39553f", density: 1.2, horizon: "light-shafts" },
  slotOverrides: [
    // 苔藓床代替地毯——moss-bed for the rug (§6.2's own example).
    { role: "rug", feature: "moss" },
    // 倒木代替书架——a fallen log where the shelf run stood.
    { role: "bookshelf", feature: "log" },
  ],
};

/** The moss: the wet, dim green room — deep moss underfoot, wet stone
 *  walls, mist hanging past the windows. Slow quiet light; boulders and
 *  standing stones where the furniture was. */
const MOSS: BiomeSkin = {
  id: "moss",
  label: "Moss",
  floor: {
    kind: "moss",
    walk: "dry",
    speed: 0.85,
    colors: { day: "#637f52", night: "#3c4f34" },
  },
  wall: {
    // Wet fitted stone — cut blocks where the dune's rock is raw cliff.
    kind: "stone",
    colors: { day: "#8b8f7c", night: "#525649" },
  },
  furnishing: {
    family: "nature",
    decks: [
      "fallen-log",
      "boulder-cluster",
      "stone-circle",
      "campfire",
      "fence-ruin",
    ],
  },
  // Wet-dim: the quiet register sunk lower and tinted cold green.
  light: { register: "quiet", tint: "#c2d6b4", intensity: 2.4 },
  window: {
    day: { sky: "#a9c8b2", fog: "#bcd2c2", ground: "#71886a", sun: "#eaf4da" },
    night: { sky: "#26352d", fog: "#334238", ground: "#3a4a3e", sun: "#bcd4bc" },
    silhouette: "mist-forest",
  },
  fog: { day: "#bcd2c2", night: "#334238", density: 1.45, horizon: "wet-mist" },
  slotOverrides: [
    // 苔藓地面连地毯处也铺满——moss swallows the rug slot too.
    { role: "rug", feature: "moss" },
    // 立石代替基座——a standing stone where the pedestal stood.
    { role: "pedestal", feature: "standingstone" },
  ],
};

/** The shallows: the flooded room — shallow water you wade (slower),
 *  water walls you cannot pass, reeds where the plants stood, and the
 *  coffee table become a small pool (§6.2's exact ask). The window looks
 *  across open water; the fog is clear depth. */
const SHALLOWS: BiomeSkin = {
  id: "shallows",
  label: "Shallows",
  floor: {
    kind: "shallow-water",
    walk: "wade",
    speed: 0.6,
    colors: { day: "#6fb3c4", night: "#3f6e7e" },
  },
  wall: {
    kind: "water-wall",
    // Water — one of the two alpha-sanctioned materials.
    opacity: 0.6,
    colors: { day: "#7fc4d4", night: "#487e8c" },
  },
  furnishing: {
    family: "nature",
    decks: ["jetty", "reeds", "boulder-cluster", "path-marker", "stone-circle"],
  },
  // underwater: the pool-bounce register deepened toward aqua.
  light: { register: "pool-bounce", tint: "#a8dde8" },
  window: {
    day: { sky: "#b9e4ec", fog: "#cbe8ee", ground: "#6fb6c6", sun: "#f2feff" },
    night: { sky: "#2b4c58", fog: "#385e68", ground: "#3f6a76", sun: "#b8e2ec" },
    silhouette: "open-water",
  },
  fog: { day: "#cbe8ee", night: "#385e68", density: 1.15, horizon: "clear-depth" },
  slotOverrides: [
    // 茶几变成小水池——the coffee table becomes a small pool (§6.2).
    { role: "coffeetable", feature: "fountain" },
    // 芦苇代替盆栽——reeds where the plant stood.
    { role: "plant", feature: "reeds" },
  ],
};

/** Every authored skin, in catalogue order. */
export const SKINS: readonly BiomeSkin[] = [
  TEMPERATE,
  DUNE,
  GROVE,
  MOSS,
  SHALLOWS,
];

/** The skin ids, in catalogue order. */
export const SKIN_IDS: readonly SkinId[] = SKINS.map((s) => s.id);

/** Look a skin up by id. */
export function skinById(id: string): BiomeSkin | undefined {
  return SKINS.find((s) => s.id === id);
}

/** Type guard for external string ids (debug URLs, saved pins). */
export function isSkinId(id: string): id is SkinId {
  return skinById(id) !== undefined;
}

/** THE ARCHETYPE → SKIN TABLE — the world assignment (P3 step three).
 *  Every NON-INTERIOR archetype maps to the skin of its world; interior
 *  archetypes stay ABSENT — an interior room is the temperate baseline and
 *  answers null (无皮肤 ≡ 温带, zero change by construction). Nature biomes
 *  draw the landscape they ARE: the dry open biomes read dune, the green
 *  ones grove, the deep wet ones moss/shallows. Wonder dioramas take a
 *  world's skin too — the duck pond is the flooded room, the play dioramas
 *  stand in the grass. One table, looked up by the compiled archetype:
 *  same slice ⇒ same world ⇒ same skin (A6).
 *
 *  (Authored-note: no snow skin exists in the catalogue — snowfield takes
 *  moss, the coldest wet end, until a snow world is authored.) */
const SKIN_BY_ARCHETYPE: Partial<Record<ArchetypeId, SkinId>> = {
  // nature — the biome is its world's skin (§3: 沙漠构成的客厅…).
  meadow: "grove",
  plains: "dune",
  forest: "moss",
  pool: "shallows",
  ocean: "shallows",
  lake: "shallows",
  beach: "dune",
  snowfield: "moss", // ← no snow skin yet; the wet-cold end stands in.
  // wonder — the diorama's world is skinned like any room's.
  ducks: "shallows", // the pond
  cats: "grove",
  dogs: "grove",
  balloons: "grove",
};

/** The skin a WORLD wears — the pure half of the assignment (the table).
 *  Interior archetypes are absent: null, the temperate baseline. */
export function skinForArchetype(archetype: ArchetypeId): BiomeSkin | null {
  const id = SKIN_BY_ARCHETYPE[archetype];
  return id ? (skinById(id) ?? null) : null;
}

/** THE consumer entry point: the skin a slice id resolves. The DEBUG FORCE
 *  wins (`dbg-skin:<id>`, alone or composed) — and a STALE forced id
 *  degrades to null, never to a crash. Otherwise the world assignment:
 *  the slice's recipe compiles from its SKIN-STRIPPED id
 *  (debug-slice.ts — the strip never perturbs the room's own streams), and
 *  the compiled ARCHETYPE decides the skin through the table above.
 *  Interior worlds resolve null — temperate ≡ no skin — so the default
 *  interior path is byte-for-byte today's. Pure in the slice id (A6). */
export function skinForSlice(sliceId: string): BiomeSkin | null {
  const forced = parseDebugSkin(sliceId);
  if (forced !== null) return skinById(forced) ?? null;
  const recipe = compileSpaceRecipe(debugSliceIdWithoutSkin(sliceId));
  return skinForArchetype(recipe.archetype);
}

/** The slot-4 fixture resolved — the register's MODULE_LIGHT_FIXTURES
 *  entry with the skin's tint/level overrides applied. The renderer's
 *  per-module sconce consumes this exactly as it consumes the register
 *  table today (×scale², the lamp's law). */
export function skinLightFixture(skin: BiomeSkin): {
  color: string;
  intensity: number;
  pool: number;
} {
  const base = MODULE_LIGHT_FIXTURES[skin.light.register];
  return {
    color: skin.light.tint ?? base.color,
    intensity: skin.light.intensity ?? base.intensity,
    pool: skin.light.pool ?? base.pool,
  };
}

/** THE §6.2 staging hook: the environment kind a skin draws for a
 *  schematic slot role, or undefined when the slot keeps its authored
 *  accepts. The staging lane calls this where it seeds a slot's kind —
 *  everything downstream (anchor, facing, clearance, the pushKit
 *  machinery) is untouched. */
export function skinSlotFeatureFor(
  skin: BiomeSkin,
  role: string,
): KitKind | undefined {
  return skin.slotOverrides?.find((o) => o.role === role)?.feature;
}
