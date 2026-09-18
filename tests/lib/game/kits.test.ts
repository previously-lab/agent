/**
 * Tests for the kit system (v0.11-room-interiors §3.1, N1). The contract
 * under test:
 *
 *  - placeKit is pure placement math: deterministic, offsets rotated with
 *    the renderer's three.js Y convention, scales multiplied through.
 *  - The sixteen interior kits match the doc's enumeration (N1's eight
 *    plus the abundance pass's eight): 3–6 pieces each, every offset
 *    inside the declared footprint disc, wall-anchored kits declaring
 *    their back offset, and a function with something to face (the
 *    pool hall's kits face the water).
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
 *  - Strand doors (v0.11-hotel-rooms B.11): every strand door's approach
 *    strip stays exactly as clear as the entrance's — no kit piece may
 *    land in the rectangle extending inward from a door's wall plane
 *    (inDoorApproach), on ANY plan shape (l-shape step/inner walls,
 *    colonnade far wall) and at ANY room scale (miniature included).
 */
import { describe, it, expect } from "vitest";
import {
  INTERIOR_KITS,
  kitsFor,
  placeKit,
  planArea,
  stageInteriorKits,
  type Kit,
  type KitZones,
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
import { createRng, deriveSubSeed, hashString, WORLD_SEED } from "@/lib/game/seed";
import {
  hostableWallsFor,
  inDoorApproach,
  placeRoomDoors,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import { wallSegmentsFor } from "@/lib/game/room-plan";
import {
  COLONNADE_BAY,
  HERO_CLEAR,
  KIT_COUNT_MAX,
  KIT_EMPTY_FLOOR_MIN,
  KIT_PATH_CLEAR,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  ROOM_DOOR_CLEAR_DEPTH,
  ROOM_DOOR_CLEAR_HALF,
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
  "suitcase", "luggagecart", "bell", "register", "towelstack",
  "lockerrow", "chair", "coatstand", "umbrellastand", "bucket", "tray",
  "bookpile",
  // The craft pass (2026-10): vanity/plant/pedestal/dining/clock/counter
  // roomcraft plus the pool hall's water-edge fittings.
  "vanity", "plant", "pedestal", "diningtable", "chairstack", "fountain",
  "poolbench", "ringpost", "grandfatherclock", "counter", "screen",
  "sideboard", "towelrail", "poolladder",
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
  // The abundance pass (2026-10): living/library corners, the salon's
  // conversation pair, and the pool hall's water-facing deck kits.
  "tv-corner",
  "bookshelf-run",
  "writing-desk",
  "sofa-group",
  "gallery-bench",
  "pool-loungers",
  "towel-station",
  "ring-post",
  // The craft pass (2026-10): roomcraft corners and the pool hall's
  // water-edge kits (fountain-court is the ballroom/library hero).
  "vanity-corner",
  "plant-pedestal",
  "clock-nook",
  "chair-stack",
  "sideboard",
  "fountain-court",
  "poolside-bench",
  "ladder-board",
  "towel-rail",
];

const kitById = (id: string): Kit => {
  const kit = INTERIOR_KITS.find((k) => k.id === id);
  if (!kit) throw new Error(`unknown kit ${id}`);
  return kit;
};

describe("kit data (§3.1)", () => {
  it("ships the twenty-five interior kits (N1's eight + the abundance pass's eight + the craft pass's nine)", () => {
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
    for (const archetype of ["hotel-room", "library", "ballroom", "pool-hall"]) {
      const heroes = kitsFor("interior", archetype, 16).filter(
        (k) => k.heroSlot,
      );
      expect(heroes.length).toBeGreaterThan(0);
    }
  });

  it("gives the pool hall a deck of water-facing kits (§3.1 pool set)", () => {
    const pool = kitsFor("interior", "pool-hall", 16);
    const waterFacing = pool.filter((k) => k.facing === "water");
    // Loungers + towel station + ring post: several DIFFERENT small
    // scenes around the same water — the anti-eight-luggage-carts bar.
    expect(waterFacing.length).toBeGreaterThanOrEqual(3);
    for (const k of waterFacing) {
      expect(k.archetypes).toEqual(["pool-hall"]);
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

  it("reads as several different scenes, never one kit many times (§6)", () => {
    // The "eight identical luggage carts in one yellow room" failure: with
    // sixteen kits in the deck, a furnished room must host a spread of kit
    // types, and no type may account for half the room's placements.
    for (const extent of [32, 64, 96]) {
      for (const sliceId of SLICE_IDS.slice(0, 24)) {
        const { pieces } = stageFor(sliceId, extent);
        const byIndex = new Map<number, string>();
        for (const p of pieces) byIndex.set(p.kitIndex, p.kitId);
        const ids = [...byIndex.values()];
        if (ids.length < 8) continue; // sparse small rooms are exempt
        expect(new Set(ids).size).toBeGreaterThanOrEqual(7);
        const counts = new Map<string, number>();
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const n of counts.values()) {
          expect(n).toBeLessThanOrEqual(Math.ceil(ids.length / 2));
        }
      }
    }
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

/* ------------------------------------------------------------------ */
/* Strand-door approach clearances (v0.11-hotel-rooms B.11).           */
/* ------------------------------------------------------------------ */

interface StagedWithDoors extends Staged {
  doors: RoomDoorPlacement[];
}

/**
 * Stage one room exactly the way space.tsx does (scaled plan dims,
 * S^0.75 prop scale, human-scale door clearance), with `doorCount`
 * strand doors composed onto every solid non-entrance wall — a superset
 * of the renderer's hostable set (it also excludes camera-facing sills),
 * so passing here is strictly stronger than the shipped configuration.
 */
function stagePlan(
  sliceId: string,
  plan: RoomPlan,
  scale: number,
  doorCount: number,
  baseExtent: number,
  archetype = "hotel-room",
): StagedWithDoors {
  const comp = composeRoom(sliceId, plan, scale);
  const propScale = Math.pow(scale, 0.75);
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scale, 0.35);
  const walls = wallSegmentsFor(plan, wallThick);
  const hostable = walls.map((w) => !w.entrance);
  const { doors } = placeRoomDoors(sliceId, plan, walls, hostable, doorCount);
  const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
  const pieces = stageInteriorKits({
    rng,
    archetype,
    plan,
    comp,
    baseArea: planArea(plan) / (scale * scale),
    baseExtent,
    propScale,
    wallThick,
    water: null,
    doors,
    heightAt: () => 0,
  });
  return { pieces, plan, comp, doors };
}

function stageWithDoors(
  sliceId: string,
  extent: number,
  doorCount: number,
  scale = 1,
  archetype = "hotel-room",
): StagedWithDoors {
  const plan = roomPlanFor(
    sliceId,
    extent * scale,
    extent * scale,
    COLONNADE_BAY * Math.sqrt(Math.max(scale, 0.35)),
  );
  return stagePlan(sliceId, plan, scale, doorCount, extent, archetype);
}

const lPlan = (extent: number, lSide: 1 | -1, stepZ: number): RoomPlan => ({
  id: "l-shape",
  width: extent,
  extent,
  lSide,
  stepZ,
  columns: [],
});

const colonnadePlan = (extent: number): RoomPlan => ({
  id: "colonnade",
  width: extent,
  extent,
  lSide: 1,
  stepZ: 0,
  columns: [],
});

describe("inDoorApproach (B.11 strip geometry)", () => {
  // One door on each wall orientation of a 16×16 rect, placed by hand.
  const handmade: RoomDoorPlacement[] = [
    { index: 0, wall: 0, x: -8, z: 8, nx: 1, nz: 0, along: 0, row: 0 }, // left wall
    { index: 1, wall: 1, x: 8, z: 8, nx: -1, nz: 0, along: 0, row: 0 }, // right wall
    { index: 2, wall: 2, x: 3, z: 16, nx: 0, nz: -1, along: 0, row: 0 }, // far wall
  ];

  it("flags the strip inward of each door's own wall and normal", () => {
    expect(inDoorApproach(-7, 8, handmade)).toBe(true); // 1m in from left
    expect(inDoorApproach(7, 8, handmade)).toBe(true); // 1m in from right
    expect(inDoorApproach(3, 15, handmade)).toBe(true); // 1m in from far
    expect(inDoorApproach(3, 16 - ROOM_DOOR_CLEAR_DEPTH + 0.1, handmade)).toBe(true);
  });

  it("does not flag outside the strip: behind the wall, past the depth, past the margin", () => {
    expect(inDoorApproach(-9, 8, handmade)).toBe(false); // behind the wall
    expect(inDoorApproach(-8 + ROOM_DOOR_CLEAR_DEPTH + 0.1, 8, handmade)).toBe(false);
    expect(inDoorApproach(-7, 8 + ROOM_DOOR_CLEAR_HALF + 0.1, handmade)).toBe(false);
    expect(inDoorApproach(-7, 8 - ROOM_DOOR_CLEAR_HALF - 0.1, handmade)).toBe(false);
    expect(inDoorApproach(0, 8, [])).toBe(false); // no doors, no strips
  });
});

describe("strand-door approach clearances (B.11)", () => {
  const DOOR_COUNTS = [1, 2, 4];

  it("keeps every strand door's strip clear of kit pieces (rect rooms)", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS.slice(0, 24)) {
        for (const n of DOOR_COUNTS) {
          const { pieces, doors } = stageWithDoors(sliceId, extent, n);
          expect(doors).toHaveLength(n);
          for (const p of pieces) {
            expect(inDoorApproach(p.x, p.z, doors)).toBe(false);
          }
        }
      }
    }
  });

  it("keeps strips clear on l-shape and colonnade plans (doors on step/inner/far walls)", () => {
    const plans = [
      lPlan(48, 1, 24),
      lPlan(48, -1, 21.6),
      colonnadePlan(64),
    ];
    let doorPiecesChecked = 0;
    for (const plan of plans) {
      for (const sliceId of SLICE_IDS.slice(0, 16)) {
        for (const n of DOOR_COUNTS) {
          const { pieces, doors } = stagePlan(sliceId, plan, 1, n, 48);
          expect(doors).toHaveLength(n);
          for (const p of pieces) {
            doorPiecesChecked += 1;
            expect(inDoorApproach(p.x, p.z, doors)).toBe(false);
          }
        }
      }
    }
    // The sweep must actually exercise furnished rooms with doors.
    expect(doorPiecesChecked).toBeGreaterThan(0);
  });

  it("keeps strips clear at miniature scale (the door and its approach never scale, A4)", () => {
    // Tier 32 at ×0.25 → an 8m dollhouse room; propScale = 0.25^0.75.
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      for (const n of [1, 2]) {
        const { pieces, doors, plan } = stageWithDoors(sliceId, 32, n, 0.25);
        expect(doors).toHaveLength(n);
        expect(plan.extent).toBeCloseTo(8, 6);
        for (const p of pieces) {
          expect(inDoorApproach(p.x, p.z, doors)).toBe(false);
        }
      }
    }
  });

  it("never swallows the entrance's approach or another door's (strip ≤ strip)", () => {
    for (const extent of [16, 32, 64]) {
      for (const sliceId of SLICE_IDS.slice(0, 24)) {
        const { doors } = stageWithDoors(sliceId, extent, 4);
        // The entrance approach corridor's midpoint stays outside every
        // strand door's strip.
        expect(inDoorApproach(0, 1.5, doors)).toBe(false);
        // No door's own approach (1m in front of it) is covered by a
        // DIFFERENT door's strip.
        for (const d of doors) {
          const others = doors.filter((o) => o.index !== d.index);
          expect(inDoorApproach(d.x + d.nx, d.z + d.nz, others)).toBe(false);
        }
      }
    }
  });

  it("keeps the existing clearances intact with strand doors present", () => {
    for (const extent of [16, 32, 64]) {
      for (const sliceId of SLICE_IDS.slice(0, 24)) {
        const { pieces, plan, comp } = stageWithDoors(sliceId, extent, 3);
        for (const p of pieces) {
          // Entrance doorway strip.
          expect(
            Math.abs(p.x) < PROP_DOOR_HALF && p.z < PROP_DOOR_DEPTH,
          ).toBe(false);
          // Inside the walkable footprint.
          expect(planContains(plan, p.x, p.z, 0)).toBe(true);
          // Off the cleared path (the path leads TO the hero — exempted).
          const nearHero =
            Math.hypot(p.x - comp.hero.x, p.z - comp.hero.z) <
            HERO_CLEAR + 3;
          if (!nearHero) {
            expect(distToPath(comp, p.x, p.z)).toBeGreaterThanOrEqual(
              comp.pathHalf + KIT_PATH_CLEAR - 1e-9,
            );
          }
        }
        // The ≥35%-empty-floor rule still holds (scaled coverage).
        expect(coverageOf({ pieces, plan, comp })).toBeLessThanOrEqual(
          1 - KIT_EMPTY_FLOOR_MIN + 1e-9,
        );
      }
    }
  });
});

describe("density with strand doors (B.11 cost report)", () => {
  it("prints the kit-count cost of door clearances per tier", () => {
    const archetypes = ["hotel-room", "library", "ballroom"] as const;
    for (const extent of TIERS) {
      let withDoorsTotal = 0;
      let baselineTotal = 0;
      let heroDropped = 0;
      let emptyRooms = 0;
      for (const sliceId of SLICE_IDS) {
        const archetype = archetypes[sliceId.length % archetypes.length];
        const baseline = stageFor(sliceId, extent, archetype);
        const withDoors = stageWithDoors(sliceId, extent, 3, 1, archetype);
        baselineTotal += kitCountOf(baseline.pieces);
        withDoorsTotal += kitCountOf(withDoors.pieces);
        const heroOf = (s: Staged) =>
          s.pieces.some(
            (p) =>
              Math.hypot(p.x - s.comp.hero.x, p.z - s.comp.hero.z) < 3.5,
          );
        if (heroOf(baseline) && !heroOf(withDoors)) heroDropped += 1;
        if (withDoors.pieces.length === 0) emptyRooms += 1;
      }
      console.log(
        `tier ${extent}m with 3 strand doors: kits ${withDoorsTotal} ` +
          `(baseline ${baselineTotal}, dropped ${baselineTotal - withDoorsTotal}), ` +
          `hero lost in ${heroDropped}/${SLICE_IDS.length} rooms, ` +
          `empty rooms ${emptyRooms}`,
      );
      // Door clearances shrink the available area by design; the room
      // settles for fewer kits rather than violating a strip. The cost
      // must stay modest — half the population vanishing would mean the
      // clearance is miscalibrated, not that the rooms are small.
      expect(withDoorsTotal).toBeGreaterThan(baselineTotal * 0.5);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Template zones (v0.11-room-interiors §7): the optional `zones` field  */
/* on KitStaging. ADDITIVE-ONLY PIN: the hashes below were captured from */
/* this module BEFORE the field existed, over the fixed matrix —         */
/* omitting it must reproduce today's staging byte-for-byte.            */
/* ------------------------------------------------------------------ */

describe("template zones parameter (§7) — additive", () => {
  const pin = (v: unknown) => {
    const s = JSON.stringify(v);
    return `${s.length}:${hashString(s)}`;
  };

  /** Replay of the capture chain: plan → composition → doors → staging. */
  function stageChain(
    sliceId: string,
    extent: number,
    archetype: string,
    widthFactor: number,
    withDoors: boolean,
    zones?: KitZones,
  ): StagedKitPiece[] {
    const width = extent * widthFactor;
    const plan = roomPlanFor(sliceId, width, extent, COLONNADE_BAY);
    const comp = composeRoom(sliceId, plan, 1);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const hostable = hostableWallsFor(plan, walls, 1);
    const doors = placeRoomDoors(sliceId, plan, walls, hostable, 3).doors;
    const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
    return stageInteriorKits({
      rng,
      archetype,
      plan,
      comp,
      baseArea: planArea(plan),
      baseExtent: extent,
      propScale: 1,
      wallThick: ROOM_WALL_THICKNESS,
      water: null,
      doors: withDoors ? doors : undefined,
      zones,
      heightAt: () => 0,
    });
  }

  /** [sliceId, extent, archetype, widthFactor, pinNoDoors, pinWithDoors].
   *  Recaptured 2026-10 after the kit deck grew from eight to sixteen:
   *  the pin's job is unchanged — omitting `zones` must reproduce the
   *  zones-less staging of the CURRENT deck byte-for-byte. Recaptured
   *  again 2026-10 for the craft pass (25 kits) + §10.5 axial doors. */
  const PINS: [string, number, string, number, string, string][] = [
    ["2026-10-11", 16, "hotel-room", 1, "6467:1955045619", "5385:1947765648"],
    ["2026-10-12", 32, "library", 1.5, "16696:1752736629", "16585:1666843699"],
    ["2026-10-13", 64, "ballroom", 0.66, "34289:2571048912", "32379:364227140"],
    ["2026-10-14", 96, "hotel-room", 1, "51582:402388874", "51528:2164671650"],
    ["2026-10-15", 32, "pool-hall", 1, "14553:3784513238", "15478:848847481"],
  ];

  it("reproduces the pre-zones staging byte-for-byte when omitted", () => {
    for (const [id, extent, arch, wf, pinNo, pinYes] of PINS) {
      expect(pin(stageChain(id, extent, arch, wf, false))).toBe(pinNo);
      expect(pin(stageChain(id, extent, arch, wf, true))).toBe(pinYes);
    }
  });

  it("treats an explicit undefined exactly as omitted", () => {
    expect(stageChain("2026-10-12", 32, "library", 1.5, true, undefined)).toEqual(
      stageChain("2026-10-12", 32, "library", 1.5, true),
    );
  });

  it("keeps every piece out of the keep-empty zones", () => {
    // Keep the whole floor empty except a central strip x ∈ (−2, 2).
    // The room is 42.24×64 (0.66 width factor): the two rects cover the
    // rest. Pieces may still land in the strip beyond the doorway apron.
    const zones: KitZones = {
      keepEmpty: [
        { x0: -21, z0: 0, x1: -2, z1: 64 },
        { x0: 2, z0: 0, x1: 32, z1: 64 },
      ],
    };
    const pieces = stageChain("2026-10-13", 64, "ballroom", 0.66, false, zones);
    expect(pieces.length).toBeGreaterThan(0);
    for (const p of pieces) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(2);
    }
  });

  it("restricts side kits to the cluster zones", () => {
    // One cluster pad in the room's south-east; nothing else.
    const zones: KitZones = {
      clusters: [{ x0: 10, z0: 30, x1: 28, z1: 55 }],
      keepEmpty: [{ x0: -32, z0: 0, x1: 32, z1: 12 }], // entry apron
    };
    const pieces = stageChain("2026-10-13", 64, "ballroom", 0.66, false, zones);
    const side = pieces.filter((p) => p.kitIndex > 0);
    expect(side.length).toBeGreaterThan(0);
    for (const p of side) {
      // A piece may ride its kit's offset out of the rect — the ORIGIN was
      // placed inside; footprints stay within 3m at scale 1.
      expect(p.x).toBeGreaterThanOrEqual(10 - 3);
      expect(p.x).toBeLessThanOrEqual(28 + 3);
      expect(p.z).toBeGreaterThanOrEqual(30 - 3);
      expect(p.z).toBeLessThanOrEqual(55 + 3);
    }
  });

  it("pins the hero kit into the hero zone when the kit is eligible", () => {
    // ballroom: dining is whitelisted and hero-eligible — the reading
    // hall's long-table pin works here.
    const zones: KitZones = {
      hero: { x0: 4, z0: 20, x1: 12, z1: 30 },
      heroKit: "dining",
    };
    const pieces = stageChain("2026-10-13", 64, "ballroom", 0.66, false, zones);
    const hero = pieces.filter((p) => p.kitIndex === 0);
    expect(hero.length).toBeGreaterThan(0);
    for (const p of hero) expect(p.kitId).toBe("dining");
    // The hero's origin is the zone rect's center (8, 25); its pieces
    // cluster around it.
    const cx = hero.reduce((s, p) => s + p.x, 0) / hero.length;
    const cz = hero.reduce((s, p) => s + p.z, 0) / hero.length;
    expect(Math.hypot(cx - 8, cz - 25)).toBeLessThan(2);
  });

  it("ignores a hero pin whose kit is not eligible for the room", () => {
    // library: dining is NOT whitelisted — the pin must degrade to the
    // seeded hero draw, never widen the whitelist by itself.
    const zones: KitZones = { heroKit: "dining" };
    const pieces = stageChain("2026-10-12", 32, "library", 1.5, false, zones);
    expect(pieces.filter((p) => p.kitId === "dining")).toHaveLength(0);
    expect(pieces.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* kitIds filter (the craft pass, 2026-10): KitStaging.kitIds restricts   */
/* the deck to a module's whitelist so composed rooms stage per module.   */
/* Omitting it must behave byte-for-byte as before.                       */
/* ------------------------------------------------------------------ */

describe("kitIds filter (module whitelists)", () => {
  function stageFiltered(
    sliceId: string,
    extent: number,
    archetype: string,
    kitIds?: readonly string[],
  ): StagedKitPiece[] {
    const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
    const comp = composeRoom(sliceId, plan, 1);
    const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
    return stageInteriorKits({
      rng,
      archetype,
      plan,
      comp,
      baseArea: planArea(plan),
      baseExtent: extent,
      propScale: 1,
      wallThick: ROOM_WALL_THICKNESS,
      water: null,
      kitIds,
      heightAt: () => 0,
    });
  }

  it("stages only whitelisted kits when kitIds is given", () => {
    // The bedroom module's whitelist (§8.2, 少而准).
    const whitelist = [
      "bed-corner",
      "writing-desk",
      "tv-corner",
      "luggage",
      "reading",
      "vanity-corner",
    ];
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      const pieces = stageFiltered(sliceId, 48, "hotel-room", whitelist);
      expect(pieces.length).toBeGreaterThan(0);
      for (const p of pieces) {
        expect(whitelist).toContain(p.kitId);
      }
    }
  });

  it("a one-kit whitelist stages that kit and nothing else", () => {
    for (const sliceId of SLICE_IDS.slice(0, 8)) {
      const pieces = stageFiltered(sliceId, 48, "library", ["bookshelf-run"]);
      for (const p of pieces) {
        expect(p.kitId).toBe("bookshelf-run");
      }
    }
  });

  it("omitting kitIds reproduces the unfiltered staging byte-for-byte", () => {
    for (const sliceId of SLICE_IDS.slice(0, 12)) {
      expect(stageFiltered(sliceId, 48, "hotel-room", undefined)).toEqual(
        stageFiltered(sliceId, 48, "hotel-room"),
      );
    }
  });

  it("an empty whitelist stages nothing (a module with no drawable kits)", () => {
    expect(stageFiltered("2026-10-0", 48, "hotel-room", [])).toHaveLength(0);
  });
});
