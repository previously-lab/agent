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
  KITS,
  kitsFor,
  placeKit,
  planArea,
  stageInteriorKits,
  TRACE_HOST_TOPS,
  TRACE_KINDS,
  traceVisible,
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
import { ROOM_MODULES } from "@/lib/game/room-modules";
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
  // The structure layer (v0.12-room-realism §2 — the living pilot's
  // vocabulary, drawn by room-schematic.ts's slots).
  "coffeetable", "mediaunit", "vase", "frame", "candle",
  // The v0.12 new-props pass (specs 附录 A + room-plans INDEX NEW PROPS):
  // wardrobe / storagerack / workbench / wallart / mop (the kitchen
  // worktop is the reshaped craft-pass `counter`).
  "wardrobe", "storagerack", "workbench", "wallart", "mop",
  // The nature set (§3.1 N4): the worn outdoor vocabulary + the reused
  // scatter kinds (log, mushroom, cairn, signpost).
  "standingstone", "boulder", "reeds", "firepit", "jettydeck", "moss",
  "ruinwall", "log", "mushroom", "cairn", "signpost",
  "yarn", "cattree", "scratchpost", "doghouse", "bone", "ball",
  // The wonder set (§3.1 N4): the diorama world's oversized playthings.
  "toyblock", "marblerun", "marblechute", "chessking", "chessrook",
  "chesspawn", "paperboat", "paperlantern", "swingframe", "swingseat",
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
  // The v0.12 new-props pass (specs 附录 A + room-plans INDEX NEW PROPS):
  // the kitchen worktop corner, the bedroom wardrobe wall, the luggage
  // rack, the workshop bench corner (workbench + storagerack), the gallery
  // hang, and the changing-room mop corner.
  "kitchen-counter",
  "wardrobe-wall",
  "storage-rack",
  "workbench-corner",
  "art-wall",
  "mop-corner",
];

/** The nature set (§3.1 N4) — the eight outdoor groups, in catalogue order. */
const NATURE_KIT_IDS = [
  "fallen-log",
  "stone-circle",
  "jetty",
  "fence-ruin",
  "campfire",
  "path-marker",
  "boulder-cluster",
  "reeds",
];

/** The wonder set (§3.1 N4) — the six diorama groups, in catalogue order. */
const WONDER_KIT_IDS = [
  "toy-blocks",
  "marble-run",
  "giant-chess",
  "paper-boats",
  "lantern-cluster",
  "swing-frame",
];

const kitById = (id: string): Kit => {
  const kit = KITS.find((k) => k.id === id);
  if (!kit) throw new Error(`unknown kit ${id}`);
  return kit;
};

