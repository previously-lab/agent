/**
 * v0.12 declarations-lane regression tests — the "declared but never
 * landed" audit (doc/design/v0.12-room-inventory.md) as contracts:
 *
 *  - A rolled-back schematic still STAGES the module's pinned heroKit
 *    (the bedroom lost its bed, the kitchen its table to a single failed
 *    first draw — kits.ts now redraws a failed hero inside its zone, and
 *    the zones were re-authored deep enough to land on the first
 *    candidate). v0.12b P2b note: with every heroKit-pinning module
 *    schematic-owned, this bar is asserted on the rollback path (the
 *    blueprint withheld), not in the gallery room.
 *  - Declared wall/floor features REACH a host in both room orientations:
 *    the dollhouse cutaway silks one or two wall roles per orientation,
 *    so niche/pilaster slots relocate to a legal full-height run instead
 *    of vanishing (bedroom niche at the south-door orientation, study
 *    pilasters at the north-door one), and the pool-deck water-rill's
 *    declared band clears the basin it used to straddle.
 *  - The shelf wall renders as GEOMETRY: every full-height run of a
 *    "shelf"-register module carries the bookcase bays (the register was
 *    a colour only — the study and reading room never grew their book
 *    walls).
 *  - THE DECK NEVER EMPTIES (kits.ts's 牌堆非空回退): a whitelist whose ∩
 *    with the archetype gating draws nothing falls back to the gated deck
 *    instead of handing the room to the archetype's bare legacy管线
 *    (the bath rendered as a pure pool basin).
 *  - §6.4 whitelist hygiene: the park bench, the housekeeping trolley and
 *    the banquet chair stacks keep out of the rooms they read wrong in.
 */
import { describe, it, expect } from "vitest";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  scaledRecipeFor,
  roomPlanFor,
  composeRoom,
  wallSegmentsFor,
  wallRoleFor,
  scaledWallHeight,
} from "@/lib/game/room-plan";
import {
  ROOM_MODULES,
  compositionForRecipe,
  compositionKitZonesFor,
  compositionTemplateFor,
} from "@/lib/game/room-modules";
import { stageInteriorKits, planArea } from "@/lib/game/kits";
import {
  roomSchematicFor,
  schematicPlacementsFor,
} from "@/lib/game/room-schematic";
import { waterRectFor } from "@/lib/game/terrain";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
  WALL_SILL_HEIGHT,
} from "@/lib/game/tuning/room";
import { ARCHETYPES } from "@/lib/game/space-types";
import {
  placeRoomDoors,
  hostableWallsFor,
  splitWallsForDoors,
  wallFacesCamera,
} from "@/lib/game/room-doors";
import { buildRoomFeatures } from "@/components/game/space";

/** The renderer's furniture memo inputs, rebuilt for one debug-gallery
 *  module room (the single-module composition the gallery forces). Pass
 *  `{ schematic: false }` to withhold the module's blueprint and stage the
 *  generic fallback path (the rollback deck the pinned heroKit serves). */
function stageModuleRoom(moduleId: string, extra: { schematic?: boolean } = {}) {
  const sliceId = `dbg-m:${moduleId}`;
  const recipe = compileSpaceRecipe(sliceId);
  const { recipe: scaledRecipe, scale } = scaledRecipeFor(recipe);
  const comp = compositionForRecipe(recipe)!;
  const plan = roomPlanFor(
    sliceId,
    scaledRecipe.width,
    scaledRecipe.size.extent,
    COLONNADE_BAY,
    WORLD_SEED,
    { plan: "rect" },
  );
  const compo = composeRoom(sliceId, plan, 1);
  const zones = compositionKitZonesFor(comp, plan);
  const kitIds = [...new Set(comp.modules.flatMap((p) => p.module.kits))];
  const water = waterRectFor(scaledRecipe);
  const schematics = schematicPlacementsFor(comp.modules, scale.factor);
  const pieces = stageInteriorKits({
    rng: createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture")),
    archetype: recipe.archetype,
    plan,
    comp: compo,
    baseExtent: recipe.size.extent,
    baseArea: planArea(plan) / (scale.factor * scale.factor),
    propScale: Math.pow(scale.factor, PROP_SCALE_EXP),
    wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
    water,
    doors: [],
    kitIds,
    zones,
    ...(extra.schematic !== false && schematics.length > 0 ? { schematics } : {}),
    heightAt: () => 0,
  });
  return { recipe, scaledRecipe, scale, comp, plan, zones, kitIds, water, pieces, schematics };
}

/** The renderer's feature-builder inputs for the same room, at one room
 *  orientation (dir = the corridor side the door hangs on). */
