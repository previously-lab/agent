/**
 * Space-recipe compiler: pure data in → pure recipe out.
 *
 * A corridor door opens onto a deterministic liminal space. Everything the
 * renderer needs is decided here, up front, from the world seed and the
 * slice id alone. No randomness exists outside the seeded RNG.
 *
 * v2 taxonomy: a weighted draw picks the world class (nature 40%,
 * interior 25%, hybrid 20%, wonder 15%), then the specific room/biome
 * within the class, then the rectangular plan's width factor (0.66 / 1 /
 * 1.5 × extent), then a palette — interior and wonder rooms pull from the
 * vivid palette set first so the door-opening color contrast stays strong
 * against the drab corridor. A skinned world (every non-interior
 * archetype) then re-weights its palette pool by the world↔palette
 * affinity below — harmonious palettes win, clashing combos floor out;
 * interior worlds keep the legacy uniform draw exactly.
 */
import {
  WORLD_SEED,
  createRng,
  deriveSubSeed,
  pick,
} from "@/lib/game/seed";
import { parseDebugSlice, worldClassOfArchetype } from "./debug-slice";
import { roomModuleById } from "./room-modules";
import { roomTemplateById } from "./room-templates";
import {
  INTERIOR_ROOMS,
  NATURE_BIOMES,
  PALETTES,
  SIZE_TIERS,
  VIVID_PALETTES,
  WIDTH_FACTORS,
  WONDER_ROOMS,
  type ArchetypeId,
  type Palette,
  type PaletteId,
  type WorldClass,
  type SpaceRecipe,
} from "@/lib/game/space-types";

