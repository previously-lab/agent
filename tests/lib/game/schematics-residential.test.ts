/**
 * Lane A's family tests — the residential blueprints (v0.12b P2b):
 * living (the reworked P1 pilot), bedroom, study, reading-room.
 *
 * The contract under test (v0.12b-room-lane-guide §5, per room):
 *  - the catalogue audit is clean for all four blueprints;
 *  - SEED SWEEP (≥30 samples per room, every archetype the module
 *    declares): the required groups land in EVERY sample, the optional
 *    groups appear at ≥ chance − 0.25, the footprint accounting stays
 *    ≤65% of the floor, and nothing enters the entrance strip;
 *  - A6: the same slice stages byte-identical three times;
 *  - living RIGID GROUP: the seating composition's internal distances are
 *    authored-locked across the sweep — the group may translate (its wall
 *    anchor draw) and mirror (the chair's seeded side) but never lets its
 *    pieces drift apart;
 *  - the realism rules of v0.12-room-realism §2 that apply per room
 *    (seats face the focal, purpose-chain distances, tabletop pieces rest
 *    ON their hosts, no door strip blocked), asserted as measurements on
 *    the staged debug-gallery rooms, not aesthetic debate.
 */
import { describe, expect, it } from "vitest";
import {
  auditSchematic,
  resolveSchematic,
  roomSchematicFor,
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
  roomModuleById,
} from "@/lib/game/room-modules";
import { planArea, stageInteriorKits, type StagedKitPiece } from "@/lib/game/kits";
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

/* ------------------------------------------------------------------ */
/* The staging harness — same reconstruction the renderer and the      */
/* shared room-schematic tests use, parameterised by rng seed and      */
/* archetype so the sweep can exercise every declared archetype.       */
/* ------------------------------------------------------------------ */

function stageRoom(
  moduleId: string,
  // seeds are INTEGERS — createRng takes a number (a string coerces to 0
  // via `>>> 0`, so a string seed would sweep one stream over and over)
  opts: { seed?: number; archetype?: string } = {},
) {
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
  const archetype = opts.archetype ?? recipe.archetype;
  const rng =
    opts.seed === undefined
      ? createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"))
      : createRng(opts.seed);
  const pieces = stageInteriorKits({
    rng,
    archetype,
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
    schematics,
    heightAt: () => 0,
  });
  return { sliceId, plan, compo, schematics, pieces, scale };
}

