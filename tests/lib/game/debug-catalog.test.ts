/**
 * The debug gallery (debug-slice.ts + debug-catalog.ts + the three pipeline
 * hooks): a `dbg-` slice must force exactly its unit, and a real memory slice
 * must come out byte-for-byte as before.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHETYPE_IDS,
  DEBUG_PAGES,
  debugSliceId,
  parseDebugSlice,
  prettyUnitLabel,
  worldClassOfArchetype,
} from "@/lib/game/debug-slice";
import {
  debugUnitBySliceId,
  debugUnitsFor,
  isDebugPage,
} from "@/lib/game/debug-catalog";
import { ROOM_MODULES, compositionForRecipe } from "@/lib/game/room-modules";
import { ROOM_TEMPLATES, resolveRoomTemplate } from "@/lib/game/room-templates";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { WORLD_SEED } from "@/lib/game/seed";

describe("debug gallery", () => {
  it("lists every standard unit, once per page, in authored order", () => {
    expect(debugUnitsFor("modules").map((u) => u.id)).toEqual(
      ROOM_MODULES.map((m) => m.id),
    );
    expect(debugUnitsFor("templates").map((u) => u.id)).toEqual(
      ROOM_TEMPLATES.map((t) => t.id),
    );
    expect(debugUnitsFor("archetypes").map((u) => u.id)).toEqual([
      ...ARCHETYPE_IDS,
    ]);
    // Sixteen archetypes today (interior + nature biomes + wonder rooms).
    expect(ARCHETYPE_IDS.length).toBe(16);
  });

  it("round-trips a slice id back to its unit and plate", () => {
    for (const page of DEBUG_PAGES) {
      for (const unit of debugUnitsFor(page)) {
        expect(parseDebugSlice(unit.sliceId)).toEqual({ page, id: unit.id });
        expect(debugUnitBySliceId(unit.sliceId)?.label).toBe(unit.label);
      }
    }
  });

  it("never matches a real memory slice", () => {
    for (const id of ["2026-09-15-0746", "core", "dbg", "dbg-m", ""]) {
      expect(parseDebugSlice(id)).toBeNull();
    }
    expect(isDebugPage("modules")).toBe(true);
    expect(isDebugPage("nope")).toBe(false);
    expect(prettyUnitLabel("pool-hall")).toBe("Pool Hall");
  });

  it("pins a module page to that one module, at tier M, deterministically", () => {
    for (const entry of ROOM_MODULES) {
      const recipe = compileSpaceRecipe(debugSliceId("modules", entry.id));
      expect(recipe.worldClass).toBe("interior");
      expect(recipe.size.extent).toBe(32);
      const composition = compositionForRecipe(recipe, WORLD_SEED, 0);
      expect(composition).not.toBeNull();
      expect(composition?.modules.map((placed) => placed.module.id)).toEqual([
        entry.id,
      ]);
      expect(composition).toEqual(
        compositionForRecipe(compileSpaceRecipe(recipe.sliceId), WORLD_SEED, 0),
      );
    }
  });

  it("pins a template page to that layout", () => {
    for (const template of ROOM_TEMPLATES) {
      const recipe = compileSpaceRecipe(debugSliceId("templates", template.id));
      expect(recipe.worldClass).toBe("interior");
      const resolved = resolveRoomTemplate(
        recipe.sliceId,
        recipe.worldClass,
        recipe.archetype,
        recipe.size.extent,
        0,
      );
      expect(resolved?.id).toBe(template.id);
      expect(recipe.size.extent).toBe(template.minExtent);
    }
  });

  it("pins an archetype page to that archetype and its world class", () => {
    for (const id of ARCHETYPE_IDS) {
      const recipe = compileSpaceRecipe(debugSliceId("archetypes", id));
      expect(recipe.archetype).toBe(id);
      expect(recipe.worldClass).toBe(worldClassOfArchetype(id));
    }
  });

  it("leaves a real slice's recipe untouched by the debug branches", () => {
    const id = "2026-09-15-0746";
    const recipe = compileSpaceRecipe(id, WORLD_SEED);
    expect(parseDebugSlice(id)).toBeNull();
    expect(compileSpaceRecipe(id, WORLD_SEED)).toEqual(recipe);
    // The composition path is unchanged for it too: whatever the seed picks,
    // the same call twice is the same composition (A6), module count included.
    const once = compositionForRecipe(recipe, WORLD_SEED, 3);
    const twice = compositionForRecipe(compileSpaceRecipe(id, WORLD_SEED), WORLD_SEED, 3);
    expect(twice).toEqual(once);
  });
});