function featuresFor(
  moduleId: string,
  dir: 1 | -1,
): ReturnType<typeof buildRoomFeatures> {
  const { recipe, scaledRecipe, scale, comp, plan, water } =
    stageModuleRoom(moduleId);
  const template = compositionTemplateFor(comp);
  const walls = wallSegmentsFor(
    plan,
    ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
  );
  const hostable = hostableWallsFor(plan, walls, 1);
  const layout = placeRoomDoors(
    `dbg-m:${moduleId}`,
    plan,
    walls,
    hostable,
    0,
    WORLD_SEED,
    { walls: template.doorWalls },
  );
  const wallRuns = splitWallsForDoors(walls, layout.doors);
  const wallHeight = scaledWallHeight(scale.factor);
  const wallHeights = wallRuns.map(({ wall }) =>
    wall.entrance || !wallFacesCamera(plan, wall, dir)
      ? wallHeight
      : Math.min(wallHeight, WALL_SILL_HEIGHT),
  );
  return buildRoomFeatures({
    template,
    plan,
    walls,
    wallRuns,
    wallHeights,
    wallHeight,
    wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
    doors: layout.doors,
    ground: ARCHETYPES[recipe.archetype].ground,
    water,
  });
}

describe("declared heroKits land (v0.12 ①)", () => {
  // v0.12b P2b re-record: the pinned set is EMPTY, and that is what the
  // first test locks. Every module that pins a heroKit went schematic-
  // owned when the three lanes landed their blueprints — an owned module
  // furnishes by slot placement, its generic hero stands down, and the
  // pinned heroKit survives only as the ROLLBACK deck (a rolled-back
  // schematic falls back to it). The "declared but never landed" audit's
  // bar now lives on that rollback path: living → sofa-group is asserted
  // in room-schematic.test.ts "degradation"; the kitchen covers the
  // service family below.
  const pinned = ROOM_MODULES.filter((m) => m.heroKit && !roomSchematicFor(m.id));
  const heroes = ROOM_MODULES.filter((m) => m.heroKit);

  it("every heroKit-pinning module is schematic-owned (the pinned list stands vacated)", () => {
    expect(heroes.length).toBeGreaterThan(0);
    expect(
      pinned.map((m) => m.id),
      `${pinned.map((m) => m.id).join(",")} still furnish by their heroKit`,
    ).toEqual([]);
  });

  it("a rolled-back schematic still stages the module's pinned heroKit", () => {
    // The kitchen with its blueprint withheld: the generic orchestration
    // owns the room again and the pinned dining table must land — what
    // must never happen is the room opening with no heroKit at all (the
    // bedroom lost its bed, the kitchen its table — the audit's origin).
    const { pieces } = stageModuleRoom("kitchen", { schematic: false });
    const staged = pieces.filter((p) => p.kitId === "dining");
    expect(
      staged.length,
      "kitchen: pinned heroKit dining never staged on rollback",
    ).toBeGreaterThan(0);
  });

  it("the schematic-owned living stages its blueprint, not its heroKit", () => {
    const { pieces, schematics } = stageModuleRoom("living");
    expect(schematics.map((s) => s.schematic.moduleId)).toEqual(["living"]);
    const kinds = new Set(pieces.map((p) => p.kind));
    // §1's required slots: sofa + coffee table + rug + reading chair +
    // floor lamp + media unit + TV.
    for (const kind of [
      "sofa",
      "coffeetable",
      "rug",
      "readingchair",
      "floorlamp",
      "mediaunit",
      "tv",
    ]) {
      expect(kinds.has(kind as never), `living: missing ${kind}`).toBe(true);
    }
    // 禁止栏: the park-bench vocabulary never enters the living room.
    expect(kinds.has("bench" as never)).toBe(false);
    expect(kinds.has("coatstand" as never)).toBe(false);
    // The schematic's groups own placement 0.
    expect(pieces[0]?.kitId).toMatch(/^living:/);
  });

  it("the bedroom's bed is the composed centrepiece, not a side kit", () => {
    const { pieces } = stageModuleRoom("bedroom");
    const kinds = pieces.filter((p) => p.kitIndex === 0).map((p) => p.kind);
    expect(kinds).toContain("bed");
    expect(pieces.some((p) => p.kind === "sofa" && p.kitIndex !== 0)).toBe(false);
  });
});

