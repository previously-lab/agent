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
  // vivid v2 set — interiors and wonders draw from these first
  | "coral"
  | "mint"
  | "butter"
  | "lavender"
  | "sky"
  | "peach"
  | "grass"
  | "salt";

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
  /** Accent color for props, trims, and water highlights. */
  accent: string;
  /** Directional "sun" (or moon) light color. */
  sunColor: string;
  /** Directional light intensity multiplier. */
  sunIntensity: number;
  /** Ambient/hemisphere light floor. Never below 0.25. */
  ambient: number;
}

/** The six original palettes — restrained, nature-friendly. */
export const PALETTES: readonly Palette[] = [
  {
    id: "dawn",
    sky: "#f3d9c8",
    fog: "#e9d2c2",
    ground: "#9aa78a",
    accent: "#e0a184",
    sunColor: "#ffd9b3",
    sunIntensity: 0.7,
    ambient: 0.45,
  },
  {
    id: "noon",
    sky: "#cfe4ee",
    fog: "#dcebf0",
    ground: "#a9b78f",
    accent: "#f0e6c8",
    sunColor: "#fff4e0",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    id: "dusk",
    sky: "#d9b8c4",
    fog: "#cbb3c0",
    ground: "#8f9a7f",
    accent: "#d98d6e",
    sunColor: "#f5b78f",
    sunIntensity: 0.5,
    ambient: 0.35,
  },
  {
    id: "night",
    sky: "#232b3a",
    fog: "#2f3849",
    ground: "#3d4536",
    accent: "#7f95b8",
    sunColor: "#a9bde0",
    sunIntensity: 0.35,
    ambient: 0.28,
  },
  {
    id: "warm",
    sky: "#ecd9b0",
    fog: "#e6d3ab",
    ground: "#a99a72",
    accent: "#d9925f",
    sunColor: "#ffdf9e",
    sunIntensity: 0.8,
    ambient: 0.5,
  },
  {
    id: "cool",
    sky: "#c2d4d8",
    fog: "#cddfe2",
    ground: "#8fa39a",
    accent: "#a8c4c9",
    sunColor: "#e6f2f0",
    sunIntensity: 0.7,
    ambient: 0.5,
  },
];

/** The vivid v2 palettes — high-saturation room colors. Interior and
 *  wonder rooms draw from this set first (see space-recipe.ts). */
export const VIVID_PALETTES: readonly Palette[] = [
  {
    id: "coral",
    sky: "#ffd9c9",
    fog: "#ffc9b8",
    ground: "#e86a58",
    accent: "#ffe14d",
    sunColor: "#fff0e0",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "mint",
    sky: "#d8f5e8",
    fog: "#cdf0e0",
    ground: "#63c88e",
    accent: "#ff7fa0",
    sunColor: "#f0fff4",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "butter",
    sky: "#fff3c4",
    fog: "#ffedb0",
    ground: "#e8c34e",
    accent: "#5fc4e8",
    sunColor: "#fff8dc",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    id: "lavender",
    sky: "#e2d4f5",
    fog: "#d9c8f0",
    ground: "#a68cd0",
    accent: "#ffd966",
    sunColor: "#f5ecff",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "sky",
    sky: "#bfe8ff",
    fog: "#cdeeff",
    ground: "#6fb7e8",
    accent: "#ff9a62",
    sunColor: "#f0faff",
    sunIntensity: 1.0,
    ambient: 0.6,
  },
  {
    id: "peach",
    sky: "#ffe3cf",
    fog: "#ffd9c0",
    ground: "#f0a070",
    accent: "#7fd0c0",
    sunColor: "#fff4e8",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "grass",
    sky: "#d0f0c0",
    fog: "#c8e8b8",
    ground: "#58b058",
    accent: "#ff8a5c",
    sunColor: "#f4ffe8",
    sunIntensity: 0.9,
    ambient: 0.55,
  },
  {
    id: "salt",
    sky: "#dff4f8",
    fog: "#d8f0f5",
    ground: "#8fc4d4",
    accent: "#ffb84d",
    sunColor: "#f4fcff",
    sunIntensity: 1.0,
    ambient: 0.6,
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
