/**
 * Shared types and constants for procedurally-generated liminal spaces.
 *
 * A space is described by a world class (what kind of place it is), an
 * archetype (the specific room/biome), a size tier (the z depth of the
 * floor plan), a seeded width (the x span — plans are rectangular), and a
 * palette (how it is lit and colored). Everything the renderer needs is a
 * pure function of these values plus the seeds carried on the compiled
 * recipe.
 *
 * Content taxonomy (v2):
 *   - nature:   outdoor biomes (meadow, plains, pool, forest, ocean, lake,
 *               beach, snowfield)
 *   - interior: hotel rooms indoors (hotel-room, pool-hall, library,
 *               ballroom) — flat floor, furniture instead of vegetation
 *   - hybrid:   a nature biome dressed with furniture that does not belong
 *               (a bed on the grass, a TV in the forest) — the surrealism
 *               is the point, but placement rules stay deterministic
 *   - wonder:   animal/balloon dioramas (ducks, cats, dogs, balloons)
 */

/** The v2 world classes — weighted 40/25/20/15 at recipe compile time. */
export type WorldClass = "nature" | "interior" | "hybrid" | "wonder";

/** Every specific room/biome id, across all world classes. */
export type ArchetypeId =
  // nature
  | "meadow"
  | "plains"
  | "pool"
  | "forest"
  // nature v2 additions
  | "ocean"
  | "lake"
  | "beach"
  | "snowfield"
  // interior
  | "hotel-room"
  | "pool-hall"
  | "library"
  | "ballroom"
  // wonder
  | "ducks"
  | "cats"
  | "dogs"
  | "balloons";

/** Biomes the nature (and hybrid) classes draw from. */
export const NATURE_BIOMES: readonly ArchetypeId[] = [
  "meadow",
  "plains",
  "pool",
  "forest",
  "ocean",
  "lake",
  "beach",
  "snowfield",
];

/** Rooms the interior class draws from. */
export const INTERIOR_ROOMS: readonly ArchetypeId[] = [
  "hotel-room",
  "pool-hall",
  "library",
  "ballroom",
];

/** Dioramas the wonder class draws from. */
export const WONDER_ROOMS: readonly ArchetypeId[] = [
  "ducks",
  "cats",
  "dogs",
  "balloons",
];

/** Square z-depth of the floor plan, in meters. */
export interface SizeTier {
  id: "S" | "M" | "L" | "XL";
  extent: number;
}

export const SIZE_TIERS: readonly SizeTier[] = [
  { id: "S", extent: 16 },
  { id: "M", extent: 32 },
  { id: "L", extent: 64 },
  { id: "XL", extent: 96 },
];

/** Floor-plan width factors (× extent, x span) — plans are rectangles. */
export const WIDTH_FACTORS: readonly number[] = [0.66, 1, 1.5];

export type PaletteId =
  | "dawn"
  | "noon"
  | "dusk"
  | "night"
  | "warm"
  | "cool"
  // quiet v3 additions — low-key moods in the base set's register
  | "moss"
  | "haze"
  // vivid v2 set — interiors and wonders draw from these first
  | "coral"
  | "mint"
  | "butter"
  | "lavender"
  | "sky"
  | "peach"
  | "grass"
  | "salt"
  // vivid v3 additions
  | "teal"
  | "plum";

/** Lighting/color bundle for a space. All colors are hex strings;
 *  intensities are multipliers in [0, 1]. The base set stays low-key and
 *  cozy (night never goes pitch black); the vivid set is deliberately
 *  saturated — door-opening color shock against the drab corridor. */
export interface Palette {
  id: PaletteId;
  /** Sky dome / background color. */
  sky: string;
  /** Fog color; doubles as the horizon blend target. */
  fog: string;
  /** Base ground color before archetype detail. */
  ground: string;
  /** Accent color for props, trims, and water highlights. Always a member
   *  of the brand palette family (src/lib/theme/palette-family.ts) — the
   *  palette's dominant hues stay its own, the one contrast colour comes
   *  from the brand arc (design §11.1). */
  accent: string;
  /* ---- Interior layer slots (the abundance pass, 2026-10) ----
   * Optional and additive: a renderer that does not know them keeps its
   * legacy derived surfaces byte-for-byte; one that does can stop
   * reading a room as ONE colour. Each palette authors its four layers
   * as a set — the floor (ground) is the dominant hue, the wall a
   * lighter chalk of it, the textile a soft companion, the timber a
   * warm wood tuned to the palette's temperature. */
  /** Wall surface colour (plaster/panelling). */
  wall?: string;
  /** Textile colour — bedding, rugs, towels, upholstery. */
  fabric?: string;
  /** Timber colour — floor boards and wooden furniture. */
  wood?: string;
  /** Directional "sun" (or moon) light color. */
  sunColor: string;
  /** Directional light intensity multiplier. */
  sunIntensity: number;
  /** Ambient/hemisphere light floor. Never below 0.25. */
  ambient: number;
}

