/**
 * Tests for the v0.12 P3 skin STAGING wiring — the orchestration side of
 * the biome skins (lib/game/skins.ts stays data + queries; this file is
 * the contract for its two staging consumers):
 *
 *  - §6.2 slot overrides (LINE ONE): resolveSchematic asks the skin before
 *    seeding a slot's kind — an overridden role draws the skin's
 *    environment kind; the slot's authored anchor, facing and clearance
 *    ride unchanged (the seeded pick's draw is still consumed, so every
 *    NON-overridden slot — and the whole default path — stays byte-for-byte
 *    the legacy resolution);
 *  - the GENERAL HOST-DROP: a lifted slot (tabletop dressing) whose
 *    relative host's kind was replaced stages NOTHING — the authored top
 *    may not exist on the replacement (a fountain is not a coffee table),
 *    so no piece may hang in the air (I2). Any override × any lifted
 *    dependent resolves by this one rule;
 *  - skin furnishing decks (LINE TWO): a skin that DECLARES its decks
 *    takes the room's draw vocabulary over through the EXPLICIT path —
 *    nature kits stage inside an interior room only under such a skin,
 *    while kitsFor's worldClasses gate is left untouched (no nature kit
 *    ever appears on the default interior path), and the shore/water rule
 *    still binds. The BASELINE (temperate) omits its decks: 无皮肤 ≡ 温带,
 *    byte-for-byte;
 *  - A6: same slice + same skin ⇒ byte-identical staging and outline.
 */
import { describe, expect, it } from "vitest";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  composeRoom,
  planContains,
  roomPlanFor,
  scaledRecipeFor,
  type RoomPlan,
} from "@/lib/game/room-plan";
import {
  KITS,
  kitsFor,
  planArea,
  stageInteriorKits,
  type KitWater,
  type StagedKitPiece,
} from "@/lib/game/kits";
import {
  resolveSchematic,
  roomSchematicFor,
  schematicPlacementsFor,
  type SchematicPlacement,
} from "@/lib/game/room-schematic";
import {
  compositionForRecipe,
  compositionKitZonesFor,
} from "@/lib/game/room-modules";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { skinById, skinForSlice, type BiomeSkin } from "@/lib/game/skins";
import { describeRoom } from "@/lib/game/describe-room";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";

const SHALLOWS = skinById("shallows")!;
const GROVE = skinById("grove")!;
const DUNE = skinById("dune")!;
/** The baseline skin — no slotOverrides and no decks, so it must stage
 *  byte-for-byte like the legacy no-skin path (无皮肤 ≡ 温带). */
const TEMPERATE = skinById("temperate")!;

// The world-owning skins' decks (the skins catalogue test pins them
// declared and non-empty).
const SHALLOWS_DECKS = SHALLOWS.furnishing.decks!;
const DUNE_DECKS = DUNE.furnishing.decks!;

/** The living tabletop slot's accepts — the lifted dressing that must not
 *  dangle when its host is replaced. These kinds appear ONLY in that slot
 *  across the living blueprint. */
const TABLETOP_ACCEPTS: readonly string[] = [
  "vase",
  "frame",
  "candle",
  "bookpile",
  "tray",
];

const NATURE_KIT_IDS: readonly string[] = KITS.filter((k) =>
  k.worldClasses.includes("nature"),
).map((k) => k.id);

/** The living blueprint against a plain 6×6 module rect — enough for the
 *  resolve-level contracts (kind / geometry), independent of a
 *  composition. */
function livingPlacement(): SchematicPlacement {
  return {
    schematic: roomSchematicFor("living")!,
    rect: { x0: -3, z0: 0, x1: 3, z1: 6 },
    exposed: { n: true, s: false, e: true, w: true },
    scale: 1,
  };
}

/** The family test's exact reconstruction (schematics-residential.test.ts)
 *  — the renderer's arguments — plus an optional skin. */
