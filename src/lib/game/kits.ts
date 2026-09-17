/**
 * Kits (v0.11-room-interiors §3.1) — the room's content is authored as
 * small hand-written GROUPS, not scattered singles. The diagnosis behind
 * the module: the old rooms did not feel empty because they had too few
 * objects, but because the objects had no relationships. A kit is 3–6
 * pieces with relative offsets and orientations (a reading corner =
 * armchair + side table + floor lamp + book supply + rug), placed as one
 * unit that FACES something — the path, the door, the hero, the water.
 *
 * Pure module: no three.js, no React, no wall clock, no Math.random.
 * Everything is data plus placement math over the caller's seeded RNG
 * stream, so the same slice always rebuilds the same room (axiom A6).
 *
 * COORDINATES. A kit is authored in a local frame at human scale: the
 * kit's origin is its arrangement center, its FORWARD is +z, and pieces
 * carry (dx, dz) offsets plus a facing relative to that forward (rotY 0 =
 * facing the kit's forward). `placeKit` maps the local frame into the
 * room with the same convention the renderer uses everywhere: a three.js
 * Y-rotation θ maps +z to (sin θ, cos θ) and +x to (cos θ, −sin θ), so
 * facing a target is always rotY = atan2(tx − x, tz − z).
 *
 * VOCABULARY. Kit pieces only reference prop kinds the renderer already
 * knows how to build (the MotifKind union in components/game/space.tsx —
 * no new geometry in this milestone). `KitKind` is a strict subset of
 * that union; the renderer passes staged pieces straight into its prop
 * dispatcher, so TypeScript rejects any kit kind the renderer drops, and
 * tests/lib/game/kits.test.ts mirrors the full list for a runtime check.
 */
import {
  distToPath,
  planContains,
  type Composition,
  type RoomPlan,
} from "./room-plan";
import {
  HERO_CLEAR,
  KIT_AREA_PER_KIT,
  KIT_COUNT_MAX,
  KIT_EMPTY_FLOOR_MIN,
  KIT_GAP,
  KIT_PATH_CLEAR,
  KIT_PLACE_ATTEMPTS,
  KIT_WALL_CLEAR,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
} from "./tuning/room";

/** Prop kinds kits may reference — a strict subset of the renderer's
 *  MotifKind union (see the module header for the sync contract). */
export type KitKind =
  | "bed"
  | "nightstand"
  | "desklamp"
  | "rug"
  | "giftbox"
  | "bench"
  | "desk"
  | "readingchair"
  | "floorlamp"
  | "bookshelf"
  | "umbrella";

/** What a free-standing kit's forward faces (orientation is the point —
 *  a kit that is just a scatter of three props is a failure). Wall-anchored
 *  kits ignore this: their back goes to the wall and they face the room. */
export type KitFacing = "path" | "door" | "hero" | "center" | "water";

/** One piece of a kit, in the kit's local frame (meters, human scale). */
export interface KitPiece {
  kind: KitKind;
  dx: number;
  dz: number;
  /** Facing inside the kit, relative to the kit's forward (+local z). */
  rotY: number;
  /** Per-piece size multiplier (default 1). */
  scale?: number;
}

/** A hand-written furnishing group (§3.1). */
export interface Kit {
  id: string;
  /** World classes that may draw this kit. */
  worldClasses: readonly string[];
  /** Optional archetype whitelist (a hotel room never gets pool lockers…
   *  unless the pool-hall's changing corner says so). */
  archetypes?: readonly string[];
  /** Minimum unscaled extent tier that may draw this kit. */
  minExtent?: number;
  /** Eligible for the far-third hero slot as a COMPOSED centrepiece (I5). */
  heroSlot?: boolean;
  /** "wall": the kit is pushed against a solid wall, its local −z (back)
   *  flush to it, and faces the room — beds, shelf rows, coat benches are
   *  wall furniture, and wall-anchoring is half of what makes a room read
   *  as arranged rather than dropped. Free kits (undefined) stand loose. */
  anchor?: "wall";
  /** Wall-anchored kits: distance from the kit origin to its rearmost
   *  piece's back edge (m, human scale) — how far off the wall the origin
   *  sits. Required when anchor === "wall". */
  backOffset?: number;
  /** What the kit faces when free-standing. */
  facing: KitFacing;
  /** Footprint disc radius (m, human scale). Every piece offset sits
   *  inside it, and placement keeps the whole disc clear of other kits —
   *  the disc is the kit's breathing room, and the sum of discs is how
   *  the ≥35%-empty-floor budget (§4.5) is accounted. */
  footprint: number;
  pieces: readonly KitPiece[];
}

