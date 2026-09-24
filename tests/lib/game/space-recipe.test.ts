/**
 * Tests for the space-recipe compiler — the deterministic door → space
 * mapping. The contract under test: same (worldSeed, sliceId) in → identical
 * recipe out, for ANY slice id (totality), and recipes are plain
 * JSON-serializable data (the renderer's only input).
 */
import { describe, it, expect } from "vitest";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  ARCHETYPE_IDS,
  INTERIOR_ROOMS,
  NATURE_BIOMES,
  PALETTES,
  SIZE_TIERS,
  VIVID_PALETTES,
  WIDTH_FACTORS,
  WONDER_ROOMS,
  type ArchetypeId,
  type PaletteId,
  type WorldClass,
} from "@/lib/game/space-types";

/** 200 fixed slice ids — deterministic input, not Math.random(). */
const SLICE_IDS = Array.from({ length: 200 }, (_, i) => `2026-09-${i}`);

function isPlainJson(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isPlainJson);
  }
  if (typeof value === "object") {
    return Object.values(value).every(
      (v) => v !== undefined && isPlainJson(v),
    );
  }
  return false;
}

describe("compileSpaceRecipe", () => {
  it("returns the identical recipe for the same sliceId across calls", () => {
    for (const sliceId of SLICE_IDS.slice(0, 20)) {
      const a = compileSpaceRecipe(sliceId);
      const b = compileSpaceRecipe(sliceId);
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // structural equality, not shared identity
    }
  });

  it("produces a different recipe for a different worldSeed", () => {
    // "Almost surely": fixed seeds make the outcome deterministic — if this
    // ever collided, the seed derivation would be broken, not unlucky.
    for (const sliceId of SLICE_IDS.slice(0, 10)) {
      const a = compileSpaceRecipe(sliceId, "world-alpha");
      const b = compileSpaceRecipe(sliceId, "world-beta");
      expect(a).not.toEqual(b);
    }
  });

  it("is total and valid over 200 slice ids (class/archetype/size/width/palette in defined sets)", () => {
    const WORLD_CLASSES: readonly WorldClass[] = [
      "nature",
      "interior",
      "hybrid",
      "wonder",
    ];
    const PALETTE_IDS = [...PALETTES, ...VIVID_PALETTES].map((p) => p.id);
    const CLASS_ROOMS: Record<WorldClass, readonly ArchetypeId[]> = {
      nature: NATURE_BIOMES,
      hybrid: NATURE_BIOMES,
      interior: INTERIOR_ROOMS,
      wonder: WONDER_ROOMS,
    };
    for (const sliceId of SLICE_IDS) {
      const recipe = compileSpaceRecipe(sliceId);
      expect(recipe.sliceId).toBe(sliceId);
      expect(WORLD_CLASSES).toContain(recipe.worldClass);
      expect(ARCHETYPE_IDS).toContain(recipe.archetype);
      // The archetype must belong to the drawn world class's room list.
      expect(CLASS_ROOMS[recipe.worldClass]).toContain(recipe.archetype);
      expect(SIZE_TIERS.map((t) => t.id)).toContain(recipe.size.id);
      // Width is a seeded WIDTH_FACTORS multiple of the extent.
      expect(
        WIDTH_FACTORS.map((f) => Math.round(recipe.size.extent * f)),
      ).toContain(recipe.width);
      expect(PALETTE_IDS).toContain(recipe.palette.id);
      expect(Number.isFinite(recipe.layoutSeed)).toBe(true);
      expect(Number.isFinite(recipe.lightSeed)).toBe(true);
    }
  });

  it("draws the interior class, every interior room, and 8 palettes over 200 ids", () => {
    // 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内。
    // The multi-class spread this test used to pin is unreachable — the
    // class draw answers interior only (CLASS_WEIGHTS' single switch),
    // and the nature/hybrid/wonder taxonomy stays dormant in
    // space-types.ts. The diversity bar survives INSIDE the class: every
    // interior room and a wide palette spread still appear across the
    // draw. (A class id returning to CLASS_WEIGHTS re-widens this test.)
    const recipes = SLICE_IDS.map((id) => compileSpaceRecipe(id));
    const classes = new Set<WorldClass>(recipes.map((r) => r.worldClass));
    const archetypes = new Set<ArchetypeId>(recipes.map((r) => r.archetype));
    const palettes = new Set<PaletteId>(recipes.map((r) => r.palette.id));
    expect([...classes]).toEqual(["interior"]);
    for (const room of INTERIOR_ROOMS) {
      expect(archetypes.has(room), `no slice drew ${room}`).toBe(true);
    }
    expect(palettes.size).toBeGreaterThanOrEqual(8);
  });

  it("covers every interior room over 600 slice ids (taxonomy completeness)", () => {
    // 世界分类收口（2026-09）：the dormant nature/hybrid/wonder rooms
    // cannot be drawn, so completeness is pinned on the live taxonomy —
    // the interior room list (ARCHETYPE_IDS still validates every recipe
    // above, drawn or dormant).
    const seen = new Set<ArchetypeId>();
    for (let i = 0; i < 600 && seen.size < INTERIOR_ROOMS.length; i++) {
      seen.add(compileSpaceRecipe(`coverage-${i}`).archetype);
    }
    for (const id of INTERIOR_ROOMS) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it("emits plain JSON-serializable data (round-trip equals, no functions/undefined)", () => {
    for (const sliceId of SLICE_IDS) {
      const recipe = compileSpaceRecipe(sliceId);
      expect(isPlainJson(recipe)).toBe(true);
      expect(JSON.parse(JSON.stringify(recipe))).toEqual(recipe);
    }
  });
});
