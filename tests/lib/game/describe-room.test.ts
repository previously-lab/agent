/**
 * Tests for describeRoom (lib/game/describe-room.ts) — the game's computed
 * room outline for the chat agent (design v0.11-room-interiors §13). The
 * contract under test: the outline is a PURE function of the slice id (same
 * slice → identical outline, any machine, any call order), total over every
 * string, and derived from the render's own pure chain — so it agrees with
 * compileSpaceRecipe / compositionForRecipe / placeRoomDoors rather than
 * re-telling the room in its own words.
 */
import { describe, it, expect } from "vitest";
import {
  describeRoom,
  formatRoomDescription,
} from "@/lib/game/describe-room";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  compositionForRecipe,
  compositionKitZonesFor,
  compositionTemplateFor,
} from "@/lib/game/room-modules";
import {
  scaledRecipeFor,
  roomPlanFor,
  composeRoom,
} from "@/lib/game/room-plan";
import { templatePlanFor, templateZonesFor } from "@/lib/game/room-templates";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  planArea,
  stageInteriorKits,
  type KitKind,
} from "@/lib/game/kits";
import { schematicPlacementsFor } from "@/lib/game/room-schematic";
import { terrainHeight, waterRectFor } from "@/lib/game/terrain";
import { skinForSlice } from "@/lib/game/skins";
import { debugSliceIdWithoutSkin } from "@/lib/game/debug-slice";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";

/** Fixed slice ids — deterministic input, not Math.random(). */
const SLICES = [
  "2026-09-12-0941",
  "2026-09-13-1530",
  "2026-09-14-2207",
  "2026-09-15-1401",
  "2026-07-24-1500",
  "2026-08-19-1400",
  "2026-10-02-0746",
  "2026-11-30-2312",
];