function stageLiving(opts: { skin?: BiomeSkin | null; seed?: number }): {
  pieces: StagedKitPiece[];
  plan: RoomPlan;
} {
  const sliceId = "dbg-m:living";
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
  const rng = createRng(
    opts.seed ?? deriveSubSeed(WORLD_SEED, sliceId, "furniture"),
  );
  const pieces = stageInteriorKits({
    rng,
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
    schematics: schematicPlacementsFor(comp.modules, scale.factor),
    ...(opts.skin ? { skin: opts.skin } : {}),
    heightAt: () => 0,
  });
  return { pieces, plan };
}

/** The kits.test.ts plain-room harness — a bare rect plan, no composition,
 *  no zones, no schematics: the deck selection under test is the only
 *  variable. */
function stagePlain(opts: {
  seed: number;
  skin?: BiomeSkin | null;
  water?: KitWater | null;
}): StagedKitPiece[] {
  const sliceId = `skin-plain-${opts.seed}`;
  const extent = 96;
  const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
  const comp = composeRoom(sliceId, plan, 1);
  return stageInteriorKits({
    rng: createRng(opts.seed),
    archetype: "hotel-room",
    plan,
    comp,
    baseArea: planArea(plan),
    baseExtent: extent,
    propScale: 1,
    wallThick: ROOM_WALL_THICKNESS,
    water: opts.water ?? null,
    ...(opts.skin ? { skin: opts.skin } : {}),
    heightAt: () => 0,
  });
}

describe("§6.2 slot overrides — the overridden slot draws the skin's kind", () => {
  it("the required coffeetable slot becomes the shallows' small pool", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const groups = resolveSchematic(
        livingPlacement(),
        createRng(seed),
        1,
        SHALLOWS,
      );
      expect(groups).not.toBeNull();
      const seating = groups!.find((g) => g.id === "living:seating")!;
      expect(seating.pieces.some((p) => p.kind === "fountain")).toBe(true);
      expect(seating.pieces.some((p) => p.kind === "coffeetable")).toBe(false);
    }
  });

  it("the required rug slot becomes the grove's moss bed", () => {
    for (const seed of [11, 12, 13]) {
      const groups = resolveSchematic(
        livingPlacement(),
        createRng(seed),
        1,
        GROVE,
      )!;
      const seating = groups.find((g) => g.id === "living:seating")!;
      expect(seating.pieces.some((p) => p.kind === "moss")).toBe(true);
      expect(seating.pieces.some((p) => p.kind === "rug")).toBe(false);
    }
  });

  it("optional overridden groups draw the override whenever they place", () => {
    // grove: bookshelf → log; shallows: plant → reeds. The groups are
    // chance-gated — sweep seeds and assert the conditional.
    let sawShelf = 0;
    let sawPlant = 0;
    for (let seed = 100; seed < 160; seed++) {
      const groveGroups = resolveSchematic(
        livingPlacement(),
        createRng(seed),
        1,
        GROVE,
      )!;
      const shelf = groveGroups.find((g) => g.id === "living:shelf");
      if (shelf) {
        sawShelf += 1;
        expect(shelf.pieces.every((p) => p.kind === "log")).toBe(true);
      }
      const shallowsGroups = resolveSchematic(
        livingPlacement(),
        createRng(seed),
        1,
        SHALLOWS,
      )!;
      const plant = shallowsGroups.find((g) => g.id === "living:plant");
      if (plant) {
        sawPlant += 1;
        expect(plant.pieces.some((p) => p.kind === "reeds")).toBe(true);
        expect(plant.pieces.every((p) => p.kind !== "plant")).toBe(true);
      }
    }
    expect(sawShelf).toBeGreaterThan(0);
    expect(sawPlant).toBeGreaterThan(0);
  });

  it("stages the replacement through the shared clearance machinery at the authored spot", () => {
    const legacy = stageLiving({});
    const skinned = stageLiving({ skin: SHALLOWS });
    const fountain = skinned.pieces.find((p) => p.kind === "fountain");
    const coffeetable = legacy.pieces.find((p) => p.kind === "coffeetable");
    expect(fountain).toBeDefined();
    expect(coffeetable).toBeDefined();
    // Same stream, same slot: the replacement sits exactly where the
    // seeded coffee table would have stood.
    expect(fountain!.x).toBeCloseTo(coffeetable!.x, 10);
    expect(fountain!.z).toBeCloseTo(coffeetable!.z, 10);
    expect(fountain!.rotY).toBeCloseTo(coffeetable!.rotY, 10);
    // …and every staged piece is inside the walkable footprint.
    for (const p of skinned.pieces) {
      expect(planContains(skinned.plan, p.x, p.z, 0)).toBe(true);
    }
  });
});

