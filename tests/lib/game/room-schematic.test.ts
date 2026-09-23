/**
 * Tests for the RoomSchematic structure layer (v0.12-room-realism §2) —
 * the P1 living pilot (doc/design/v0.12-room-specs.md §1). The contract
 * under test:
 *
 *  - The catalogue is sound (auditSchematic: anchors/facings reference
 *    only earlier slots, the 禁止栏 holds — no bench / pool furniture /
 *    housekeeping kind in any accepts).
 *  - The six "reads as a real room" rules, as MEASUREMENTS on the staged
 *    debug-gallery living room (§2's "write the rules as tests, not
 *    aesthetic debates"): seats face the focal wall, the coffee table
 *    stands 0.35–0.5m in front of the sofa on its axis, the floor lamp
 *    sits ≤1.2m from a seat, the rug's edge covers the three seats, no
 *    piece blocks the doorway strip (≥1.4m door discipline via the shared
 *    path machinery), the coverage stays ≤65%, and the focal-axis slots
 *    compose axially (§2 rule 6, 会客 may be axial).
 *  - Purpose chain (§2 rule 2/4): the TV answers the sofa on the focal
 *    wall; tabletop pieces rest ON the coffee table (lifted, never
 *    floating).
 *  - A6: same slice ⇒ same room — staging twice from fresh streams is
 *    byte-identical.
 *  - Degradation: a placement whose required groups cannot land rolls
 *    back EVERY schematic piece and the living room falls back to its
 *    generic hero/side-kit staging — never a half-furnished room.
 *  - The no-blueprint path is byte-for-byte: the study debug room stages
 *    exactly the pieces the pre-change build rendered (golden captured
 *    from the probe at HEAD 50c8b25).
 */
import { describe, it, expect } from "vitest";
import {
  auditSchematic,
  resolveSchematic,
  roomSchematicFor,
  roomSchematics,
  schematicPlacementsFor,
} from "@/lib/game/room-schematic";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  composeRoom,
  distToPath,
  roomPlanFor,
  scaledRecipeFor,
} from "@/lib/game/room-plan";
import {
  compositionForRecipe,
  compositionKitZonesFor,
  ROOM_MODULES,
} from "@/lib/game/room-modules";
import { planArea, stageInteriorKits } from "@/lib/game/kits";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  KIT_EMPTY_FLOOR_MIN,
  KIT_PATH_CLEAR,
  KIT_WALL_CLEAR,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";
import { describeRoom } from "@/lib/game/describe-room";

/** The renderer's furniture-memo inputs, rebuilt for one debug-gallery
 *  module room (same reconstruction declarations.test.ts uses). */
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
    water: null,
    doors: [],
    kitIds: [...new Set(comp.modules.flatMap((p) => p.module.kits))],
    zones: compositionKitZonesFor(comp, plan),
    ...(extra.schematic !== false && schematics.length > 0 ? { schematics } : {}),
    heightAt: () => 0,
  });
  return { sliceId, recipe, scale, comp, plan, compo, schematics, pieces };
}