describe("kit data (§3.1)", () => {
  it("ships the thirty-one interior kits (N1's eight + the abundance pass's eight + the craft pass's nine + the v0.12 new-props pass's six)", () => {
    expect(
      KITS.filter((k) => k.worldClasses.includes("interior")).map(
        (k) => k.id,
      ),
    ).toEqual(KIT_IDS);
  });

  it("keeps every kit inside the 3–6 piece rule", () => {
    for (const kit of KITS) {
      expect(kit.pieces.length).toBeGreaterThanOrEqual(3);
      expect(kit.pieces.length).toBeLessThanOrEqual(6);
    }
  });

  it("keeps every piece offset inside the declared footprint disc", () => {
    for (const kit of KITS) {
      for (const p of kit.pieces) {
        expect(Math.hypot(p.dx, p.dz)).toBeLessThanOrEqual(kit.footprint);
      }
    }
  });

  it("references only kinds the renderer can build", () => {
    for (const kit of KITS) {
      for (const p of kit.pieces) {
        expect(RENDERER_MOTIF_KINDS).toContain(p.kind);
      }
    }
  });

  it("lands every interior kit with a module whose whitelist deals it (§6: kind 与消费端同次落地)", () => {
    // The water-rill lesson: a kind no module's whitelist names is dead
    // data — staging can never draw it. Every hand-written interior kit
    // is referenced by at least one standard module (the deal still gates
    // on the kit's own world-class/archetype eligibility).
    // 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内。
    // These four pool-hall kits were dealt ONLY by the pool-deck hall's
    // whitelist; with the deck off MODULE_ORDER (its data dormant in
    // modules/public.ts) they have no on-registry dealer until the deck
    // returns or another module picks them up. The exemption is an
    // explicit dormancy list, not a softened assertion — anything NEW
    // here is the dead-data drift this test exists to catch.
    const DORMANT_ORPHANS = [
      "pool-loungers",
      "ring-post",
      "poolside-bench",
      "ladder-board",
    ];
    const whitelists = new Set(ROOM_MODULES.flatMap((m) => m.kits));
    for (const kit of KITS) {
      if (
        kit.worldClasses.includes("interior") &&
        !DORMANT_ORPHANS.includes(kit.id)
      ) {
        expect(
          whitelists.has(kit.id),
          `kit "${kit.id}" is dealt by no module whitelist`,
        ).toBe(true);
      }
    }
  });

  it("declares a back offset for every wall-anchored kit", () => {
    for (const kit of KITS) {
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

describe("nature kit data (§3.1 N4)", () => {
  const NATURE_BIOMES = [
    "meadow",
    "plains",
    "forest",
    "ocean",
    "lake",
    "beach",
    "snowfield",
  ] as const;

  it("ships the eight nature kits, in catalogue order", () => {
    expect(
      KITS.filter((k) => k.worldClasses.includes("nature")).map((k) => k.id),
    ).toEqual(NATURE_KIT_IDS);
  });

  it("gives every non-pool nature biome at least one hero-eligible kit", () => {
    for (const biome of NATURE_BIOMES) {
      const heroes = kitsFor("nature", biome, 96).filter((k) => k.heroSlot);
      expect(heroes.length).toBeGreaterThan(0);
    }
  });

  it("keeps the outdoor pool biome on its legacy fixture path (empty nature deck)", () => {
    // The pool IS its content — rim-anchored fixtures stay on the motif
    // scatter path; kits must not claim it.
    expect(kitsFor("nature", "pool", 96)).toHaveLength(0);
  });

  it("marks the shore kits water-bound and water-facing", () => {
    for (const id of ["jetty", "reeds"]) {
      const k = kitById(id);
      expect(k.shore).toBe(true);
      expect(k.intoWater).toBe(true);
      expect(k.facing).toBe("water");
    }
  });

  it("whitelists shore kits only for water biomes", () => {
    for (const biome of ["meadow", "plains", "forest", "snowfield"] as const) {
      expect(kitsFor("nature", biome, 96).some((k) => k.shore)).toBe(false);
    }
    for (const biome of ["lake", "beach", "ocean"] as const) {
      expect(kitsFor("nature", biome, 96).some((k) => k.shore)).toBe(true);
    }
  });

  it("declares a facing for every nature kit (§4: orientation is the relation)", () => {
    for (const id of NATURE_KIT_IDS) {
      expect(["path", "door", "hero", "center", "water"]).toContain(
        kitById(id).facing,
      );
    }
  });
});

describe("wonder kit data (§3.1 N4)", () => {
  const WONDER_ROOMS = ["ducks", "cats", "dogs", "balloons"] as const;

  it("ships the six wonder kits, in catalogue order", () => {
    expect(
      KITS.filter((k) => k.worldClasses.includes("wonder")).map((k) => k.id),
    ).toEqual(WONDER_KIT_IDS);
  });

  it("gives every wonder archetype at least one hero-eligible kit", () => {
    for (const room of WONDER_ROOMS) {
      const heroes = kitsFor("wonder", room, 96).filter((k) => k.heroSlot);
      expect(heroes.length).toBeGreaterThan(0);
    }
  });

  it("whitelists the paper boats to the duck pond (the wonder water room)", () => {
    expect(kitsFor("wonder", "ducks", 16).map((k) => k.id)).toContain(
      "paper-boats",
    );
    for (const room of ["cats", "dogs", "balloons"] as const) {
      expect(kitsFor("wonder", room, 16).map((k) => k.id)).not.toContain(
        "paper-boats",
      );
    }
  });

  it("declares a facing for every wonder kit (§4)", () => {
    for (const id of WONDER_KIT_IDS) {
      expect(["path", "door", "hero", "center", "water"]).toContain(
        kitById(id).facing,
      );
    }
  });

  it("stacks the toy blocks by dy, never floating unsupported (I2)", () => {
    const stacked = kitById("toy-blocks").pieces.filter((p) => (p.dy ?? 0) > 0);
    expect(stacked.length).toBeGreaterThan(0);
    for (const p of stacked) {
      // The only lifted block rests on the origin block's top (0.72).
      expect(Math.hypot(p.dx, p.dz)).toBeLessThan(0.1);
      expect(p.dy).toBeCloseTo(0.72, 2);
    }
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

/* ------------------------------------------------------------------ */
/* Nature staging (§3.1 N4) — the same machine on the outdoor deck.     */
/* ------------------------------------------------------------------ */

function stageNature(
  sliceId: string,
  extent: number,
  archetype: string,
  water: { cx: number; cz: number; halfX: number; halfZ: number } | null,
): Staged {
  const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
  const comp = composeRoom(sliceId, plan, 1);
  const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
  const pieces = stageInteriorKits({
    rng,
    worldClass: "nature",
    archetype,
    plan,
    comp,
    baseArea:
      planArea(plan) - (water ? water.halfX * 2 * water.halfZ * 2 : 0),
    baseExtent: extent,
    propScale: 1,
    wallThick: ROOM_WALL_THICKNESS,
    water,
    heightAt: () => 0,
  });
  return { pieces, plan, comp };
}

const LAKE_WATER_64 = { cx: 0, cz: 32, halfX: 16, halfZ: 16 };
const DRY_BIOMES = ["forest", "meadow", "plains", "snowfield"] as const;
const WATER_BIOMES = ["lake", "beach", "ocean"] as const;

describe("nature staging (§3.1 N4)", () => {
  it("is deterministic per sliceId (A6: same memory, same room)", () => {
    for (const archetype of [...DRY_BIOMES, ...WATER_BIOMES]) {
      for (const sliceId of SLICE_IDS.slice(0, 12)) {
        expect(
          stageNature(sliceId, 64, archetype, LAKE_WATER_64).pieces,
        ).toEqual(stageNature(sliceId, 64, archetype, LAKE_WATER_64).pieces);
      }
    }
  });

  it("places a hero in the far third, on dry ground, in water biomes too", () => {
    // The hero retry exists because the composed focal point can land in
    // the basin; the retried hero must still be far-third and out of the
    // water (its kit is never intoWater) — on waterside rooms it stands
    // on the far bank, the composed focal point of a flooded room. A
    // room whose every candidate failed (rare) grows no hero: kitIndex 0
    // then belongs to a side kit, which the heroSlot check filters out.
    const heroIds = new Set(
      kitsFor("nature", "lake", 96)
        .filter((k) => k.heroSlot)
        .map((k) => k.id),
    );
    let heroRooms = 0;
    for (const sliceId of SLICE_IDS) {
      const { pieces } = stageNature(sliceId, 64, "lake", LAKE_WATER_64);
      const zero = pieces.filter((p) => p.kitIndex === 0);
      const zeroIds = new Set(zero.map((p) => p.kitId));
      const isHero = zeroIds.size > 0 && [...zeroIds].every((id) => heroIds.has(id));
      if (!isHero) continue;
      heroRooms += 1;
      for (const p of zero) {
        expect(p.z).toBeGreaterThan(64 * 0.6);
        expect(
          Math.abs(p.x - LAKE_WATER_64.cx) < LAKE_WATER_64.halfX &&
            Math.abs(p.z - LAKE_WATER_64.cz) < LAKE_WATER_64.halfZ,
        ).toBe(false);
      }
    }
    expect(heroRooms).toBeGreaterThanOrEqual(SLICE_IDS.length * 0.85);
  });

  it("keeps every non-shore piece out of the water", () => {
    const shoreKits = new Set(["jetty", "reeds"]);
    for (const sliceId of SLICE_IDS.slice(0, 24)) {
      const { pieces } = stageNature(sliceId, 64, "lake", LAKE_WATER_64);
      for (const p of pieces) {
        if (shoreKits.has(p.kitId)) continue;
        expect(
          Math.abs(p.x - LAKE_WATER_64.cx) < LAKE_WATER_64.halfX &&
            Math.abs(p.z - LAKE_WATER_64.cz) < LAKE_WATER_64.halfZ,
        ).toBe(false);
      }
    }
  });

  it("kept every clearance: footprint, doorway, path, 留白", () => {
    for (const archetype of [...DRY_BIOMES, ...WATER_BIOMES]) {
      for (const extent of [16, 32, 64, 96]) {
        const water = WATER_BIOMES.includes(archetype as "lake")
          ? {
              cx: 0,
              cz: extent * 0.5,
              halfX: extent * 0.25,
              halfZ: extent * 0.25,
            }
          : null;
        for (const sliceId of SLICE_IDS.slice(0, 16)) {
          const staged = stageNature(sliceId, extent, archetype, water);
          expect(coverageOf(staged)).toBeLessThanOrEqual(
            1 - KIT_EMPTY_FLOOR_MIN + 1e-9,
          );
          for (const p of staged.pieces) {
            expect(planContains(staged.plan, p.x, p.z, 0)).toBe(true);
            expect(
              Math.abs(p.x) < PROP_DOOR_HALF && p.z < PROP_DOOR_DEPTH,
            ).toBe(false);
            const nearHero =
              Math.hypot(p.x - staged.comp.hero.x, p.z - staged.comp.hero.z) <
              HERO_CLEAR + 3;
            if (!nearHero && !p.trace) {
              expect(distToPath(staged.comp, p.x, p.z)).toBeGreaterThanOrEqual(
                staged.comp.pathHalf + KIT_PATH_CLEAR - 1e-9,
              );
            }
          }
        }
      }
    }
  });

  it("drops the shore kits when the room has no water", () => {
    // A lake-archetype deck has shore kits; staging it dry must not draw
    // a single jetty section or reed clump.
    for (const sliceId of SLICE_IDS.slice(0, 24)) {
      const { pieces } = stageNature(sliceId, 64, "lake", null);
      expect(pieces.some((p) => p.kitId === "jetty" || p.kitId === "reeds")).toBe(
        false,
      );
    }
  });

  it("actually places shore kits across a water sweep (the channel is alive)", () => {
    let withShore = 0;
    for (const sliceId of SLICE_IDS) {
      const { pieces } = stageNature(sliceId, 64, "lake", LAKE_WATER_64);
      if (pieces.some((p) => p.kitId === "jetty" || p.kitId === "reeds")) {
        withShore += 1;
      }
    }
    expect(withShore).toBeGreaterThan(SLICE_IDS.length / 4);
  });

  it("reads as several different scenes, never one kit many times (§6)", () => {
    for (const sliceId of SLICE_IDS.slice(0, 24)) {
      const { pieces } = stageNature(sliceId, 64, "forest", null);
      const byIndex = new Map<number, string>();
      for (const p of pieces) byIndex.set(p.kitIndex, p.kitId);
      const ids = [...byIndex.values()];
      if (ids.length < 6) continue;
      expect(new Set(ids).size).toBeGreaterThanOrEqual(4);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The §4.4 trace — the room's exactly-one calm trace, on a visible     */
/* host. Both world classes run the same selection.                     */
/* ------------------------------------------------------------------ */

/** Hosts eligible for a trace under the visibility rule (the mirror of
 *  the selection logic in stageInteriorKits — kept small on purpose). */
function visibleHostCount(
  pieces: StagedKitPiece[],
  comp: Composition,
  propScale: number,
  extent: number,
): number {
  const carriedBy = new Set<number>();
  for (const p of pieces) {
    if ((TRACE_KINDS as readonly string[]).includes(p.kind) && p.dy > 0) {
      carriedBy.add(p.kitIndex);
    }
  }
  return pieces.filter(
    (p) =>
      TRACE_HOST_TOPS[p.kind] !== undefined &&
      !carriedBy.has(p.kitIndex) &&
      traceVisible(comp, p.x, p.z, propScale, extent),
  ).length;
}

/** The §4.4 invariants: at most one trace everywhere; exactly one with a
 *  visible host (zero otherwise); it rides a real host inside the
 *  visibility band and its kind is whitelisted. */
function checkTraceRules(
  pieces: StagedKitPiece[],
  comp: Composition,
  propScale: number,
  extent: number,
) {
  const traces = pieces.filter((p) => p.trace);
  expect(traces.length).toBeLessThanOrEqual(1);
  if (visibleHostCount(pieces, comp, propScale, extent) > 0) {
    expect(traces).toHaveLength(1);
    const t = traces[0];
    expect(TRACE_KINDS).toContain(t.kind);
    const host = pieces.find(
      (p) => p !== t && p.x === t.x && p.z === t.z,
    );
    expect(host).toBeDefined();
    expect(TRACE_HOST_TOPS[host!.kind]).toBeDefined();
  } else {
    expect(traces).toHaveLength(0);
  }
}

describe("the §4.4 trace", () => {
  it("obeys the exactly-one rule across the interior sweep", () => {
    for (const extent of TIERS) {
      for (const sliceId of SLICE_IDS) {
        const { pieces, comp } = stageFor(sliceId, extent);
        checkTraceRules(pieces, comp, 1, extent);
      }
    }
  });

  it("obeys the exactly-one rule across the nature sweep", () => {
    for (const archetype of [...DRY_BIOMES, ...WATER_BIOMES]) {
      for (const sliceId of SLICE_IDS.slice(0, 16)) {
        const { pieces, comp } = stageNature(
          sliceId,
          64,
          archetype,
          WATER_BIOMES.includes(archetype as "lake") ? LAKE_WATER_64 : null,
        );
        checkTraceRules(pieces, comp, 1, 64);
      }
    }
  });

  it("actually places traces across the sweep (the selector is alive)", () => {
    let interiorTraced = 0;
    for (const sliceId of SLICE_IDS) {
      if (stageFor(sliceId, 64).pieces.some((p) => p.trace)) interiorTraced += 1;
    }
    expect(interiorTraced).toBeGreaterThan(SLICE_IDS.length / 2);
    let natureTraced = 0;
    for (const sliceId of SLICE_IDS) {
      if (
        stageNature(sliceId, 64, "forest", null).pieces.some((p) => p.trace)
      ) {
        natureTraced += 1;
      }
    }
    expect(natureTraced).toBeGreaterThan(SLICE_IDS.length / 4);
  });

  it("is deterministic per sliceId (A6: same memory, same trace)", () => {
    const traceOf = (pieces: StagedKitPiece[]) =>
      pieces.filter((p) => p.trace).map((p) => [p.kind, p.x, p.z, p.kitId]);
    for (const sliceId of SLICE_IDS.slice(0, 12)) {
      expect(traceOf(stageFor(sliceId, 64).pieces)).toEqual(
        traceOf(stageFor(sliceId, 64).pieces),
      );
      expect(traceOf(stageNature(sliceId, 64, "lake", LAKE_WATER_64).pieces)).toEqual(
        traceOf(stageNature(sliceId, 64, "lake", LAKE_WATER_64).pieces),
      );
    }
  });

  it("stays calm (§6): only whitelisted kinds, never a horror prop", () => {
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      for (const p of stageFor(sliceId, 32).pieces) {
        if (!p.trace) continue;
        expect(["bookpile", "tray", "towelstack"]).toContain(p.kind);
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
   *  again 2026-10 for the craft pass (25 kits) + §10.5 axial doors, and
   *  again for the nature pass + §4.4 trace: the trace is an additive
   *  piece (a room with no eligible host stages byte-for-byte as before —
   *  the 16 m pin is unchanged), and rooms that grew one changed hash,
   *  as every additive pin capture has. Recaptured a fourth time 2026-10
   *  for the §6 anti-repetition cap (KIT_ROOM_CAP — the room-wide draw
   *  re-deal) and the open-field piece-reach margin: both intentionally
   *  steer kit selection and field positions, so the pins that moved,
   *  moved for the audit item, not by accident. Recaptured a fifth time
   *  for the v0.12 new-props pass (31 kits — the six NEW PROPS groups
   *  widen every interior deal): the 16 m no-door pin moves too this
   *  time — a wider deck shifts the deal even where the cap never
   *  binds. Recaptured a sixth time for the v0.13 module grid: only the
   *  WITH-doors pins move (strand doors reseat onto lattice cell centers,
   *  shifting their approach strips); the no-door pins are unchanged. */
  const PINS: [string, number, string, number, string, string][] = [
    ["2026-10-11", 16, "hotel-room", 1, "6060:535184652", "5986:3747424891"],
    ["2026-10-12", 32, "library", 1.5, "17717:2165748283", "17699:1570385866"],
    ["2026-10-13", 64, "ballroom", 0.66, "30230:83039979", "29165:4262870438"],
    ["2026-10-14", 96, "hotel-room", 1, "31847:1835721113", "30879:1633728112"],
    ["2026-10-15", 32, "pool-hall", 1, "16558:2811097141", "16370:1042149808"],
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

describe("openFields channel (§8.2 随机区域 — the sparse dressing)", () => {
  // Two module-scale voids inside a 48×48 plan: one west field, one east.
  const FIELDS = [
    { x0: -20, z0: 10, x1: -8, z1: 22 },
    { x0: 8, z0: 26, x1: 20, z1: 38 },
  ] as const;

  function stageFields(
    sliceId: string,
    openFields?: readonly (typeof FIELDS)[number][],
  ): StagedKitPiece[] {
    const extent = 48;
    const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
    const comp = composeRoom(sliceId, plan, 1);
    const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
    return stageInteriorKits({
      rng,
      archetype: "hotel-room",
      plan,
      comp,
      baseArea: planArea(plan),
      baseExtent: extent,
      propScale: 1,
      wallThick: ROOM_WALL_THICKNESS,
      water: null,
      ...(openFields ? { openFields } : {}),
      heightAt: () => 0,
    });
  }

  /** Placements whose CENTER falls inside a field rect — the field pieces. */
  function fieldPieces(
    pieces: StagedKitPiece[],
  ): Map<number, (typeof FIELDS)[number]> {
    const byIndex = new Map<number, StagedKitPiece>();
    for (const p of pieces) {
      // A placement's first piece carries its origin-ish center well enough
      // for the inside-the-field grouping.
      if (!byIndex.has(p.kitIndex)) byIndex.set(p.kitIndex, p);
    }
    const out = new Map<number, (typeof FIELDS)[number]>();
    for (const [kitIndex, p] of byIndex) {
      const f = FIELDS.find(
        (r) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1,
      );
      if (f) out.set(kitIndex, f);
    }
    return out;
  }

  it("is deterministic per sliceId (A6)", () => {
    for (const sliceId of SLICE_IDS.slice(0, 12)) {
      expect(stageFields(sliceId, FIELDS)).toEqual(stageFields(sliceId, FIELDS));
    }
  });

  it("omitting openFields reproduces the pre-dressing staging byte-for-byte", () => {
    for (const sliceId of SLICE_IDS.slice(0, 12)) {
      expect(stageFields(sliceId, undefined)).toEqual(stageFields(sliceId));
    }
  });

  it("dresses each field with at most OPEN_FIELD_PIECE_MAX placements — and side kits never spill in", () => {
    for (const sliceId of SLICE_IDS) {
      // Mirror the composed room: side kits are restricted to cluster
      // zones (the modules' rects), which do NOT overlap the fields — so
      // every placement inside a field came from the openFields channel.
      const extent = 48;
      const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
      const pieces = stageInteriorKits({
        rng,
        archetype: "hotel-room",
        plan,
        comp,
        baseArea: planArea(plan),
        baseExtent: extent,
        propScale: 1,
        wallThick: ROOM_WALL_THICKNESS,
        water: null,
        openFields: FIELDS,
        zones: {
          // Hero pinned to the center strip's far third — module zones
          // never overlap the fields in a real composition either.
          hero: { x0: -6, z0: 30, x1: 6, z1: 38 },
          clusters: [{ x0: -6, z0: 6, x1: 6, z1: 42 }],
        },
        heightAt: () => 0,
      });
      const inFields = fieldPieces(pieces);
      const perField = new Map<(typeof FIELDS)[number], number>();
      for (const f of inFields.values()) {
        perField.set(f, (perField.get(f) ?? 0) + 1);
      }
      for (const n of perField.values()) {
        expect(n).toBeLessThanOrEqual(3);
      }
    }
  });

  it("fields actually get dressed across a sweep (the channel is alive)", () => {
    // Not every field of every room dresses (0 is a legal draw — 少而准),
    // but across 48 rooms the two fields must sometimes host pieces.
    let dressed = 0;
    for (const sliceId of SLICE_IDS) {
      if (fieldPieces(stageFields(sliceId, FIELDS)).size > 0) dressed += 1;
    }
    expect(dressed).toBeGreaterThan(SLICE_IDS.length / 4);
  });

  it("field pieces keep every clearance (path, doorway, footprint, 留白)", () => {
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      const extent = 48;
      const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
      const pieces = stageInteriorKits({
        rng,
        archetype: "hotel-room",
        plan,
        comp,
        baseArea: planArea(plan),
        baseExtent: extent,
        propScale: 1,
        wallThick: ROOM_WALL_THICKNESS,
        water: null,
        openFields: FIELDS,
        // The hero is exempt from the path check by design (the path leads
        // TO it) — pin it to the center strip so only true field pieces
        // land inside the fields.
        zones: {
          hero: { x0: -6, z0: 30, x1: 6, z1: 38 },
          clusters: [{ x0: -6, z0: 6, x1: 6, z1: 42 }],
        },
        heightAt: () => 0,
      });
      const staged: Staged = { pieces, plan, comp };
      const inFields = fieldPieces(pieces);
      for (const [kitIndex, f] of inFields) {
        for (const p of pieces.filter((q) => q.kitIndex === kitIndex)) {
          expect(planContains(plan, p.x, p.z, 0)).toBe(true);
          expect(
            Math.abs(p.x) < PROP_DOOR_HALF && p.z < PROP_DOOR_DEPTH,
          ).toBe(false);
          expect(
            distToPath(comp, p.x, p.z),
          ).toBeGreaterThanOrEqual(comp.pathHalf + KIT_PATH_CLEAR - 1e-9);
          expect(p.x >= f.x0 && p.x <= f.x1 && p.z >= f.z0 && p.z <= f.z1).toBe(
            true,
          );
        }
      }
      // And the global 65% coverage cap still binds with fields dressed.
      expect(coverageOf(staged)).toBeLessThanOrEqual(1 - KIT_EMPTY_FLOOR_MIN + 1e-9);
    }
  });

  it("respects a module whitelist when dressing (the fields draw from the room's own deck)", () => {
    const whitelist = ["luggage", "coat-bench"];
    const extent = 48;
    for (const sliceId of SLICE_IDS.slice(0, 16)) {
      const plan = roomPlanFor(sliceId, extent, extent, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
      const pieces = stageInteriorKits({
        rng,
        archetype: "hotel-room",
        plan,
        comp,
        baseArea: planArea(plan),
        baseExtent: extent,
        propScale: 1,
        wallThick: ROOM_WALL_THICKNESS,
        water: null,
        kitIds: whitelist,
        openFields: FIELDS,
        heightAt: () => 0,
      });
      for (const p of pieces) expect(whitelist).toContain(p.kitId);
    }
  });
});