describe("the replacement keeps the slot's authored staging semantics", () => {
  it("anchor, facing, footprint and lift are byte-identical — kinds swap, the host's dressing drops", () => {
    // The shallows' kind swaps, by kind name (each swapped kind appears
    // only in its own slot's accepts across the living blueprint).
    const KIND_SWAP: Record<string, string> = {
      coffeetable: "fountain",
      plant: "reeds",
    };
    for (const seed of [301, 302, 303]) {
      const legacy = resolveSchematic(livingPlacement(), createRng(seed), 1)!;
      const skinned = resolveSchematic(
        livingPlacement(),
        createRng(seed),
        1,
        SHALLOWS,
      )!;
      expect(skinned.map((g) => g.id)).toEqual(legacy.map((g) => g.id));
      for (let i = 0; i < legacy.length; i++) {
        const lg = legacy[i];
        const sg = skinned[i];
        expect({ ...sg, pieces: [] }).toEqual({ ...lg, pieces: [] });
        // The skinned pieces ARE the legacy pieces — the overridden kinds
        // swapped, the host's lifted dressing skin-dropped. Every
        // surviving piece carries its legacy geometry (offsets, facing,
        // lift, scale) byte-for-byte.
        const expected = lg.pieces
          .filter((p) => !TABLETOP_ACCEPTS.includes(p.kind))
          .map((p) => ({ ...p, kind: KIND_SWAP[p.kind] ?? p.kind }));
        expect(sg.pieces).toEqual(expected);
      }
    }
  });
});

describe("§6.2 host-drop — a replaced host takes its lifted dressing with it", () => {
  it("no dangling dressing: the tabletop slot stages nothing when its host is replaced", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const groups = resolveSchematic(
        livingPlacement(),
        createRng(seed),
        1,
        SHALLOWS,
      )!;
      const seating = groups.find((g) => g.id === "living:seating")!;
      // every surviving seating piece stands on the floor — nothing floats
      expect(seating.pieces.every((p) => p.dy === 0)).toBe(true);
      // …and no tabletop kind survived the replacement of its host
      expect(
        seating.pieces.some((p) => TABLETOP_ACCEPTS.includes(p.kind)),
      ).toBe(false);
    }
    // end-to-end through the staging machinery
    const { pieces } = stageLiving({ skin: SHALLOWS });
    for (const p of pieces.filter((x) => x.kitId === "living:seating")) {
      expect(TABLETOP_ACCEPTS).not.toContain(p.kind);
    }
    // and the outline agrees: no vase / frame / candle in the flooded room
    const kinds = describeRoom("dbg-skin:shallows+dbg-m:living").furnishing!.flatMap(
      (f) => f.pieces,
    );
    for (const kind of ["vase", "frame", "candle"]) {
      expect(kinds).not.toContain(kind);
    }
  });

  it("the drop is stream-aligned: the rest of the room is byte-identical", () => {
    const legacy = stageLiving({});
    const skinned = stageLiving({ skin: SHALLOWS });
    // the armchair anchors to the coffee table's spot — its coordinates
    // prove the stream never shifted behind the dropped dressing
    const armchairOf = (ps: StagedKitPiece[]) =>
      ps.find((p) => p.kind === "readingchair");
    expect(armchairOf(skinned.pieces)).toBeDefined();
    expect(armchairOf(skinned.pieces)!.x).toBeCloseTo(
      armchairOf(legacy.pieces)!.x,
      10,
    );
    expect(armchairOf(skinned.pieces)!.z).toBeCloseTo(
      armchairOf(legacy.pieces)!.z,
      10,
    );
  });

  it("without an override the dressing rests on its host as today", () => {
    for (const skin of [undefined, TEMPERATE] as const) {
      const { pieces } = stageLiving({ skin });
      const seating = pieces.filter((p) => p.kitId === "living:seating");
      const dressing = seating.filter((p) => p.dy > 0);
      expect(dressing.length).toBeGreaterThan(0);
      const host = seating.find((p) => p.kind === "coffeetable")!;
      for (const d of dressing) {
        // ON the coffee table: the authored top lift, at the host's spot
        expect(Math.hypot(d.x - host.x, d.z - host.z)).toBeLessThan(0.5);
        expect(d.y).toBeGreaterThan(0);
      }
    }
  });
});

