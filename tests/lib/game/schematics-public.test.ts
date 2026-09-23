/**
 * Tests for Lane C's public-family blueprints (v0.12b P2b): gallery-module,
 * dining-hall, sunroom, pool-deck (src/lib/game/schematics/public.ts),
 * laid out per doc/design/room-plans/<moduleId>.txt and judged by the six
 * "reads as a real room" rules (v0.12-room-realism.md §2) as MEASUREMENTS
 * on the staged debug-gallery rooms — the room-schematic.test.ts living
 * pilot's contract, applied to the four public rooms.
 *
 * Two of the rooms carry a reported, main-agent-gated dependency (the
 * lane report + doc/design/v0.12b-lane-C-notes.md carry the full text):
 *
 *  - PER-ROOM BANS. The audit audits each blueprint against its own
 *    `bans` list (DEFAULT_BANNED_KINDS when absent — the machinery
 *    landed mid-flight, replacing the old one-size ban). The gallery
 *    and the pool deck declare theirs (the bench / the lounger-
 *    poolbench-towelrail are their legal vocabulary, §6.4 + specs
 *    §8/§10); the dining hall and the sunroom let the shared default
 *    bind them.
 *
 *  - ZONES LANDED. The lane's three reported module-data requests
 *    (gallery north band deleted + corridor shallowed, dining corridor
 *    shallowed — modules/public.ts, with the fixture entries
 *    re-recorded) are APPLIED: gallery and dining sweep against the
 *    real module data below, no overrides.
 *
 * The sunroom and the pool deck needed neither zones nor bans: every
 * authored slot validates against the module data as shipped (the
 * sunroom is v0.13's 2×1 wide-and-shallow cell — 12×6, the seats 1.8–
 * 2.05m off the glass with the plant band 0.8–1.2m off it; the pool
 * deck furnishes the dry flanks and the north waterline around the
 * real pool-hall basin and the water-rill runnel).
 */
import { describe, expect, it } from "vitest";
import {
  auditSchematic,
  roomSchematicFor,
  schematicPlacementsFor,
} from "@/lib/game/room-schematic";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  composeRoom,
  roomPlanFor,
  scaledRecipeFor,
  type RoomPlan,
} from "@/lib/game/room-plan";
import {
  compositionForRecipe,
  compositionKitZonesFor,
} from "@/lib/game/room-modules";
import {
  planArea,
  stageInteriorKits,
  type KitZones,
  type StagedKitPiece,
} from "@/lib/game/kits";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import { waterRectFor } from "@/lib/game/terrain";
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
/* Staging fixture (the shared helper's reconstruction, plus a seeded  */
/* stream knob and a zones override for the reported module edits).    */
/* ------------------------------------------------------------------ */

interface StagedRoom {
  pieces: StagedKitPiece[];
  plan: RoomPlan;
  scaleFactor: number;
  propScale: number;
  schemActive: boolean;
}

function stageModuleRoom(
  moduleId: string,
  extra: {
    stream?: string;
    zones?: (zones: KitZones, plan: RoomPlan) => KitZones;
  } = {},
): StagedRoom {
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
  const zones = compositionKitZonesFor(comp, plan);
  const propScale = Math.pow(scale.factor, PROP_SCALE_EXP);
  const pieces = stageInteriorKits({
    rng: createRng(
      deriveSubSeed(WORLD_SEED, extra.stream ?? sliceId, "furniture"),
    ),
    archetype: recipe.archetype,
    plan,
    comp: compo,
    baseExtent: recipe.size.extent,
    baseArea: planArea(plan) / (scale.factor * scale.factor),
    propScale,
    wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
    water: null,
    doors: [],
    kitIds: [...new Set(comp.modules.flatMap((p) => p.module.kits))],
    zones: extra.zones ? extra.zones(zones, plan) : zones,
    ...(schematics.length > 0 ? { schematics } : {}),
    heightAt: () => 0,
  });
  return {
    pieces,
    plan,
    scaleFactor: scale.factor,
    propScale,
    schemActive: pieces.some((p) => p.kitId.startsWith(`${moduleId}:`)),
  };
}

const SWEEP_N = 36;
function sweep(
  moduleId: string,
  extra: Parameters<typeof stageModuleRoom>[1] = {},
): StagedRoom[] {
  return Array.from({ length: SWEEP_N }, (_, i) =>
    stageModuleRoom(moduleId, { ...extra, stream: `sweep-${i}` }),
  );
}

