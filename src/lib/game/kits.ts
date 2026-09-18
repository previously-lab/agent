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
 * VOCABULARY. Kit pieces reference prop kinds the renderer knows how to
 * build (the MotifKind union in components/game/space.tsx). `KitKind` is a
 * strict subset of that union; the renderer passes staged pieces straight
 * into its prop dispatcher, so TypeScript rejects any kit kind the
 * renderer drops, and tests/lib/game/kits.test.ts mirrors the full list
 * for a runtime check.
 */
import {
  distToPath,
  planContains,
  type Composition,
  type RoomPlan,
} from "./room-plan";
import { inDoorApproach, type RoomDoorPlacement } from "./room-doors";
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
  | "umbrella"
  | "suitcase"
  | "luggagecart"
  | "bell"
  | "register"
  | "towelstack"
  | "lockerrow"
  | "chair"
  | "coatstand"
  | "umbrellastand"
  | "bucket"
  | "tray"
  | "bookpile"
  // The renderer's remaining INTERIOR vocabulary (abundance pass): a sofa
  // group, a tv corner and a shelf run were unbuildable while these were
  // missing — the props existed, no kit could name them.
  | "sofa"
  | "tv"
  | "bookshelf"
  | "column"
  // Pool-deck pieces — the pool hall's water-facing kits (§3.1 pool set).
  | "lounger"
  | "umbrella"
  | "ring"
  // The craft pass (2026-10, 简化的 3D ≠ 简化的细节): the data lane's
  // wanted-but-unbuildable list — a vanity with a real (faked-gloss)
  // mirror, floor plants and their pedestals, a laid dining table, a
  // stack of chairs, a fountain basin, poolside benches, a freestanding
  // pool ladder and the existing diving board, a grandfather clock, a
  // true reception counter, plus the pass's own additions (folding
  // screen, sideboard, towel rail, ring post).
  | "vanity"
  | "plant"
  | "pedestal"
  | "diningtable"
  | "chairstack"
  | "fountain"
  | "poolbench"
  | "ringpost"
  | "grandfatherclock"
  | "counter"
  | "screen"
  | "sideboard"
  | "towelrail"
  | "poolladder"
  | "board";

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
  /** Lift above the floor (m, default 0) for pieces that sit ON another
   *  piece — the bell and register on the counter, the tray on the dining
   *  table. Supported by the furniture beneath them, never floating (I2);
   *  scaled with the kit like the horizontal offsets. */
  dy?: number;
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
  /** Floor-relative lift (scaled) — 0 for everything that stands on the
   *  floor; >0 only for pieces resting on another piece of the same kit. */
  dy: number;
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
      dy: (p.dy ?? 0) * t.scale,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The interior kits (§3.1): N1's original eight, then the abundance   */
