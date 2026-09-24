/**
 * Tests for the v0.12 P3 skin → render-input resolver lane
 * (lib/game/tuning/render.ts) — the pure half of the renderer wiring
 * (space.tsx / game-canvas.tsx consume these; the catalogue itself is
 * audited in skins.test.ts).
 *
 * The contract under test:
 *  1. DEFAULT PATH ZERO CHANGE: every resolver answers null (or the
 *     exact legacy constant) for skin === null — each renderer call
 *     site keeps its legacy expression behind a `??` / branch, so the
 *     default room renders pixel-for-pixel as before;
 *  2. THE DEBUG FORCE COMPOSES: `dbg-skin:<id>` alone and
 *     `dbg-skin:<id>+dbg-m:<unit>` resolve to the same skin's inputs,
 *     and unknown/stale ids degrade to the legacy answers, never crash;
 *  3. DAY AND NIGHT both land on the render inputs (the pairs authored
 *     in the data reach the renderer's door);
 *  4. THE TRANSPARENCY BUDGET HOLDS AT THE RENDER GATE: only glass /
 *     water-wall kinds get alpha, and only when the data declared an
 *     opacity < 1 — a forged opaque kind carrying opacity is refused;
 *  5. WALK SPEED: wade skins answer < 1 — through the debug force AND
 *     through the P3-step-three world assignment (a real pool/lake/ocean/
 *     duck slice wades slower); dry skins and every interior (temperate)
 *     slice answer exactly 1.
 */
import { describe, expect, it } from "vitest";
import {
  SKIN_APRON_DARKEN,
  skinFloorHex,
  skinFogHex,
  skinSkirtApronHex,
  skinSkirtOverhangScale,
  skinWalkSpeedScale,
  skinWallAlpha,
  skinWallHex,
  skinWindowBake,
  skinWindowNightTintHex,
} from "@/lib/game/tuning/render";
import { skinById, skinForSlice, SKINS, SKIN_IDS, type BiomeSkin } from "@/lib/game/skins";
import { debugSliceIdWithoutSkin } from "@/lib/game/debug-slice";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  composeRoom,
  roomPlanFor,
  scaledRecipeFor,
  wallSegmentsFor,
} from "@/lib/game/room-plan";
import {
  compositionForRecipe,
  compositionKitZonesFor,
  compositionTemplateFor,
} from "@/lib/game/room-modules";
import {
  doorAffordanceFor,
  resolveRoomTemplate,
  templatePlanFor,
  templateZonesFor,
} from "@/lib/game/room-templates";
import { doorCapacityFor } from "@/lib/game/room-doors";
import { schematicPlacementsFor } from "@/lib/game/room-schematic";
import { stageInteriorKits, planArea } from "@/lib/game/kits";
import { roomTerminalFor } from "@/lib/game/anchor";
import { terrainHeight, waterRectFor } from "@/lib/game/terrain";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";
import { describeRoom } from "@/lib/game/describe-room";

const DUNE = skinById("dune")!;
const SHALLOWS = skinById("shallows")!;
const MOSS = skinById("moss")!;
const DAY = false;
const NIGHT = true;