/* ------------------------------------------------------------------ */
/* Measurement helpers (the shared living-pilot algorithms).           */
/* ------------------------------------------------------------------ */

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

/** Conservative coverage bound: one disc per placed group (radius =
 *  spread from the group's first piece + the kind's authored clearance,
 *  scaled by the piece's own scale), rugs flat and exempt — the
 *  room-schematic.test.ts algorithm, piece-scale aware. */
const CLEARANCE: Record<string, number> = {
  wallart: 0.2,
  floorlamp: 0.35,
  pedestal: 0.5,
  standingstone: 0.3,
  bench: 0.6,
  readingchair: 0.55,
  nightstand: 0.35,
  bookpile: 0.2,
  plant: 0.4,
  diningtable: 0.55,
  chair: 0.4,
  tray: 0.15,
  candle: 0.15,
  vase: 0.15,
  frame: 0.15,
  coffeetable: 0.55,
  sideboard: 0.85,
  fountain: 1.1,
  lounger: 0.55,
  umbrella: 0.6,
  poolbench: 0.6,
  ringpost: 0.4,
  towelrail: 0.35,
  poolladder: 0.5,
  board: 0.5,
};
function coverageRatio(pieces: StagedKitPiece[], plan: RoomPlan): number {
  const groups = new Map<number, { x: number; z: number; r: number }>();
  for (const p of pieces) {
    if (p.kind === "rug") continue;
    const g = groups.get(p.kitIndex) ?? { x: p.x, z: p.z, r: 0 };
    g.r = Math.max(
      g.r,
      Math.hypot(p.x - g.x, p.z - g.z) + (CLEARANCE[p.kind] ?? 0.5) * p.scale,
    );
    groups.set(p.kitIndex, g);
  }
  let covered = 0;
  for (const g of groups.values()) covered += Math.PI * g.r * g.r;
  return covered / planArea(plan);
}

/** Every piece inside the walkable band and out of the entrance strip. */
function assertClearances(samples: StagedRoom[], label: string) {
  for (const s of samples) {
    const wallInset =
      ROOM_WALL_THICKNESS * Math.max(s.scaleFactor, 0.35) +
      KIT_WALL_CLEAR * s.propScale;
    const pieceClear = KIT_PATH_CLEAR * s.propScale;
    const halfW = s.plan.width / 2;
    for (const p of s.pieces) {
      expect(
        Math.abs(p.x) <= halfW - wallInset + 1e-9 &&
          p.z >= wallInset - 1e-9 &&
          p.z <= s.plan.extent - wallInset + 1e-9,
        `${label}: ${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} outside the walkable band`,
      ).toBe(true);
      expect(
        Math.abs(p.x) < PROP_DOOR_HALF + pieceClear &&
          p.z < PROP_DOOR_DEPTH + pieceClear,
        `${label}: ${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} blocks the entrance strip`,
      ).toBe(false);
    }
  }
}

/** Required groups present in EVERY sample; optional group presence
 *  floors at chance − 0.2. */
function assertGroupPresence(
  samples: StagedRoom[],
  moduleId: string,
  required: readonly string[],
  optional: Readonly<Record<string, number>>,
) {
  for (const [i, s] of samples.entries()) {
    expect(
      s.schemActive,
      `${moduleId} sweep-${i}: the schematic owned the room`,
    ).toBe(true);
    const present = new Set(
      s.pieces
        .filter((p) => p.kitId.startsWith(`${moduleId}:`))
        .map((p) => p.kitId.slice(moduleId.length + 1)),
    );
    for (const g of required) {
      expect(present.has(g), `${moduleId} sweep-${i}: required ${g}`).toBe(
        true,
      );
    }
  }
  for (const [g, chance] of Object.entries(optional)) {
    const rate =
      samples.filter((s) =>
        s.pieces.some((p) => p.kitId === `${moduleId}:${g}`),
      ).length / samples.length;
    expect(
      rate,
      `${moduleId}: optional ${g} lands ${(rate * 100).toFixed(0)}% (chance ${chance})`,
    ).toBeGreaterThanOrEqual(chance - 0.2);
  }
}