describe("declared features land in both orientations (v0.12 ②)", () => {
  it("the bedroom niche builds whichever side of the corridor the room hangs on", () => {
    const north = featuresFor("bedroom", 1);
    const south = featuresFor("bedroom", -1);
    expect(north.niches.length + south.niches.length).toBeGreaterThan(0);
    // Both orientations now resolve the slot (declared role or fallback).
    expect(north.niches).toHaveLength(1);
    expect(south.niches).toHaveLength(1);
  });

  it("the study pilasters build in the north-door orientation too", () => {
    const north = featuresFor("study", 1);
    const south = featuresFor("study", -1);
    expect(north.pilasters.length).toBeGreaterThan(0);
    expect(south.pilasters.length).toBeGreaterThan(0);
  });

  it("the pool-deck water-rill clears the basin at both orientations", () => {
    const north = featuresFor("pool-deck", 1);
    const south = featuresFor("pool-deck", -1);
    expect(north.rill).not.toBeNull();
    expect(south.rill).not.toBeNull();
    const { water } = stageModuleRoom("pool-deck");
    expect(water).not.toBeNull();
    for (const rill of [north.rill!, south.rill!]) {
      const overlap =
        Math.abs((rill.x0 + rill.x1) / 2 - water!.cx) <
          (rill.x1 - rill.x0) / 2 + water!.halfX &&
        Math.abs((rill.z0 + rill.z1) / 2 - water!.cz) <
          (rill.z1 - rill.z0) / 2 + water!.halfZ;
      expect(overlap).toBe(false);
    }
  });
});

describe("the deck never empties (v0.12 ④)", () => {
  it("falls back to the gated deck when the whitelist ∩ gating draws nothing", () => {
    // "dining" is not pool-hall eligible: the whitelist filter alone
    // empties the deck. The fallback relaxes ONLY the whitelist — the
    // room still furnishes from the pool hall's own vocabulary.
    const { plan, comp, zones, kitIds, water, scale, recipe } =
      stageModuleRoom("bath");
    const pieces = stageInteriorKits({
      rng: createRng(deriveSubSeed(WORLD_SEED, "dbg-m:bath", "furniture")),
      archetype: recipe.archetype,
      plan,
      comp: composeRoom("dbg-m:bath", plan, 1),
      baseExtent: recipe.size.extent,
      baseArea: planArea(plan) / (scale.factor * scale.factor),
      propScale: Math.pow(scale.factor, PROP_SCALE_EXP),
      wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
      water,
      doors: [],
      kitIds: ["dining"],
      zones,
      heightAt: () => 0,
    });
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every((p) => p.kitId !== "dining")).toBe(true);
    expect(kitIds).toContain("lockers");
  });

  it("the bath stages its changing-room kits on the dry rims", () => {
    const { pieces } = stageModuleRoom("bath");
    const kinds = new Set(pieces.map((p) => p.kind));
    expect(kinds.has("lockerrow")).toBe(true);
    expect(kinds.has("bench")).toBe(true);
    expect(
      kinds.has("towelrail") || kinds.has("towelstack") || kinds.has("bucket"),
    ).toBe(true);
    // No piece stands in the basin.
    const { water } = stageModuleRoom("bath");
    for (const p of pieces) {
      const inWater =
        Math.abs(p.x - water!.cx) < water!.halfX &&
        Math.abs(p.z - water!.cz) < water!.halfZ;
      expect(inWater).toBe(false);
    }
  });
});

describe("§6.4 whitelist hygiene (v0.12 ⑤)", () => {
  it("keeps the park bench out of the living room", () => {
    const living = ROOM_MODULES.find((m) => m.id === "living")!;
    expect(living.kits).not.toContain("coat-bench");
  });

  it("keeps the housekeeping trolley out of the foyer and the dining hall", () => {
    for (const id of ["foyer", "dining-hall"]) {
      const m = ROOM_MODULES.find((r) => r.id === id)!;
      expect(m.kits).not.toContain("housekeeping");
    }
  });

  it("keeps the banquet chair stacks out of the luggage room", () => {
    const storage = ROOM_MODULES.find((m) => m.id === "storage")!;
    expect(storage.kits).not.toContain("chair-stack");
  });

  it("still leaves every module a short whitelist (§6 少而准)", () => {
    for (const m of ROOM_MODULES) {
      expect(m.kits.length).toBeGreaterThanOrEqual(2);
      expect(m.kits.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("shelf-register modules carry their book walls (v0.12 ③)", () => {
  it("study and reading-room declare the shelf register", () => {
    for (const id of ["study", "reading-room"]) {
      const m = ROOM_MODULES.find((r) => r.id === id)!;
      expect(m.wall).toBe("shelf");
    }
  });

  it("a full-height run exists for the book wall at both orientations", () => {
    // The render builds ShelfWallRun on exactly the full-height runs of a
    // shelf-registered module (single-module rooms attribute every span to
    // the module's own register) — so the pure side asserts the host
    // exists whichever side of the corridor the room hangs on.
    for (const id of ["study", "reading-room"]) {
      for (const dir of [1, -1] as const) {
        const { scale, plan } = stageModuleRoom(id);
        const walls = wallSegmentsFor(
          plan,
          ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
        );
        const wallHeight = scaledWallHeight(scale.factor);
        const full = walls.filter(
          (w) => w.entrance || !wallFacesCamera(plan, w, dir),
        );
        expect(
          full.length,
          `${id} dir=${dir}: no full-height run for the book wall`,
        ).toBeGreaterThan(0);
        expect(wallHeight).toBeGreaterThan(0);
      }
    }
  });
});
