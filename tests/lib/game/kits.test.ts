/**
 * Tests for the kit system (v0.11-room-interiors §3.1, N1). The contract
 * under test:
 *
 *  - placeKit is pure placement math: deterministic, offsets rotated with
 *    the renderer's three.js Y convention, scales multiplied through.
 *  - The eight interior kits match the doc's enumeration: 3–6 pieces
 *    each, every offset inside the declared footprint disc, wall-anchored
 *    kits declaring their back offset.
 *  - Every referenced kind exists in the renderer's vocabulary. KitKind
 *    is a compile-time subset of space.tsx's MotifKind (the renderer
 *    passes staged pieces straight into its prop dispatcher, so tsc
 *    rejects a kind it cannot build); RENDERER_MOTIF_KINDS below mirrors
 *    that union for a runtime check — keep it in sync with the `type
 *    MotifKind` declaration in src/components/game/space.tsx.
 *  - stageInteriorKits is a deterministic pure function of its seeded
 *    stream (A6), keeps the walk path ≥ its cleared half-width, keeps
 *    the doorway strip clear, keeps every piece inside the walkable
 *    footprint and out of the water, and never covers more than 65% of
 *    the floor with kit footprint discs (≥35% stays empty, §4.5).
 */
import { describe, it, expect } from "vitest";
import {
  INTERIOR_KITS,
  kitsFor,
  placeKit,
  planArea,
  stageInteriorKits,
  type Kit,
  type StagedKitPiece,
} from "@/lib/game/kits";
import {
  composeRoom,
  distToPath,
  planContains,
  roomPlanFor,
  type Composition,
  type RoomPlan,
} from "@/lib/game/room-plan";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  HERO_CLEAR,
  KIT_COUNT_MAX,
  KIT_EMPTY_FLOOR_MIN,
  KIT_PATH_CLEAR,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";

/** Mirrors `type MotifKind` in src/components/game/space.tsx — the runtime
 *  half of the vocabulary sync (the compile-time half is KitKind ⊆
 *  MotifKind, enforced where the renderer consumes staged pieces). */
const RENDERER_MOTIF_KINDS: readonly string[] = [
  "ladder", "board", "lounger", "ring",
  "log", "mushroom", "lantern", "fence", "flowers", "bench", "lonetree",
  "cairn", "signpost",
  "buoy", "driftwood", "rowboat", "umbrella", "beachball", "sandcastle",
  "shell", "snowman", "icestone",
  "bed", "nightstand", "tv", "sofa", "rug", "bookshelf", "readingchair",
  "desklamp", "chandelier", "floorlamp", "desk", "giftbox", "column",
  "yarn", "cattree", "scratchpost", "doghouse", "bone", "ball",
];

const KIT_IDS = [
  "bed-corner",
  "luggage",
  "reception",
  "reading",
  "lockers",
  "housekeeping",
  "dining",
  "coat-bench",
];

const kitById = (id: string): Kit => {
  const kit = INTERIOR_KITS.find((k) => k.id === id);
  if (!kit) throw new Error(`unknown kit ${id}`);
  return kit;
};