/** The original palettes — restrained, nature-friendly. Every accent
 *  is a brand-family member (palette-family.ts); the family index is noted
 *  beside it. */
export const PALETTES: readonly Palette[] = [
  {
    id: "dawn",
    sky: "#f3d9c8",
    fog: "#e9d2c2",
    ground: "#9aa78a",
    accent: "#8b71b2", // family #27 — violet, complement of the sage ground
    wall: "#efe0d2",
    fabric: "#d8c3b0",
    wood: "#a98a68",
    sunColor: "#ffd9b3",
    sunIntensity: 0.7,
    ambient: 0.45,
  },
  {
    id: "noon",
    sky: "#cfe4ee",
    fog: "#dcebf0",
    ground: "#a9b78f",
    accent: "#7168a3", // family #10 — deep violet against the light ground
    wall: "#e8f0f2",
    fabric: "#bccfd8",
    wood: "#9a8a70",
    sunColor: "#fff4e0",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    id: "dusk",
    sky: "#d9b8c4",
    fog: "#cbb3c0",
    ground: "#8f9a7f",
    accent: "#656ca6", // family #9 — indigo, darkest band against mid ground
    wall: "#d9c6cc",
    fabric: "#b79aa8",
    wood: "#8a705c",
    sunColor: "#f5b78f",
    sunIntensity: 0.5,
    ambient: 0.35,
  },
  {
    id: "night",
    sky: "#232b3a",
    fog: "#2f3849",
    ground: "#3d4536",
    accent: "#93c1fa", // family #87 — light periwinkle, reads against the dark
    wall: "#2e3748",
    fabric: "#46506a",
    wood: "#6b5c4a",
    sunColor: "#a9bde0",
    sunIntensity: 0.35,
    ambient: 0.28,
  },
  {
    id: "warm",
    sky: "#ecd9b0",
    fog: "#e6d3ab",
    ground: "#a99a72",
    accent: "#647ebc", // family #24 — brand-side blue, complement of honey
    wall: "#f2e4c2",
    fabric: "#d9b98a",
    wood: "#b08a5e",
    sunColor: "#ffdf9e",
    sunIntensity: 0.8,
    ambient: 0.5,
  },
  {
    id: "cool",
    sky: "#c2d4d8",
    fog: "#cddfe2",
    ground: "#8fa39a",
    accent: "#ad6689", // family #31 — rose, warm counterweight to the teal-grey
    wall: "#d8e4e4",
    fabric: "#a9c2c0",
    wood: "#8a7a64",
    sunColor: "#e6f2f0",
    sunIntensity: 0.7,
    ambient: 0.5,
  },
  {
    // 苔藓深处 — the base set's deep end: forest-floor green under a
    // chalk-green light, a mid family violet as the one contrast.
    id: "moss",
    sky: "#c4cec0",
    fog: "#b8c4b2",
    ground: "#5a7050",
    accent: "#966eaa", // family #28 — mid violet against the dark green
    wall: "#ccd4c2",
    fabric: "#8a9a78",
    wood: "#7a6a52",
    sunColor: "#e8f0d8",
    sunIntensity: 0.55,
    ambient: 0.4,
  },
  {
    // 薄雾清晨 — a pale grey-violet morning; the family's deep teal
    // endpoint is the only saturated note in the room (the blue band sits
    // too close to the grey-violet ground to read as a contrast).
    id: "haze",
    sky: "#d8d4e0",
    fog: "#cfcada",
    ground: "#9a94a8",
    accent: "#2e8269", // family #0 — deep teal against the pale grey-violet
    wall: "#e4e0ea",
    fabric: "#b4aec2",
    wood: "#8a7a68",
    sunColor: "#f0ecf4",
    sunIntensity: 0.6,
    ambient: 0.5,
  },
];

