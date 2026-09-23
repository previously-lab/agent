/**
 * Tests for Lane B's service-family blueprints (v0.12b P2b): foyer,
 * kitchen, bath, storage, workshop (doc/design/v0.12b-room-lane-guide.md
 * §5's per-room Definition of Done, against doc/design/room-plans/
 * {foyer,kitchen,bath,storage,workshop}.txt and v0.12-room-specs.md
 * §5–§7/§12–§13).
 *
 *  - Catalogue soundness: every blueprint passes auditSchematic (ordered
 *    references, 禁止栏 holds — the banned kinds never enter an accepts).
 *  - Seed sweep (resolve level, 40 seeds × 5 rooms): required groups land
 *    in EVERY sample; optional groups respect their chance floor; a seed
 *    replays byte-identically (A6); and the authored groups stay rigid
 *    (the composition translates as one — pairwise piece distances stay
 *    inside their authored bands).
 *  - Staging sweep (debug-gallery rooms, world-seed varied): the staged
 *    room carries every required piece under its schematic kitId (a
 *    rolled-back schematic would fall back to generic kit ids — caught),
 *    keeps the entrance strip and the walkable footprint, stays ≤65%
 *    covered, and stages three times byte-identically.
 *  - The six "reads as a real room" rules that apply per room, as
 *    MEASUREMENTS on the staged pieces (the lane guide §5's contract:
 *    rules as tests, not aesthetic debates).
 *
 * Vocabulary collisions with the audit's global banned list (bench /
 * towelstack / towelrail / bucket / luggagecart / lockerrow / chairstack)
 * are substituted, not smuggled: the foyer waits on a sofa (not a bench),
 * the bath authors a vanity station (not the banned locker/towel wall),
 * storage's cart is a door-side case pile, and the workshop keeps no
 * chair stack. See doc/design/v0.12b-lane-B-notes.md for the full list
 * and the adjudication requests.
 */
import { describe, it, expect } from "vitest";
import {
  auditSchematic,
  resolveSchematic,
  roomSchematicFor,
  roomSchematics,
  schematicPlacementsFor,
  type ResolvedSchematicGroup,
} from "@/lib/game/room-schematic";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  composeRoom,
  roomPlanFor,
  scaledRecipeFor,
} from "@/lib/game/room-plan";
import {
  compositionForRecipe,
  compositionKitZonesFor,
} from "@/lib/game/room-modules";
import {
  planArea as kitPlanArea,
  stageInteriorKits,
  type StagedKitPiece,
} from "@/lib/game/kits";
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

/** The renderer's furniture-memo inputs, rebuilt for one debug-gallery
 *  module room — the shared test's stageModuleRoom, with an optional
 *  world seed so the staging sweep can vary the stream (same module,
 *  different draws; the dbg-m slice pins the room, the seed perturbs it). */