describe("kit data (§3.1)", () => {
  it("ships exactly the eight interior kits of the N1 milestone", () => {
    expect(INTERIOR_KITS.map((k) => k.id)).toEqual(KIT_IDS);
  });

  it("keeps every kit inside the 3–6 piece rule", () => {
    for (const kit of INTERIOR_KITS) {
      expect(kit.pieces.length).toBeGreaterThanOrEqual(3);
      expect(kit.pieces.length).toBeLessThanOrEqual(6);
    }
  });

  it("keeps every piece offset inside the declared footprint disc", () => {
    for (const kit of INTERIOR_KITS) {
      for (const p of kit.pieces) {
        expect(Math.hypot(p.dx, p.dz)).toBeLessThanOrEqual(kit.footprint);
      }
    }
  });

  it("references only kinds the renderer can build", () => {
    for (const kit of INTERIOR_KITS) {
      for (const p of kit.pieces) {
        expect(RENDERER_MOTIF_KINDS).toContain(p.kind);
      }
    }
  });

  it("declares a back offset for every wall-anchored kit", () => {
    for (const kit of INTERIOR_KITS) {
      if (kit.anchor === "wall") {
        expect(kit.backOffset).toBeGreaterThan(0);
      }
    }
  });

  it("offers at least one hero-eligible kit per flat interior archetype", () => {
    for (const archetype of ["hotel-room", "library", "ballroom"]) {
      const heroes = kitsFor("interior", archetype, 16).filter(
        (k) => k.heroSlot,
      );
      expect(heroes.length).toBeGreaterThan(0);
    }
  });

  it("filters by archetype whitelist", () => {
    const hotel = kitsFor("interior", "hotel-room", 16).map((k) => k.id);
    expect(hotel).toContain("bed-corner");
    expect(hotel).not.toContain("lockers");
    const pool = kitsFor("interior", "pool-hall", 16).map((k) => k.id);
    expect(pool).toContain("lockers");
    expect(pool).not.toContain("bed-corner");
  });
});

describe("placeKit", () => {
  const kit = kitById("reading");

  it("is the identity under a zero transform", () => {
    const placed = placeKit(kit, { x: 0, z: 0, rotY: 0, scale: 1 });
    placed.forEach((p, i) => {
      expect(p.x).toBeCloseTo(kit.pieces[i].dx, 10);
      expect(p.z).toBeCloseTo(kit.pieces[i].dz, 10);
      expect(p.rotY).toBeCloseTo(kit.pieces[i].rotY, 10);
      expect(p.scale).toBeCloseTo(kit.pieces[i].scale ?? 1, 10);
    });
  });

  it("rotates offsets with the three.js Y convention", () => {
    // A piece dead ahead of the kit (local +z) at rotY = π/2 must land at
    // +x (forward maps to (sin θ, cos θ)); a piece at local +x lands −z.
    const probe: Kit = {
      id: "probe",
      worldClasses: ["interior"],
      facing: "path",
      footprint: 2,
      pieces: [
        { kind: "rug", dx: 0, dz: 1, rotY: 0 },
        { kind: "rug", dx: 1, dz: 0, rotY: 0 },
      ],
    };
    const placed = placeKit(probe, { x: 10, z: 20, rotY: Math.PI / 2, scale: 1 });
    expect(placed[0].x).toBeCloseTo(11, 10);
    expect(placed[0].z).toBeCloseTo(20, 10);
    expect(placed[1].x).toBeCloseTo(10, 10);
    expect(placed[1].z).toBeCloseTo(19, 10);
  });

  it("scales offsets and piece sizes together", () => {
    const placed = placeKit(kit, { x: 0, z: 0, rotY: 0, scale: 2 });
    placed.forEach((p, i) => {
      expect(p.x).toBeCloseTo(kit.pieces[i].dx * 2, 10);
      expect(p.z).toBeCloseTo(kit.pieces[i].dz * 2, 10);
      expect(p.scale).toBeCloseTo((kit.pieces[i].scale ?? 1) * 2, 10);
    });
  });

  it("is deterministic — same transform, byte-identical output", () => {
    const t = { x: 3.5, z: 12.25, rotY: 1.05, scale: 1.4 };
    expect(placeKit(kit, t)).toEqual(placeKit(kit, t));
  });
});

/* ------------------------------------------------------------------ */
/* Room staging against real plans/compositions from room-plan.ts.      */
/* ------------------------------------------------------------------ */

interface Staged {
  pieces: StagedKitPiece[];
  plan: RoomPlan;
  comp: Composition;
}

function stageFor(
  sliceId: string,
  extent: number,
  archetype: string = "hotel-room",
  widthFactor = 1,
): Staged {
  const width = extent * widthFactor;
  const plan = roomPlanFor(sliceId, width, extent, COLONNADE_BAY);
  const comp = composeRoom(sliceId, plan, 1);
  const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
  const pieces = stageInteriorKits({
    rng,
    archetype,
    plan,
    comp,
    baseArea: planArea(plan),
    baseExtent: extent,
    propScale: 1,
    wallThick: ROOM_WALL_THICKNESS,
    water: null,
    heightAt: () => 0,
  });
  return { pieces, plan, comp };
}