const norm = (r: number) => {
  let a = r % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
/** A piece's forward (+z local, mapped through rotY). */
const forward = (p: { rotY: number }) => ({
  x: Math.sin(p.rotY),
  z: Math.cos(p.rotY),
});

function livingPieces() {
  const { pieces, plan, compo, schematics } = stageModuleRoom("living");
  expect(schematics.map((s) => s.schematic.moduleId)).toEqual(["living"]);
  const byKind = (kind: string) => pieces.filter((p) => p.kind === kind);
  const one = (kind: string) => {
    const all = byKind(kind);
    expect(all.length, `living: expected one ${kind}`).toBeGreaterThan(0);
    return all[0];
  };
  // The living module fills the 12×12 debug room: the focal wall is the
  // far (north) face, z = extent.
  const focalZ = plan.extent;
  const centerX = 0;
  return { pieces, plan, compo, schematics, byKind, one, focalZ, centerX };
}

describe("the schematic catalogue is sound", () => {
  it("every blueprint passes the audit (references ordered, 禁止栏 holds)", () => {
    expect(roomSchematics().length).toBeGreaterThan(0);
    for (const s of roomSchematics()) {
      expect(auditSchematic(s), `${s.moduleId}: ${auditSchematic(s).join("; ")}`).toEqual([]);
    }
  });

  it("every standard module owns its blueprint (the P1 pilot went catalogue-wide)", () => {
    // P1-era pin, re-recorded for v0.12b P2b: it used to assert the living
    // was the ONLY blueprint while the pilot was the lone schematic. The
    // three lanes landed the remaining twelve, so the assertion flips to
    // the catalogue contract — all thirteen standard modules furnish by
    // their authored plan, and a module with no blueprint is the bug now.
    expect(ROOM_MODULES.length).toBeGreaterThanOrEqual(13);
    for (const m of ROOM_MODULES) {
      expect(roomSchematicFor(m.id), `${m.id}: missing blueprint`).toBeDefined();
    }
  });
});

describe("rule 1 — the seats face the focal (§2)", () => {
  it("the sofa squares on the focal wall; the TV faces the sofa; the chair faces the table", () => {
    const { one, pieces } = livingPieces();
    const sofa = one("sofa");
    // Facing the far wall = facing +z ⇒ rotY ≈ 0.
    expect(Math.abs(norm(sofa.rotY)), "sofa must face the focal wall").toBeLessThan(0.06);
    const tv = one("tv");
    const toSofa = { x: sofa.x - tv.x, z: sofa.z - tv.z };
    const len = Math.hypot(toSofa.x, toSofa.z);
    const f = forward(tv);
    expect((f.x * toSofa.x + f.z * toSofa.z) / len, "the TV must face the sofa").toBeGreaterThan(0.95);
    const chair = one("readingchair");
    const ct = one("coffeetable");
    const toTable = { x: ct.x - chair.x, z: ct.z - chair.z };
    const l2 = Math.hypot(toTable.x, toTable.z);
    const fc = forward(chair);
    expect(
      (fc.x * toTable.x + fc.z * toTable.z) / l2,
      "the armchair must face the coffee table",
    ).toBeGreaterThan(0.9);
    // the TV is the media wall's piece, not a stray: it rides a
    // schematic group with the media unit
    const tvGroup = pieces.find((p) => p.kind === "tv")!;
    expect(tvGroup.kitId).toBe("living:media");
  });
});

describe("rule 2 — the purpose chain (§2)", () => {
  it("the coffee table stands 0.35–0.5m in front of the sofa, on its axis", () => {
    const { one } = livingPieces();
    const sofa = one("sofa");
    const ct = one("coffeetable");
    // sofa half-depth 0.425, coffee-table half-depth 0.275 (authored).
    const gap = ct.z - sofa.z - 0.425 - 0.275;
    expect(gap, `coffee table gap ${gap.toFixed(3)}m`).toBeGreaterThanOrEqual(0.35);
    expect(gap, `coffee table gap ${gap.toFixed(3)}m`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(ct.x - sofa.x), "coffee table on the sofa's axis").toBeLessThan(0.2);
  });

  it("the floor lamp sits within a seat's reach (≤1.2m of the sofa center)", () => {
    const { one } = livingPieces();
    const sofa = one("sofa");
    const lamp = one("floorlamp");
    expect(dist(sofa, lamp), `lamp ${dist(sofa, lamp).toFixed(3)}m from the sofa`).toBeLessThanOrEqual(1.2);
  });

  it("the TV stands on the focal wall, on the sofa's axis", () => {
    const { one, focalZ, centerX } = livingPieces();
    const tv = one("tv");
    const media = one("mediaunit");
    const sofa = one("sofa");
    expect(focalZ - media.z, "media unit against the focal wall").toBeLessThanOrEqual(1.1);
    expect(focalZ - tv.z, "the TV at the focal wall").toBeLessThanOrEqual(1.3);
    expect(Math.abs(media.x - centerX), "the media unit on the room's axis").toBeLessThan(1.2);
    expect(Math.abs(tv.x - sofa.x), "the TV answers the sofa's axis").toBeLessThan(0.5);
  });

  it("the tabletop pieces rest ON the coffee table — lifted, never floating", () => {
    const { pieces, one } = livingPieces();
    const ct = one("coffeetable");
    const decor = pieces.filter(
      (p) => p.dy > 0 && ["vase", "frame", "candle", "bookpile", "tray"].includes(p.kind),
    );
    expect(decor.length, "the coffee table's top is dressed").toBeGreaterThanOrEqual(1);
    for (const d of decor) {
      expect(d.dy, "dressing rides the table top").toBeGreaterThan(0.3);
      expect(Math.abs(d.x - ct.x), "dressing on the table").toBeLessThan(0.35);
      expect(Math.abs(d.z - ct.z), "dressing on the table").toBeLessThan(0.3);
    }
  });
});

describe("rule 3 — social distance (§2)", () => {
  it("the grouped seats stand 0.6–2.4m apart", () => {
    const { one } = livingPieces();
    const sofa = one("sofa");
    const chair = one("readingchair");
    const d = dist(sofa, chair);
    expect(d, `seats ${d.toFixed(3)}m apart`).toBeGreaterThanOrEqual(0.6);
    expect(d, `seats ${d.toFixed(3)}m apart`).toBeLessThanOrEqual(2.4);
  });
});

describe("rule 4 — nothing blocks the doors (§2, the ≥1.4m discipline)", () => {
  it("no piece lands in the entrance strip (the shared doorway machinery)", () => {
    const { pieces, plan } = livingPieces();
    const pieceClear = KIT_PATH_CLEAR * 1; // propScale is 1 in the debug room
    const wallInset = ROOM_WALL_THICKNESS + KIT_WALL_CLEAR * 1;
    for (const p of pieces) {
      expect(
        Math.abs(p.x) < PROP_DOOR_HALF + pieceClear && p.z < PROP_DOOR_DEPTH + pieceClear,
        `${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} blocks the entrance strip`,
      ).toBe(false);
      // …and every piece stays inside the walkable footprint (shared
      // planContains margin).
      const halfW = plan.width / 2;
      expect(Math.abs(p.x) <= halfW - wallInset + 1e-9).toBe(true);
      expect(p.z >= wallInset - 1e-9 && p.z <= plan.extent - wallInset + 1e-9).toBe(true);
    }
  });

  it("the optional pieces keep off the cleared walk path (non-terminus placements)", () => {
    const { pieces, compo } = livingPieces();
    for (const p of pieces) {
      if (p.kitId.startsWith("living:seating") || p.kitId.startsWith("living:media")) continue;
      const d = distToPath(compo, p.x, p.z);
      expect(
        d >= compo.pathHalf + KIT_PATH_CLEAR - 1e-9,
        `${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} stands ${d.toFixed(2)}m off the path ` +
          `(needs ${(compo.pathHalf + KIT_PATH_CLEAR).toFixed(2)}m)`,
      ).toBe(true);
    }
  });
});

describe("rule 5 — the rug anchors the group; the floor stays ≤65% covered (§2/§6)", () => {
  it("the rug's edge covers the sofa, the coffee table and the chair", () => {
    const { one } = livingPieces();
    const rug = one("rug");
    const radius = 1.5 * rug.scale;
    for (const kind of ["sofa", "coffeetable", "readingchair"]) {
      const seat = one(kind);
      const d = dist(rug, seat);
      expect(
        d < radius - 0.2,
        `rug r=${radius.toFixed(2)} must reach the ${kind} (d=${d.toFixed(2)})`,
      ).toBe(true);
    }
  });

  it("the placed footprint discs never exceed 65% of the floor", () => {
    const { pieces, plan } = livingPieces();
    // Conservative upper bound of the machinery's accounting: one disc per
    // placed group (radius = the group's spread + its largest piece
    // radius — the true group footprint can only be smaller), rugs are
    // flat and count no disc (the machinery exempts them). Generic kit
    // placements (none in the single-module living) use their authored
    // footprints.
    const RADIUS: Record<string, number> = {
      sofa: 1.15,
      coffeetable: 0.6,
      readingchair: 0.55,
      floorlamp: 0.35,
      mediaunit: 0.85,
      tv: 0.35,
      sideboard: 0.95,
      bookshelf: 0.95,
      pedestal: 0.4,
      plant: 0.4,
      nightstand: 0.35,
      vase: 0.15,
      frame: 0.15,
      candle: 0.15,
      bookpile: 0.15,
      tray: 0.15,
    };
    let covered = 0;
    const groups = new Map<number, { x: number; z: number; r: number }>();
    for (const p of pieces) {
      if (p.kind === "rug") continue; // flat: walked over, no disc
      const g = groups.get(p.kitIndex) ?? { x: p.x, z: p.z, r: 0 };
      const spread = Math.hypot(p.x - g.x, p.z - g.z);
      g.r = Math.max(g.r, spread + (RADIUS[p.kind] ?? 0.5));
      groups.set(p.kitIndex, g);
    }
    for (const g of groups.values()) covered += Math.PI * g.r * g.r;
    const cap = (1 - KIT_EMPTY_FLOOR_MIN) * planArea(plan);
    expect(
      covered <= cap + 1e-6,
      `covered ≈${covered.toFixed(1)}m² > ${cap.toFixed(1)}m² cap`,
    ).toBe(true);
  });
});

describe("rule 6 — the living composes axially (§2)", () => {
  it("the focal-axis slots sit on the room's center axis", () => {
    const { one, centerX } = livingPieces();
    const sofa = one("sofa");
    const ct = one("coffeetable");
    const media = one("mediaunit");
    expect(Math.abs(sofa.x - centerX), "the sofa near the axis").toBeLessThan(0.7);
    expect(Math.abs(ct.x - sofa.x), "the table on the sofa").toBeLessThan(0.25);
    expect(Math.abs(media.x - sofa.x), "the media wall on the sofa").toBeLessThan(0.45);
  });
});

describe("A6 — same slice, same living room", () => {
  it("staging twice from fresh streams is byte-identical", () => {
    const a = stageModuleRoom("living").pieces;
    const b = stageModuleRoom("living").pieces;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("the seeded draws drive real variety across streams (same room per seed)", () => {
    const { schematics } = stageModuleRoom("living");
    const placement = schematics[0];
    const combos = new Set<string>();
    const sides = new Set<string>();
    let requiredAlways = true;
    for (let seed = 1; seed <= 40; seed++) {
      const groups = resolveSchematic(placement, createRng(seed), 1)!;
      const ids = groups.map((g) => g.id).sort();
      // the required core is always there…
      const core = ids.filter(
        (id) => id === "living:seating" || id === "living:media",
      );
      if (core.length !== 2) requiredAlways = false;
      combos.add(ids.join(","));
      const chair = groups
        .find((g) => g.id === "living:seating")!
        .pieces.find((p) => p.kind === "readingchair")!;
      sides.add(chair.dx > 0 ? "e" : "w");
      // …and each seed replays identically
      const again = resolveSchematic(placement, createRng(seed), 1)!;
      expect(JSON.stringify(again)).toBe(JSON.stringify(groups));
    }
    expect(requiredAlways).toBe(true);
    expect(combos.size, "the optional groups / counts / sides must vary").toBeGreaterThan(2);
    expect(sides.size, "the chair's L side must vary").toBe(2);
  });
});

describe("degradation — a blueprint that cannot land never half-furnishes", () => {
  it("a required group's failure rolls back to the generic orchestration", () => {
    const { plan, compo, recipe, scale } = stageModuleRoom("living");
    // A living module squeezed into a 0.6m strip off the plan's edge: the
    // sofa's group can never validate (planContains), the placement must
    // forfeit everything.
    const broken = [
      {
        ...schematicPlacementsFor(
          compositionForRecipe(compileSpaceRecipe("dbg-m:living"))!.modules,
          1,
        )[0],
        rect: { x0: -20, z0: -30, x1: -19.4, z1: -29.4 },
      },
    ];
    const pieces = stageInteriorKits({
      rng: createRng(deriveSubSeed(WORLD_SEED, "dbg-m:living", "furniture")),
      archetype: recipe.archetype,
      plan,
      comp: compo,
      baseExtent: recipe.size.extent,
      baseArea: planArea(plan) / (scale.factor * scale.factor),
      propScale: Math.pow(scale.factor, PROP_SCALE_EXP),
      wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
      water: null,
      doors: [],
      kitIds: ["sofa-group", "tv-corner", "reading", "clock-nook", "sideboard", "plant-pedestal"],
      zones: compositionKitZonesFor(
        compositionForRecipe(compileSpaceRecipe("dbg-m:living"))!,
        plan,
      ),
      schematics: broken,
      heightAt: () => 0,
    });
    // No schematic piece survived…
    expect(pieces.every((p) => !p.kitId.startsWith("living:"))).toBe(true);
    // …and the generic hero took the room back (placement 0 = the pinned
    // sofa-group hero kit).
    expect(pieces.length).toBeGreaterThan(0);
    const hero = pieces.filter((p) => p.kitIndex === 0);
    expect(hero.length).toBeGreaterThan(0);
    expect(hero.every((p) => p.kitId === "sofa-group")).toBe(true);
  });
});

describe("the no-blueprint path is byte-for-byte (contrast golden)", () => {
  it("the study debug room stages exactly the pre-change pieces (probe @ 50c8b25)", () => {
    // v0.13 RESAMPLE: the golden was recaptured after the module-grid snap
    // (study 10×10 → 12×12): the reading corner sits deeper and the
    // density law places two writing-desk groups where one fit before. The
    // pin's job is unchanged — the GENERIC path stages deterministically
    // — the bytes are the current no-blueprint truth.
    const { pieces } = stageModuleRoom("study", { schematic: false });
    const round = (n: number) => {
      const r = Math.round(n * 100) / 100;
      return r === 0 ? 0 : r; // normalize −0
    };
    const got = pieces.map((p) => ({ kind: p.kind, x: round(p.x), z: round(p.z) }));
    expect(got).toEqual([
      { kind: "rug", x: -0.05, z: 8.17 },
      { kind: "readingchair", x: 0, z: 8.52 },
      { kind: "nightstand", x: -0.8, z: 8.62 },
      { kind: "floorlamp", x: 0.75, z: 8.87 },
      { kind: "bookpile", x: 0.55, z: 7.97 },
      { kind: "rug", x: -4.5, z: 6.86 },
      { kind: "desk", x: -4.85, z: 6.86 },
      { kind: "chair", x: -4, z: 6.86 },
      { kind: "desklamp", x: -5, z: 6.31 },
      { kind: "bookpile", x: -4.3, z: 7.61 },
      { kind: "pedestal", x: -3.06, z: 2.95 },
      { kind: "plant", x: -2.76, z: 2.1 },
      { kind: "plant", x: -2.51, z: 3.65 },
      { kind: "rug", x: 4.5, z: 10.03 },
      { kind: "desk", x: 4.85, z: 10.03 },
      { kind: "chair", x: 4, z: 10.03 },
      { kind: "desklamp", x: 5, z: 10.58 },
      { kind: "bookpile", x: 4.3, z: 9.28 },
      { kind: "towelstack", x: -4.85, z: 6.86 },
    ]);
  });

  it("omitting the schematics input entirely yields the identical study staging", () => {
    const a = stageModuleRoom("study", { schematic: false }).pieces;
    const { plan, compo, recipe, scale } = stageModuleRoom("study");
    const b = stageInteriorKits({
      rng: createRng(deriveSubSeed(WORLD_SEED, "dbg-m:study", "furniture")),
      archetype: recipe.archetype,
      plan,
      comp: compo,
      baseExtent: recipe.size.extent,
      baseArea: planArea(plan) / (scale.factor * scale.factor),
      propScale: Math.pow(scale.factor, PROP_SCALE_EXP),
      wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
      water: null,
      doors: [],
      kitIds: ["writing-desk", "bookshelf-run", "reading", "plant-pedestal"],
      zones: compositionKitZonesFor(
        compositionForRecipe(compileSpaceRecipe("dbg-m:study"))!,
        plan,
      ),
      heightAt: () => 0,
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("the outline is same-sourced with the render", () => {
  it("describeRoom lists the living's schematic groups (not kit ids)", () => {
    const desc = describeRoom("dbg-m:living");
    expect(desc.furnishing).not.toBeNull();
    const kitIds = desc.furnishing!.map((f) => f.kit);
    expect(kitIds[0]).toMatch(/^living:/);
    const kinds = new Set(desc.furnishing!.flatMap((f) => f.pieces));
    expect(kinds.has("coffeetable" as never)).toBe(true);
    expect(kinds.has("mediaunit" as never)).toBe(true);
  });

  it("the window-avoidance note derives the feature host walls", () => {
    const bedroom = describeRoom("dbg-m:bedroom");
    // The bedroom declares a niche on its east edge → the right wall is
    // a feature host the render's window pool excludes (v0.12 rule sync).
    expect(bedroom.fixtures.featureHostWalls).toContain("right");
  });
});