/* pass's eight — every piece is a real prop of its own kind, and every */
/* kit has a function and something it faces (§4): a door, the path,   */
/* the hero, or the water.                                              */
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
    id: "luggage",
    worldClasses: ["interior"],
    facing: "door",
    footprint: 1.4,
    pieces: [
      { kind: "luggagecart", dx: 0, dz: -0.3, rotY: 0 },
      { kind: "suitcase", dx: 0.42, dz: 0.45, rotY: 0.3 },
      { kind: "suitcase", dx: -0.35, dz: 0.5, rotY: -0.25, scale: 0.85 },
      { kind: "suitcase", dx: 0.02, dz: 0.95, rotY: 0.15, scale: 0.9 },
    ],
  },
  {
    // 柜台 + 铃 + 登记簿 + 椅 — the greeter: a TRUE reception counter
    // (craft pass: the desk stand-in is gone) with the clerk's chair
    // behind it, bell and ledger ON the countertop (dy lifts them onto
    // it — supported by it, never floating), facing the door.
    id: "reception",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library", "hotel-room"],
    anchor: "wall",
    backOffset: 1.4,
    facing: "door",
    footprint: 1.7,
    pieces: [
      { kind: "counter", dx: 0, dz: 0, rotY: 0 },
      { kind: "chair", dx: 0, dz: -1.05, rotY: 0 },
      { kind: "bell", dx: 0.55, dz: 0.15, rotY: 0, dy: 1.02 },
      { kind: "register", dx: -0.5, dz: 0.1, rotY: 0.15, dy: 1.02 },
    ],
  },
  {
    // 扶手椅 + 边桌 + 落地灯 + 书堆 — the reading corner, chair facing
    // the room (and the hero when free-standing): a loose book pile on
    // the floor beside the chair, lamp on the other side.
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
      { kind: "bookpile", dx: -0.55, dz: 0.55, rotY: 0.3 },
    ],
  },
  {
    // 一排储物柜，其中一扇虚掩 — the changing corner: one locker cabinet
    // along the wall (its middle door ajar — baked into the lockerrow
    // geometry), a bench in front, towels waiting on the side.
    id: "lockers",
    worldClasses: ["interior"],
    archetypes: ["pool-hall", "library", "ballroom"],
    anchor: "wall",
    backOffset: 0.3,
    facing: "center",
    footprint: 2.9,
    pieces: [
      { kind: "lockerrow", dx: 0, dz: 0, rotY: 0 },
      { kind: "bench", dx: 0, dz: 0.95, rotY: 0 },
      { kind: "towelstack", dx: 1.15, dz: 0.6, rotY: -0.2, scale: 0.9 },
    ],
  },
  {
    // 推车 + 毛巾堆 + 水桶 — housekeeping, paused mid-round (calm, never
    // abandoned-in-a-hurry — I4): the trolley, two towel piles, a bucket.
    id: "housekeeping",
    worldClasses: ["interior"],
    facing: "path",
    footprint: 1.3,
    pieces: [
      { kind: "luggagecart", dx: 0, dz: 0, rotY: 0, scale: 0.95 },
      { kind: "towelstack", dx: 0.62, dz: 0.4, rotY: 0.2 },
      { kind: "towelstack", dx: 0.5, dz: 0.85, rotY: -0.15, scale: 0.75 },
      { kind: "bucket", dx: -0.5, dz: 0.55, rotY: 0 },
    ],
  },
  {
    // 餐桌 + 两椅 + 桌布 + 餐具 — a LAID table now (craft pass): the long
    // diningtable carries its cloth, plates and candlesticks; two chairs
    // face each other across its long sides; a serving tray waits beside
    // the settings. The rug under the setting carries the floor dressing.
    id: "dining",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom"],
    heroSlot: true,
    facing: "path",
    footprint: 1.85,
    pieces: [
      { kind: "rug", dx: 0, dz: 0, rotY: 0, scale: 1.15 },
      { kind: "diningtable", dx: 0, dz: 0, rotY: 0 },
      { kind: "chair", dx: -0.55, dz: 0.8, rotY: Math.PI },
      { kind: "chair", dx: 0.55, dz: -0.8, rotY: 0 },
      { kind: "tray", dx: 0.85, dz: 0.05, rotY: 0.4, dy: 0.78 },
    ],
  },
  {
    // 衣帽架 + 长凳 + 伞架 — the threshold corner: coat stand, bench,
    // umbrella stand with its umbrellas.
    id: "coat-bench",
    worldClasses: ["interior"],
    anchor: "wall",
    backOffset: 0.35,
    facing: "path",
    footprint: 1.5,
    pieces: [
      { kind: "bench", dx: 0, dz: 0, rotY: 0 },
      { kind: "coatstand", dx: -0.95, dz: -0.15, rotY: 0 },
      { kind: "umbrellastand", dx: 0.95, dz: -0.15, rotY: 0 },
    ],
  },

  /* -------------------------------------------------------------- */
  /* The abundance pass (2026-10): eight more hand-written groups so  */
  /* one room reads as SEVERAL different small scenes, never the same */
  /* kit eight times (the eight-identical-luggage-carts failure).     */
  /* -------------------------------------------------------------- */

  {
    // 沙发 + 电视 + 落地灯 + 边柜 — the living corner: sofa back to the
    // wall, the tv facing it across the rug. Faces the room's center.
    id: "tv-corner",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom"],
    anchor: "wall",
    backOffset: 0.55,
    facing: "center",
    footprint: 2.0,
    pieces: [
      { kind: "rug", dx: 0, dz: 0.5, rotY: 0, scale: 1.2 },
      { kind: "sofa", dx: 0, dz: 0, rotY: 0 },
      { kind: "tv", dx: 0, dz: 1.55, rotY: Math.PI },
      { kind: "floorlamp", dx: -1.15, dz: -0.15, rotY: 0 },
      { kind: "nightstand", dx: 1.15, dz: -0.1, rotY: 0 },
    ],
  },
  {
    // 三联书架 + 书堆 + 面向书墙的扶手椅 — the shelf wall: three shelves
    // in a run, loose piles at their feet, one chair turned toward the
    // spines. The library's signature wall.
    id: "bookshelf-run",
    worldClasses: ["interior"],
    archetypes: ["library", "ballroom"],
    anchor: "wall",
    backOffset: 0.3,
    facing: "center",
    footprint: 2.6,
    pieces: [
      { kind: "bookshelf", dx: -1.6, dz: 0, rotY: 0 },
      { kind: "bookshelf", dx: 0, dz: 0, rotY: 0 },
      { kind: "bookshelf", dx: 1.6, dz: 0, rotY: 0 },
      { kind: "bookpile", dx: -0.8, dz: 0.7, rotY: 0.2 },
      { kind: "bookpile", dx: 0.85, dz: 0.75, rotY: -0.3 },
      { kind: "readingchair", dx: 0, dz: 1.15, rotY: Math.PI },
    ],
  },
  {
    // 写字台 + 椅 + 台灯 + 书堆 — the writing desk against the wall, its
    // chair pulled up to it, the lamp ON the desktop: work paused, not
    // abandoned (I4).
    id: "writing-desk",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library"],
    anchor: "wall",
    backOffset: 0.5,
    facing: "center",
    footprint: 1.6,
    pieces: [
      { kind: "rug", dx: 0, dz: 0.35, rotY: 0, scale: 0.9 },
      { kind: "desk", dx: 0, dz: 0, rotY: 0 },
      { kind: "chair", dx: 0, dz: 0.85, rotY: Math.PI },
      { kind: "desklamp", dx: 0.55, dz: -0.15, rotY: 0, dy: 0.8 },
      { kind: "bookpile", dx: -0.75, dz: 0.55, rotY: 0.3 },
    ],
  },
  {
    // 两张对坐的沙发 + 茶几 + 落地灯 — the conversation pair: two sofas
    // facing each other across a low table on one rug. Free-standing,
    // turned toward the path; the salon's composed centrepiece (I5).
    id: "sofa-group",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom"],
    heroSlot: true,
    facing: "path",
    footprint: 2.4,
    pieces: [
      { kind: "rug", dx: 0, dz: 0, rotY: 0, scale: 1.4 },
      { kind: "sofa", dx: -1.15, dz: 0, rotY: Math.PI / 2 },
      { kind: "sofa", dx: 1.15, dz: 0, rotY: -Math.PI / 2 },
      { kind: "nightstand", dx: 0, dz: -0.8, rotY: 0 },
      { kind: "floorlamp", dx: 0, dz: 0.85, rotY: 0 },
    ],
  },
  {
    // 长凳 + 摊开的书 + 衣帽架 — the gallery bench: one bench facing the
    // room's focus, a book left OPEN on the seat (the doc's own calm
    // trace, §1 I4), a coat stand keeping it company.
    id: "gallery-bench",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    minExtent: 64,
    facing: "hero",
    footprint: 1.3,
    pieces: [
      { kind: "bench", dx: 0, dz: 0, rotY: 0 },
      { kind: "bookpile", dx: 0.35, dz: 0.05, rotY: 0.2, dy: 0.45 },
      { kind: "coatstand", dx: -1.05, dz: -0.1, rotY: 0 },
    ],
  },
  {
    // 两把躺椅 + 边桌 + 遮阳伞立座 + 毛巾 — the pool deck's signature
    // pair (§3.1 loungers), turned toward the water; umbrella on its
    // STAND, nothing hangs (I2).
    id: "pool-loungers",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    heroSlot: true,
    facing: "water",
    footprint: 2.1,
    pieces: [
      { kind: "lounger", dx: -0.75, dz: 0, rotY: 0 },
      { kind: "lounger", dx: 0.75, dz: 0, rotY: 0 },
      { kind: "umbrella", dx: 0, dz: -0.9, rotY: 0 },
      { kind: "nightstand", dx: 0, dz: 0.2, rotY: 0, scale: 0.9 },
      { kind: "towelstack", dx: 1.4, dz: 0.5, rotY: 0.2 },
    ],
  },
  {
    // 毛巾堆 + 长凳 + 水桶 — the towel station: dry towels waiting by the
    // water, a bench to sit on while drying off. Faces the water.
    id: "towel-station",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    facing: "water",
    footprint: 1.4,
    pieces: [
      { kind: "towelstack", dx: -0.55, dz: 0, rotY: 0 },
      { kind: "towelstack", dx: 0.5, dz: 0.1, rotY: 0.2, scale: 0.8 },
      { kind: "bench", dx: 0, dz: 0.85, rotY: 0 },
      { kind: "bucket", dx: 1.05, dz: 0.6, rotY: 0 },
    ],
  },
  {
    // 救生圈立柱 + 毛巾 — the lifeguard post: two rings on their stands
    // at the pool's edge, towels beneath. Faces the water.
    id: "ring-post",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    facing: "water",
    footprint: 1.1,
    pieces: [
      { kind: "ring", dx: 0, dz: 0, rotY: 0 },
      { kind: "ring", dx: 0.7, dz: 0.3, rotY: 0.4, scale: 0.9 },
      { kind: "towelstack", dx: -0.6, dz: 0.4, rotY: 0 },
    ],
  },

  /* -------------------------------------------------------------- */
  /* The craft pass (2026-10): the data lane's wanted-but-unbuildable */
  /* list, made real — a vanity with a mirror, plants on pedestals,   */
  /* a laid table's companions, stacked chairs, a fountain court,     */
  /* poolside furniture, the hall's clock. Every group keeps the §6   */
  /* rules: 3–6 pieces, never an equidistant repeat, something it     */
  /* faces.                                                           */
  /* -------------------------------------------------------------- */

  {
    // 梳妆台 + 凳 + 屏风 — the vanity corner: the mirror table against
    // the wall, its stool pulled up, a folding screen half-screening the
    // corner (the room's one piece of mid-room layering — it stands on
    // the floor, nothing hangs).
    id: "vanity-corner",
    worldClasses: ["interior"],
    archetypes: ["hotel-room"],
    anchor: "wall",
    backOffset: 0.5,
    facing: "center",
    footprint: 1.7,
    pieces: [
      { kind: "rug", dx: 0, dz: 0.55, rotY: 0, scale: 0.9 },
      { kind: "vanity", dx: 0, dz: 0, rotY: 0 },
      { kind: "chair", dx: 0, dz: 0.75, rotY: Math.PI, scale: 0.9 },
      { kind: "screen", dx: -1.25, dz: 0.15, rotY: 0.5 },
    ],
  },
  {
    // 盆栽 + 基座 — the plant pair (§3.1): a pedestal with its little
    // vase and two floor plants of different sizes, standing loose —
    // the cheapest vertical rhythm a room can have.
    id: "plant-pedestal",
    worldClasses: ["interior"],
    facing: "center",
    footprint: 1.2,
    pieces: [
      { kind: "pedestal", dx: 0, dz: 0, rotY: 0 },
      { kind: "plant", dx: 0.85, dz: 0.3, rotY: 0 },
      { kind: "plant", dx: -0.7, dz: 0.55, rotY: 0.8, scale: 0.8 },
    ],
  },
  {
    // 落地大钟 + 基座 + 盆栽 — the clock nook: the tall case against the
    // wall, flanked by a pedestal and a plant — a hall's quiet corner.
    id: "clock-nook",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom"],
    anchor: "wall",
    backOffset: 0.35,
    facing: "center",
    footprint: 1.5,
    pieces: [
      { kind: "grandfatherclock", dx: 0, dz: 0, rotY: 0 },
      { kind: "pedestal", dx: 1.1, dz: 0.1, rotY: 0 },
      { kind: "plant", dx: -1.0, dz: 0.25, rotY: 0.4, scale: 0.9 },
    ],
  },
  {
    // 一叠椅子 + 衣帽架 — stacked chairs against the wall (§3.1): the
    // room hosts gatherings often enough to keep spares. Calm, stored —
    // never toppled (I4).
    id: "chair-stack",
    worldClasses: ["interior"],
    archetypes: ["library", "ballroom", "hotel-room"],
    anchor: "wall",
    backOffset: 0.45,
    facing: "center",
    footprint: 1.4,
    pieces: [
      { kind: "chairstack", dx: 0, dz: 0, rotY: 0 },
      { kind: "chairstack", dx: 1.05, dz: 0.15, rotY: 0.35, scale: 0.92 },
      { kind: "coatstand", dx: -1.05, dz: 0.1, rotY: 0 },
    ],
  },
  {
    // 矮柜 + 镜 + 扶手椅 — the sideboard (§3.1): the credenza with its
    // leaning mirror and vase against the wall, a chair angled toward it.
    id: "sideboard",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom"],
    anchor: "wall",
    backOffset: 0.4,
    facing: "center",
    footprint: 1.7,
    pieces: [
      { kind: "rug", dx: 0, dz: 0.55, rotY: 0, scale: 0.9 },
      { kind: "sideboard", dx: 0, dz: 0, rotY: 0 },
      { kind: "readingchair", dx: 1.4, dz: 0.6, rotY: -0.5 },
    ],
  },
  {
    // 喷泉盆 + 两条长凳 — the fountain court (§3.1 fountain): a dry-ish
    // basin with a skin of water, benches facing it from both sides — a
    // composed centrepiece for the big quiet rooms (I5).
    id: "fountain-court",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    minExtent: 64,
    heroSlot: true,
    facing: "center",
    footprint: 2.4,
    pieces: [
      { kind: "fountain", dx: 0, dz: 0, rotY: 0 },
      { kind: "poolbench", dx: 0, dz: 1.75, rotY: Math.PI },
      { kind: "poolbench", dx: 0, dz: -1.75, rotY: 0 },
      { kind: "plant", dx: 1.85, dz: 0.9, rotY: 0.6, scale: 0.9 },
    ],
  },
  {
    // 水边长凳 + 毛巾 + 救生圈立柱 — the poolside bench (§3.1
    // shallow-bench's dry twin): sit down, dry off, the ring on its post.
    id: "poolside-bench",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    facing: "water",
    footprint: 1.3,
    pieces: [
      { kind: "poolbench", dx: 0, dz: 0, rotY: 0 },
      { kind: "towelstack", dx: 0.9, dz: 0.2, rotY: 0.2 },
      { kind: "ringpost", dx: -0.95, dz: 0.15, rotY: 0 },
    ],
  },
  {
    // 扶梯 + 跳板 + 长凳 — the pool's working edge (§3.1 ladder-board):
    // the A-frame ladder stands on the deck (freestanding — never bound
    // to the basin's geometry), the board on its pillar, a bench nearby.
    id: "ladder-board",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    facing: "water",
    footprint: 2.2,
    pieces: [
      { kind: "poolladder", dx: 0, dz: 0, rotY: 0 },
      { kind: "board", dx: 1.7, dz: 0.35, rotY: 0 },
      { kind: "poolbench", dx: -1.55, dz: 0.55, rotY: 0.3 },
    ],
  },
  {
    // 毛巾架 + 毛巾堆 + 水桶 — the towel rail (§3.1 towel-rail): fresh
    // towels draped on their rail, spares folded beneath. Faces the water.
    id: "towel-rail",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    facing: "water",
    footprint: 1.1,
    pieces: [
      { kind: "towelrail", dx: 0, dz: 0, rotY: 0 },
      { kind: "towelstack", dx: 0.75, dz: 0.25, rotY: 0.2, scale: 0.9 },
      { kind: "bucket", dx: -0.7, dz: 0.3, rotY: 0 },
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

/** An axis-aligned rectangle in the plan's local frame (absolute meters,
 *  scaled coordinates — what the renderer built). */
export interface KitZoneRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * A layout template's content zones (v0.11-room-interiors §7.2), resolved
 * to absolute plan coordinates by room-templates.ts and consumed here. All
 * fields optional; an absent `zones` (or an absent field) reproduces the
 * legacy staging exactly.
 *
 *   hero      — the composed centrepiece stands at this rect's center
 *               (falling back to comp.hero when the rect is off-plan),
 *               instead of the seeded far-third slot.
 *   heroKit   — pin the hero to this kit id when it is hero-eligible for
 *               the room (the reading hall's long table); otherwise the
 *               hero is drawn as today.
 *   clusters  — side kits are placed only with their origin inside one of
 *               these rects (the shelf walls' feet, the bedroom wing).
 *   keepEmpty — no kit piece may land inside, and no kit's footprint disc
 *               may overlap (the entrance apron, the hall spine).
 */
export interface KitZones {
  hero?: KitZoneRect;
  heroKit?: string;
  clusters?: readonly KitZoneRect[];
  keepEmpty?: readonly KitZoneRect[];
}

function inZoneRect(x: number, z: number, r: KitZoneRect): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

/** Disc–rect overlap (center distance to the rect < radius). */
function discTouchesZone(x: number, z: number, radius: number, r: KitZoneRect): boolean {
  const cx = Math.max(r.x0, Math.min(x, r.x1));
  const cz = Math.max(r.z0, Math.min(z, r.z1));
  return Math.hypot(x - cx, z - cz) < radius;
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
  /** Strand doors (B.11) — every door's approach strip stays as clear as
   *  the entrance's: no piece may land in the rectangle extending inward
   *  from a door's wall plane (inDoorApproach, room-doors.ts). Empty /
   *  absent = today's single-entrance room. */
  doors?: readonly RoomDoorPlacement[];
  /** Already-occupied discs kits must not touch (e.g. a pool-hall's
   *  water-anchored fixtures placed by the legacy furnishing path). */
  obstacles?: readonly { x: number; z: number; r: number }[];
  /** Layout-template content zones (§7) — see KitZones. Absent = today's
   *  seeded staging, byte-for-byte. */
  zones?: KitZones;
  /** Per-module kit whitelist (§8's modular rooms, 2026-10): when present,
   *  only these kit ids may be drawn — a composed room's module lands its
   *  OWN authored set (room-modules.ts's `kits` lists, filtered through
   *  the same archetype eligibility above, so the whitelist never widens
   *  a kit's gate). Omitted = the full deck, byte-for-byte as today. */
  kitIds?: readonly string[];
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
 *     the doorway strip AND out of every strand door's approach strip
 *     (B.11 — a door must stay walkable-to), off the cleared path
 *     (pathHalf + KIT_PATH_CLEAR — the ≥1.4 m promise is measured to kit
 *     geometry), and out of the water. Kits are dry furniture; nothing
 *     hangs, nothing floats (I2). When door approaches shrink a small
 *     room past what its density target wants, the room places FEWER
 *     kits — a clearance is never violated to hit the target.
 *
 * Pure function of the inputs: same rng stream, same room (A6).
 */
export function stageInteriorKits(o: KitStaging): StagedKitPiece[] {
  const kits = kitsFor("interior", o.archetype, o.baseExtent).filter(
    (k) => !o.kitIds || o.kitIds.includes(k.id),
  );
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
      // Strand-door approaches (B.11): the same doorway-strip shaping,
      // following each door's own wall and probed inward normal.
      if (o.doors && inDoorApproach(p.x, p.z, o.doors)) return null;
      if (
        !opts.skipPathCheck &&
        distToPath(comp, p.x, p.z) < comp.pathHalf + pieceClear
      ) {
        return null;
      }
      if (water && insideWater(p.x, p.z, water, pieceClear)) return null;
      // Template keep-empty zones (§7): the entrance apron, the hall
      // spine — authored voids the furnishing must respect.
      if (o.zones?.keepEmpty) {
        for (const r of o.zones.keepEmpty) {
          if (inZoneRect(p.x, p.z, r)) return null;
        }
      }
    }
    const r = kit.footprint * t.scale;
    for (const d of discs) {
      if (Math.hypot(t.x - d.x, t.z - d.z) < r + d.r + KIT_GAP * propScale) {
        return null;
      }
    }
    if (o.zones?.keepEmpty) {
      for (const zone of o.zones.keepEmpty) {
        if (discTouchesZone(t.x, t.z, r, zone)) return null;
      }
    }
    return placed.map((p) => ({
      ...p,
      y: o.heightAt(p.x, p.z) + p.dy,
      kitId: kit.id,
      kitIndex,
    }));
  };

  let nextKitIndex = 0;

  // 1. The hero: composed centrepiece at the far-third slot. The path
  //    leads TO it, so the path check is skipped for the hero itself; the
  //    hero's clearing keeps everything else off its stage.
  //    Template zones (§7) may pin the hero's kit and stand it at the
  //    template's hero rect instead of the seeded slot.
  const heroKits = kits.filter((k) => k.heroSlot);
  if (heroKits.length > 0) {
    const pinned = o.zones?.heroKit
      ? heroKits.find((k) => k.id === o.zones!.heroKit)
      : undefined;
    const kit = pinned ?? heroKits[Math.floor(rng() * heroKits.length)];
    let hx = comp.hero.x;
    let hz = comp.hero.z;
    if (o.zones?.hero) {
      const zx = (o.zones.hero.x0 + o.zones.hero.x1) / 2;
      const zz = (o.zones.hero.z0 + o.zones.hero.z1) / 2;
      if (planContains(plan, zx, zz, wallInset)) {
        hx = zx;
        hz = zz;
      }
    }
    const t: KitTransform = {
      x: hx,
      z: hz,
      rotY: Math.atan2(-hx, -hz),
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
      // Template cluster zones (§7): side kits live where the template put
      // its content areas — the shelf walls' feet, the bedroom wing.
      if (o.zones?.clusters && o.zones.clusters.length > 0) {
        if (!o.zones.clusters.some((r) => inZoneRect(t.x, t.z, r))) continue;
      }
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