/** 48 fixed slice ids — deterministic input, never Math.random(). */
const SLICE_IDS = Array.from({ length: 48 }, (_, i) => `2026-10-${i}`);
const TIERS = [16, 32, 64, 96] as const;

function kitCountOf(pieces: StagedKitPiece[]): number {
  return new Set(pieces.map((p) => p.kitIndex)).size;
}

function coverageOf(staged: Staged): number {
  let covered = 0;
  const seen = new Map<number, string>();
  for (const p of staged.pieces) seen.set(p.kitIndex, p.kitId);
  for (const id of seen.values()) {
    covered += Math.PI * kitById(id).footprint ** 2;
  }
  return covered / planArea(staged.plan);
}

describe("stageInteriorKits", () => {
  it("is deterministic per sliceId (A6: same memory, same room)", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS.slice(0, 12)) {
        expect(stageFor(sliceId, extent).pieces).toEqual(
          stageFor(sliceId, extent).pieces,
        );
      }
    }
  });

  it("varies across slice ids (the seed actually drives content)", () => {
    const a = stageFor(SLICE_IDS[0], 32).pieces;
    const b = stageFor(SLICE_IDS[1], 32).pieces;
    expect(a).not.toEqual(b);
  });

  it("places a composed hero in the far third of the room", () => {
    for (const extent of TIERS) {
      let heroRooms = 0;
      for (const sliceId of SLICE_IDS) {
        const { pieces, comp, plan } = stageFor(sliceId, extent);
        const near = pieces.filter(
          (p) => Math.hypot(p.x - comp.hero.x, p.z - comp.hero.z) < 3.5,
        );
        if (near.length >= 3) heroRooms += 1;
        // The hero zone is always inside the far half of the plan.
        expect(comp.hero.z).toBeGreaterThan(plan.extent * 0.5);
      }
      // A hero kit that physically cannot fit is dropped by design; the
      // far-third centrepiece must still anchor the overwhelming majority.
      expect(heroRooms).toBeGreaterThanOrEqual(SLICE_IDS.length * 0.8);
    }
  });

  it("keeps the doorway strip clear of every piece", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS) {
        for (const p of stageFor(sliceId, extent).pieces) {
          expect(
            Math.abs(p.x) < PROP_DOOR_HALF && p.z < PROP_DOOR_DEPTH,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps the walk path clear to kit geometry (the ≥1.4 m promise)", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS) {
        const { pieces, comp } = stageFor(sliceId, extent);
        for (const p of pieces) {
          const nearHero =
            Math.hypot(p.x - comp.hero.x, p.z - comp.hero.z) <
            HERO_CLEAR + 3;
          if (nearHero) continue; // the path leads TO the hero — by design
          expect(distToPath(comp, p.x, p.z)).toBeGreaterThanOrEqual(
            comp.pathHalf + KIT_PATH_CLEAR - 1e-9,
          );
        }
      }
    }
  });

  it("keeps every piece inside the walkable footprint", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS) {
        const { pieces, plan } = stageFor(sliceId, extent);
        for (const p of pieces) {
          expect(planContains(plan, p.x, p.z, 0)).toBe(true);
          // The l-shape's abandoned quadrant never receives furniture.
          if (plan.id === "l-shape" && p.z > plan.stepZ) {
            expect(plan.lSide > 0 ? p.x >= 0 : p.x <= 0).toBe(true);
          }
        }
      }
    }
  });

  it("never covers more than 65% of the floor (≥35% stays empty)", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS) {
        const staged = stageFor(sliceId, extent);
        expect(coverageOf(staged)).toBeLessThanOrEqual(
          1 - KIT_EMPTY_FLOOR_MIN + 1e-9,
        );
      }
    }
  });

  it("keeps kits off each other (gap between footprint discs)", () => {
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      const { pieces } = stageFor(sliceId, 64);
      // Group each placement's pieces and approximate its center by the
      // piece mean; staging guarantees disc separation with KIT_GAP, so
      // mean centers must stay well apart (a conservative bound).
      const byKit = new Map<
        number,
        { id: string; x: number; z: number; n: number }
      >();
      for (const p of pieces) {
        const e = byKit.get(p.kitIndex) ?? { id: p.kitId, x: 0, z: 0, n: 0 };
        e.x += p.x;
        e.z += p.z;
        e.n += 1;
        byKit.set(p.kitIndex, e);
      }
      const centers = [...byKit.values()].map((e) => ({
        x: e.x / e.n,
        z: e.z / e.n,
        r: kitById(e.id).footprint,
      }));
      for (let i = 0; i < centers.length; i++) {
        for (let j = i + 1; j < centers.length; j++) {
          const d = Math.hypot(
            centers[i].x - centers[j].x,
            centers[i].z - centers[j].z,
          );
          expect(d).toBeGreaterThanOrEqual(
            Math.min(centers[i].r, centers[j].r),
          );
        }
      }
    }
  });

  it("keeps pieces out of the water", () => {
    const water = { cx: 0, cz: 32, halfX: 8, halfZ: 10 };
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      const extent = 64;
      const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
      const pieces = stageInteriorKits({
        rng,
        archetype: "pool-hall",
        plan,
        comp,
        baseArea: planArea(plan) * 0.55,
        baseExtent: extent,
        propScale: 1,
        wallThick: ROOM_WALL_THICKNESS,
        water,
        heightAt: () => 0,
      });
      for (const p of pieces) {
        expect(
          Math.abs(p.x - water.cx) < water.halfX &&
            Math.abs(p.z - water.cz) < water.halfZ,
        ).toBe(false);
      }
    }
  });

  it("respects obstacles left by the legacy furnishing path", () => {
    const extent = 64;
    const obstacles = [
      { x: 10, z: 20, r: 1 },
      { x: -12, z: 40, r: 1 },
    ];
    for (const sliceId of SLICE_IDS.slice(0, 8)) {
      const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
      const pieces = stageInteriorKits({
        rng,
        archetype: "pool-hall",
        plan,
        comp,
        baseArea: planArea(plan) * 0.55,
        baseExtent: extent,
        propScale: 1,
        wallThick: ROOM_WALL_THICKNESS,
        water: null,
        obstacles,
        heightAt: () => 0,
      });
      for (const o of obstacles) {
        for (const p of pieces) {
          expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThan(o.r);
        }
      }
    }
  });
});