/** A6 — same stream, same room: three fresh stagings byte-identical. */
function assertDeterminism(moduleId: string, extra: Parameters<typeof stageModuleRoom>[1]) {
  const a = stageModuleRoom(moduleId, { ...extra, stream: "a6-check" });
  const b = stageModuleRoom(moduleId, { ...extra, stream: "a6-check" });
  const c = stageModuleRoom(moduleId, { ...extra, stream: "a6-check" });
  expect(JSON.stringify(b.pieces)).toBe(JSON.stringify(a.pieces));
  expect(JSON.stringify(c.pieces)).toBe(JSON.stringify(a.pieces));
}

const byGroup = (s: StagedRoom, moduleId: string, group: string) =>
  s.pieces.filter((p) => p.kitId === `${moduleId}:${group}`);

/* ------------------------------------------------------------------ */
/* gallery-module                                                      */
/* ------------------------------------------------------------------ */

describe("gallery-module — the long LOOKING wall (room-plans/gallery-module.txt)", () => {
  const id = "gallery-module";

  it("passes the catalogue audit under its own 禁止栏", () => {
    expect(auditSchematic(roomSchematicFor(id)!)).toEqual([]);
  });

  it("required core lands in every sweep sample; optionals respect their floors", () => {
    const samples = sweep(id);
    assertGroupPresence(
      samples,
      id,
      [
        "art-1",
        "art-2",
        "art-3",
        "wash-w",
        "wash-e",
        "sculpture",
        "bench-w",
        "bench-e",
      ],
      { "art-4": 0.55, "art-5": 0.55, nook: 0.5, "plant-w": 0.6, "plant-e": 0.6 },
    );
  });

  it("keeps the floor ≤65% covered", () => {
    for (const [i, s] of sweep(id).entries()) {
      const ratio = coverageRatio(s.pieces, s.plan);
      expect(
        ratio,
        `sweep-${i}: coverage ${(ratio * 100).toFixed(0)}% > 65%`,
      ).toBeLessThanOrEqual(1 - KIT_EMPTY_FLOOR_MIN + 1e-9);
    }
  });

  it("nothing leaves the walkable band or blocks the entrance strip", () => {
    assertClearances(sweep(id), id);
  });

  it("A6 — three fresh stagings of the same slice are identical", () => {
    assertDeterminism(id, {});
  });

  it("the viewing wall reads as a gallery (realism §2, as measurements)", () => {
    const violations: string[] = [];
    const samples = sweep(id);
    for (const [i, s] of samples.entries()) {
      const e = s.plan.extent;
      const halfW = s.plan.width / 2;
      const arts = s.pieces.filter((p) => p.kind === "wallart");
      if (arts.length < 3 || arts.length > 5)
        violations.push(`sweep-${i}: ${arts.length} paintings staged`);
      for (const a of arts) {
        // hung on the focal wall, facing into the room (rotY ≈ π).
        if (a.z / e < 0.86 || a.z / e > 0.99)
          violations.push(`sweep-${i}: painting z=${(a.z / e).toFixed(2)} off the far wall`);
        if (Math.abs(norm(a.rotY - Math.PI)) > 0.25)
          violations.push(`sweep-${i}: painting rotY=${a.rotY.toFixed(2)} not facing the room`);
        if (Math.abs(a.x) / halfW > 0.92)
          violations.push(`sweep-${i}: painting x=${a.x.toFixed(2)} off the wall run`);
      }
      // washers 2m off the art wall, never mid-room.
      for (const g of ["wash-w", "wash-e"]) {
        for (const l of byGroup(s, id, g)) {
          if (l.z / e < 0.7 || l.z / e > 0.88)
            violations.push(`sweep-${i}: ${g} z=${(l.z / e).toFixed(2)} not washing the wall`);
        }
      }
      // benches face the art (rotY ≈ 0), mid-south, with a viewing
      // distance (authored metres — normalised by the room's scale,
      // the debug gallery draws colossal).
      const benches = [...byGroup(s, id, "bench-w"), ...byGroup(s, id, "bench-e")].filter(
        (p) => p.kind === "bench",
      );
      if (benches.length !== 2) violations.push(`sweep-${i}: ${benches.length} benches`);
      for (const b of benches) {
        if (Math.abs(norm(b.rotY)) > 0.2)
          violations.push(`sweep-${i}: bench rotY=${b.rotY.toFixed(2)} not facing the art`);
        if (b.z / e < 0.3 || b.z / e > 0.46)
          violations.push(`sweep-${i}: bench z=${(b.z / e).toFixed(2)} out of the viewing band`);
        const nearest = Math.min(...arts.map((a) => dist(a, b))) / s.scaleFactor;
        if (nearest < 3.2 || nearest > 8)
          violations.push(`sweep-${i}: bench ${nearest.toFixed(2)} authored-m off the art`);
      }
      // sculpture: a stone ON every pedestal (lifted, never floating).
      const pedestals = s.pieces.filter((p) => p.kind === "pedestal");
      const stones = s.pieces.filter((p) => p.kind === "standingstone");
      if (pedestals.length < 1 || pedestals.length > 2)
        violations.push(`sweep-${i}: ${pedestals.length} pedestals`);
      if (stones.length !== pedestals.length)
        violations.push(`sweep-${i}: ${stones.length} stones for ${pedestals.length} pedestals`);
      for (const st of stones) {
        if (st.dy < 0.8) violations.push(`sweep-${i}: stone dy=${st.dy.toFixed(2)} not on the cap`);
        if (!pedestals.some((pe) => dist(pe, st) < 0.15))
          violations.push(`sweep-${i}: stone floats off its pedestal`);
      }
      // axial discipline: the composition straddles the room axis.
      const meanAbsArt =
        arts.reduce((sum, a) => sum + Math.abs(a.x), 0) / Math.max(1, arts.length);
      if (meanAbsArt > halfW * 0.75)
        violations.push(`sweep-${i}: the art row drifted off the axis`);
    }
    expect(violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* dining-hall                                                         */
/* ------------------------------------------------------------------ */

describe("dining-hall — one long banquet table (room-plans/dining-hall.txt)", () => {
  const id = "dining-hall";

  it("passes the catalogue audit", () => {
    expect(auditSchematic(roomSchematicFor(id)!)).toEqual([]);
  });

  it("required core lands in every sweep sample; the rug respects its floor", () => {
    const samples = sweep(id);
    assertGroupPresence(
      samples,
      id,
      [
        "table-1",
        "table-2",
        "table-3",
        "table-4",
        "chair-n1",
        "chair-n2",
        "chair-n3",
        "chair-n4",
        "chair-s1",
        "chair-s2",
        "chair-s3",
        "chair-s4",
        "lamp-w",
        "lamp-e",
        "sideboard-w",
        "sideboard-e",
      ],
      { rug: 0.7 },
    );
  });

  it("keeps the floor ≤65% covered", () => {
    for (const [i, s] of sweep(id).entries()) {
      const ratio = coverageRatio(s.pieces, s.plan);
      expect(
        ratio,
        `sweep-${i}: coverage ${(ratio * 100).toFixed(0)}% > 65%`,
      ).toBeLessThanOrEqual(1 - KIT_EMPTY_FLOOR_MIN + 1e-9);
    }
  });

  it("nothing leaves the walkable band or blocks the entrance strip", () => {
    assertClearances(sweep(id), id);
  });

  it("A6 — three fresh stagings of the same slice are identical", () => {
    assertDeterminism(id, {});
  });

  it("the banquet reads as one table, squared chairs, served flanks (§2)", () => {
    const violations: string[] = [];
    const samples = sweep(id);
    for (const [i, s] of samples.entries()) {
      const e = s.plan.extent;
      const tables = s.pieces.filter((p) => p.kind === "diningtable");
      if (tables.length !== 4) violations.push(`sweep-${i}: ${tables.length} table segments`);
      const xs = tables.map((t) => t.x).sort((a, b) => a - b);
      for (let k = 1; k < xs.length; k++) {
        const gap = xs[k] - xs[k - 1];
        if (gap < 1.5 || gap > 2.0)
          violations.push(`sweep-${i}: table segments ${gap.toFixed(2)}m apart`);
      }
      const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
      if (Math.abs(meanX) > 0.4) violations.push(`sweep-${i}: the table left the axis`);
      for (const t of tables) {
        if (t.z < 7.2 || t.z > 7.7)
          violations.push(`sweep-${i}: table z=${t.z.toFixed(2)} out of the room's middle`);
      }
      // eight chairs, each pulled up to ITS segment and squared at it.
      const chairs = s.pieces.filter((p) => p.kind === "chair");
      if (chairs.length !== 8) violations.push(`sweep-${i}: ${chairs.length} chairs`);
      for (const c of chairs) {
        const host = tables.find((t) => Math.abs(t.x - c.x) < 0.9);
        if (!host) {
          violations.push(`sweep-${i}: chair @${c.x.toFixed(2)},${c.z.toFixed(2)} off every segment`);
          continue;
        }
        const d = dist(c, host);
        if (d < 0.85 || d > 1.3)
          violations.push(`sweep-${i}: chair ${d.toFixed(2)}m from its table segment`);
        const f = forward(c);
        const to = { x: host.x - c.x, z: host.z - c.z };
        const len = Math.hypot(to.x, to.z);
        if ((f.x * to.x + f.z * to.z) / len < 0.9)
          violations.push(`sweep-${i}: chair at ${c.x.toFixed(2)},${c.z.toFixed(2)} not facing its table`);
      }
      // the serving flank: sideboards on the dais wall, dressed on top.
      for (const g of ["sideboard-w", "sideboard-e"]) {
        for (const sb of byGroup(s, id, g)) {
          if (sb.z / e < 0.85)
            violations.push(`sweep-${i}: ${g} z=${(sb.z / e).toFixed(2)} not on the dais wall`);
        }
      }
      const dressing = s.pieces.filter(
        (p) => p.dy > 0.3 && ["tray", "candle", "vase", "frame"].includes(p.kind),
      );
      if (dressing.length < 2)
        violations.push(`sweep-${i}: only ${dressing.length} dressed tops`);
      for (const d of dressing) {
        const host = s.pieces.find(
          (h) =>
            (h.kind === "diningtable" || h.kind === "sideboard") &&
            h.kitIndex === d.kitIndex &&
            dist(h, d) < 0.6,
        );
        if (!host) violations.push(`sweep-${i}: ${d.kind} floats off its top`);
      }
      // 宴会厅备用词汇 never enters the schematic path.
      const stray = s.pieces.filter(
        (p) =>
          !p.trace &&
          ["chairstack", "towelstack", "bucket", "luggagecart"].includes(p.kind),
      );
      if (stray.length > 0)
        violations.push(`sweep-${i}: ${stray.map((p) => p.kind).join(",")} staged`);
    }
    expect(violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* sunroom                                                             */
/* ------------------------------------------------------------------ */

describe("sunroom — sitting before the glass (room-plans/sunroom.txt)", () => {
  const id = "sunroom";

  it("passes the catalogue audit", () => {
    expect(auditSchematic(roomSchematicFor(id)!)).toEqual([]);
  });

  it("required core lands in every sweep sample; optionals respect their floors", () => {
    const samples = sweep(id);
    assertGroupPresence(
      samples,
      id,
      ["tea-table", "chair-1", "chair-2", "plant-1", "plant-2"],
      { rug: 0.7, lamp: 0.6, "plant-3": 0.6, "plant-4": 0.6, sideboard: 0.55, fountain: 0.35 },
    );
    // The seating always carries the two glass-facing chairs and the
    // tea table (the lamp is the seeded accent).
    for (const [i, s] of samples.entries()) {
      const own = s.pieces.filter((p) => p.kitId.startsWith("sunroom:"));
      const count = (k: string) => own.filter((p) => p.kind === k).length;
      expect(count("readingchair"), `sweep-${i}: ${count("readingchair")} chairs`).toBe(2);
      expect(count("coffeetable"), `sweep-${i}: no tea table`).toBe(1);
    }
  });

  it("keeps the floor ≤65% covered", () => {
    for (const [i, s] of sweep(id).entries()) {
      const ratio = coverageRatio(s.pieces, s.plan);
      expect(
        ratio,
        `sweep-${i}: coverage ${(ratio * 100).toFixed(0)}% > 65%`,
      ).toBeLessThanOrEqual(1 - KIT_EMPTY_FLOOR_MIN + 1e-9);
    }
  });

  it("nothing leaves the walkable band or blocks the entrance strip", () => {
    assertClearances(sweep(id), id);
  });

  it("A6 — three fresh stagings of the same slice are identical", () => {
    assertDeterminism(id, {});
  });

  it("sitting before the glass holds (the room's signature, §2 rule 1)", () => {
    const violations: string[] = [];
    const samples = sweep(id);
    for (const [i, s] of samples.entries()) {
      const e = s.plan.extent;
      const chairs = s.pieces.filter((p) => p.kind === "readingchair");
      if (chairs.length !== 2) violations.push(`sweep-${i}: ${chairs.length} chairs`);
      for (const c of chairs) {
        // squared on the glass wall (rotY ≈ 0 = facing +z = the glass).
        if (Math.abs(norm(c.rotY)) > 0.15)
          violations.push(`sweep-${i}: chair rotY=${c.rotY.toFixed(2)} not facing the glass`);
        // a viewing band between the seat and the glass (12×6: the
        // chairs ride 1.8–2.05m off the glass, the plants 0.8–1.2m).
        if (e - c.z < 1.7 || e - c.z > 2.3)
          violations.push(`sweep-${i}: chair ${(e - c.z).toFixed(2)}m off the glass`);
      }
      // the tea table held between the pair.
      const table = s.pieces.find((p) => p.kind === "coffeetable");
      if (!table) violations.push(`sweep-${i}: no tea table`);
      else {
        if (Math.abs(table.x) > 0.4)
          violations.push(`sweep-${i}: tea table x=${table.x.toFixed(2)} off the axis`);
        if (Math.abs(chairs[0].x + chairs[1].x) > 0.5)
          violations.push(`sweep-${i}: the chair pair is not mirrored`);
        for (const c of chairs) {
          const d = dist(c, table);
          if (d < 1.2 || d > 1.7)
            violations.push(`sweep-${i}: chair ${d.toFixed(2)}m from the tea table`);
        }
      }
      // the plant band between the seats and the glass.
      const plants = s.pieces.filter((p) => p.kind === "plant");
      if (plants.length < 2) violations.push(`sweep-${i}: ${plants.length} plants`);
      for (const pl of plants) {
        if (chairs.length > 0 && pl.z <= Math.min(...chairs.map((c) => c.z)) - 0.2)
          violations.push(`sweep-${i}: a plant drifted behind the seats`);
        if (pl.z / e < 0.75 || pl.z / e > 0.92)
          violations.push(`sweep-${i}: plant z=${(pl.z / e).toFixed(2)} off the glass band`);
      }
      // the lamp, when it lands, within a seat's reach.
      const lamp = s.pieces.find((p) => p.kind === "floorlamp");
      if (lamp) {
        const nearest = Math.min(...chairs.map((c) => dist(c, lamp)));
        if (nearest > 1.35)
          violations.push(`sweep-${i}: lamp ${nearest.toFixed(2)}m from the nearest seat`);
      }
      // nothing dry-room or stray.
      const stray = s.pieces.filter(
        (p) => !p.trace && ["bed", "tv", "bench", "lounger"].includes(p.kind),
      );
      if (stray.length > 0)
        violations.push(`sweep-${i}: ${stray.map((p) => p.kind).join(",")} staged`);
    }
    expect(violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* pool-deck                                                           */
/* ------------------------------------------------------------------ */

describe("pool-deck — the dry edges of the water (room-plans/pool-deck.txt)", () => {
  const id = "pool-deck";

  it("passes the catalogue audit under its own 禁止栏", () => {
    expect(auditSchematic(roomSchematicFor(id)!)).toEqual([]);
  });

  it("required core lands in every sweep sample; optionals respect their floors", () => {
    const samples = sweep(id);
    assertGroupPresence(
      samples,
      id,
      [
        "lounger-w1",
        "lounger-w2",
        "lounger-e1",
        "lounger-e2",
        "umbrella-1",
        "bench-w",
        "ring-post",
        "towel-rail",
        "ladder",
        "board",
      ],
      { "umbrella-2": 0.5, "bench-w2": 0.4, "bench-e": 0.5, plant: 0.5 },
    );
  });

  it("keeps the floor ≤65% covered", () => {
    for (const [i, s] of sweep(id).entries()) {
      const ratio = coverageRatio(s.pieces, s.plan);
      expect(
        ratio,
        `sweep-${i}: coverage ${(ratio * 100).toFixed(0)}% > 65%`,
      ).toBeLessThanOrEqual(1 - KIT_EMPTY_FLOOR_MIN + 1e-9);
    }
  });

  it("nothing leaves the walkable band or blocks the entrance strip", () => {
    assertClearances(sweep(id), id);
  });

  it("A6 — three fresh stagings of the same slice are identical", () => {
    assertDeterminism(id, {});
  });

  it("every piece keeps out of the basin and the rill runnel (the water geometry)", () => {
    // The debug staging passes water: null, so the shared water check
    // cannot run there — this test emulates the exact rectangle the
    // renderer hands staging (space.tsx: waterRectFor(scaledRecipe))
    // and fails any piece centre inside the basin band or the WaterRill
    // runnel band. Trace pieces ride their already-validated hosts, so
    // they are exempt.
    const violations: string[] = [];
    const samples = sweep(id);
    const wr = waterRectFor(scaledRecipeFor(compileSpaceRecipe(`dbg-m:${id}`)).recipe)!;
    for (const [i, s] of samples.entries()) {
      const f = s.scaleFactor;
      const margin = KIT_PATH_CLEAR * s.propScale;
      const rillX0 = (0.86 - 0.5) * s.plan.width;
      const rillX1 = (0.94 - 0.5) * s.plan.width;
      const rillZ0 = 0.1 * s.plan.extent;
      const rillZ1 = 0.9 * s.plan.extent;
      for (const p of s.pieces) {
        if (p.trace) continue;
        if (
          Math.abs(p.x - wr.cx * f) < wr.halfX * f + margin &&
          Math.abs(p.z - wr.cz * f) < wr.halfZ * f + margin
        ) {
          violations.push(
            `sweep-${i}: ${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} stands in the basin`,
          );
        }
        if (
          p.x > rillX0 - 0.3 &&
          p.x < rillX1 + 0.3 &&
          p.z > rillZ0 - 0.3 &&
          p.z < rillZ1 + 0.3
        ) {
          violations.push(
            `sweep-${i}: ${p.kind}@${p.x.toFixed(2)},${p.z.toFixed(2)} stands in the rill runnel`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the deck reads as a pool deck (§2: seats square at the water)", () => {
    const violations: string[] = [];
    const samples = sweep(id);
    for (const [i, s] of samples.entries()) {
      const e = s.plan.extent;
      const cx = 0;
      const cz = e / 2;
      const loungers = s.pieces.filter((p) => p.kind === "lounger");
      if (loungers.length !== 4) violations.push(`sweep-${i}: ${loungers.length} loungers`);
      for (const l of loungers) {
        // squared at the basin (the room's focus).
        const f = forward(l);
        const to = { x: cx - l.x, z: cz - l.z };
        const len = Math.hypot(to.x, to.z);
        if ((f.x * to.x + f.z * to.z) / len < 0.55)
          violations.push(`sweep-${i}: lounger @${l.x.toFixed(2)},${l.z.toFixed(2)} not facing the water`);
        // on the dry flanks, never over the basin (water halfX 4.02 +
        // the piece-clear margin).
        if (Math.abs(l.x) < 4.5)
          violations.push(`sweep-${i}: lounger x=${l.x.toFixed(2)} inside the basin margin`);
      }
      // each flank pair staggers along its rim.
      const west = loungers.filter((l) => l.x < 0).sort((a, b) => a.z - b.z);
      const east = loungers.filter((l) => l.x > 0).sort((a, b) => a.z - b.z);
      for (const pair of [west, east]) {
        if (pair.length !== 2) {
          violations.push(`sweep-${i}: a flank pair has ${pair.length} loungers`);
          continue;
        }
        const gap = pair[1].z - pair[0].z;
        if (gap < 1.2 || gap > 3.4)
          violations.push(`sweep-${i}: flank pair staggered ${gap.toFixed(2)}m`);
      }
      // the working edge: ladder west, board east, on the north
      // waterline strip and squared at the pool (facing south).
      for (const g of ["ladder", "board"]) {
        for (const p of byGroup(s, id, g)) {
          if (p.z / e < 0.8 || p.z / e > 0.95)
            violations.push(`sweep-${i}: ${g} z=${(p.z / e).toFixed(2)} off the waterline`);
          if (Math.abs(norm(p.rotY - Math.PI)) > 0.25)
            violations.push(`sweep-${i}: ${g} rotY=${p.rotY.toFixed(2)} not facing the pool`);
        }
      }
      const ladder = byGroup(s, id, "ladder")[0];
      const board = byGroup(s, id, "board")[0];
      if (ladder && board && ladder.x > board.x)
        violations.push(`sweep-${i}: the ladder left the west end`);
      // the ring post steps off the water's west edge (basin edge
      // −4.02); the towel rail hangs by the west loungers.
      for (const p of byGroup(s, id, "ring-post")) {
        if (p.x > -4.6 || p.x < -5.4)
          violations.push(`sweep-${i}: ring post x=${p.x.toFixed(2)} off the west water edge`);
      }
      for (const p of byGroup(s, id, "towel-rail")) {
        if (p.x > -6.4)
          violations.push(`sweep-${i}: towel rail x=${p.x.toFixed(2)} not on the west wall`);
      }
    }
    expect(violations).toEqual([]);
  });
});