describe("the default path — zero change", () => {
  it("no skin (or a skin without overrides) resolves byte-for-byte", () => {
    for (const seed of [201, 202, 203, 204, 205]) {
      const legacy = resolveSchematic(livingPlacement(), createRng(seed), 1);
      expect(
        resolveSchematic(livingPlacement(), createRng(seed), 1, null),
      ).toEqual(legacy);
      expect(
        resolveSchematic(livingPlacement(), createRng(seed), 1, TEMPERATE),
      ).toEqual(legacy);
    }
  });

  it("the worldClasses gate is not dismantled — nature kits stay off the interior deck", () => {
    for (const archetype of ["hotel-room", "library", "ballroom", "pool-hall"]) {
      const ids = kitsFor("interior", archetype, 96).map((k) => k.id);
      for (const id of NATURE_KIT_IDS) {
        expect(ids, `${archetype} drew nature kit ${id}`).not.toContain(id);
      }
    }
  });

  it("无皮肤 ≡ 温带: the baseline omits its decks and stages byte-for-byte like no skin", () => {
    expect(TEMPERATE.furnishing.decks).toBeUndefined();
    // plain room: the deck falls back to the archetype vocabulary
    expect(stagePlain({ seed: 88, skin: TEMPERATE })).toEqual(
      stagePlain({ seed: 88 }),
    );
    // composed room: module whitelists + zones + schematics all intact
    expect(stageLiving({ skin: TEMPERATE }).pieces).toEqual(
      stageLiving({}).pieces,
    );
  });

  it("the baseline takes over nothing — temperate stages only the room's own vocabulary", () => {
    // (The byte-equality 无皮肤 ≡ 温带 itself is proven at the staging
    // level above: identical inputs modulo the skin ⇒ identical pieces.
    // At the outline level the skinned and bare ids are different slices
    // with different streams, so the contract asserted here is the
    // VOCABULARY one: the baseline skin triggered no deck takeover.)
    const interiorIds = new Set(
      KITS.filter((k) => k.worldClasses.includes("interior")).map((k) => k.id),
    );
    const temp = describeRoom("dbg-skin:temperate+dbg-m:living");
    expect(temp.skin?.id).toBe("temperate");
    for (const f of temp.furnishing!) {
      if (f.kit.startsWith("living:")) continue;
      expect(interiorIds, f.kit).toContain(f.kit);
    }
    // …while the world-owning dune skin DOES replace the vocabulary (its
    // own slice: every generic placement rides the dune's nature decks).
    const dune = describeRoom("dbg-skin:dune+dbg-m:living");
    const duneKitIds = dune.furnishing!
      .filter((f) => !f.kit.startsWith("living:"))
      .map((f) => f.kit);
    for (const id of duneKitIds) expect(DUNE_DECKS).toContain(id);
    if (duneKitIds.length > 0) {
      expect(duneKitIds.some((id) => NATURE_KIT_IDS.includes(id))).toBe(true);
    }
  });
});