describe("describeRoom", () => {
  it("is deterministic: same slice → identical outline, independent of call order", () => {
    for (const sliceId of SLICES) {
      const first = describeRoom(sliceId);
      // Interleave other slices between the two calls — purity means the
      // second read of the same slice is byte-identical regardless.
      for (const other of SLICES) describeRoom(other);
      const second = describeRoom(sliceId);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it("is total: any string is a valid slice id", () => {
    for (const odd of ["", "not-a-slice", "🚪", "2026-99-99-9999"]) {
      const desc = describeRoom(odd);
      expect(desc.sliceId).toBe(odd);
      expect(formatRoomDescription(desc, "zh").length).toBeGreaterThan(0);
    }
  });

  it("agrees with the recipe compiler — the outline never re-derives the recipe", () => {
    for (const sliceId of SLICES) {
      const desc = describeRoom(sliceId);
      const recipe = compileSpaceRecipe(sliceId);
      expect(desc.worldClass).toBe(recipe.worldClass);
      expect(desc.archetype).toBe(recipe.archetype);
      expect(desc.sizeTier).toBe(recipe.size.id);
      expect(desc.palette).toBe(recipe.palette.id);
      // Scaled dims come from the renderer's scaledRecipeFor, not a copy.
      const { recipe: scaled } = scaledRecipeFor(recipe);
      expect(desc.width).toBe(scaled.width);
      expect(desc.extent).toBe(scaled.size.extent);
    }
  });

  it("mirrors the module composition for interior rooms", () => {
    for (const sliceId of SLICES) {
      const recipe = compileSpaceRecipe(sliceId);
      const desc = describeRoom(sliceId);
      const composition = compositionForRecipe(recipe);
      if (recipe.worldClass !== "interior") {
        expect(desc.layout.kind).not.toBe("modules");
        continue;
      }
      expect(composition).not.toBeNull();
      expect(desc.layout.kind).toBe("modules");
      if (desc.layout.kind !== "modules" || !composition) continue;
      expect(desc.layout.topology).toBe(composition.topology);
      expect(desc.layout.modules.map((m) => m.id)).toEqual(
        composition.modules.map((p) => p.module.id),
      );
      // A composed interior is furnished from the pure chain — the
      // pool-hall modules (bath, pool-deck) included: a composed pool
      // room's content is its modules' whitelists + blueprints alone
      // (the legacy rim scatter retires once a composition exists), so
      // the enumeration names exactly what the render stages.
      expect(desc.furnishing).not.toBeNull();
      expect(desc.furnishing!.length).toBeGreaterThan(0);
      if (recipe.archetype === "pool-hall") {
        expect(desc.water).not.toBeNull();
      }
    }
  });

  it("reports door capacity without runtime inputs, and never invents placements", () => {
    for (const sliceId of SLICES) {
      const desc = describeRoom(sliceId);
      expect(desc.doors.placed).toBeUndefined();
      expect(desc.doors.measuredCapacity).toBeGreaterThanOrEqual(0);
      if (desc.doors.permittedWalls) {
        // §10.5 axial semantics: permitted walls are the north/south faces.
        for (const role of desc.doors.permittedWalls) {
          expect(["far", "step", "left", "right", "inner"]).toContain(role);
        }
      }
    }
  });

  it("places doors exactly when strandDoors + corridorSide are given, inside the permitted walls", () => {
    for (const sliceId of SLICES) {
      for (const side of ["north", "south"] as const) {
        const desc = describeRoom(sliceId, {
          strandDoors: 3,
          corridorSide: side,
        });
        expect(desc.doors.placed).toBeDefined();
        // Exactly the requested count — placement relaxes, never drops.
        expect(desc.doors.placed?.doors).toHaveLength(3);
        // The affordance holds on every ladder rung: a banned wall never
        // receives a door, however tight the room.
        if (desc.doors.permittedWalls) {
          for (const door of desc.doors.placed?.doors ?? []) {
            expect(desc.doors.permittedWalls).toContain(door.wall);
          }
        }
        // Deterministic with the runtime inputs pinned, too.
        const again = describeRoom(sliceId, {
          strandDoors: 3,
          corridorSide: side,
        });
        expect(JSON.stringify(again)).toBe(JSON.stringify(desc));
      }
    }
  });

  it("renders the same facts in English and Chinese", () => {
    for (const sliceId of SLICES.slice(0, 4)) {
      const desc = describeRoom(sliceId);
      const en = formatRoomDescription(desc, "en");
      const zh = formatRoomDescription(desc, "zh");
      expect(en).toContain(sliceId);
      expect(zh).toContain(sliceId);
      // Same line count — one line per fact in both locales.
      expect(zh.split("\n")).toHaveLength(en.split("\n").length);
      // The zh render is actually Chinese; the en render is not.
      expect(zh).toMatch(/[一-鿿]/);
      expect(en).not.toMatch(/[一-鿿]/);
    }
  });

  it("formats a doorless room's entrance and window semantics", () => {
    const desc = describeRoom("2026-09-12-0941");
    const zh = formatRoomDescription(desc, "zh");
    expect(zh).toContain("入口在南墙");
    expect(zh).toContain("东西侧墙");
  });
});


// 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内。
// The "describeRoom worldClass furnishing (nature/wonder kits in the
// outline)" suite lived here — four cases that scanned deterministic
// probe ids for a nature / pool-biome / wonder slice and enumerated the
// resolved skin's decks. With the world draw interior-only no probe id
// can produce those rooms (the scan window comes back empty), and the
// whole block's premise — a real slice drawing a skinned world — is
// unreachable until a class id returns to CLASS_WEIGHTS. The nature /
// wonder kits, the biome and wonder archetype lists, the skins and their
// decks stay dormant in kits.ts, space-types.ts and skins.ts; the
// debug gallery still reaches them (`dbg-skin:<id>` — see skin-render.test.ts
// / skins.test.ts), which is where the skinned-world contracts are pinned
// now; the archetype pins themselves resolve the temperate baseline.

/* ------------------------------------------------------------------ */
/* 描述 = 画面 — the outline's furnishing vs the renderer's staging.    */
/*                                                                      */
/* The committed cross-check above compares single-module rooms only,   */
/* which is exactly the shape where the two zone sources (the           */
/* composition's kit zones vs the plain template's) stage               */
/* byte-identical pieces — compositionKitZonesFor is a strict widening  */
/* of templateZonesFor, differing ONLY in the per-cluster kitIds the    */
/* zone-first side-kit draw deals from, which matters solely for        */
/* MULTI-module rooms whose modules whitelist different kits. The       */
/* v0.13 drift (2d1feed) lived there unnoticed; these cases pin the     */
/* precedence.                                                          */
/*                                                                      */
/* Honest limit: this is a BY-CONSTRUCTION check. The staging oracle    */
/* reuses the same pure helpers describe-room.ts calls                  */
/* (stageInteriorKits and friends) — an independent oracle would need   */
/* the renderer's own furniture memo, which lives in space.tsx outside  */
/* the importable pure chain. What IS pinned independently is the       */
/* PRECEDENCE: the "templateZones" variant below restages each room the */
/* way a reverted describe-room would, and must DISAGREE with the       */
/* outline on every listed slice — so a revert fails loudly.            */
/* ------------------------------------------------------------------ */

/** Multi-module composed slices where the two zone sources genuinely
 *  stage different kits (found by scanning; each is named by its
 *  composed modules). At least one carries a bath beside a living
 *  module — the shape the drift report cited (dining-hall + bath). */
const DIVERGENT_COMPOSED_SLICES: { sliceId: string; modules: string }[] = [
  { sliceId: "2026-02-01-1530", modules: "storage+foyer" },
  { sliceId: "2026-04-01-1530", modules: "sunroom+bath+workshop" },
  { sliceId: "2026-07-01-1401", modules: "bath+reading-room" },
  { sliceId: "2026-08-01-0941", modules: "living+bath+study+reading-room" },
  { sliceId: "2026-11-01-0941", modules: "sunroom+dining-hall" },
];

/** Re-stage a composed room's furnishing the way describe-room.ts does,
 *  with the ZONE SOURCE switchable: "composition" is the renderer's
 *  precedence (and the current describe-room), "template" is the
 *  pre-2d1feed behaviour (templateZonesFor fed unconditionally). Every
 *  other argument mirrors describeRoom's staging block exactly. */
function stageFurnishingFor(
  sliceId: string,
  zoneSource: "composition" | "template",
): { kit: string; pieces: KitKind[] }[] | null {
  const skin = skinForSlice(sliceId);
  const roomId = debugSliceIdWithoutSkin(sliceId);
  const recipe = compileSpaceRecipe(roomId, WORLD_SEED);
  const { recipe: scaled, scale } = scaledRecipeFor(recipe, 0);
  const scaleFactor = scale.factor;
  const composition = compositionForRecipe(recipe, WORLD_SEED, 0);
  if (!composition) return null;
  const template = compositionTemplateFor(composition);
  const plan = roomPlanFor(
    roomId,
    scaled.width,
    scaled.size.extent,
    COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35)),
    WORLD_SEED,
    templatePlanFor(template),
  );
  const water = waterRectFor(scaled);
  const rng = createRng(deriveSubSeed(WORLD_SEED, roomId, "furniture"));
  const kitIds = [...new Set(composition.modules.flatMap((p) => p.module.kits))];
  const schematicPlacements = schematicPlacementsFor(composition.modules, scaleFactor);
  const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
  const waterArea = water
    ? (water.halfX * 2 * water.halfZ * 2) / (scaleFactor * scaleFactor)
    : 0;
  const staged = stageInteriorKits({
    rng,
    worldClass: "interior",
    archetype: recipe.archetype,
    skin,
    plan,
    comp: composeRoom(roomId, plan, scaleFactor, WORLD_SEED),
    baseArea: Math.max(0, baseArea - waterArea),
    baseExtent: recipe.size.extent,
    propScale: Math.pow(scaleFactor, PROP_SCALE_EXP),
    wallThick: ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35),
    water,
    kitIds,
    ...(schematicPlacements.length > 0
      ? { schematics: schematicPlacements }
      : {}),
    ...(composition.openFields.length > 0
      ? {
          openFields: composition.openFields.map((f) => ({
            x0: f.x0 * scaleFactor,
            z0: f.z0 * scaleFactor,
            x1: f.x1 * scaleFactor,
            z1: f.z1 * scaleFactor,
          })),
        }
      : {}),
    zones:
      zoneSource === "composition"
        ? compositionKitZonesFor(composition, plan)
        : templateZonesFor(template, plan),
    heightAt: (x, z) => terrainHeight(scaled, x, z),
  });
  const byPlacement = new Map<number, { kit: string; pieces: KitKind[] }>();
  for (const piece of staged) {
    const entry = byPlacement.get(piece.kitIndex) ?? {
      kit: piece.kitId,
      pieces: [],
    };
    entry.pieces.push(piece.kind);
    byPlacement.set(piece.kitIndex, entry);
  }
  return [...byPlacement.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);
}