/** Per-channel hex blend: `a` toward `b` by `t` (0..1). Pure. */
function blendHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const channel = (shift: number) => {
    const va = (pa >> shift) & 0xff;
    const vb = (pb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  const rgb = (channel(16) << 16) | (channel(8) << 8) | channel(0);
  return `#${(0x1000000 | rgb).toString(16).slice(1)}`;
}

/** Multiply a hex color's brightness by `k`. Pure. */
function scaleHex(a: string, k: number): string {
  return blendHex(a, "#000000", 1 - k);
}

/**
 * Fog-of-war color for a palette — the room's own shadow. The fog doubles
 * as the scene background beyond the plan, so it IS the void the room
 * floats in: tie it to the palette's fog/sky hue, desaturate only 15%
 * toward neutral gray (the hue must survive — a butter room casts a honey
 * shadow, not a gray one), then darken hard (~55%) so the space melts
 * into a deeper tone of itself at the fog line. Applied to EVERY palette
 * including the vivid set.
 */
function atmosphereFog(palette: Palette): string {
  return scaleHex(
    blendHex(blendHex(palette.fog, palette.sky, 0.5), "#8a8f94", 0.15),
    0.45,
  );
}

/**
 * Door-glow color for a palette — the "content hint" seen through the door
 * frame before the room exists. It must read as the light OF THAT ROOM,
 * not a decorative contrast, and it must match what the room actually
 * delivers once the player steps through: the room's world is its ground
 * under its sky, melting into the palette's own fog shadow. So the glow
 * takes the room's ground→sky midpoint (its dominant hue) and lifts it
 * only a touch toward white — enough to glow against the corridor wall,
 * not enough to bleach the hue away. A butter room's door leaks warm
 * honey light, a pool room's leaks cool blue.
 */
export function doorGlowColor(palette: Palette): string {
  return blendHex(blendHex(palette.ground, palette.sky, 0.5), "#ffffff", 0.1);
}

/** World-class draw weights — nature 40 / interior 25 / hybrid 20 / wonder 15. */
const CLASS_WEIGHTS: readonly { id: WorldClass; weight: number }[] = [
  { id: "nature", weight: 0.4 },
  { id: "interior", weight: 0.25 },
  { id: "hybrid", weight: 0.2 },
  { id: "wonder", weight: 0.15 },
];

/** Weighted class pick from the next draw of `rng`. */
function pickClass(rng: () => number): WorldClass {
  let r = rng();
  for (const entry of CLASS_WEIGHTS) {
    if (r < entry.weight) return entry.id;
    r -= entry.weight;
  }
  return "nature";
}

/* ------------------------------------------------------------------ */
/* THE WORLD↔PALETTE AFFINITY (v0.12 P4 — 配色与皮肤联动)              */
/*                                                                    */
/* A skinned room renders its floor / walls / window / fog / fixture  */
/* from the SKIN — the palette keeps only the accent, the sun         */
/* colour/intensity, the ambient floor and the dusk/night mood. A     */
/* palette whose hues fight the skin's world spends those remaining   */
/* channels against the room (hot-orange accents in a flooded room,   */
/* a cold-blue door glow leaking into a dune) — two clashing palettes */
/* do not read as two worlds, they read as the same mistake. So the   */
/* palette draw is AFFINITY-WEIGHTED per archetype: harmonious        */
/* palettes ×1, neutral ×0.45, clashing ×0.12 — every palette stays   */
/* possible (the long tail is never deleted), the draw simply stops   */
/* spending a third of all slices on fighting combos.                 */
/*                                                                    */
/* 依据 (measured, not taste): the palette grounds and skin floors    */
/* were converted to HSV hue once (one-off measurement, numbers in    */
/* the family lists below). Five families emerged —                   */
/*   HOT_WARM  coral 8° peach 23° warm 44° butter 46°                 */
/*   SAGE      dawn 87° noon 81° dusk 84° night 92°                   */
/*   GREEN     moss 101° grass 120° mint 146°                         */
/*   COLD      cool 153° teal 186° salt 194° sky 204°                 */
/*   VIOLET    haze 258° lavender 263° plum 306°                      */
/* — and the rule is family-vs-family: a skin's world harmonizes      */
/* with its own family and close neighbours, clashes with the         */
/* opposite temperature. SIBLINGS SHARING ONE SKIN are split by       */
/* giving each its own sub-region of the harmonious space (pool reads */
/* bright aqua, ocean deep+night, lake green-banked) so "same skin"   */
/* no longer means "same palette pool" — the per-skin fog/window/     */
/* light slots are identical there; the palette region is the one     */
/* per-slice channel that can still separate them. Siblings whose     */
/* READ differs from their skin's family (snowfield wears the moss    */
/* skin until a snow skin is authored) follow the SKIN — the render   */
/* is the truth — with their cold read nudged inside the family.      */
/* Interior archetypes have NO entry: no skin, legacy uniform draw,   */
/* byte-for-byte (无皮肤 ≡ 温带).                                     */
/* ------------------------------------------------------------------ */

/** The five measured hue families (see the header for the numbers). */
const HOT_WARM = ["coral", "peach", "warm", "butter"] as const;
const SAGE = ["dawn", "noon", "dusk", "night"] as const;
const GREEN = ["moss", "grass", "mint"] as const;
const COLD = ["cool", "teal", "salt", "sky"] as const;
const VIOLET = ["haze", "lavender", "plum"] as const;

interface PaletteAffinity {
  /** Palettes whose hues live in the world's family — full weight. */
  harmonize: readonly PaletteId[];
  /** Palettes whose hues fight the world's family — floor weight. */
  clash: readonly PaletteId[];
}

/** Every NON-INTERIOR archetype's palette affinity (interior worlds
 *  answer null skin and keep the legacy uniform draw — zero change).
 *  Each list is authored against the measured families above; a
 *  sibling's delta from its skin's family carries its reason inline. */
const ARCHETYPE_PALETTE_AFFINITY: Partial<Record<ArchetypeId, PaletteAffinity>> = {
  // —— grove family (world hue ≈ 97°: grass floor, hedge walls) ———————
  meadow: {
    // open grassland: greens + the blue sky over it
    harmonize: [...SAGE, ...GREEN, "sky", "salt"],
    clash: [...HOT_WARM, ...VIOLET],
  },
  cats: {
    // sunlit grove diorama: greens + warm play; cold blues fight the fur
    harmonize: ["moss", "grass", "mint", "noon", "dawn", "butter"],
    clash: ["coral", "peach", "sky", "teal", "plum"],
  },
  dogs: {
    // the park read: brighter greens, peach tolerated, violet out
    harmonize: ["grass", "mint", "noon", "butter", "peach"],
    clash: ["coral", "sky", "teal", "plum", "lavender"],
  },
  balloons: {
    // the festive exception: balloons float IN the sky — violet/sky
    // harmonize here (the one grove sibling where the cold family is
    // the world's own); deep moss/night sink the party
    harmonize: ["sky", "salt", "lavender", "mint", "noon", "butter", "coral"],
    clash: ["moss", "teal", "night"],
  },
  // —— dune family (world hue ≈ 38°: hot pale gold, rock walls) ——————
  plains: {
    // dry interior flats: the hot golds own it, no sea in sight
    harmonize: [...HOT_WARM, "dawn"],
    clash: [...COLD, ...VIOLET],
  },
  beach: {
    // sea-side dune: salt/sky join the golds (the shore is half the
    // read); lush greens and violet-grey belong to other worlds
    harmonize: [...HOT_WARM, "dawn", "salt", "sky"],
    clash: [...GREEN, ...VIOLET],
  },
  // —— moss family (world hue ≈ 97° but dark & wet: moss floor) ——————
  forest: {
    // deep wet green: the moss palette was authored for exactly this
    harmonize: ["moss", "haze", "night", "dusk", "cool"],
    clash: [...HOT_WARM],
  },
  snowfield: {
    // no snow skin yet — the wet-cold moss skin stands in (the table's
    // own note), so the affinity follows the SKIN; the cold read is
    // nudged inside the family (haze/lavender pale mist in), lush
    // summer greens (grass/mint) out
    harmonize: ["moss", "haze", "night", "cool", "lavender"],
    clash: [...HOT_WARM, "grass", "mint"],
  },
  // —— shallows family (world hue ≈ 192°: wade water, aqua walls) ————
  pool: {
    // the bright swimming-pool read: clear aqua, daylight
    harmonize: ["sky", "salt", "teal", "cool", "mint"],
    clash: [...HOT_WARM],
  },
  ocean: {
    // open sea: deeper — night joins (夜海), shore greens leave
    harmonize: ["sky", "salt", "teal", "night", "cool"],
    clash: [...HOT_WARM, ...GREEN],
  },
  lake: {
    // the green-banked water: shore greens and the bright lake noon
    harmonize: ["mint", "grass", "salt", "sky", "noon", "cool"],
    clash: [...HOT_WARM],
  },
  ducks: {
    // the pond diorama: bright shore water, reedy greens; the night
    // pond stays neutral (a moonlit pond is a fine read, not the norm)
    harmonize: ["sky", "salt", "mint", "teal", "cool", "grass"],
    clash: [...HOT_WARM],
  },
};

/** Affinity weights — harmonious full, neutral mid, clash floor. The
 *  floor is deliberately NOT zero: every palette stays drawable, the
 *  distribution reading (tests/lib/game/variant-distribution.test.ts)
 *  reports both the raw and the harmonious combo counts. */
const AFFINITY_HARMONIZE_WEIGHT = 1;
const AFFINITY_NEUTRAL_WEIGHT = 0.45;
const AFFINITY_CLASH_WEIGHT = 0.12;

/** The affinity class of one palette under one archetype's world —
 *  "harmonize" / "neutral" / "clash", or null when the archetype has
 *  no world skin (interior — the legacy uniform draw owns it). Pure. */
export function paletteAffinityFor(
  archetype: ArchetypeId,
  paletteId: PaletteId,
): "harmonize" | "neutral" | "clash" | null {
  const affinity = ARCHETYPE_PALETTE_AFFINITY[archetype];
  if (!affinity) return null;
  if ((affinity.harmonize as readonly string[]).includes(paletteId)) return "harmonize";
  if ((affinity.clash as readonly string[]).includes(paletteId)) return "clash";
  return "neutral";
}

function paletteAffinityWeight(archetype: ArchetypeId, paletteId: PaletteId): number {
  switch (paletteAffinityFor(archetype, paletteId)) {
    case "harmonize":
      return AFFINITY_HARMONIZE_WEIGHT;
    case "clash":
      return AFFINITY_CLASH_WEIGHT;
    default:
      return AFFINITY_NEUTRAL_WEIGHT;
  }
}

/** One-draw weighted pick — consumes EXACTLY one draw of `rng`, the
 *  same consumption as pick(), so swapping a uniform for a weighted
 *  pick never perturbs the stream (A6: same slice ⇒ same recipe). */
function weightedPick<T>(
  rng: () => number,
  items: readonly T[],
  weight: (item: T) => number,
): T {
  let ticket = rng() * items.reduce((sum, item) => sum + weight(item), 0);
  for (const item of items) {
    ticket -= weight(item);
    if (ticket < 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Compile the recipe for the space behind a corridor door.
 *
 * The recipe is everything the renderer needs: rendering must be a pure
 * function of this value, with no further dependence on the world seed or
 * slice id. Regenerating with the same `sliceId` and `worldSeed` must
 * produce an identical recipe — same world class, same archetype, same
 * size tier and width, same palette, same layout/light seeds — on any
 * machine, at any time.
 *
 * Each recipe facet derives from its own sub-seed, so changing one facet
 * of the world never reshuffles the others. Any string works as a
 * `sliceId`; compilation is total and never throws.
 *
 * @param sliceId   Door label / memory slice the space belongs to.
 * @param worldSeed World seed the sub-seeds are derived from.
 */
export function compileSpaceRecipe(
  sliceId: string,
  worldSeed: string = WORLD_SEED,
): SpaceRecipe {
  const classRng = createRng(deriveSubSeed(worldSeed, sliceId, "class"));
  const typeRng = createRng(deriveSubSeed(worldSeed, sliceId, "type"));
  const sizeRng = createRng(deriveSubSeed(worldSeed, sliceId, "size"));
  const widthRng = createRng(deriveSubSeed(worldSeed, sliceId, "width"));
  const styleRng = createRng(deriveSubSeed(worldSeed, sliceId, "style"));

  let worldClass = pickClass(classRng);
  let archetype =
    worldClass === "interior"
      ? pick(typeRng, INTERIOR_ROOMS)
      : worldClass === "wonder"
        ? pick(typeRng, WONDER_ROOMS)
        : pick(typeRng, NATURE_BIOMES); // nature AND hybrid

  let size = pick(sizeRng, SIZE_TIERS);

  // Debug gallery (debug-slice.ts): a `dbg-` slice pins the facets its page
  // reviews — the archetype page its archetype, the module page an interior
  // room of that module's own archetype at tier M (the composition sizes the
  // plan), the template page the tier its layout asks for. A real slice never
  // matches, so every draw above and below is untouched for it.
  const debug = parseDebugSlice(sliceId);
  if (debug?.page === "archetypes") {
    archetype = debug.id as typeof archetype;
    worldClass = worldClassOfArchetype(debug.id);
  } else if (debug?.page === "modules") {
    worldClass = "interior";
    const pinnedModule = roomModuleById(debug.id);
    if (pinnedModule && pinnedModule.archetypes.length > 0) {
      archetype = pinnedModule.archetypes[0];
    }
    size = SIZE_TIERS.find((tier) => tier.extent === 32) ?? size;
  } else if (debug?.page === "templates") {
    worldClass = "interior";
    const template = roomTemplateById(debug.id);
    if (template?.archetypes?.length) archetype = template.archetypes[0];
    if (template) {
      size = SIZE_TIERS.find((tier) => tier.extent === template.minExtent) ?? size;
    }
  }

  const widthFactor = pick(widthRng, WIDTH_FACTORS);

  // Palette: interior/wonder rooms favor the vivid set (85%) for the
  // door-opening color shock; everything else draws from the full pool.
  // A skinned world (every non-interior archetype) then re-weights the
  // pool by its palette affinity — same single draw, harmonious worlds
  // win, clashes floor out; an interior world (null skin) keeps the
  // legacy uniform pick byte-for-byte.
  const pool =
    (worldClass === "interior" || worldClass === "wonder") && styleRng() < 0.85
      ? VIVID_PALETTES
      : [...PALETTES, ...VIVID_PALETTES];
  const palette = ARCHETYPE_PALETTE_AFFINITY[archetype]
    ? weightedPick(styleRng, pool, (p) => paletteAffinityWeight(archetype, p.id))
    : pick(styleRng, pool);

  return {
    sliceId,
    worldClass,
    archetype,
    size,
    width: Math.round(size.extent * widthFactor),
    palette: {
      ...palette,
      // The raw palette fog reads as colored paint from the 45° camera;
      // the recipe carries the atmosphere-adjusted variant instead.
      fog: atmosphereFog(palette),
    },
    layoutSeed: deriveSubSeed(worldSeed, sliceId, "layout"),
    lightSeed: deriveSubSeed(worldSeed, sliceId, "light"),
  };
}