/** Where and how one kit instance is set down. `scale` multiplies both
 *  the piece offsets and the piece sizes (kits grow with the room's prop
 *  scale exactly as single props do). */
export interface KitTransform {
  x: number;
  z: number;
  rotY: number;
  scale: number;
}

/** One kit piece in absolute room coordinates. */
export interface PlacedKitPiece {
  kind: KitKind;
  x: number;
  z: number;
  rotY: number;
  scale: number;
}

/**
 * Map a kit into the room: offsets rotated by θ (three.js Y convention:
 * x′ = dx·cosθ + dz·sinθ, z′ = −dx·sinθ + dz·cosθ), translated to (x, z),
 * facings summed, scales multiplied. Pure and deterministic.
 */
export function placeKit(kit: Kit, t: KitTransform): PlacedKitPiece[] {
  const c = Math.cos(t.rotY);
  const s = Math.sin(t.rotY);
  return kit.pieces.map((p) => {
    const dx = p.dx * t.scale;
    const dz = p.dz * t.scale;
    return {
      kind: p.kind,
      x: t.x + dx * c + dz * s,
      z: t.z - dx * s + dz * c,
      rotY: t.rotY + p.rotY,
      scale: (p.scale ?? 1) * t.scale,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The eight interior kits (§3.1, N1). Pieces reference only existing   */
/* renderer kinds — substitutions are marked where the doc's piece has  */
/* no exact kind yet (no new geometry in this milestone).               */
/* ------------------------------------------------------------------ */

export const INTERIOR_KITS: readonly Kit[] = [
  {
    // 床 + 两床头柜 + 台灯 + 地毯 — the hotel-room signature. Headboard
    // (the bed's local −z) to the wall, lamp beside the right nightstand,
    // rug under the foot of the bed.
    id: "bed-corner",
    worldClasses: ["interior"],
    archetypes: ["hotel-room"],
    heroSlot: true,
    anchor: "wall",
    backOffset: 1.15,
    facing: "path",
    footprint: 2.7,
    pieces: [
      { kind: "rug", dx: 0, dz: 0.55, rotY: 0, scale: 1.3 },
      { kind: "bed", dx: 0, dz: 0, rotY: 0 },
      { kind: "nightstand", dx: -1.3, dz: -0.75, rotY: 0 },
      { kind: "nightstand", dx: 1.3, dz: -0.75, rotY: 0 },
      { kind: "desklamp", dx: 1.85, dz: -0.75, rotY: 0 },
    ],
  },
  {
    // 两三只箱包 + 行李车 — the calm trace (I4): someone's bags, waiting.
    // SUBSTITUTIONS: no suitcase or luggage-cart kinds exist — giftboxes
    // stand in for the luggage (a lidded box reads as a hatbox/suitcase)
    // and a low bench for the cart/rack.
    id: "luggage",
    worldClasses: ["interior"],
    facing: "door",
    footprint: 1.4,
    pieces: [
      { kind: "bench", dx: 0, dz: -0.3, rotY: 0 },
      { kind: "giftbox", dx: 0.42, dz: 0.45, rotY: 0.3 },
      { kind: "giftbox", dx: -0.35, dz: 0.5, rotY: -0.25, scale: 0.85 },
      { kind: "giftbox", dx: 0.02, dz: 0.95, rotY: 0.15, scale: 0.9 },
    ],
  },
  {
    // 柜台 + 铃 + 登记簿 + 椅 — the greeter: counter with the clerk's
    // chair behind it, facing the door. SUBSTITUTIONS: the bell is a
    // small desklamp beside the counter (a small lit object is the
    // closest "service point" kind), the register book a half-size
    // giftbox at the counter's end.
    id: "reception",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    anchor: "wall",
    backOffset: 1.4,
    facing: "door",
    footprint: 1.7,
    pieces: [
      { kind: "desk", dx: 0, dz: 0, rotY: 0 },
      { kind: "readingchair", dx: 0, dz: -1.05, rotY: 0 },
      { kind: "desklamp", dx: 0.9, dz: -0.3, rotY: 0 },
      { kind: "giftbox", dx: -0.85, dz: 0.35, rotY: 0.2, scale: 0.5 },
    ],
  },
  {
    // 扶手椅 + 边桌 + 落地灯 + 书堆 — the reading corner, chair facing
    // the room (and the hero when free-standing). SUBSTITUTIONS: the side
    // table is a nightstand; the book pile is a bookshelf behind the
    // chair (no loose-book kind exists).
    id: "reading",
    worldClasses: ["interior"],
    archetypes: ["library", "hotel-room", "ballroom"],
    heroSlot: true,
    anchor: "wall",
    backOffset: 1.4,
    facing: "hero",
    footprint: 1.8,
    pieces: [
      { kind: "rug", dx: 0.05, dz: 0.35, rotY: 0, scale: 0.9 },
      { kind: "readingchair", dx: 0, dz: 0, rotY: 0 },
      { kind: "nightstand", dx: 0.8, dz: -0.1, rotY: 0 },
      { kind: "floorlamp", dx: -0.75, dz: -0.35, rotY: 0 },
      { kind: "bookshelf", dx: -0.05, dz: -1.15, rotY: 0 },
    ],
  },
  {
    // 一排储物柜，其中一扇虚掩 — a cabinet row along the wall, the middle
    // unit pulled slightly forward: the "one ajar" beat, kept calm (I4).
    // SUBSTITUTION: no locker kind exists — bookshelves are the closest
    // tall cabinet geometry.
    id: "lockers",
    worldClasses: ["interior"],
    archetypes: ["pool-hall", "library", "ballroom"],
    anchor: "wall",
    backOffset: 0.25,
    facing: "center",
    footprint: 2.9,
    pieces: [
      { kind: "bookshelf", dx: -1.9, dz: 0, rotY: 0 },
      { kind: "bookshelf", dx: 0, dz: 0.18, rotY: 0.06 },
      { kind: "bookshelf", dx: 1.9, dz: 0, rotY: 0 },
    ],
  },
  {
    // 推车 + 毛巾堆 + 水桶 — housekeeping, paused mid-round (calm, never
    // abandoned-in-a-hurry — I4). SUBSTITUTIONS: the cart is a low bench,
    // the towel piles small giftboxes; the bucket is omitted (no close
    // kind) — the kit stays inside the 3–6 piece rule regardless.
    id: "housekeeping",
    worldClasses: ["interior"],
    facing: "path",
    footprint: 1.3,
    pieces: [
      { kind: "bench", dx: 0, dz: 0, rotY: 0, scale: 0.9 },
      { kind: "giftbox", dx: 0.55, dz: 0.45, rotY: 0.2, scale: 0.8 },
      { kind: "giftbox", dx: 0.45, dz: 0.95, rotY: -0.15, scale: 0.65 },
    ],
  },
  {
    // 餐桌 + 两椅 + 桌布 + 餐具 — two chairs facing each other across the
    // table. SUBSTITUTIONS: the tablecloth is a rug under the setting
    // (nothing may float — I2 — so floor dressing carries it), the
    // tableware a small lamp beside the table as the centrepiece.
    id: "dining",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom"],
    heroSlot: true,
    facing: "path",
    footprint: 1.85,
    pieces: [
      { kind: "rug", dx: 0, dz: 0, rotY: 0, scale: 1.15 },
      { kind: "desk", dx: 0, dz: 0, rotY: 0 },
      { kind: "readingchair", dx: 0, dz: 0.85, rotY: Math.PI },
      { kind: "readingchair", dx: 0, dz: -0.85, rotY: 0 },
      { kind: "desklamp", dx: 0.85, dz: 0.3, rotY: 0, scale: 1.1 },
    ],
  },
  {
    // 衣帽架 + 长凳 + 伞架 — the threshold corner. SUBSTITUTIONS: no
    // coat-rack kind exists — a floor lamp at 0.9 scale stands in (a tall
    // slim pole beside the bench); the umbrella kind plays the umbrella
    // stand, drawn smaller.
    id: "coat-bench",
    worldClasses: ["interior"],
    anchor: "wall",
    backOffset: 0.35,
    facing: "path",
    footprint: 1.5,
    pieces: [
      { kind: "bench", dx: 0, dz: 0, rotY: 0 },
      { kind: "floorlamp", dx: -0.95, dz: -0.15, rotY: 0, scale: 0.9 },
      { kind: "umbrella", dx: 0.95, dz: -0.15, rotY: 0, scale: 0.7 },
    ],
  },
];

/** Kits a room of this class/archetype/tier may draw. */
export function kitsFor(
  worldClass: string,
  archetype: string,
  baseExtent: number,
): readonly Kit[] {
  return INTERIOR_KITS.filter(
    (k) =>
      k.worldClasses.includes(worldClass) &&
      (!k.archetypes || k.archetypes.includes(archetype)) &&
      (k.minExtent === undefined || baseExtent >= k.minExtent),
  );
}

/* ------------------------------------------------------------------ */
/* Room staging (§4) — the replacement for uniform scatter on interior  */
/* rooms. Pure: every decision rides the caller's seeded RNG.           */
/* ------------------------------------------------------------------ */

export interface KitWater {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

export interface KitStaging {
  /** Seeded stream for this room's kit layer (one stream per room, drawn
   *  in a fixed order — determinism is the whole point). */
  rng: () => number;
  archetype: string;
  /** The SCALED plan and composition (what the renderer built). */
  plan: RoomPlan;
  comp: Composition;
  /** UNSCALED floor area (m²) driving the density target — the authored
   *  population is a function of the human-scale tier, then the scale
   *  notation stretches the space around it (the scatter convention). */
  baseArea: number;
  /** UNSCALED extent tier (16/32/64/96) for the density table. */
  baseExtent: number;
  /** The room's prop scale (S^0.75) — kits grow exactly as props do. */
  propScale: number;
  /** Perimeter wall thickness (scaled, m). */
  wallThick: number;
  water: KitWater | null;
  /** Already-occupied discs kits must not touch (e.g. a pool-hall's
   *  water-anchored fixtures placed by the legacy furnishing path). */
  obstacles?: readonly { x: number; z: number; r: number }[];
  /** Terrain snap for piece y (the shared heightfield). */
  heightAt: (x: number, z: number) => number;
}

/** One staged piece, ready for the renderer's prop dispatcher. */
export interface StagedKitPiece extends PlacedKitPiece {
  y: number;
  kitId: string;
  /** Serial of the kit PLACEMENT this piece belongs to (the same kit type
   *  can be set down several times in one room) — also a stable render
   *  key. The hero placement is 0. */
  kitIndex: number;
}

/** Walkable floor area of a plan (m²): the bounding box minus the
 *  l-shape's abandoned quadrant. */
export function planArea(plan: RoomPlan): number {
  let area = plan.width * plan.extent;
  if (plan.id === "l-shape") {
    area -= (plan.width / 2) * (plan.extent - plan.stepZ);
  }
  return area;
}

function insideWater(
  x: number,
  z: number,
  water: KitWater,
  margin: number,
): boolean {
  return (
    Math.abs(x - water.cx) < water.halfX + margin &&
    Math.abs(z - water.cz) < water.halfZ + margin
  );
}

/** Nearest point on the composition's path (door → bend → hero) to (x, z). */
function nearestOnPath(
  comp: Composition,
  x: number,
  z: number,
): { x: number; z: number } {
  const a = { x: 0, z: 0 };
  const b = { x: comp.path.bx, z: comp.path.bz };
  const c = comp.hero;
  let best = a;
  let bestD = Infinity;
  for (const [p, q] of [
    [a, b],
    [b, c],
  ] as const) {
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len2 = dx * dx + dz * dz;
    const t =
      len2 === 0
        ? 0
        : Math.min(1, Math.max(0, ((x - p.x) * dx + (z - p.z) * dz) / len2));
    const px = p.x + t * dx;
    const pz = p.z + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) {
      bestD = d;
      best = { x: px, z: pz };
    }
  }
  return best;
}

/** The kit's facing, resolved to a rotY (three.js convention: facing a
 *  target = atan2(tx − x, tz − z)). Wall-anchored kits are rotated by
 *  their wall instead — see drawKitTransform. */
function facingRotY(
  facing: KitFacing,
  x: number,
  z: number,
  comp: Composition,
  water: KitWater | null,
): number {
  switch (facing) {
    case "path": {
      const p = nearestOnPath(comp, x, z);
      return Math.atan2(p.x - x, p.z - z);
    }
    case "door":
      return Math.atan2(-x, -z);
    case "hero":
      return Math.atan2(comp.hero.x - x, comp.hero.z - z);
    case "center":
      // Face the room's central axis from wherever the kit stands.
      return Math.atan2(-x, 0);
    case "water":
      return water
        ? Math.atan2(water.cx - x, water.cz - z)
        : Math.atan2(-x, -z);
  }
}

/** Candidate walls for an anchored kit: both sides and the far wall,
 *  except colonnade plans, whose sides are open bays (far wall only).
 *  The entrance wall is never an anchor — the doorway zone stays clear. */
type AnchorWall = "left" | "right" | "far";

function anchorWalls(plan: RoomPlan): readonly AnchorWall[] {
  return plan.id === "colonnade"
    ? ["far"]
    : ["left", "right", "far"];
}

/**
 * Draw a transform for one kit candidate. Wall-anchored kits try each
 * candidate wall in a seeded order: back flush to the wall (origin at
 * wallThick + backOffset·scale off it), facing the room; free kits draw
 * a uniform position and face their declared target. Returns null when
 * the draw is structurally impossible (e.g. no room left on that wall).
 */
function drawKitTransform(
  rng: () => number,
  kit: Kit,
  plan: RoomPlan,
  comp: Composition,
  water: KitWater | null,
  scale: number,
  wallInset: number,
): KitTransform | null {
  const halfW = plan.width / 2;
  const { extent } = plan;
  const back = (kit.backOffset ?? 0) * scale;

  if (kit.anchor === "wall") {
    const walls = anchorWalls(plan);
    const start = Math.floor(rng() * walls.length);
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[(start + i) % walls.length];
      const inset = wallInset + back;
      if (wall === "far") {
        // Beyond an l-shape's step only the kept half has a far wall.
        const lo =
          plan.id === "l-shape" && plan.lSide > 0
            ? wallInset
            : -halfW + wallInset;
        const hi =
          plan.id === "l-shape" && plan.lSide < 0
            ? -wallInset
            : halfW - wallInset;
        if (hi - lo < 0.5) continue;
        const x = lo + rng() * (hi - lo);
        // Facing the room from the far wall = facing the door (−z): π.
        return { x, z: extent - inset, rotY: Math.PI, scale };
      }
      const zLo = wallInset + 0.5;
      const zHi = extent - wallInset - 0.5;
      if (zHi - zLo < 0.5) continue;
      const z = zLo + rng() * (zHi - zLo);
      if (wall === "left") {
        // Back to the −x wall, facing +x: rotY = π/2.
        return { x: -halfW + inset, z, rotY: Math.PI / 2, scale };
      }
      // Back to the +x wall, facing −x: rotY = −π/2.
      return { x: halfW - inset, z, rotY: -Math.PI / 2, scale };
    }
    return null;
  }

  const m = wallInset + 0.2 * scale;
  const xLo = -halfW + m;
  const xHi = halfW - m;
  const zLo = m;
  const zHi = extent - m;
  if (xHi - xLo < 0.4 || zHi - zLo < 0.4) return null;
  const x = xLo + rng() * (xHi - xLo);
  const z = zLo + rng() * (zHi - zLo);
  return { x, z, rotY: facingRotY(kit.facing, x, z, comp, water), scale };
}

/**
 * Stage an interior room with kits (§4):
 *
 *  1. HERO: one hero-eligible kit anchors the far-third focal slot as a
 *     composed centrepiece (I5), facing the door — the thing you see when
 *     you walk in. It keeps the legacy clearing (HERO_CLEAR).
 *  2. SIDE KITS: count ∝ the unscaled floor area (I3, KIT_AREA_PER_KIT,
 *     tapering per tier, KIT_COUNT_MAX backstop), wall-anchored or free
 *     per kit, never touching each other (KIT_GAP), and hard-capped so at
 *     least KIT_EMPTY_FLOOR_MIN of the scaled floor stays empty.
 *  3. CLEARANCES: every piece stays inside the walkable footprint, out of
 *     the doorway strip, off the cleared path (pathHalf + KIT_PATH_CLEAR —
 *     the ≥1.4 m promise is measured to kit geometry), and out of the
 *     water. Kits are dry furniture; nothing hangs, nothing floats (I2).
 *
 * Pure function of the inputs: same rng stream, same room (A6).
 */
export function stageInteriorKits(o: KitStaging): StagedKitPiece[] {
  const kits = kitsFor("interior", o.archetype, o.baseExtent);
  if (kits.length === 0) return [];
  const { rng, plan, comp, propScale, water } = o;
  const wallInset = o.wallThick + KIT_WALL_CLEAR * propScale;
  const pieceClear = KIT_PATH_CLEAR * propScale;
  const discs: { x: number; z: number; r: number }[] = [
    ...(o.obstacles ?? []),
  ];
  const out: StagedKitPiece[] = [];
  const scaledArea = planArea(plan);
  const coverageCap = (1 - KIT_EMPTY_FLOOR_MIN) * scaledArea;
  let covered = 0;
  for (const d of discs) covered += Math.PI * d.r * d.r;

  const pushKit = (
    kit: Kit,
    t: KitTransform,
    opts: { skipPathCheck: boolean },
    kitIndex: number,
  ): StagedKitPiece[] | null => {
    const placed = placeKit(kit, t);
    for (const p of placed) {
      if (!planContains(plan, p.x, p.z, wallInset)) return null;
      if (Math.abs(p.x) < PROP_DOOR_HALF + pieceClear && p.z < PROP_DOOR_DEPTH + pieceClear) {
        return null;
      }
      if (
        !opts.skipPathCheck &&
        distToPath(comp, p.x, p.z) < comp.pathHalf + pieceClear
      ) {
        return null;
      }
      if (water && insideWater(p.x, p.z, water, pieceClear)) return null;
    }
    const r = kit.footprint * t.scale;
    for (const d of discs) {
      if (Math.hypot(t.x - d.x, t.z - d.z) < r + d.r + KIT_GAP * propScale) {
        return null;
      }
    }
    return placed.map((p) => ({
      ...p,
      y: o.heightAt(p.x, p.z),
      kitId: kit.id,
      kitIndex,
    }));
  };

  let nextKitIndex = 0;

  // 1. The hero: composed centrepiece at the far-third slot. The path
  //    leads TO it, so the path check is skipped for the hero itself; the
  //    hero's clearing keeps everything else off its stage.
  const heroKits = kits.filter((k) => k.heroSlot);
  if (heroKits.length > 0) {
    const kit = heroKits[Math.floor(rng() * heroKits.length)];
    const t: KitTransform = {
      x: comp.hero.x,
      z: comp.hero.z,
      rotY: Math.atan2(-comp.hero.x, -comp.hero.z),
      scale: propScale,
    };
    const pieces = pushKit(kit, t, { skipPathCheck: true }, nextKitIndex);
    if (pieces) {
      nextKitIndex += 1;
      out.push(...pieces);
      const r = Math.max(kit.footprint, HERO_CLEAR) * propScale;
      discs.push({ x: t.x, z: t.z, r });
      covered += Math.PI * kit.footprint * propScale * kit.footprint * propScale;
    }
  }

  // 2. Side kits, area-driven. The coverage budget is checked against the
  //    smallest remaining kit: when even that would break the 35%-empty
  //    floor, the room is done, whatever the raw target says.
  const perKit = KIT_AREA_PER_KIT[o.baseExtent] ?? 18;
  const countMax = KIT_COUNT_MAX[o.baseExtent] ?? 12;
  const target = Math.min(
    countMax,
    Math.max(1, Math.round(o.baseArea / perKit)),
  );
  const minCov = Math.min(...kits.map((k) => k.footprint * propScale)) ** 2 * Math.PI;
  let prevId: string | null = null;
  for (let slot = 0; slot < target; slot++) {
    if (covered + minCov > coverageCap) break;
    for (let a = 0; a < KIT_PLACE_ATTEMPTS; a++) {
      let kit = kits[Math.floor(rng() * kits.length)];
      // Variety re-roll: the same kit twice in a row reads as a warehouse
      // aisle, not an arrangement (§6: kits are never equidistant repeats).
      if (kit.id === prevId && kits.length > 1) {
        kit = kits[Math.floor(rng() * kits.length)];
      }
      const cov = Math.PI * (kit.footprint * propScale) ** 2;
      if (covered + cov > coverageCap) continue;
      const t = drawKitTransform(rng, kit, plan, comp, water, propScale, wallInset);
      if (!t) continue;
      const pieces = pushKit(kit, t, { skipPathCheck: false }, nextKitIndex);
      if (!pieces) continue;
      nextKitIndex += 1;
      out.push(...pieces);
      discs.push({ x: t.x, z: t.z, r: kit.footprint * t.scale });
      covered += cov;
      prevId = kit.id;
      break;
    }
  }
  return out;
}