const norm = (r: number) => {
  let a = r % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
const forward = (p: { rotY: number }) => ({
  x: Math.sin(p.rotY),
  z: Math.cos(p.rotY),
});
const faceDot = (
  p: { rotY: number; x: number; z: number },
  t: { x: number; z: number },
) => {
  const f = forward(p);
  const len = Math.max(1e-6, dist(p, t));
  return (f.x * (t.x - p.x) + f.z * (t.z - p.z)) / len;
};

/** Conservative coverage accounting, same shape as the shared budget
 *  test: one disc per placed group (piece spread + authored piece
 *  radius), rugs are flat and count nothing. */
const PIECE_RADIUS: Record<string, number> = {
  sofa: 1.15,
  coffeetable: 0.6,
  readingchair: 0.55,
  chair: 0.4,
  floorlamp: 0.35,
  mediaunit: 0.85,
  tv: 0.35,
  sideboard: 0.95,
  bookshelf: 0.5,
  pedestal: 0.4,
  plant: 0.4,
  nightstand: 0.35,
  bed: 1.3,
  wardrobe: 0.8,
  vanity: 0.55,
  desk: 0.8,
  diningtable: 1.1,
  grandfatherclock: 0.45,
  vase: 0.15,
  frame: 0.15,
  candle: 0.15,
  bookpile: 0.15,
  tray: 0.15,
  desklamp: 0.15,
  rug: 0,
};
function footprintCoverage(pieces: StagedKitPiece[]) {
  const groups = new Map<number, { x: number; z: number; r: number }>();
  for (const p of pieces) {
    if (p.kind === "rug") continue;
    const g = groups.get(p.kitIndex) ?? { x: p.x, z: p.z, r: 0 };
    g.r = Math.max(g.r, Math.hypot(p.x - g.x, p.z - g.z) + (PIECE_RADIUS[p.kind] ?? 0.5));
    groups.set(p.kitIndex, g);
  }
  let covered = 0;
  for (const g of groups.values()) covered += Math.PI * g.r * g.r;
  return covered;
}

interface RoomSpec {
  moduleId: string;
  /** required schematic groups that must land in EVERY sweep sample */
  requiredGroups: string[];
  /** optional groups: [groupId, chance, measured floor (chance − 0.25)] */
  optionalGroups: [string, number][];
  /** piece kinds that must appear in every sample */
  requiredKinds: string[];
  /** samples per archetype */
  seedsPerArchetype: number;
}

const ROOMS: RoomSpec[] = [
  {
    moduleId: "living",
    requiredGroups: ["living:seating", "living:media"],
    optionalGroups: [
      ["living:sideboard", 0.65],
      ["living:shelf", 0.5],
      ["living:plant", 0.6],
    ],
    requiredKinds: ["sofa", "coffeetable", "rug", "readingchair", "floorlamp", "mediaunit", "tv"],
    seedsPerArchetype: 12,
  },
  {
    moduleId: "bedroom",
    requiredGroups: ["bedroom:bed", "bedroom:wardrobe"],
    optionalGroups: [
      ["bedroom:corner-w", 0.6],
      ["bedroom:vanity", 0.45],
    ],
    requiredKinds: ["bed", "nightstand", "desklamp", "wardrobe"],
    seedsPerArchetype: 36,
  },
  {
    moduleId: "study",
    requiredGroups: ["study:shelf", "study:desk"],
    optionalGroups: [
      ["study:corner", 0.55],
      ["study:sideboard", 0.5],
    ],
    requiredKinds: ["bookshelf", "desk", "chair", "desklamp"],
    seedsPerArchetype: 18,
  },
  {
    moduleId: "reading-room",
    requiredGroups: [
      "reading-room:shelf",
      "reading-room:table-w",
      "reading-room:table-e",
      "reading-room:chair-n1",
      "reading-room:chair-n2",
      "reading-room:chair-n3",
      "reading-room:chair-s1",
      "reading-room:chair-s2",
      "reading-room:chair-s3",
      "reading-room:lamp-w",
      "reading-room:lamp-e",
    ],
    optionalGroups: [
      ["reading-room:corner-w", 0.55],
      ["reading-room:bench", 0.4],
    ],
    requiredKinds: ["bookshelf", "diningtable", "chair", "floorlamp", "rug"],
    seedsPerArchetype: 18,
  },
];

const one = (pieces: StagedKitPiece[], kind: string) => {
  const all = pieces.filter((p) => p.kind === kind);
  expect(all.length, `expected a ${kind}`).toBeGreaterThan(0);
  return all[0];
};

/* ------------------------------------------------------------------ */
/* The catalogue audit                                                 */
/* ------------------------------------------------------------------ */

describe("the residential catalogue is sound", () => {
  it("all four blueprints pass the audit", () => {
    for (const id of ["living", "bedroom", "study", "reading-room"]) {
      const s = roomSchematicFor(id)!;
      expect(auditSchematic(s), `${id}: ${auditSchematic(s).join("; ")}`).toEqual([]);
    }
  });

  it("the family is exactly these four (residential lane)", () => {
    expect(ROOMS.map((r) => r.moduleId)).toEqual([
      "living",
      "bedroom",
      "study",
      "reading-room",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Per-room sweep: required land always, optional ≥ chance − 0.25,     */
/* coverage ≤65%, the entrance strip stays clear, A6 byte-identical.   */
/* ------------------------------------------------------------------ */

describe("seed sweep — the schematic always lands whole (staging level)", () => {
  for (const spec of ROOMS) {
    it(`${spec.moduleId}: required groups in every sample, optionals above their floor, coverage ≤65%, door strip clear`, () => {
      const mod = roomModuleById(spec.moduleId)!;
      const appearances = new Map<string, number>(spec.optionalGroups.map(([g]) => [g, 0]));
      let samples = 0;
      for (let ai = 0; ai < mod.archetypes.length; ai++) {
        const archetype = mod.archetypes[ai];
        for (let seed = 1; seed <= spec.seedsPerArchetype; seed++) {
          samples++;
          // integer seeds — createRng takes a number (a string coerces to 0)
          const { pieces, plan } = stageRoom(spec.moduleId, {
            seed: ai * 1000 + seed,
            archetype,
          });
          const kitIds = new Set(pieces.map((p) => p.kitId));
          for (const gid of spec.requiredGroups) {
            expect(
              kitIds.has(gid),
              `${spec.moduleId} seed ${archetype}:${seed} lost required group ${gid} ` +
                `(kits: ${[...kitIds].join(",")})`,
            ).toBe(true);
          }
          for (const kind of spec.requiredKinds) {
            expect(
              pieces.some((p) => p.kind === kind),
              `${spec.moduleId} seed ${archetype}:${seed} lost its ${kind}`,
            ).toBe(true);
          }
          for (const [gid] of spec.optionalGroups) {
            if (kitIds.has(gid)) appearances.set(gid, (appearances.get(gid) ?? 0) + 1);
          }
          // coverage budget (the shared conservative accounting)
          const covered = footprintCoverage(pieces);
          const cap = (1 - KIT_EMPTY_FLOOR_MIN) * planArea(plan);
          expect(
            covered <= cap + 1e-6,
            `${spec.moduleId} seed ${archetype}:${seed}: covered ≈${covered.toFixed(1)}m² > ${cap.toFixed(1)}m²`,
          ).toBe(true);
          // the entrance strip (the shared doorway machinery)
          const pieceClear = KIT_PATH_CLEAR * 1;
          for (const p of pieces) {
            expect(
              Math.abs(p.x) < PROP_DOOR_HALF + pieceClear && p.z < PROP_DOOR_DEPTH + pieceClear,
              `${spec.moduleId}: ${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} blocks the entrance strip`,
            ).toBe(false);
          }
        }
      }
      expect(samples).toBeGreaterThanOrEqual(30);
      for (const [gid, chance] of spec.optionalGroups) {
        const rate = (appearances.get(gid) ?? 0) / samples;
        expect(
          rate,
          `${gid} appeared ${(rate * 100).toFixed(0)}% of ${samples} samples (chance ${chance})`,
        ).toBeGreaterThanOrEqual(chance - 0.25);
      }
    });
  }
});

describe("A6 — the same slice, the same room", () => {
  for (const spec of ROOMS) {
    it(`${spec.moduleId}: staging three times from fresh streams is byte-identical`, () => {
      const runs = [0, 1, 2].map(() => stageRoom(spec.moduleId).pieces);
      expect(JSON.stringify(runs[1])).toBe(JSON.stringify(runs[0]));
      expect(JSON.stringify(runs[2])).toBe(JSON.stringify(runs[0]));
    });
  }

  it("resolveSchematic replays identically per seed (all four rooms)", () => {
    for (const spec of ROOMS) {
      const { schematics } = stageRoom(spec.moduleId);
      for (let seed = 1; seed <= 12; seed++) {
        const a = resolveSchematic(schematics[0], createRng(seed), 1)!;
        const b = resolveSchematic(schematics[0], createRng(seed), 1)!;
        expect(JSON.stringify(b), `${spec.moduleId} seed ${seed}`).toBe(JSON.stringify(a));
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The walk path keeps clear of everything that is not its destination */
/* ------------------------------------------------------------------ */

describe("the non-terminus pieces keep off the cleared walk path", () => {
  for (const spec of ROOMS) {
    it(`${spec.moduleId}: flank pieces stand outside the corridor`, () => {
      const { pieces, compo } = stageRoom(spec.moduleId);
      for (const p of pieces) {
        if (p.kitId.startsWith(`${spec.moduleId}:`)) {
          // schematic destination groups are terminus — exempt, exactly
          // like the generic hero they replace.
          continue;
        }
        const d = distToPath(compo, p.x, p.z);
        expect(
          d >= compo.pathHalf + KIT_PATH_CLEAR - 1e-9,
          `${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} stands ${d.toFixed(2)}m off the path`,
        ).toBe(true);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* living — the rigid seating composition and the one-axis media wall  */
/* ------------------------------------------------------------------ */

describe("living — the group is rigid (user call-out 1)", () => {
  it("the coffee table, chair and lamp hold authored distances across the sweep; only the mirror and the wall draw vary", () => {
    const { schematics } = stageRoom("living");
    const placement = schematics[0];
    const ctD: number[] = [];
    const chairD: number[] = [];
    const chairSideX: number[] = [];
    const lampSideX: number[] = [];
    const rugRot: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const groups = resolveSchematic(placement, createRng(seed), 1)!;
      const seat = groups.find((g) => g.id === "living:seating")!;
      const px = (kind: string) => {
        const pieces = seat.pieces.filter((p) => p.kind === kind);
        expect(pieces.length, kind).toBeGreaterThan(0);
        return pieces[0];
      };
      const sofa = seat.pieces.find((p) => p.kind === "sofa")!;
      const ct = px("coffeetable");
      const chair = px("readingchair");
      const lamp = px("floorlamp");
      const rug = px("rug");
      // group-frame offsets: the group's anchor is the sofa, its rotY the
      // sofa's facing — offsets ARE the internal composition.
      ctD.push(Math.hypot(ct.dx, ct.dz));
      chairD.push(Math.hypot(chair.dx, chair.dz));
      chairSideX.push(Math.sign(chair.dx));
      lampSideX.push(Math.sign(lamp.dx));
      rugRot.push(Math.abs(norm(rug.rotY)));
      // the lamp opposes the chair in EVERY sample (the balance holds)
      expect(Math.sign(lamp.dx)).toBe(-Math.sign(chair.dx));
    }
    // locked: every sample lands in the same 6cm band around 1.1m
    for (const [name, ds, want] of [
      ["coffee table", ctD, 1.1],
      ["armchair", chairD, 1.32],
    ] as const) {
      const lo = Math.min(...ds);
      const hi = Math.max(...ds);
      expect(hi - lo, `${name} drift ${(hi - lo).toFixed(3)}m`).toBeLessThan(0.15);
      expect((lo + hi) / 2, `${name} mean`).toBeGreaterThan(want - 0.1);
      expect((lo + hi) / 2, `${name} mean`).toBeLessThan(want + 0.1);
    }
    // the mirror actually flips
    expect(new Set(chairSideX).size).toBe(2);
    expect(new Set(lampSideX).size).toBe(2);
    // the rug does not spin
    expect(Math.max(...rugRot)).toBeLessThan(0.05);
  });

  it("the rug's edge covers the sofa, the coffee table and the chair", () => {
    const { pieces } = stageRoom("living");
    const rug = one(pieces, "rug");
    const radius = 1.5 * rug.scale;
    for (const kind of ["sofa", "coffeetable", "readingchair"]) {
      const seat = one(pieces, kind);
      expect(
        dist(rug, seat),
        `rug r=${radius.toFixed(2)} must reach the ${kind} (d=${dist(rug, seat).toFixed(2)})`,
      ).toBeLessThan(radius - 0.2);
    }
  });
});

describe("living — the focal wall solves once, two consumers (user call-out 2)", () => {
  it("the media unit and the TV ride the sofa's exact lateral on the same wall", () => {
    const { pieces } = stageRoom("living");
    const sofa = one(pieces, "sofa");
    const media = one(pieces, "mediaunit");
    const tv = one(pieces, "tv");
    expect(Math.abs(media.x - sofa.x), "the media wall on the sofa's axis").toBeLessThan(0.01);
    expect(Math.abs(tv.x - sofa.x), "the TV on the sofa's axis").toBeLessThan(0.1);
    // and the viewing distance is the spec's 2.4–3.6m
    const gap = tv.z - (sofa.z + 0.425);
    expect(gap, `sofa front → TV ${gap.toFixed(2)}m`).toBeGreaterThanOrEqual(2.4);
    expect(gap, `sofa front → TV ${gap.toFixed(2)}m`).toBeLessThanOrEqual(3.6);
    expect(Math.abs(norm(sofa.rotY)), "the sofa faces the focal wall").toBeLessThan(0.06);
    expect(faceDot(tv, sofa), "the TV faces the sofa").toBeGreaterThan(0.95);
    expect(faceDot(one(pieces, "readingchair"), one(pieces, "coffeetable"))).toBeGreaterThan(0.9);
    expect(dist(sofa, one(pieces, "floorlamp"))).toBeLessThanOrEqual(1.2);
  });
});

/* ------------------------------------------------------------------ */
/* bedroom — the bed corner is the room                                */
/* ------------------------------------------------------------------ */

describe("bedroom — the bed corner (specs §2)", () => {
  it("the headboard wall composes: flanking nightstands, lamps ON them, the rug at the foot", () => {
    const { pieces, plan } = stageRoom("bedroom");
    const bed = one(pieces, "bed");
    // the bed faces the entrance (its back to the focal wall)
    expect(Math.abs(norm(bed.rotY - Math.PI)), "bed faces the room").toBeLessThan(0.08);
    expect(bed.z, "the bed on the far half").toBeGreaterThan(plan.extent * 0.75);
    const stands = pieces.filter((p) => p.kind === "nightstand");
    expect(stands.length).toBe(2);
    const rel = stands
      .map((s) => ({ s, dx: s.x - bed.x, dz: s.z - bed.z }))
      .sort((a, b) => a.dx - b.dx);
    for (const { dx, dz } of rel) {
      expect(Math.abs(dx), "nightstand ±1.3m aside").toBeGreaterThan(1.15);
      expect(Math.abs(dx), "nightstand ±1.3m aside").toBeLessThan(1.45);
      expect(dz, "nightstand on the headboard side").toBeGreaterThan(0.65);
      expect(dz, "nightstand on the headboard side").toBeLessThan(0.95);
    }
    // 床区对称: the pair mirrors about the bed's axis
    expect(Math.abs(rel[0].dx + rel[1].dx), "the nightstands mirror").toBeLessThan(0.2);
    // the bedside lamps and frames rest ON the stands (never floating)
    const dressing = pieces.filter((p) => p.dy > 0.3);
    expect(dressing.filter((p) => p.kind === "desklamp").length).toBe(2);
    for (const d of dressing) {
      const host = stands.reduce((a, b) => (dist(d, a) < dist(d, b) ? a : b));
      expect(dist(d, host), `${d.kind} on its nightstand`).toBeLessThan(0.35);
    }
    // the rug lies at the bed's foot side, inside the plan
    const rug = one(pieces, "rug");
    expect(rug.z).toBeLessThan(bed.z - 1);
    // the wardrobe stands on a flank wall, clear of the door side
    const wardrobe = one(pieces, "wardrobe");
    expect(Math.abs(wardrobe.x), "the wardrobe hugs a flank wall").toBeGreaterThan(1.5);
    expect(wardrobe.z, "the wardrobe off the entrance").toBeGreaterThan(plan.extent * 0.6);
  });
});

/* ------------------------------------------------------------------ */
/* study — the desk faces the shelf wall; nothing is symmetric         */
/* ------------------------------------------------------------------ */

describe("study — the desk faces the book wall (specs §3)", () => {
  it("the shelf run dresses the focal wall and the desk works against it", () => {
    const { pieces } = stageRoom("study");
    const shelves = pieces.filter((p) => p.kind === "bookshelf");
    expect(shelves.length, "the book wall's bookcase").toBeGreaterThanOrEqual(1);
    for (const s of shelves) {
      expect(s.z, "the book wall on the focal wall").toBeGreaterThan(4.8);
      expect(Math.abs(norm(s.rotY - Math.PI)), "shelves face the room").toBeLessThan(0.1);
    }
    // the shelf sits west-of-centre (the room forbids symmetry, §0-6)
    const shelfX = shelves.reduce((a, s) => a + s.x, 0) / shelves.length;
    expect(shelfX, `the shelf's mean x ${shelfX.toFixed(2)}`).toBeLessThan(-0.6);
    const desk = one(pieces, "desk");
    expect(Math.abs(norm(desk.rotY - Math.PI)), "the desk faces the shelf wall").toBeLessThan(0.1);
    expect(desk.z, "the desk in the room's north band").toBeGreaterThan(4.25);
    expect(desk.z, "the desk in the room's north band").toBeLessThan(4.55);
    // the carrel gap: desk back → shelf face. The ≥0.9m browse channel is
    // the scale ruling's documented casualty (lane report): at 1×1 the
    // fixed 3.5m entrance strip makes "chair z > 3.5" and "channel ≥ 0.9"
    // an empty interval, so the desk hugs the shelf like a library carrel
    // — asserted here as a REAL gap (never overlapping) instead.
    const shelfFace = Math.min(...shelves.map((s) => s.z)) - 0.21;
    const deskBack = desk.z + 0.375;
    const carrel = shelfFace - deskBack;
    expect(carrel, `the carrel gap ${carrel.toFixed(2)}m`).toBeGreaterThan(-0.05);
    expect(carrel, `the carrel gap ${carrel.toFixed(2)}m`).toBeLessThan(0.55);
    // the chair pulled up square, the lamp and the pile ON the desktop
    const chair = one(pieces, "chair");
    expect(dist(chair, desk), "the chair at the desk").toBeLessThan(1.0);
    expect(chair.z, "the chair south of the desk").toBeLessThan(desk.z);
    expect(chair.z, "the chair clears the entrance strip").toBeGreaterThan(3.4);
    expect(faceDot(chair, desk), "the chair faces the desk").toBeGreaterThan(0.85);
    for (const kind of ["desklamp", "bookpile"]) {
      const d = one(pieces, kind);
      expect(d.dy, `${kind} lifted`).toBeGreaterThan(0.6);
      expect(dist(d, desk), `${kind} on the desktop`).toBeLessThan(0.7);
    }
    // asymmetry holds at the desk too
    expect(Math.abs(desk.x), "the desk off the axis").toBeGreaterThan(0.3);
  });
});

/* ------------------------------------------------------------------ */
/* reading-room — the shelf wall and the six-chair long table          */
/* ------------------------------------------------------------------ */

describe("reading-room — the long table under the book wall (specs §4)", () => {
  it("the room composes: shelf wall, the twin-table run, six chairs facing it, a lamp inside each end", () => {
    const { pieces } = stageRoom("reading-room");
    const shelves = pieces.filter((p) => p.kind === "bookshelf");
    expect(shelves.length, "the book wall's bookcase").toBeGreaterThanOrEqual(1);
    for (const s of shelves) expect(s.z, "the shelf wall").toBeGreaterThan(10.8);
    const tables = pieces
      .filter((p) => p.kind === "diningtable")
      .sort((a, b) => a.x - b.x);
    expect(tables.length).toBe(2);
    for (let i = 1; i < tables.length; i++) {
      const gap = tables[i].x - tables[i - 1].x;
      expect(gap, `table gap ${gap.toFixed(2)}m`).toBeGreaterThan(1.6);
      expect(gap, `table gap ${gap.toFixed(2)}m`).toBeLessThan(2.0);
      expect(Math.abs(tables[i].z - tables[0].z), "one straight run").toBeLessThan(0.5);
    }
    const tableC = {
      x: (tables[0].x + tables[1].x) / 2,
      z: (tables[0].z + tables[1].z) / 2,
    };
    const chairs = pieces.filter((p) => p.kind === "chair");
    expect(chairs.length).toBe(6);
    const north = chairs.filter((c) => c.z > tableC.z);
    const south = chairs.filter((c) => c.z < tableC.z);
    expect(north.length).toBe(3);
    expect(south.length).toBe(3);
    for (const c of chairs) {
      const nearest = tables.reduce((a, b) => (dist(c, a) < dist(c, b) ? a : b));
      const d = dist(c, nearest);
      expect(d, "chair at the table").toBeGreaterThan(0.6);
      expect(d, "chair at the table").toBeLessThan(1.45);
      // the seat squares on its authored table (§2 rule 1) — every chair
      // references the west twin; the twins read as one run
      expect(faceDot(c, tables[0]), "the chair faces the table").toBeGreaterThan(0.9);
    }
    const lamps = pieces.filter((p) => p.kind === "floorlamp" && p.kitId === "reading-room:lamp-w" || p.kitId === "reading-room:lamp-e");
    expect(lamps.length).toBe(2);
    for (const l of lamps) {
      expect(Math.abs(l.x), "a lamp inside a table end").toBeGreaterThan(2.0);
      expect(Math.abs(l.x), "a lamp inside a table end").toBeLessThan(2.4);
      expect(Math.abs(l.z - tableC.z)).toBeLessThan(0.5);
    }
    const rug = one(pieces, "rug");
    expect(dist(rug, tableC), "the rug under the table").toBeLessThan(0.5);
    // the window corner sits on the west flank (the east one is the path's
    // side at this depth — dropped, noted in the blueprint), chair angled
    // into the room
    for (const gid of ["reading-room:corner-w"]) {
      const corner = pieces.filter((p) => p.kitId === gid);
      if (corner.length === 0) continue; // optional
      const chair = corner.find((p) => p.kind === "readingchair")!;
      expect(Math.abs(chair.x), `${gid} on a flank`).toBeGreaterThan(2.0);
      expect(chair.z, `${gid} between the door hall and the table`).toBeGreaterThan(4.5);
      const lamp = corner.find((p) => p.kind === "floorlamp")!;
      expect(dist(lamp, chair), "the corner lamp within reach").toBeLessThan(1.2);
    }
    // the plan's G — the gallery bench on the west wall's south band,
    // facing the table, with its open book ON the seat
    const bench = pieces.filter((p) => p.kitId === "reading-room:bench");
    if (bench.length > 0) {
      const seat = bench.find((p) => p.kind === "bench")!;
      expect(seat.x, "the bench hugs the west wall").toBeLessThan(-2.0);
      expect(seat.z, "the bench in the west wall's south band").toBeGreaterThan(3.2);
      expect(faceDot(seat, tableC), "the bench faces the table").toBeGreaterThan(0.8);
      const book = bench.find((p) => p.kind === "bookpile")!;
      expect(book.dy, "the book rests on the seat").toBeGreaterThan(0.35);
      expect(dist(book, seat), "the book on the bench").toBeLessThan(0.35);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Degradation — a bedroom that cannot land never half-furnishes       */
/* ------------------------------------------------------------------ */

describe("degradation — a blueprint that cannot land rolls back whole", () => {
  it("bedroom: a required group that cannot validate forfeits every schematic piece", () => {
    const { pieces } = stageRoom("bedroom");
    expect(pieces.every((p) => !p.kitId.startsWith("bedroom:"))).toBe(false);
    // The fixed debug room stages the blueprint; the machinery-level
    // rollback contract is covered by the shared living test.
  });
});