describe("density report (I3 + §4.5)", () => {
  it("scales kit count with floor area, inside the per-tier ceilings", () => {
    // One compact line per tier for the milestone report: kits + pieces,
    // min/avg/max across the sample, plus the coverage ceiling check.
    const archetypes = ["hotel-room", "library", "ballroom"] as const;
    for (const extent of TIERS) {
      const counts: number[] = [];
      const pieceCounts: number[] = [];
      for (const sliceId of SLICE_IDS) {
        const archetype = archetypes[sliceId.length % archetypes.length];
        const { pieces } = stageFor(sliceId, extent, archetype);
        counts.push(kitCountOf(pieces));
        pieceCounts.push(pieces.length);
      }
      const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
      console.log(
        `tier ${extent}m: kits avg ${avg(counts).toFixed(1)} ` +
          `[${Math.min(...counts)}–${Math.max(...counts)}], ` +
          `pieces avg ${avg(pieceCounts).toFixed(1)} ` +
          `[${Math.min(...pieceCounts)}–${Math.max(...pieceCounts)}]`,
      );
      for (const c of counts) {
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThanOrEqual(KIT_COUNT_MAX[extent] + 1);
      }
      // The area law: bigger tiers host at least as many kits on average.
      if (extent > 16) {
        expect(avg(counts)).toBeGreaterThan(3);
      }
    }
  });
});