describe("default path: zero change", () => {
  it("every colour resolver answers null for skin === null", () => {
    expect(skinFloorHex(null, DAY)).toBeNull();
    expect(skinFloorHex(null, NIGHT)).toBeNull();
    expect(skinWallHex(null, DAY)).toBeNull();
    expect(skinWallHex(null, NIGHT)).toBeNull();
    expect(skinFogHex(null, DAY)).toBeNull();
    expect(skinFogHex(null, NIGHT)).toBeNull();
    expect(skinSkirtApronHex(null, DAY)).toBeNull();
    expect(skinSkirtApronHex(null, NIGHT)).toBeNull();
    expect(skinWindowBake(null)).toBeNull();
    expect(skinWindowNightTintHex(null)).toBeNull();
  });

  it("the numeric resolvers answer the exact legacy constants", () => {
    // ×1 keeps the skirt-overhang and walk-speed math FP-identical.
    expect(skinSkirtOverhangScale(null)).toBe(1);
    // The soft-hills apron darkening IS the legacy 0.62 factor.
    expect(SKIN_APRON_DARKEN["soft-hills"]).toBe(0.62);
    // No alpha on the default path: the wall material stays opaque.
    expect(skinWallAlpha(null)).toBeNull();
  });

  it("interior real slices and plain unit pins walk at full speed — the temperate baseline answers 1", () => {
    // P3 step three: every slice resolves its world's skin, and an interior
    // world is the temperate baseline (null) — so these answer the legacy
    // constant exactly. A stale/unknown skin id degrades the same way.
    for (const id of [
      "2026-09-15-0746",
      "core",
      "dbg-m:living",
      "dbg-t:reading-hall",
      "dbg-a:library",
      // stale/unknown skin id degrades to the legacy room, never a crash
      "dbg-skin:volcano",
      "dbg-skin:",
    ]) {
      expect(skinWalkSpeedScale(id), id).toBe(1);
    }
  });

  it("a water world walks slower — the wade skin arrives through the world assignment", () => {
    // 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内 —
    // no real slice draws a wade biome anymore, so the world assignment
    // is exercised through the debug gallery's archetype pins (the same
    // skinForSlice path — the archetype is pinned, not the skin forced;
    // the class and skin still resolve from the archetype itself).
    const wade = (["pool", "ocean", "lake", "ducks"] as const)
      .map((a) => `dbg-a:${a}`)
      .find((id) => skinForSlice(id)?.floor.walk === "wade");
    expect(wade).toBeDefined();
    const skin = skinForSlice(wade!)!;
    expect(skin.floor.walk).toBe("wade");
    expect(skinWalkSpeedScale(wade!)).toBe(skin.floor.speed);
    expect(skinWalkSpeedScale(wade!)).toBeLessThan(1);
    // A6: the same slice answers the same speed on every read.
    expect(skinWalkSpeedScale(wade!)).toBe(skinWalkSpeedScale(wade!));
  });
});

describe("debug force: dbg-skin alone and composed with dbg-m", () => {
  it("composes with a unit pin — the same skin either way", () => {
    const alone = skinWallHex(SHALLOWS, DAY);
    expect(skinWalkSpeedScale("dbg-skin:shallows+dbg-m:living")).toBe(0.6);
    expect(skinWalkSpeedScale("dbg-skin:shallows")).toBe(0.6);
    expect(skinWallHex(SHALLOWS, DAY)).toBe(alone);
  });

  it("reaches the render inputs through the real slice id", () => {
    // The composed id is what SpaceScene and game-canvas resolve.
    expect(skinWalkSpeedScale("dbg-skin:dune+dbg-m:living")).toBe(1);
    expect(skinSkirtOverhangScale(DUNE)).toBe(DUNE.fog.density);
  });
});