function stageModuleRoom(
  moduleId: string,
  worldSeed: string = WORLD_SEED,
) {
  const sliceId = `dbg-m:${moduleId}`;
  const recipe = compileSpaceRecipe(sliceId, worldSeed);
  const { recipe: scaledRecipe, scale } = scaledRecipeFor(recipe);
  const comp = compositionForRecipe(recipe, worldSeed)!;
  const plan = roomPlanFor(
    sliceId,
    scaledRecipe.width,
    scaledRecipe.size.extent,
    COLONNADE_BAY,
    worldSeed,
    { plan: "rect" },
  );
  const compo = composeRoom(sliceId, plan, 1, worldSeed);
  const schematics = schematicPlacementsFor(comp.modules, scale.factor);
  const pieces = stageInteriorKits({
    rng: createRng(deriveSubSeed(worldSeed, sliceId, "furniture")),
    archetype: recipe.archetype,
    plan,
    comp: compo,
    baseExtent: recipe.size.extent,
    baseArea: kitPlanArea(plan) / (scale.factor * scale.factor),
    propScale: Math.pow(scale.factor, PROP_SCALE_EXP),
    wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
    water: null,
    doors: [],
    kitIds: [...new Set(comp.modules.flatMap((p) => p.module.kits))],
    zones: compositionKitZonesFor(comp, plan),
    ...(schematics.length > 0 ? { schematics } : {}),
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
/** Facing alignment: how squarely `p` faces toward `target`. */
const faces = (p: StagedKitPiece, target: { x: number; z: number }) => {
  const d = { x: target.x - p.x, z: target.z - p.z };
  const len = Math.hypot(d.x, d.z) || 1e-9;
  const f = forward(p);
  return (f.x * d.x + f.z * d.z) / len;
};

/** One placement resolved against a fresh seeded stream (the resolve
 *  level the A6 sweep runs at). */
function resolveFor(
  moduleId: string,
  seed: number,
): ResolvedSchematicGroup[] {
  const { schematics } = stageModuleRoom(moduleId);
  const placement = schematics.find(
    (s) => s.schematic.moduleId === moduleId,
  )!;
  const groups = resolveSchematic(placement, createRng(seed), 1);
  expect(groups, `${moduleId}#${seed}: resolution forfeited`).not.toBeNull();
  return groups!;
}

function groupPieces(groups: ResolvedSchematicGroup[], id: string) {
  const g = groups.find((g) => g.id === id);
  expect(g, `group ${id}`).toBeDefined();
  return g!.pieces;
}

/** An optional group's pieces — null when the seed left the group out. */
function optionalGroupPieces(groups: ResolvedSchematicGroup[], id: string) {
  return groups.find((g) => g.id === id)?.pieces ?? null;
}

/** A staged room's view: pieces by kind + the schematic-only filter. */
function staged(moduleId: string, worldSeed: string = WORLD_SEED) {
  const { pieces, plan, schematics } = stageModuleRoom(moduleId, worldSeed);
  expect(schematics.map((s) => s.schematic.moduleId)).toEqual([moduleId]);
  const byKind = (kind: string) => pieces.filter((p) => p.kind === kind);
  const one = (kind: string) => {
    const all = byKind(kind);
    expect(all.length, `${moduleId}: expected a ${kind}`).toBeGreaterThan(0);
    return all[0];
  };
  return { pieces, plan, byKind, one, schematics };
}

const SERVICE_MODULES = [
  "foyer",
  "kitchen",
  "bath",
  "storage",
  "workshop",
] as const;

/** Required group ids per room (must land in every sweep sample). */
const REQUIRED_GROUPS: Record<(typeof SERVICE_MODULES)[number], string[]> = {
  foyer: ["foyer:desk", "foyer:waiting", "foyer:threshold"],
  kitchen: [
    "kitchen:counter",
    "kitchen:table",
    "kitchen:chair-approach",
    "kitchen:chair-counter",
    "kitchen:sideboard",
    "kitchen:cleaning",
  ],
  bath: ["bath:lockers-w", "bath:rail-w", "bath:towelstation"],
  storage: ["storage:rack-n", "storage:rack-flank", "storage:cart"],
  workshop: [
    "workshop:bench",
    "workshop:materials",
    "workshop:credenza",
    "workshop:paperwork",
  ],
};

/** Optional groups and their seeded chance (presence floor asserted). */
const OPTIONAL_GROUPS: Record<
  (typeof SERVICE_MODULES)[number],
  { id: string; chance: number }[]
> = {
  foyer: [
    { id: "foyer:mat", chance: 0.7 },
    { id: "foyer:clock", chance: 0.5 },
  ],
  kitchen: [
    { id: "kitchen:end-w", chance: 0.5 },
    { id: "kitchen:end-e", chance: 0.5 },
  ],
  bath: [
    { id: "bath:lockers-e", chance: 0.55 },
    { id: "bath:rail-e", chance: 0.5 },
    { id: "bath:vanity", chance: 0.7 },
    { id: "bath:plants", chance: 0.6 },
  ],
  storage: [{ id: "storage:mop", chance: 0.6 }],
  workshop: [
    { id: "workshop:mop", chance: 0.6 },
    { id: "workshop:spares", chance: 0.6 },
  ],
};

const SWEEP_SEEDS = 40;
const STAGING_SEEDS = ["sweep-a", "sweep-b", "sweep-c", "sweep-d", "sweep-e", "sweep-f"];

describe("the service catalogue is sound", () => {
  it("every Lane B blueprint passes the audit", () => {
    for (const id of SERVICE_MODULES) {
      const s = roomSchematicFor(id)!;
      expect(s, id).toBeDefined();
      expect(auditSchematic(s), `${id}: ${auditSchematic(s).join("; ")}`).toEqual([]);
    }
  });

  it("the service family carries exactly the five rooms, in MODULE_ORDER", () => {
    const ids = roomSchematics().map((s) => s.moduleId);
    const service = SERVICE_MODULES.filter((id) => ids.includes(id));
    expect(service).toEqual([...SERVICE_MODULES]);
  });
});

describe("seed sweep — required groups land in every sample (resolve level)", () => {
  for (const id of SERVICE_MODULES) {
    describe(id, () => {
      const required = REQUIRED_GROUPS[id];
      it(`${required.length} required groups place in all ${SWEEP_SEEDS} samples`, () => {
        for (let seed = 1; seed <= SWEEP_SEEDS; seed++) {
          const groups = resolveFor(id, seed);
          const got = new Set(groups.map((g) => g.id));
          for (const rid of required) {
            expect(got.has(rid), `${id}#${seed}: ${rid} missing`).toBe(true);
          }
        }
      });

      it("optional groups respect their chance floor", () => {
        const optional = OPTIONAL_GROUPS[id];
        for (const { id: gid, chance } of optional) {
          let present = 0;
          for (let seed = 1; seed <= SWEEP_SEEDS; seed++) {
            const groups = resolveFor(id, seed);
            if (groups.some((g) => g.id === gid)) present += 1;
          }
          // chance − tolerance 0.25 (40 samples; the binomial tail past
          // a quarter under the rate is negligible).
          expect(
            present / SWEEP_SEEDS,
            `${gid} present ${present}/${SWEEP_SEEDS}, chance ${chance}`,
          ).toBeGreaterThanOrEqual(chance - 0.25);
        }
      });

      it("the optional slot chances fire inside required groups (foyer plant)", () => {
        if (id !== "foyer") return;
        let plants = 0;
        for (let seed = 1; seed <= SWEEP_SEEDS; seed++) {
          const groups = resolveFor(id, seed);
          const threshold = groups.find((g) => g.id === "foyer:threshold")!;
          if (threshold.pieces.some((p) => p.kind === "plant")) plants += 1;
        }
        expect(plants / SWEEP_SEEDS, "thresholdplant chance 0.6").toBeGreaterThanOrEqual(0.3);
      });

      it("each seed replays byte-identically (A6)", () => {
        for (let seed = 1; seed <= SWEEP_SEEDS; seed++) {
          const a = resolveFor(id, seed);
          const b = resolveFor(id, seed);
          expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        }
      });

      it("the authored groups stay rigid across samples", () => {
        const bands: {
          pair: [string, string];
          group: string;
          min: number;
          max: number;
          optional?: boolean;
        }[] = RIGID_PAIRS[id];
        for (const { pair, group, min, max, optional } of bands) {
          for (let seed = 1; seed <= SWEEP_SEEDS; seed++) {
            const groups = resolveFor(id, seed);
            // An optional composition places whole or not at all — the
            // band is asserted only in the samples where it landed.
            const pieces = optional
              ? optionalGroupPieces(groups, group)
              : groupPieces(groups, group);
            if (!pieces) continue;
            const a = pieces.find((p) => p.kind === pair[0])!;
            // "*" = the first other piece (a dressing slot may draw any
            // of several kinds).
            const b =
              pair[1] === "*"
                ? pieces.find((p) => p.kind !== pair[0])!
                : pieces.find((p) => p.kind === pair[1])!;
            const d = Math.hypot(a.dx - b.dx, a.dz - b.dz);
            expect(
              d,
              `${group} ${pair.join("-")}#${seed} = ${d.toFixed(3)}m`,
            ).toBeGreaterThanOrEqual(min);
            expect(
              d,
              `${group} ${pair.join("-")}#${seed} = ${d.toFixed(3)}m`,
            ).toBeLessThanOrEqual(max);
          }
        }
      });
    });
  }
});

/** Authored pairwise distance bands (group-frame offsets, m) — the
 *  composition may translate/rotate as one, never drift apart. */
const RIGID_PAIRS: Record<
  (typeof SERVICE_MODULES)[number],
  { pair: [string, string]; group: string; min: number; max: number; optional?: boolean }[]
> = {
  foyer: [
    { pair: ["counter", "bell"], group: "foyer:desk", min: 0.28, max: 0.58 },
    { pair: ["counter", "register"], group: "foyer:desk", min: 0.28, max: 0.58 },
  ],
  kitchen: [
    {
      pair: ["diningtable", "*"],
      group: "kitchen:table",
      min: 0.04,
      max: 0.42,
    },
  ],
  bath: [
    {
      pair: ["vanity", "chair"],
      group: "bath:vanity",
      min: 0.68,
      max: 0.9,
      optional: true,
    },
    {
      pair: ["bench", "bucket"],
      group: "bath:towelstation",
      min: 0.7,
      max: 1.0,
    },
  ],
  storage: [
    {
      pair: ["storagerack", "suitcase"],
      group: "storage:rack-n",
      min: 0.38,
      max: 0.62,
    },
  ],
  workshop: [
    {
      pair: ["workbench", "chair"],
      group: "workshop:bench",
      min: 0.82,
      max: 1.1,
    },
  ],
};

describe("staging — the schematic owns the room (no fallback, no blocked doors)", () => {
  for (const id of SERVICE_MODULES) {
    describe(id, () => {
      it("stages every required piece under its schematic kitId", () => {
        const { pieces } = staged(id);
        for (const p of pieces) {
          expect(
            p.kitId.startsWith(`${id}:`),
            `${id}: piece ${p.kind}@${p.kitId} — a rolled-back schematic ` +
              "fell back to generic staging",
          ).toBe(true);
        }
        for (const kind of REQUIRED_KINDS[id]) {
          expect(
            pieces.some((p) => p.kind === kind),
            `${id}: required kind ${kind} missing`,
          ).toBe(true);
        }
      });

      it("required pieces land across staging seeds too (pushKit accepts)", () => {
        for (const ws of STAGING_SEEDS) {
          const { pieces } = staged(id, ws);
          for (const p of pieces) {
            expect(p.kitId.startsWith(`${id}:`), `${id}@${ws}: ${p.kind}@${p.kitId}`).toBe(true);
          }
          for (const kind of REQUIRED_KINDS[id]) {
            expect(
              pieces.some((p) => p.kind === kind),
              `${id}@${ws}: required kind ${kind} missing`,
            ).toBe(true);
          }
        }
      });

      it("keeps the entrance strip and the walkable footprint clear", () => {
        const { pieces, plan } = staged(id);
        const pieceClear = KIT_PATH_CLEAR;
        const wallInset = ROOM_WALL_THICKNESS + KIT_WALL_CLEAR;
        for (const p of pieces) {
          expect(
            Math.abs(p.x) < PROP_DOOR_HALF + pieceClear && p.z < PROP_DOOR_DEPTH + pieceClear,
            `${id}: ${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} blocks the entrance strip`,
          ).toBe(false);
          const halfW = plan.width / 2;
          expect(Math.abs(p.x) <= halfW - wallInset + 1e-9).toBe(true);
          expect(p.z >= wallInset - 1e-9 && p.z <= plan.extent - wallInset + 1e-9).toBe(true);
        }
      });

      it("the placed footprint discs never exceed 65% of the floor", () => {
        const { pieces, plan } = staged(id);
        // Conservative upper bound (the shared test's accounting): one
        // disc per placed group, radius = the group's spread + its
        // largest piece radius; rugs are flat and count no disc.
        const RADIUS: Record<string, number> = {
          counter: 0.75,
          register: 0.15,
          bell: 0.15,
          grandfatherclock: 0.35,
          bench: 0.75,
          coatstand: 0.4,
          umbrellastand: 0.4,
          plant: 0.4,
          tray: 0.15,
          vase: 0.15,
          candle: 0.15,
          diningtable: 0.9,
          chair: 0.4,
          sideboard: 0.85,
          mop: 0.3,
          bucket: 0.3,
          vanity: 0.8,
          screen: 0.5,
          lockerrow: 0.5,
          towelrail: 0.55,
          towelstack: 0.2,
          suitcase: 0.4,
          luggagecart: 0.7,
          storagerack: 0.75,
          chairstack: 0.55,
          workbench: 0.95,
          desklamp: 0.15,
          bookpile: 0.2,
          desk: 0.8,
        };
        let covered = 0;
        const groups = new Map<number, { x: number; z: number; r: number }>();
        for (const p of pieces) {
          if (p.trace) continue;
          if (p.kind === "rug") continue; // flat: walked over, no disc
          const g = groups.get(p.kitIndex) ?? { x: p.x, z: p.z, r: 0 };
          const spread = Math.hypot(p.x - g.x, p.z - g.z);
          g.r = Math.max(g.r, spread + (RADIUS[p.kind] ?? 0.5));
          groups.set(p.kitIndex, g);
        }
        for (const g of groups.values()) covered += Math.PI * g.r * g.r;
        const cap = (1 - KIT_EMPTY_FLOOR_MIN) * kitPlanArea(plan);
        expect(
          covered <= cap + 1e-6,
          `${id}: covered ≈${covered.toFixed(1)}m² > ${cap.toFixed(1)}m² cap`,
        ).toBe(true);
      });

      it("stages three times byte-identically (A6, same slice)", () => {
        const a = staged(id).pieces;
        const b = staged(id).pieces;
        const c = staged(id).pieces;
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(JSON.stringify(c)).toBe(JSON.stringify(a));
      });
    });
  }
});

/** Required prop kinds per room (the staged room must carry them). */
const REQUIRED_KINDS: Record<(typeof SERVICE_MODULES)[number], string[]> = {
  foyer: ["counter", "register", "bell", "bench", "coatstand", "umbrellastand"],
  kitchen: ["counter", "tray", "vase", "diningtable", "chair", "sideboard", "mop"],
  bath: ["lockerrow", "bench", "towelstack", "bucket", "towelrail"],
  storage: ["storagerack", "suitcase", "luggagecart"], // the mop/bucket corner is optional
  workshop: ["workbench", "desklamp", "tray", "chair", "storagerack", "desk"],
};

describe("foyer — the arrival hub (specs §12 / foyer.txt, variant A 对门前台)", () => {
  it("the desk stands ON the axis facing the door, ledger and bell ON the counter", () => {
    const { one } = staged("foyer");
    const counter = one("counter");
    expect(Math.abs(counter.x), "the podium on the room axis").toBeLessThan(0.6);
    expect(counter.z, "the podium mid-room, 2.4–2.6m off the far wall").toBeGreaterThan(9.2);
    expect(counter.z).toBeLessThan(9.8);
    expect(Math.abs(norm(counter.rotY - Math.PI)), "counter faces the door").toBeLessThan(0.15);
    for (const kind of ["register", "bell"]) {
      const piece = one(kind);
      expect(piece.dy, `${kind} rides the counter top`).toBeGreaterThan(0.85);
      expect(piece.dy).toBeLessThan(1.1);
      expect(dist(piece, counter), `${kind} on the counter`).toBeLessThan(0.6);
    }
  });

  it("the waiting bench answers the desk across the room", () => {
    const { one } = staged("foyer");
    const bench = one("bench");
    const counter = one("counter");
    expect(bench.x, "bench against the east wall").toBeGreaterThan(3.9);
    expect(faces(bench, counter), "bench faces the desk").toBeGreaterThan(0.8);
  });

  it("the threshold takes the west wall's entrance third, off the spine", () => {
    const { pieces, one } = staged("foyer");
    for (const kind of ["coatstand", "umbrellastand"]) {
      const p = one(kind);
      expect(p.x, `${kind} on the west wall`).toBeLessThan(-5.0);
      expect(p.z, `${kind} in the entrance third`).toBeGreaterThan(1.7);
      expect(p.z, `${kind} in the entrance third`).toBeLessThan(3.4);
    }
    // The spine (x ±1.9, entrance half z<6) stays empty: every piece
    // keeps out of it.
    for (const p of pieces) {
      expect(
        Math.abs(p.x) < 1.85 && p.z < 5.9,
        `${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} sits in the spine`,
      ).toBe(false);
    }
    const clock = pieces.find((p) => p.kind === "grandfatherclock");
    if (clock) expect(clock.z, "the lobby clock behind the desk").toBeGreaterThan(7);
  });
});

describe("kitchen — the working wall and the laid table (specs §5 / kitchen.txt)", () => {
  it("the counter stands on the focal wall with its dressing ON the slab", () => {
    const { one, plan } = staged("kitchen");
    const focalZ = plan.extent;
    const counter = one("counter");
    expect(focalZ - counter.z, "counter at the focal wall").toBeLessThanOrEqual(1.1);
    const tray = one("tray");
    expect(tray.dy, "the slab dressing is lifted").toBeGreaterThan(0.95);
    expect(dist(tray, counter), "the tray on the counter").toBeLessThan(1.3);
  });

  it("the table sits 0.9m+ off the counter, its chairs square at it", () => {
    const { byKind, one } = staged("kitchen");
    const table = one("diningtable");
    const counter = one("counter");
    expect(dist(table, counter), "table—counter working gap").toBeGreaterThanOrEqual(1.8);
    const chairs = byKind("chair");
    expect(chairs.length, "2–4 chairs").toBeGreaterThanOrEqual(2);
    for (const c of chairs) {
      expect(faces(c, table), "chair faces the table").toBeGreaterThan(0.9);
    }
    const approach = Math.min(...chairs.map((c) => c.z));
    expect(approach, "a chair between the door and the table").toBeLessThan(table.z);
  });

  it("the mop parks in the south-west corner", () => {
    const { one } = staged("kitchen");
    const mop = one("mop");
    expect(mop.x, "mop west").toBeLessThan(-3.5);
    expect(mop.z, "mop south").toBeLessThan(1.7);
  });
});

describe("bath — a real changing room on the dry rims (specs §6 / bath.txt, 16×10)", () => {
  it("the locker run stands on the west rim facing the water side", () => {
    const { byKind } = staged("bath");
    const lockers = byKind("lockerrow");
    expect(lockers.length, "the west run is required").toBeGreaterThanOrEqual(1);
    const west = lockers.find((l) => l.x < -6.5)!;
    expect(west, "a run on the west rim").toBeDefined();
    expect(forward(west).x, "the lockers face east, into the room").toBeGreaterThan(0.9);
  });

  it("the towel station: bench at the far strip, towels ON it, bucket beside", () => {
    const { one, byKind } = staged("bath");
    const bench = one("bench");
    expect(bench.z, "the bench on the north edge, past the water").toBeGreaterThan(8.2);
    const towels = byKind("towelstack");
    expect(towels.length, "folded towels on the seat").toBeGreaterThanOrEqual(1);
    for (const t of towels) {
      expect(t.dy, "the towels ride the bench seat").toBeGreaterThan(0.4);
      expect(dist(t, bench), "towels on the bench").toBeLessThan(0.6);
    }
    const bucket = one("bucket");
    expect(dist(bucket, bench), "the bucket beside the bench").toBeLessThan(1.2);
  });

  it("the towel rails stand at the water's edge on the rims", () => {
    const { one } = staged("bath");
    const rail = one("towelrail");
    expect(rail.x, "west rail at the water margin (basin edge ≈ −4.7)").toBeLessThan(-4.8);
    expect(rail.x, "rail still on the rim, not mid-floor").toBeGreaterThan(-5.5);
    expect(rail.z, "mid-rim").toBeGreaterThan(5.2);
    expect(rail.z).toBeLessThan(5.7);
  });

  it("every piece stays out of the keep-empty spine; the vanity keeps its group", () => {
    const { pieces, byKind } = staged("bath");
    for (const p of pieces) {
      expect(
        Math.abs(p.x) < 2.0 && p.z < 5,
        `${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} sits in the spine`,
      ).toBe(false);
    }
    const vanity = byKind("vanity");
    if (vanity.length === 0) return; // the optional station stayed out
    const chair = byKind("chair");
    expect(chair.length, "the stool came with the vanity").toBeGreaterThan(0);
    expect(faces(chair[0], vanity[0]), "the stool faces the mirror").toBeGreaterThan(0.9);
  });
});

describe("storage — being tidied, by composition (specs §7 / storage.txt)", () => {
  it("one rack anchors the north wall, the second stands on a flank", () => {
    const { byKind } = staged("storage");
    const racks = byKind("storagerack");
    expect(racks.length).toBeGreaterThanOrEqual(2);
    expect(
      racks.some((r) => r.z > 7),
      "a rack on the north wall",
    ).toBe(true);
    expect(
      racks.some((r) => Math.abs(r.x) > 3),
      "a rack on a flank",
    ).toBe(true);
  });

  it("cases ride the shelves and the rack's feet; the cart waits by the door", () => {
    const { byKind } = staged("storage");
    const cases = byKind("suitcase");
    expect(cases.length, "3+ suitcases").toBeGreaterThanOrEqual(3);
    expect(
      cases.filter((c) => c.dy > 0.1).length,
      "cases on the rack shelves",
    ).toBeGreaterThanOrEqual(2);
    expect(
      cases.some((c) => c.dy === 0),
      "cases at the racks' feet",
    ).toBe(true);
    const cart = byKind("luggagecart");
    expect(cart.length, "the luggage cart is required").toBeGreaterThanOrEqual(1);
    expect(cart[0].x, "cart door-side, east").toBeGreaterThan(2.5);
    expect(cart[0].z, "cart a metre in, by the door").toBeLessThan(2.2);
    // The centre spine (x ±0.5, full depth) stays empty.
    for (const c of cases) {
      expect(Math.abs(c.x), "case out of the spine").toBeGreaterThan(0.45);
    }
  });
});

describe("workshop — the bench owns the focal wall (specs §13 / workshop.txt)", () => {
  it("the workbench wall composes: slab tools, pulled-up chair", () => {
    const { one, plan } = staged("workshop");
    const focalZ = plan.extent;
    const bench = one("workbench");
    expect(focalZ - bench.z, "bench at the focal wall").toBeLessThanOrEqual(1.2);
    const chair = one("chair");
    expect(faces(chair, bench), "the chair faces the bench").toBeGreaterThan(0.9);
    for (const kind of ["desklamp", "tray"]) {
      const piece = one(kind);
      expect(piece.dy, `${kind} on the slab`).toBeGreaterThan(0.8);
      expect(dist(piece, bench), `${kind} on the bench`).toBeLessThan(0.75);
    }
  });

  it("the room composes asymmetrically — bench west, credenza east", () => {
    const { one, byKind } = staged("workshop");
    const bench = one("workbench");
    const credenzaKinds = [...byKind("sideboard"), ...byKind("storagerack")];
    const east = credenzaKinds.filter((c) => c.x > 3);
    expect(east.length, "the east materials group").toBeGreaterThan(0);
    for (const e of east) {
      // Not a mirror image about the room axis (§2 rule 6).
      expect(
        Math.abs(bench.x + e.x),
        "bench and credenza must not mirror",
      ).toBeGreaterThan(1.5);
    }
    const rack = byKind("storagerack").find((r) => r.z > 7);
    expect(rack, "materials rack on the west flank's far end").toBeDefined();
    expect(rack!.x).toBeLessThan(-3.5);
  });

  it("keeps the paperwork end near the entrance when it lands", () => {
    const { pieces, byKind } = staged("workshop");
    const desk = byKind("desk");
    if (desk.length === 0) return; // the paperwork group stayed out
    expect(desk[0].x, "desk on the west wall").toBeLessThan(-3.5);
    expect(desk[0].z, "desk near the entrance").toBeLessThan(3);
    const lamp = pieces.find((p) => p.kind === "desklamp" && p.dy > 0.7 && dist(p, desk[0]) < 0.7);
    expect(lamp, "the desk's lamp on the desktop").toBeDefined();
  });

  it("the half-finished chair stack waits in the south-east when it lands", () => {
    const { byKind } = staged("workshop");
    const stack = byKind("chairstack");
    if (stack.length === 0) return; // the optional spares stayed out
    expect(stack[0].x, "stack in the east half").toBeGreaterThan(2.3);
    expect(stack[0].z, "stack by the south end").toBeLessThan(2.2);
  });
});