describe("skin furnishing decks — the explicit nature path", () => {
  it("a skinned interior room stages its skin's decks (nature kits, explicitly)", () => {
    const stagedIds = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      for (const p of stagePlain({ seed, skin: DUNE })) {
        expect(DUNE_DECKS, `seed ${seed}: ${p.kitId}`).toContain(p.kitId);
        stagedIds.add(p.kitId);
      }
    }
    // The dune actually furnished — its decks were drawn, not gated away.
    expect(stagedIds.size).toBeGreaterThan(0);
    expect([...stagedIds].some((id) => NATURE_KIT_IDS.includes(id))).toBe(true);
  });

  it("the same room on the default path draws zero nature kits", () => {
    const stagedIds = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      for (const p of stagePlain({ seed })) {
        expect(NATURE_KIT_IDS, `seed ${seed}: ${p.kitId}`).not.toContain(
          p.kitId,
        );
        stagedIds.add(p.kitId);
      }
    }
    expect(stagedIds.size).toBeGreaterThan(0);
  });

  it("the shore/water rule still binds under a skin", () => {
    // No basin: the shallows' jetty and reeds are water-bound and must
    // drop out of the deck — what stages is the dry remainder of the decks.
    const stagedIds = new Set<string>();
    for (let seed = 21; seed <= 30; seed++) {
      for (const p of stagePlain({ seed, skin: SHALLOWS })) {
        expect(["jetty", "reeds"], `seed ${seed}: ${p.kitId}`).not.toContain(
          p.kitId,
        );
        expect(SHALLOWS_DECKS).toContain(p.kitId);
        stagedIds.add(p.kitId);
      }
    }
    expect(stagedIds.size).toBeGreaterThan(0);
  });
});

describe("A6 — determinism with a skin", () => {
  it("same seed + same skin stages byte-identical, with and without a skin", () => {
    for (const skin of [null, GROVE, SHALLOWS] as const) {
      const a = stagePlain({ seed: 77, ...(skin ? { skin } : {}) });
      const b = stagePlain({ seed: 77, ...(skin ? { skin } : {}) });
      expect(a).toEqual(b);
    }
    const a = stageLiving({ seed: 4242, skin: DUNE });
    const b = stageLiving({ seed: 4242, skin: DUNE });
    expect(a.pieces).toEqual(b.pieces);
  });

  it("the skinned outline lists the replacement kind and only the skin's decks", () => {
    const desc = describeRoom("dbg-skin:shallows+dbg-m:living");
    const kinds = desc.furnishing!.flatMap((f) => f.pieces);
    // §6.2's ask: the coffee table became the small pool…
    expect(kinds).toContain("fountain");
    expect(kinds).not.toContain("coffeetable");
    // …while the structure layer (the sofa it serves) is untouched.
    expect(kinds).toContain("sofa");
    // Every non-schematic placement rides the skin's decks.
    for (const f of desc.furnishing!) {
      if (f.kit.startsWith("living:")) continue;
      expect(SHALLOWS_DECKS).toContain(f.kit);
    }
    expect(desc.skin?.id).toBe("shallows");
  });

  it("real slices wear their world: interior → null, nature → its skin (A6 in the outline)", () => {
    // Interior worlds resolve the temperate baseline — null, byte-for-byte
    // the skinless path.
    for (const id of ["2026-09-15-0746", "core", "dbg-m:living"]) {
      expect(skinForSlice(id)).toBeNull();
      expect(describeRoom(id).skin).toBeNull();
    }
    // A real nature slice resolves its world's skin, and the outline is a
    // stable function of the slice (A6).
    let nature: string | null = null;
    for (let i = 0; i < 3000 && nature === null; i++) {
      const id = `staging-world-${i}`;
      if (compileSpaceRecipe(id).worldClass === "nature") nature = id;
    }
    expect(nature).not.toBeNull();
    const skin = skinForSlice(nature!);
    expect(skin).not.toBeNull();
    const desc = describeRoom(nature!);
    expect(desc.skin?.id).toBe(skin!.id);
    expect(JSON.stringify(describeRoom(nature!))).toBe(JSON.stringify(desc));
  });
});