/** The vivid palettes — high-saturation room colors. Interior and
 *  wonder rooms draw from this set first (see space-recipe.ts). Every
 *  accent is a brand-family member (palette-family.ts); the family index
 *  is noted beside it. */
export const VIVID_PALETTES: readonly Palette[] = [
  {
    id: "coral",
    sky: "#ffd9c9",
    fog: "#ffc9b8",
    ground: "#e86a58",
    accent: "#13808b", // family #3 — deep cyan, complement of coral
    wall: "#ffe8dc",
    fabric: "#f2b39a",
    wood: "#b08868",
    sunColor: "#fff0e0",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "mint",
    sky: "#d8f5e8",
    fog: "#cdf0e0",
    ground: "#63c88e",
    accent: "#a76895", // family #30 — mauve, complement of mint
    wall: "#e8f8ef",
    fabric: "#a8dcc2",
    wood: "#a08a6a",
    sunColor: "#f0fff4",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "butter",
    sky: "#fff3c4",
    fog: "#ffedb0",
    ground: "#e8c34e",
    accent: "#5970a6", // family #8 — deep blue-violet, complement of butter
    wall: "#fdf2c8",
    fabric: "#f0d488",
    wood: "#b8935a",
    sunColor: "#fff8dc",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    id: "lavender",
    sky: "#e2d4f5",
    fog: "#d9c8f0",
    ground: "#a68cd0",
    accent: "#339377", // family #16 — teal; lavender's true complement is
    // yellow-green, which the family excludes on principle — the teal arc
    // endpoint is the nearest legible member
    wall: "#efe8fa",
    fabric: "#c4aee0",
    wood: "#98806a",
    sunColor: "#f5ecff",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "sky",
    sky: "#bfe8ff",
    fog: "#cdeeff",
    ground: "#6fb7e8",
    accent: "#8d5e8e", // family #13 — plum; the orange complement is outside
    // the family, so the rose end supplies the contrast
    wall: "#e2f2ff",
    fabric: "#a8d0f0",
    wood: "#9a8870",
    sunColor: "#f0faff",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    id: "peach",
    sky: "#ffe3cf",
    fog: "#ffd9c0",
    ground: "#f0a070",
    accent: "#328bb0", // family #21 — steel blue, complement of peach
    wall: "#ffeee2",
    fabric: "#f6bf98",
    wood: "#aa8662",
    sunColor: "#fff4e8",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "grass",
    sky: "#d0f0c0",
    fog: "#c8e8b8",
    ground: "#58b058",
    accent: "#9f6aa0", // family #29 — mauve, complement of grass
    wall: "#e8f6dc",
    fabric: "#a0d098",
    wood: "#9a8a62",
    sunColor: "#f4ffe8",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "salt",
    sky: "#dff4f8",
    fog: "#d8f0f5",
    ground: "#8fc4d4",
    accent: "#995b79", // family #15 — deep rose; the amber complement is
    // outside the family, the rose end is the contrast instead
    wall: "#eaf8fb",
    fabric: "#b2dae2",
    wood: "#a09070",
    sunColor: "#f4fcff",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    // 深青 — the pool-ink teal; its contrast is the family's deep rose.
    id: "teal",
    sky: "#c8ecee",
    fog: "#bce4e6",
    ground: "#2f8f9a",
    accent: "#c17299", // family #47 — deep rose, complement of teal
    wall: "#d8f0f0",
    fabric: "#7cc0c4",
    wood: "#a08a68",
    sunColor: "#f0fbfb",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    // 熟李 — a ripe plum violet; its contrast is the family's cyan-teal
    // (the teal palette above wears the same pair the other way round).
    id: "plum",
    sky: "#eedff0",
    fog: "#e4d2e8",
    ground: "#84537f",
    accent: "#10919d", // family #19 — cyan-teal, complement of plum
    wall: "#f2e6f4",
    fabric: "#bd93b8",
    wood: "#8a7460",
    sunColor: "#faf0fb",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
];

/** Everything the renderer needs to build one deterministic space. */
export interface SpaceRecipe {
  /** The memory slice this space belongs to; the human-facing door label. */
  sliceId: string;
  /** What kind of place: nature / interior / hybrid / wonder. */
  worldClass: WorldClass;
  /** The specific room/biome (one of the class's list). */
  archetype: ArchetypeId;
  size: SizeTier;
  /** Floor-plan x span in meters — seeded from WIDTH_FACTORS × extent. */
  width: number;
  palette: Palette;
  /** Raw sub-seed driving archetype layout (placement of trees/rocks/water). */
  layoutSeed: number;
  /** Raw sub-seed driving light variation (sun angle, flicker, intensity jitter). */
  lightSeed: number;
}

/** Per-archetype generation parameters consumed by the renderer/scatterer. */
export interface ArchetypeSpec {
  id: ArchetypeId;
  /** Ground heightfield shape. */
  ground: "flat" | "rolling" | "sunken";
  /** Tree instances per m² (0 = none). */
  treeDensity: number;
  /** Rock instances per m² (0 = none). */
  rockDensity: number;
  /** Fraction of floor area covered by water (0..1). */
  waterCoverage: number;
  /** Water rect center along z, as a fraction of extent (0.5 = centered;
   *  beach pushes the shore toward the far wall). */
  waterCenter: number;
  /** Whether the space is enclosed by perimeter walls. */
  walled: boolean;
  /** Whether the space has a ceiling (false = open sky). */
  ceiling: boolean;
  /** Fog density multiplier for this archetype. */
  fogDensity: number;
}

export const ARCHETYPES: Record<ArchetypeId, ArchetypeSpec> = {
  meadow: {
    id: "meadow",
    ground: "flat",
    treeDensity: 0.15,
    rockDensity: 0.1,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.012,
  },
  plains: {
    id: "plains",
    ground: "rolling",
    treeDensity: 0.04,
    rockDensity: 0.06,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.018,
  },
  pool: {
    id: "pool",
    ground: "sunken",
    treeDensity: 0,
    rockDensity: 0.05,
    waterCoverage: 0.85,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.01,
  },
  forest: {
    id: "forest",
    ground: "rolling",
    treeDensity: 0.8,
    rockDensity: 0.12,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.03,
  },
  ocean: {
    id: "ocean",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0.02,
    waterCoverage: 0.95,
    waterCenter: 0.62,
    walled: true,
    ceiling: false,
    fogDensity: 0.008,
  },
  lake: {
    id: "lake",
    ground: "flat",
    treeDensity: 0.12,
    rockDensity: 0.06,
    waterCoverage: 0.42,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.014,
  },
  beach: {
    id: "beach",
    ground: "flat",
    treeDensity: 0.02,
    rockDensity: 0.03,
    waterCoverage: 0.5,
    waterCenter: 0.72,
    walled: true,
    ceiling: false,
    fogDensity: 0.01,
  },
  snowfield: {
    id: "snowfield",
    ground: "flat",
    treeDensity: 0.07,
    rockDensity: 0.02,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.016,
  },
  "hotel-room": {
    id: "hotel-room",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.009,
  },
  "pool-hall": {
    id: "pool-hall",
    ground: "sunken",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0.45,
    waterCenter: 0.55,
    walled: true,
    ceiling: false,
    fogDensity: 0.009,
  },
  library: {
    id: "library",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.012,
  },
  ballroom: {
    id: "ballroom",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.008,
  },
  ducks: {
    id: "ducks",
    ground: "sunken",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0.7,
    waterCenter: 0.55,
    walled: true,
    ceiling: false,
    fogDensity: 0.01,
  },
  cats: {
    id: "cats",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.01,
  },
  dogs: {
    id: "dogs",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.01,
  },
  balloons: {
    id: "balloons",
    ground: "flat",
    treeDensity: 0,
    rockDensity: 0,
    waterCoverage: 0,
    waterCenter: 0.5,
    walled: true,
    ceiling: false,
    fogDensity: 0.009,
  },
};

export const ARCHETYPE_IDS: readonly ArchetypeId[] = [
  "meadow",
  "plains",
  "pool",
  "forest",
  "ocean",
  "lake",
  "beach",
  "snowfield",
  "hotel-room",
  "pool-hall",
  "library",
  "ballroom",
  "ducks",
  "cats",
  "dogs",
  "balloons",
];
