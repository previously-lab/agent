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
 * against the drab corridor.
 */
import {
  WORLD_SEED,
  createRng,
  deriveSubSeed,
  pick,
} from "@/lib/game/seed";
import {
  INTERIOR_ROOMS,
  NATURE_BIOMES,
  PALETTES,
  SIZE_TIERS,
  VIVID_PALETTES,
  WIDTH_FACTORS,
  WONDER_ROOMS,
  type Palette,
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
 * Fog-of-war color for a palette. The raw palette fog is sky-adjacent and
 * reads as paint at 45° top-down (pink/orange soup that swallows the room).
 * Tie it to the sky, desaturate 40% toward neutral gray, darken 15% — the
 * fog becomes "air", not a white wall. Applied to EVERY palette including
 * the vivid set, so saturated rooms keep breathable distance cues.
 */
function atmosphereFog(palette: Palette): string {
  return scaleHex(
    blendHex(blendHex(palette.fog, palette.sky, 0.5), "#8a8f94", 0.4),
    0.85,
  );
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

  const worldClass = pickClass(classRng);
  const archetype =
    worldClass === "interior"
      ? pick(typeRng, INTERIOR_ROOMS)
      : worldClass === "wonder"
        ? pick(typeRng, WONDER_ROOMS)
        : pick(typeRng, NATURE_BIOMES); // nature AND hybrid

  const size = pick(sizeRng, SIZE_TIERS);
  const widthFactor = pick(widthRng, WIDTH_FACTORS);

  // Palette: interior/wonder rooms favor the vivid set (85%) for the
  // door-opening color shock; everything else draws from the full pool.
  const palette =
    (worldClass === "interior" || worldClass === "wonder") &&
    styleRng() < 0.85
      ? pick(styleRng, VIVID_PALETTES)
      : pick(styleRng, [...PALETTES, ...VIVID_PALETTES]);

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