describe("describeRoom furnishing = the renderer's staging (multi-module rooms)", () => {
  it("agrees with the composition-zone staging — same kits, same piece kinds, same count", () => {
    for (const { sliceId, modules } of DIVERGENT_COMPOSED_SLICES) {
      const desc = describeRoom(sliceId);
      // Guard the premise: this slice really composes several modules.
      expect(desc.layout.kind, `${sliceId} (${modules})`).toBe("modules");
      if (desc.layout.kind !== "modules") continue;
      expect(desc.layout.modules.length).toBeGreaterThan(1);
      const staged = stageFurnishingFor(sliceId, "composition");
      expect(staged).not.toBeNull();
      // Same kit ids in the same order, same piece-kind lists per
      // placement, same total piece count — the outline names exactly
      // the pieces the render stages.
      expect(desc.furnishing, `${sliceId} (${modules})`).toEqual(staged);
      const count = (f: { pieces: KitKind[] }[]) =>
        f.reduce((n, e) => n + e.pieces.length, 0);
      expect(count(desc.furnishing ?? [])).toBe(count(staged ?? []));
    }
  });

  it("would FAIL under the reverted precedence — template zones stage different kits here", () => {
    for (const { sliceId, modules } of DIVERGENT_COMPOSED_SLICES) {
      const desc = describeRoom(sliceId);
      const reverted = stageFurnishingFor(sliceId, "template");
      expect(reverted, `${sliceId} (${modules})`).not.toBeNull();
      // The reverted staging disagrees with the outline on every one of
      // these slices — that disagreement IS the drift 2d1feed fixed.
      expect(
        JSON.stringify(reverted),
        `${sliceId} (${modules}): template zones stage the same pieces as the composition zones — this slice no longer detects a precedence revert, pick another`,
      ).not.toBe(JSON.stringify(desc.furnishing));
    }
  });
});