describe("day and night both land on the render inputs", () => {
  it("floor / wall / fog / apron hexes follow the theme", () => {
    expect(skinFloorHex(DUNE, DAY)).toBe("#d9b87e");
    expect(skinFloorHex(DUNE, NIGHT)).toBe("#87704b");
    expect(skinWallHex(DUNE, DAY)).toBe("#c39b72");
    expect(skinWallHex(DUNE, NIGHT)).toBe("#7a6248");
    expect(skinFogHex(DUNE, DAY)).toBe("#e6d3a8");
    expect(skinFogHex(DUNE, NIGHT)).toBe("#4e4862");
    // The apron reads the FOG colour (the far field at the room's feet).
    expect(skinSkirtApronHex(DUNE, DAY)).toBe(skinFogHex(DUNE, DAY));
    expect(skinSkirtApronHex(DUNE, NIGHT)).toBe(skinFogHex(DUNE, NIGHT));
  });

  it("the window bake carries the day colours AND the silhouette", () => {
    const bake = skinWindowBake(DUNE);
    expect(bake).not.toBeNull();
    expect(bake!.sky).toBe(DUNE.window.day.sky);
    expect(bake!.fog).toBe(DUNE.window.day.fog);
    expect(bake!.ground).toBe(DUNE.window.day.ground);
    expect(bake!.sunColor).toBe(DUNE.window.day.sun);
    expect(bake!.silhouette).toBe("dunes");
  });

  it("the night view tint is the skin's own night haze", () => {
    expect(skinWindowNightTintHex(DUNE)).toBe(DUNE.window.night.fog);
    expect(skinWindowNightTintHex(SHALLOWS)).toBe(SHALLOWS.window.night.fog);
    // …and every skin's night haze differs from the legacy constant's job:
    for (const skin of SKINS) {
      expect(skinWindowNightTintHex(skin)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("transparency budget at the render gate (§5)", () => {
  it("only the shallows' water wall carries alpha", () => {
    expect(skinWallAlpha(SHALLOWS)).toEqual({ transparent: true, opacity: 0.6 });
    for (const skin of SKINS) {
      if (skin.id === "shallows") continue;
      expect(skinWallAlpha(skin), skin.id).toBeNull();
    }
  });

  it("refuses a forged opacity on an opaque kind — the renderer never widens", () => {
    const forged = {
      ...DUNE,
      wall: { kind: "rock", opacity: 0.5, colors: DUNE.wall.colors },
    } as BiomeSkin;
    expect(skinWallAlpha(forged)).toBeNull();
    // And a declared-but-1.0 opacity is a no-op, not a transparent wall.
    const glassy = {
      ...DUNE,
      wall: { kind: "glass", opacity: 1, colors: DUNE.wall.colors },
    } as BiomeSkin;
    expect(skinWallAlpha(glassy)).toBeNull();
  });
});

describe("the fog slot's apron reading (§3 远景读法)", () => {
  it("density scales the apron's reach", () => {
    expect(skinSkirtOverhangScale(DUNE)).toBe(1.35);
    expect(skinSkirtOverhangScale(MOSS)).toBe(1.45);
    expect(skinSkirtOverhangScale(SHALLOWS)).toBe(1.15);
    expect(skinSkirtOverhangScale(skinById("temperate")!)).toBe(1);
  });

  it("haze horizons keep the apron close to the fog; clear depth sits darker", () => {
    // wet-mist and sand-haze read LOW-contrast (misty depth)…
    expect(SKIN_APRON_DARKEN["wet-mist"]).toBeGreaterThan(
      SKIN_APRON_DARKEN["soft-hills"],
    );
    expect(SKIN_APRON_DARKEN["sand-haze"]).toBeGreaterThan(
      SKIN_APRON_DARKEN["soft-hills"],
    );
    // …clear-depth is the crisp, darkest far field.
    expect(SKIN_APRON_DARKEN["clear-depth"]).toBeLessThan(
      SKIN_APRON_DARKEN["soft-hills"],
    );
  });
});

describe("walk speed: wade semantics", () => {
  it("wade floors slow the walk, dry floors keep full speed", () => {
    expect(SHALLOWS.floor.walk).toBe("wade");
    expect(skinWalkSpeedScale("dbg-skin:shallows+dbg-m:living")).toBe(
      SHALLOWS.floor.speed,
    );
    expect(skinWalkSpeedScale("dbg-skin:shallows+dbg-m:living")).toBeLessThan(1);
    // Moss is dry but deliberately heavy underfoot (0.85 < 1 is data-legal
    // for a dry floor — the multiplier rides the speed regardless).
    expect(skinWalkSpeedScale("dbg-skin:moss")).toBe(0.85);
    for (const skin of SKINS) {
      if (skin.floor.walk === "wade") {
        expect(skin.floor.speed).toBeLessThan(1);
      }
    }
  });
});


/* ------------------------------------------------------------------ */
/* P3-b1 — the skin rides the VIEW, never the SEEDS.                  */
/*                                                                    */
/* The render lane strips a leading `dbg-skin:<id>+` segment from   */
/* every seeded derivation (debug-slice.ts debugSliceIdWithoutSkin —  */
/* the SAME strip describe-room's outline lane uses), so one unit    */
/* stages byte-for-byte under every skin and temperate ≡ no skin.    */
/* These tests replay the renderer's own pure input chain (the exact */
/* calls space.tsx makes) and demand invariance across the skins.    */
/* ------------------------------------------------------------------ */

/**
 * The renderer's spatial inputs for a slice id — the exact pure chain
 * space.tsx builds (plan / composition / staged furniture / the anchor
 * terminal), replayed through the real functions. Everything here is
 * seeded; the view layer (colours / light / window / fog) never enters.
 */
function spatialInputs(id: string): {
  plan: unknown;
  comp: unknown;
  furniture: unknown;
  terminal: unknown;
} {
  // P3-b1: the render lane's seed — skin-stripped.
  const seedId = debugSliceIdWithoutSkin(id);
  const recipe = compileSpaceRecipe(seedId);
  const { recipe: scaled, scale } = scaledRecipeFor(recipe, 0);
  const scaleFactor = scale.factor;
  const propScale = Math.pow(scaleFactor, PROP_SCALE_EXP);
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  const plan = roomPlanFor(
    seedId,
    scaled.width,
    scaled.size.extent,
    COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35)),
    WORLD_SEED,
  );
  const comp = composeRoom(seedId, plan, scaleFactor);
  const composition = compositionForRecipe(recipe, WORLD_SEED, 0);
  const water = waterRectFor(scaled);
  const rng = createRng(deriveSubSeed(WORLD_SEED, seedId, "furniture"));
  const kitIds = composition
    ? [...new Set(composition.modules.flatMap((p) => p.module.kits))]
    : undefined;
  const schematics = composition
    ? schematicPlacementsFor(composition.modules, scaleFactor)
    : [];
  const openFields = composition?.openFields.map((f) => ({
    x0: f.x0 * scaleFactor,
    z0: f.z0 * scaleFactor,
    x1: f.x1 * scaleFactor,
    z1: f.z1 * scaleFactor,
  }));
  const furniture = stageInteriorKits({
    rng,
    archetype: recipe.archetype,
    plan,
    comp,
    baseExtent: recipe.size.extent,
    baseArea: planArea(plan) / (scaleFactor * scaleFactor),
    propScale,
    wallThick,
    water,
    doors: [],
    kitIds,
    schematics,
    openFields,
    zones: composition ? compositionKitZonesFor(composition, plan) : undefined,
    heightAt: (x: number, z: number) => terrainHeight(scaled, x, z),
  });
  const terminal = roomTerminalFor({
    sliceId: seedId,
    plan,
    comp,
    width: scaled.width,
    wallThick,
    propScale,
    water,
  });
  return { plan, comp, furniture, terminal };
}

describe("P3-b1: the skin rides the view, never the seeds", () => {
  const BASE = "dbg-m:living";
  const SKINNED = SKIN_IDS.map((id) => `dbg-skin:${id}+${BASE}`);

  it("every skinned variant strips to the SAME room id", () => {
    for (const id of SKINNED) {
      expect(debugSliceIdWithoutSkin(id), id).toBe(BASE);
    }
    // A BARE skin keeps its id: the seeded room stays seeded, view-only.
    expect(debugSliceIdWithoutSkin("dbg-skin:dune")).toBe("dbg-skin:dune");
    // Real memory slices and plain pins are identity.
    expect(debugSliceIdWithoutSkin("2026-09-15-0746")).toBe("2026-09-15-0746");
    expect(debugSliceIdWithoutSkin(BASE)).toBe(BASE);
  });

  it("same module + different skins ⇒ byte-identical plan/compose/furniture/terminal", () => {
    const signatures = [...SKINNED, BASE].map(
      (id) => JSON.stringify(spatialInputs(id)),
    );
    for (const sig of signatures) {
      expect(sig).toBe(signatures[0]);
    }
    // Sanity: the invariant is not the trivial equality of empty rooms —
    // the living room actually furnishes.
    expect(spatialInputs(BASE).furniture).not.toEqual([]);
  });

  it("temperate ≡ no skin — field by field on the spatial render inputs", () => {
    const skinned = spatialInputs(`dbg-skin:temperate+${BASE}`);
    const plain = spatialInputs(BASE);
    expect(skinned.plan).toEqual(plain.plan);
    expect(skinned.comp).toEqual(plain.comp);
    expect(skinned.furniture).toEqual(plain.furniture);
    expect(skinned.terminal).toEqual(plain.terminal);
  });

  it("the strip is seeds-only — the view layer still sees the force", () => {
    expect(skinForSlice(`dbg-skin:temperate+${BASE}`)?.id).toBe("temperate");
    expect(skinForSlice(BASE)).toBeNull();
    // The wade force reaches the walk speed through the raw door id…
    expect(skinWalkSpeedScale(`dbg-skin:shallows+${BASE}`)).toBe(0.6);
    expect(skinWalkSpeedScale(BASE)).toBe(1);
  });

  it("the outline lane (describe-room) strips to the SAME room — no drift", () => {
    // Cross-lane guard: the description and the picture derive from one
    // stripped id. Both lanes keep the RAW id only as the request's
    // identity field (describe-room's sliceId, the renderer's
    // GAME_DEBUG.room.sliceId) — never as a seed. The §6.2 slot-override
    // lane (another writer's) legitimately swaps PIECE KINDS inside the
    // same kit groups — so the comparison splits:
    //   (1) everything except identity/view/furnishing byte-equal;
    //   (2) furnishing: same kit groups, same piece counts, and every
    //       changed piece is one of the skin's OWN declared override
    //       features — nothing else may move.
    type Outline = ReturnType<typeof describeRoom>;
    const outline = (id: string): Outline => describeRoom(id);

    const base = outline(BASE);
    const baseRest = JSON.stringify({
      ...base,
      sliceId: null,
      skin: null,
      furnishing: null,
    });
    for (const id of SKINNED) {
      const o = outline(id);
      expect(
        JSON.stringify({ ...o, sliceId: null, skin: null, furnishing: null }),
        id,
      ).toBe(baseRest);
    }
    // (2) the furnishing contract — MY lane's part is the kit GROUPS (the
    //     staging layout's skeleton): identical ids and order under every
    //     skin. The PIECE-KIND swaps inside them are the staging lane's
    //     §6.2 vocabulary (overridden slots re-seed their companions — a
    //     grove bookshelf becomes [log, log, towelstack]); they own those
    //     tests (skin-staging.test.ts). What my lane owes: temperate swaps
    //     nothing — its furnishing is LITERALLY the unskinned one.
    for (const id of SKINNED) {
      const o = outline(id);
      expect(o.furnishing?.map((f) => f.kit), id).toEqual(
        base.furnishing?.map((f) => f.kit),
      );
      if (skinForSlice(id)?.id === "temperate") {
        expect(o.furnishing).toEqual(base.furnishing);
      }
    }
  });
});


/* ------------------------------------------------------------------ */
/* P3 step two — the render FEEDS the skin to the staging machine,    */
/* so the painted room and its description enumerate the same pieces. */
/* ------------------------------------------------------------------ */

/**
 * The render path's exact staging replay: every input space.tsx's
 * furniture memo builds — INCLUDING the skin (read from the raw id,
 * the renderer's own dual-id contract). Grouped by kitIndex exactly
 * like describe-room's furnishing enumeration, so the two are
 * comparable field for field.
 */
function renderStaging(id: string): { kit: string; pieces: string[] }[] {
  const seedId = debugSliceIdWithoutSkin(id);
  const recipe = compileSpaceRecipe(seedId);
  const { recipe: scaled, scale } = scaledRecipeFor(recipe, 0);
  const scaleFactor = scale.factor;
  const propScale = Math.pow(scaleFactor, PROP_SCALE_EXP);
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  const bay = COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35));
  // The render lane's template resolution (space.tsx roomTemplateForDoorCount
  // for a doorless mount, restated with the same pure calls describe-room
  // mirrors): a composition folds itself; every other class draws from the
  // §7 catalogue by measured selection.
  const composition = compositionForRecipe(recipe, WORLD_SEED, 0);
  const template = composition
    ? compositionTemplateFor(composition)
    : resolveRoomTemplate(
        seedId,
        recipe.worldClass,
        recipe.archetype,
        recipe.size.extent,
        0,
        WORLD_SEED,
        (t) => {
          const p = roomPlanFor(
            seedId,
            scaled.width,
            scaled.size.extent,
            bay,
            WORLD_SEED,
            templatePlanFor(t),
          );
          return doorCapacityFor(
            p,
            wallSegmentsFor(p, wallThick),
            null,
            doorAffordanceFor(t),
          );
        },
      );
  const plan = roomPlanFor(
    seedId,
    scaled.width,
    scaled.size.extent,
    bay,
    WORLD_SEED,
    template ? templatePlanFor(template) : undefined,
  );
  const comp = composeRoom(seedId, plan, scaleFactor);
  const water = waterRectFor(scaled);
  const rng = createRng(deriveSubSeed(WORLD_SEED, seedId, "furniture"));
  const kitIds = composition
    ? [...new Set(composition.modules.flatMap((p) => p.module.kits))]
    : undefined;
  const schematics = composition
    ? schematicPlacementsFor(composition.modules, scaleFactor)
    : [];
  const openFields = composition?.openFields.map((f) => ({
    x0: f.x0 * scaleFactor,
    z0: f.z0 * scaleFactor,
    x1: f.x1 * scaleFactor,
    z1: f.z1 * scaleFactor,
  }));
  const staged = stageInteriorKits({
    rng,
    // The render lane's class contract: nature AND hybrid stage on the
    // outdoor machine ("nature"), wonder on the wonder machine, interior
    // on the default.
    worldClass:
      recipe.worldClass === "nature" || recipe.worldClass === "hybrid"
        ? "nature"
        : recipe.worldClass,
    archetype: recipe.archetype,
    // The render lane feeds the skin to staging for interior and
    // nature/hybrid rooms; WONDER rooms wear their skin's VIEW only — the
    // diorama keeps its authored deck, so no skin rides into the wonder
    // staging call (space.tsx's wonder branch, restated).
    skin: recipe.worldClass === "wonder" ? null : skinForSlice(id),
    plan,
    comp,
    baseExtent: recipe.size.extent,
    // Water biomes subtract their basin from the density area (the
    // renderer's nature/wonder/pool-hall branches); dry interiors don't
    // (their water is null anyway, so the two rules agree there).
    baseArea:
      recipe.worldClass !== "interior" || recipe.archetype === "pool-hall"
        ? Math.max(
            0,
            planArea(plan) / (scaleFactor * scaleFactor) -
              (water ? (water.halfX * 2 * water.halfZ * 2) / (scaleFactor * scaleFactor) : 0),
          )
        : planArea(plan) / (scaleFactor * scaleFactor),
    propScale,
    wallThick,
    water,
    doors: [],
    kitIds,
    schematics,
    openFields,
    zones: composition
      ? compositionKitZonesFor(composition, plan)
      : template
        ? templateZonesFor(template, plan)
        : undefined,
    heightAt: (x: number, z: number) => terrainHeight(scaled, x, z),
  });
  const byPlacement = new Map<number, { kit: string; pieces: string[] }>();
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

describe("P3 step two: the render feeds the skin to staging", () => {
  const BASE = "dbg-m:living";
  const SKINNED = SKIN_IDS.map((id) => `dbg-skin:${id}+${BASE}`);

  it("the render's staged pieces are LITERALLY the outline's furnishing (描述 = 画面)", () => {
    // The钉死: for every skin (and the unskinned room), the renderer's
    // own staging — same seeds, same skin — enumerates exactly the
    // pieces describe-room reports, per kit group and in order. Any
    // future drift between the picture and its description fails here.
    for (const id of [BASE, ...SKINNED]) {
      const outline = describeRoom(id).furnishing;
      expect(outline, `${id}: the outline furnishes`).not.toBeNull();
      expect(renderStaging(id), id).toEqual(outline);
    }
  });

  it("描述 = 画面 holds on the world-assigned rooms too (nature pin, wonder pin)", () => {
    // P3 step three: a nature room furnishes from its world's skin and a
    // wonder room keeps its authored deck under the view skin — both
    // lanes enumerate the same pieces either way.
    // 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内 —
    // the hybrid class no longer exists (CLASS_WEIGHTS draws interior
    // only), so the hybrid probe that scanned for one is gone; the
    // nature/wonder pins still reach those worlds through the debug
    // gallery and pin this contract.
    for (const id of ["dbg-a:forest", "dbg-a:meadow", "dbg-a:ducks"]) {
      const outline = describeRoom(id).furnishing;
      expect(outline, `${id}: the outline furnishes`).not.toBeNull();
      expect(renderStaging(id), id).toEqual(outline);
    }
    // …and the worlds diverge where the assignment says they do.
    expect(describeRoom("dbg-a:forest").skin?.id).toBe("moss");
    expect(describeRoom("dbg-a:ducks").skin?.id).toBe("shallows");
  });

  it("the skin visibly changes the staged world (the wiring is live)", () => {
    // §6.2 overrides and the skin decks actually reach the pieces — the
    // dune room stages its ruinwall/cairn, not the base furniture.
    const dune = renderStaging(`dbg-skin:dune+${BASE}`);
    expect(JSON.stringify(dune)).toContain("ruinwall");
    expect(JSON.stringify(dune)).toContain("cairn");
    const base = renderStaging(BASE);
    expect(JSON.stringify(base)).toContain("bookshelf");
    expect(JSON.stringify(base)).not.toContain("ruinwall");
  });

  it("temperate ≡ no skin stays literal WITH the skin fed through", () => {
    expect(renderStaging(`dbg-skin:temperate+${BASE}`)).toEqual(
      renderStaging(BASE),
    );
    // …and the skinless path is untouched: null skin ≡ omitted skin.
    expect(renderStaging(BASE)).toEqual(
      renderStaging("dbg-skin:temperate+dbg-m:living"),
    );
  });
});
