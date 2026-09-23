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
 *
 * WORLD CLASSES. The deck holds every hand-written kit — the interior
 * sets (N1, the abundance pass, the craft pass), the nature set
 * (§3.1 N4: fallen-log, stone-circle, jetty, fence-ruin, campfire,
 * path-marker, boulder-cluster, reeds) and the wonder set (§3.1 N4:
 * toy-blocks, marble-run, giant-chess, paper-boats, lantern-cluster,
 * swing-frame). `worldClasses` + `archetypes` gate which room may draw
 * which kit (a meadow never grows pool lockers; the outdoor pool biome
 * keeps its rim-anchored fixture scatter — its content IS the water —
 * and draws no kits at all).
 *
 * THE TRACE (§4.4). Staging ends by selecting the room's ONE trace: a
 * single calm piece (an open book, a tea tray, a folded towel — never
 * toppled/broken/bloody, §6) set ON a host piece the walker actually
 * passes: a host inside the path/hero visibility band. Same seeded
 * stream, same slice ⇒ same trace (A6); a room with no eligible host
 * grows no trace (空场 rules) — exactly one otherwise.
 */
import {
  distToPath,
  planContains,
  type Composition,
  type RoomPlan,
} from "./room-plan";
import { inDoorApproach, type RoomDoorPlacement } from "./room-doors";
import {
  resolveSchematic,
  type ResolvedSchematicGroup,
  type SchematicPlacement,
} from "./room-schematic";
import {
  HERO_CLEAR,
  HERO_Z_MIN,
  KIT_AREA_PER_KIT,
  KIT_COUNT_MAX,
  KIT_EMPTY_FLOOR_MIN,
  KIT_GAP,
  KIT_HERO_ATTEMPTS,
  KIT_PATH_CLEAR,
  KIT_PLACE_ATTEMPTS,
  KIT_ROOM_CAP,
  KIT_WALL_CLEAR,
  OPEN_FIELD_PIECE_MAX,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  TRACE_VIEW_MARGIN,
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
  | "board"
  // The nature set (§3.1 N4, 2026-10): worn outdoor pieces for the nature
  // kits — standing stones, boulders, water-edge reeds, the unlit fire
  // pit, jetty deck sections, moss patches and the eroded dry-stone wall.
  // The kits also reuse the existing scatter vocabulary (the fallen log,
  // mushroom clusters, cairns and the signpost), so those kinds join the
  // subset here.
  | "standingstone"
  | "boulder"
  | "reeds"
  | "firepit"
  | "jettydeck"
  | "moss"
  | "ruinwall"
  | "log"
  | "mushroom"
  | "cairn"
  | "signpost"
  // The wonder set (§3.1 N4, 2026-10): the diorama world's oversized
  // playthings — giant toy blocks (a stud-topped cube, stacked by the
  // kit's dy), the marble-run tower with its exit chute and dish, three
  // giant chessmen, folded paper boats, warm paper ground lanterns, and
  // the self-supported swing frame with its rope-hung seats (§3.1's
  // explicit exception to I2: the seat hangs from the FRAME's crossbar,
  // never from a ceiling).
  | "toyblock"
  | "marblerun"
  | "marblechute"
  | "chessking"
  | "chessrook"
  | "chesspawn"
  | "paperboat"
  | "paperlantern"
  | "swingframe"
  | "swingseat"
  // The structure layer (v0.12-room-realism §2, the living pilot): the
  // room-schematic slots draw these — a low coffee table with a dressed
  // top, the media unit under the TV, and the tabletop dressing trio
  // (vase / picture frame / candle) that says someone lives here.
  | "coffeetable"
  | "mediaunit"
  | "vase"
  | "frame"
  | "candle"
  // The v0.12 new-props pass (specs 附录 A + room-plans INDEX's NEW PROPS
  // column, the "平面图需要、词表里没有" list): the kitchen worktop counter
  // is the craft pass's `counter` RESHAPED (see space.tsx — the panelled
  // body now carries a 0.15m backsplash and a sink groove, and serves both
  // the reception and the kitchen), so only these five join here — the
  // bedroom wardrobe (双门高柜 + 顶线), the open storage rack (层板可承
  // suitcase/tray), the workshop bench (厚木台 + 台钳), the wall-flush
  // picture (程序化色块, hung ON the wall — the plan set's 贴墙件, never
  // ceiling-hung), and the floor-standing mop (与 bucket 配对的家务件).
  | "wardrobe"
  | "storagerack"
  | "workbench"
  | "wallart"
  | "mop";

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
  /** WATER-BOUND kits (jetty, reeds): the origin is drawn ON the water
   *  rectangle's edge — the piece offsets were authored to straddle the
   *  shoreline — and the kit is dropped from the deck entirely when the
   *  room has no water. The kit still faces its declared target (the
   *  water, for both), so the walkway runs out into the basin and the
   *  reeds lean over it. */
  shore?: boolean;
  /** Pieces may stand in the water (their bases reach the bed — a jetty
   *  on posts, reeds rooted in the shallows). The dry-furniture rule
   *  "kits stay out of the water" is waived per kit, exactly as the pool
   *  hall's rim fixtures overhang the basin; everything else still holds
   *  (plan footprint, path, doorway strips, kit gaps). */
  intoWater?: boolean;
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

export const KITS: readonly Kit[] = [
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
      { kind: "bell", dx: 0.55, dz: 0.15, rotY: 0, dy: 0.96 },
      { kind: "register", dx: -0.5, dz: 0.1, rotY: 0.15, dy: 0.96 },
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
    // 推车 + 毛巾堆 + 水桶 + 拖把 — housekeeping, paused mid-round (calm,
    // never abandoned-in-a-hurry — I4): the trolley, two towel piles, a
    // bucket, and the mop leaning against the trolley's deck — the "someone
    // is keeping this place" beat (realism §6.3) for the kitchen, the
    // luggage room and the workshop.
    id: "housekeeping",
    worldClasses: ["interior"],
    facing: "path",
    footprint: 1.3,
    pieces: [
      { kind: "luggagecart", dx: 0, dz: 0, rotY: 0, scale: 0.95 },
      { kind: "towelstack", dx: 0.62, dz: 0.4, rotY: 0.2 },
      { kind: "towelstack", dx: 0.5, dz: 0.85, rotY: -0.15, scale: 0.75 },
      { kind: "bucket", dx: -0.5, dz: 0.55, rotY: 0 },
      { kind: "mop", dx: -0.38, dz: -0.12, rotY: -0.5 },
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

  /* -------------------------------------------------------------- */
  /* The v0.12 new-props pass (specs 附录 A + the room-plans INDEX's   */
  /* NEW PROPS column): the six groups that put the formerly          */
  /* unbuildable kinds into staged rooms — each new kind lands WITH   */
  /* the kit that names it and the module whitelist that deals it     */
  /* (the §6 "一个 kind 与它的消费端同一次落地" rule).                 */
  /* -------------------------------------------------------------- */

  {
    // 一字操作台 + 台面小物 + 拖把水桶 — the kitchen's working wall
    // (§5: counter 必备, bucket+mop 角落必备): the worktop counter with
    // its tray and vase ON the slab (the sink groove is baked into the
    // counter's top), the mop and bucket parked at its end. Wall-anchored:
    // the backsplash reads against the kitchen wall.
    id: "kitchen-counter",
    worldClasses: ["interior"],
    anchor: "wall",
    backOffset: 0.4,
    facing: "center",
    footprint: 1.6,
    pieces: [
      { kind: "counter", dx: 0, dz: 0, rotY: 0 },
      { kind: "tray", dx: -0.5, dz: 0.02, rotY: 0.15, dy: 0.96 },
      { kind: "vase", dx: 0.32, dz: -0.08, rotY: 0, dy: 0.96 },
      { kind: "mop", dx: 1.35, dz: -0.08, rotY: 0.4 },
      { kind: "bucket", dx: 1.48, dz: 0.28, rotY: 0 },
    ],
  },
  {
    // 双门衣柜 + 盆栽 + 书堆 — the bedroom's wardrobe wall (§2: wardrobe
    // 必备, against the non-door, non-headboard wall): the tall cabinet,
    // a plant breathing at its end, the bedside reading waiting on the
    // floor. Floor-standing, never hung (双门 + 顶线).
    // §6.4 逐件问责: no `luggage` here — §2's ban list names the
    // luggagecart (and the cart IS the kit's centrepiece), and the
    // wardrobe is the §2 必备 this wall exists for. The wardrobe stays
    // eligible for every interior archetype: it is the bedroom suite's
    // storage wherever that suite lands (and it keeps the bedroom a
    // legal companion for the pool hall/library/ballroom compositions —
    // the luggage kit used to carry that cross-archetype eligibility).
    id: "wardrobe-wall",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom", "pool-hall"],
    anchor: "wall",
    backOffset: 0.35,
    facing: "center",
    footprint: 1.5,
    pieces: [
      { kind: "wardrobe", dx: 0, dz: 0, rotY: 0 },
      { kind: "plant", dx: 1.2, dz: 0.12, rotY: 0.5 },
      { kind: "bookpile", dx: -0.95, dz: 0.28, rotY: 0.25 },
    ],
  },
  {
    // 开放层架 + 箱 + 托盘 — the luggage room's rack wall (§7: storagerack
    // 必备, suitcase×2–4 必备): two cases ride the shelves (the kit's dy
    // lifts them onto real boards, never floating), a tray holds the small
    // stuff on the top shelf.
    id: "storage-rack",
    worldClasses: ["interior"],
    anchor: "wall",
    backOffset: 0.35,
    facing: "center",
    footprint: 1.5,
    pieces: [
      { kind: "storagerack", dx: 0, dz: 0, rotY: 0 },
      { kind: "suitcase", dx: -0.35, dz: 0.02, rotY: 0.1, dy: 0.14 },
      { kind: "suitcase", dx: 0.32, dz: -0.04, rotY: -0.3, scale: 0.85, dy: 0.64 },
      { kind: "tray", dx: 0.1, dz: 0.08, rotY: 0.5, dy: 1.14 },
    ],
  },
  {
    // 厚重木工作台 + 物料架 + 台前椅 + 台面工具 — the workshop's working
    // wall (§13: workbench 必备, storagerack/sideboard 2 组必备): the
    // bench with its vise, a rack of materials beside it, the chair pulled
    // up, the lamp and the tool tray ON the slab. ONE kit names BOTH new
    // workshop kinds — the module whitelist cap (§6 少而准) leaves room
    // for only one entry, and the two belong to the same corner anyway.
    id: "workbench-corner",
    worldClasses: ["interior"],
    anchor: "wall",
    backOffset: 0.5,
    facing: "center",
    footprint: 1.9,
    pieces: [
      { kind: "workbench", dx: 0, dz: 0, rotY: 0 },
      { kind: "storagerack", dx: -1.65, dz: -0.05, rotY: 0 },
      { kind: "chair", dx: 0.15, dz: 1.05, rotY: Math.PI },
      { kind: "desklamp", dx: -0.5, dz: -0.05, rotY: 0.3, dy: 0.9 },
      { kind: "tray", dx: 0.5, dz: 0.02, rotY: -0.2, dy: 0.9 },
    ],
  },
  {
    // 一排挂画 + 盆栽 — the gallery hang (§8: wallart×3–5 沿长墙 必备):
    // four frames at seeded-feeling staggered heights and sizes (the
    // geometry takes the room's accent for its canvas blocks, so the row
    // reads as ONE collection), a plant at the row's end. The frames ride
    // ON the wall (the plan set's 贴墙件 — flush, never ceiling-hung): the
    // pieces' negative dz keeps their backs at the wall while the kit
    // origin stands off it like every wall kit (a hugging origin lands
    // OUTSIDE the cluster bands and the row could never stage).
    id: "art-wall",
    worldClasses: ["interior"],
    anchor: "wall",
    backOffset: 0.8,
    facing: "center",
    footprint: 2.5,
    pieces: [
      { kind: "wallart", dx: -1.5, dz: -0.76, rotY: 0, dy: 1.5, scale: 0.85 },
      { kind: "wallart", dx: -0.5, dz: -0.76, rotY: 0, dy: 1.62, scale: 1 },
      { kind: "wallart", dx: 0.55, dz: -0.76, rotY: 0, dy: 1.46, scale: 0.75 },
      { kind: "wallart", dx: 1.5, dz: -0.76, rotY: 0, dy: 1.58, scale: 0.95 },
      { kind: "plant", dx: 2.35, dz: -0.6, rotY: 0.6 },
    ],
  },
  {
    // 拖把 + 水桶 + 备用毛巾 — the changing room's quiet corner (realism
    // §6.3: 家务件 belong in the 浴室/厨房/行李房/工作间 corner slots):
    // the mop standing with its bucket, a spare towel pile waiting. The
    // bath's §6 ban on luggagecart keeps the full housekeeping trolley out,
    // so the cleaning pair gets its own small group.
    id: "mop-corner",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    anchor: "wall",
    backOffset: 0.45,
    facing: "center",
    footprint: 0.8,
    pieces: [
      { kind: "mop", dx: -0.25, dz: -0.05, rotY: -0.35 },
      { kind: "bucket", dx: 0.25, dz: 0.1, rotY: 0 },
      { kind: "towelstack", dx: 0.05, dz: 0.4, rotY: 0.2, scale: 0.9 },
    ],
  },

  /* -------------------------------------------------------------- */
  /* The nature set (§3.1 N4, 2026-10): eight hand-written groups    */
  /* that turn the outdoor biomes from scattered props into arranged  */
  /* scenes — every kit has a relation (faces the path, the water or  */
  /* the hero), nothing is an equidistant repeat (§6), and everything  */
  /* stands on the ground or the bed — the jetty's deck rides on its  */
  /* posts, the reeds root in the shallows, nothing hangs (I2).       */
  /* -------------------------------------------------------------- */

  {
    // 倒木 + 蘑菇 + 苔藓 — the forest's resting spot: a fallen trunk (its
    // long axis across the kit's forward), a mushroom cluster at its
    // root end and a moss patch at the other. Faces the walk path.
    id: "fallen-log",
    worldClasses: ["nature"],
    archetypes: ["forest", "meadow", "plains", "snowfield", "lake"],
    facing: "path",
    footprint: 1.7,
    pieces: [
      { kind: "log", dx: 0, dz: 0, rotY: 0 },
      { kind: "mushroom", dx: 0.95, dz: 0.4, rotY: 0.4 },
      { kind: "moss", dx: -0.75, dz: -0.35, rotY: 0.9, scale: 1.1 },
    ],
  },
  {
    // 几块立石 — the worn ring: five standing stones on a circle, the
    // gap toward the kit's forward (whoever approaches is expected),
    // heights staggered by weather, not violence. A composed focal
    // centrepiece for the dry biomes (I5).
    id: "stone-circle",
    worldClasses: ["nature"],
    archetypes: ["forest", "meadow", "plains", "snowfield"],
    heroSlot: true,
    facing: "center",
    footprint: 2.2,
    pieces: [
      { kind: "standingstone", dx: 1.04, dz: 1.15, rotY: -0.6 },
      { kind: "standingstone", dx: -1.04, dz: 1.15, rotY: 0.6, scale: 0.9 },
      { kind: "standingstone", dx: 1.0, dz: -1.19, rotY: 2.5, scale: 1.1 },
      { kind: "standingstone", dx: -1.0, dz: -1.19, rotY: -2.5, scale: 0.8 },
      { kind: "standingstone", dx: 0, dz: -1.55, rotY: Math.PI },
    ],
  },
  {
    // 木栈道探入水中 — the jetty: three deck sections in a line running
    // out over the water, a mooring cairn at its root on the shore. The
    // origin lands ON the water's edge and the kit faces the water, so
    // the walkway reaches into the basin; the posts stand on the bed.
    id: "jetty",
    worldClasses: ["nature"],
    archetypes: ["lake", "beach", "ocean"],
    shore: true,
    intoWater: true,
    facing: "water",
    footprint: 3.6,
    pieces: [
      { kind: "jettydeck", dx: 0, dz: 0.3, rotY: 0 },
      { kind: "jettydeck", dx: 0, dz: 1.55, rotY: 0 },
      { kind: "jettydeck", dx: 0, dz: 2.8, rotY: 0 },
      { kind: "cairn", dx: 0.85, dz: -0.6, rotY: 0.5, scale: 0.7 },
    ],
  },
  {
    // 残破矮墙 — the old field wall: two runs of worn dry-stone, their
    // heights staggered by erosion (calm decay — never a fresh break,
    // no debris, §6's bans hold), a moss patch at the foot. Faces the
    // path like a boundary the walker is meant to follow.
    id: "fence-ruin",
    worldClasses: ["nature"],
    archetypes: ["meadow", "plains", "forest", "snowfield", "beach"],
    facing: "path",
    footprint: 1.9,
    pieces: [
      { kind: "ruinwall", dx: -0.55, dz: 0, rotY: 0 },
      { kind: "ruinwall", dx: 0.6, dz: 0.08, rotY: 0.12 },
      { kind: "moss", dx: 0.1, dz: 0.5, rotY: 0.4, scale: 0.9 },
    ],
  },
  {
    // 火塘，不点火 — the hearth, cold: a ring of fire stones, an ash
    // pan with two charred logs, and two log seats set tangentially —
    // a gathering place, composed centrepiece (I5), unlit by rule.
    id: "campfire",
    worldClasses: ["nature"],
    archetypes: ["forest", "meadow", "plains", "snowfield", "lake", "beach"],
    heroSlot: true,
    facing: "center",
    footprint: 1.8,
    pieces: [
      { kind: "firepit", dx: 0, dz: 0, rotY: 0 },
      { kind: "log", dx: -1.05, dz: 0.25, rotY: 1.35, scale: 0.72 },
      { kind: "log", dx: 0.95, dz: 0.55, rotY: -0.9, scale: 0.62 },
    ],
  },
  {
    // 路标 + 石块 — the waymark: a signpost where the path bends, a
    // cairn and a boulder at its foot. Faces the walk path.
    id: "path-marker",
    worldClasses: ["nature"],
    archetypes: ["plains", "meadow", "forest", "snowfield", "lake", "beach", "ocean"],
    facing: "path",
    footprint: 1.4,
    pieces: [
      { kind: "signpost", dx: 0, dz: 0, rotY: 0 },
      { kind: "cairn", dx: 0.75, dz: 0.35, rotY: 0.3, scale: 0.55 },
      { kind: "boulder", dx: -0.7, dz: 0.45, rotY: 0, scale: 0.5 },
    ],
  },
  {
    // 巨石群 — the boulder cluster: three weathered boulders leaning
    // together at seeded angles, moss between them. A composed
    // centrepiece for the big quiet biomes (I5).
    id: "boulder-cluster",
    worldClasses: ["nature"],
    archetypes: ["forest", "meadow", "plains", "snowfield", "lake", "beach", "ocean"],
    heroSlot: true,
    facing: "center",
    footprint: 2.3,
    pieces: [
      { kind: "boulder", dx: 0, dz: 0, rotY: 0, scale: 1.15 },
      { kind: "boulder", dx: 1.15, dz: 0.5, rotY: 0.9, scale: 0.8 },
      { kind: "boulder", dx: -0.9, dz: 0.8, rotY: 2.1, scale: 0.65 },
      { kind: "moss", dx: 0.35, dz: -0.75, rotY: 0, scale: 1 },
    ],
  },
  {
    // 水边芦苇 — the reed bed: three clumps rooted in the shallows at
    // the water's edge (the origin sits ON the shoreline; the offsets
    // straddle it), leaning toward the water. Shore kit: drawn on the
    // basin's edge, dropped when the room has no water.
    id: "reeds",
    worldClasses: ["nature"],
    archetypes: ["lake", "beach", "ocean"],
    shore: true,
    intoWater: true,
    facing: "water",
    footprint: 1.5,
    pieces: [
      { kind: "reeds", dx: -0.55, dz: 0.35, rotY: 0.2 },
      { kind: "reeds", dx: 0.4, dz: 0.55, rotY: 1.2, scale: 0.85 },
      { kind: "reeds", dx: 0.05, dz: -0.25, rotY: 2.2, scale: 0.7 },
    ],
  },

  /* -------------------------------------------------------------- */
  /* The wonder set (§3.1 N4, 2026-10): the diorama world's authored */
  /* playthings — oversized, calm, never toppled (I4), every kit has  */
  /* a relation (faces the water, the path, or stands as the composed */
  /* centrepiece). The swing frame's seats hang from ITS OWN crossbar */
  /* (§3.1's explicit allowance) — never from a ceiling (I2).        */
  /* -------------------------------------------------------------- */

  {
    // 巨型积木堆 — giant toy blocks: three on the floor at scattered
    // angles, a fourth stacked on the first (the kit's dy — supported,
    // never floating). Played-with, not toppled (I4).
    id: "toy-blocks",
    worldClasses: ["wonder"],
    archetypes: ["ducks", "cats", "dogs", "balloons"],
    facing: "center",
    footprint: 1.6,
    pieces: [
      { kind: "toyblock", dx: 0, dz: 0, rotY: 0.3 },
      { kind: "toyblock", dx: 0.9, dz: 0.25, rotY: -0.25, scale: 0.85 },
      { kind: "toyblock", dx: -0.72, dz: 0.6, rotY: 0.95, scale: 0.7 },
      { kind: "toyblock", dx: 0.02, dz: -0.02, rotY: 0.62, dy: 0.72 },
    ],
  },
  {
    // 滚球轨道 — the marble run corner: the tower with its two disc
    // ramps, the exit chute running down to the marble dish, and a
    // small chair pulled up to watch it run — paused, never abandoned
    // (I4). A composed centrepiece (I5): the tower owns the far-third
    // slot, the chute and chair arrange around it.
    id: "marble-run",
    worldClasses: ["wonder"],
    archetypes: ["ducks", "cats", "dogs", "balloons"],
    heroSlot: true,
    facing: "path",
    footprint: 2.2,
    pieces: [
      { kind: "marblerun", dx: 0, dz: 0, rotY: 0 },
      { kind: "marblechute", dx: 1.35, dz: 0.3, rotY: -Math.PI / 2 },
      { kind: "chair", dx: -1.35, dz: -0.5, rotY: 2.2 },
    ],
  },
  {
    // 几个超大棋子 — giant chessmen mid-game: the alabaster king, a
    // slate rook answered across the board-that-is-the-floor, a pawn
    // advanced between them. A composed centrepiece (I5) — the game IS
    // the focus, the pieces face the room's center like players.
    id: "giant-chess",
    worldClasses: ["wonder"],
    archetypes: ["ducks", "cats", "dogs", "balloons"],
    heroSlot: true,
    facing: "center",
    footprint: 2.1,
    pieces: [
      { kind: "chessking", dx: -0.85, dz: 0, rotY: 0.2 },
      { kind: "chessrook", dx: 0.8, dz: 0.55, rotY: -0.4 },
      { kind: "chesspawn", dx: 0.05, dz: -0.75, rotY: 0.9 },
    ],
  },
  {
    // 折纸船 — folded paper boats left at the pond's edge, prows toward
    // the water (facing "water"): someone's fleet, ready for launch.
    // Only the duck pond (the wonder room with water) grows them.
    id: "paper-boats",
    worldClasses: ["wonder"],
    archetypes: ["ducks"],
    facing: "water",
    footprint: 1.4,
    pieces: [
      { kind: "paperboat", dx: 0, dz: 0, rotY: 0 },
      { kind: "paperboat", dx: 0.7, dz: 0.4, rotY: 0.5, scale: 0.85 },
      { kind: "paperboat", dx: -0.6, dz: 0.5, rotY: -0.35, scale: 0.7 },
    ],
  },
  {
    // 地面灯笼群 — ground lanterns breathing warm light at staggered
    // heights, a little constellation standing on the floor. Faces the
    // room's center; the glow is small and authored (the room's real
    // light still comes from its fixtures — B.13).
    id: "lantern-cluster",
    worldClasses: ["wonder"],
    archetypes: ["ducks", "cats", "dogs", "balloons"],
    facing: "center",
    footprint: 1.8,
    pieces: [
      { kind: "paperlantern", dx: 0, dz: 0, rotY: 0, scale: 1.1 },
      { kind: "paperlantern", dx: 0.8, dz: 0.45, rotY: 0.7, scale: 0.8 },
      { kind: "paperlantern", dx: -0.7, dz: 0.5, rotY: 1.9, scale: 0.9 },
      { kind: "paperlantern", dx: 0.15, dz: -0.8, rotY: 3.4, scale: 0.7 },
      { kind: "paperlantern", dx: -0.5, dz: -0.6, rotY: 4.6, scale: 0.75 },
    ],
  },
  {
    // 带支架的秋千 — the swing frame standing on its own two A-ends,
    // two rope-hung seats at rest. §3.1's explicit exception to I2: the
    // seats hang from the frame's crossbar, never from a ceiling. Faces
    // the walk path — you swing toward the room.
    id: "swing-frame",
    worldClasses: ["wonder"],
    archetypes: ["ducks", "cats", "dogs", "balloons"],
    facing: "path",
    footprint: 2.5,
    pieces: [
      { kind: "swingframe", dx: 0, dz: 0, rotY: 0 },
      { kind: "swingseat", dx: 1.02, dz: 0, rotY: 0 },
      { kind: "swingseat", dx: -1.02, dz: 0, rotY: 0 },
    ],
  },
];

/** Kits a room of this class/archetype/tier may draw. */
export function kitsFor(
  worldClass: string,
  archetype: string,
  baseExtent: number,
): readonly Kit[] {
  return KITS.filter(
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

/** A cluster rect with its own DRAW DECK attached (a composed room's
 *  modules, room-modules.ts compositionKitZonesFor): side kits standing in
 *  this zone draw from THESE kit ids — the module's whitelist — instead of
 *  the room-wide union deck, so one kit no longer sprawls across the whole
 *  room (§8.1.4: "不同模块各自的陈设"). Absent/empty = the room deck. */
export interface KitClusterRect extends KitZoneRect {
  kitIds?: readonly string[];
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
 *               A cluster rect may carry its own kitIds (KitClusterRect) —
 *               the module's whitelist; the draw then picks a ZONE first
 *               and deals from that module's deck (§8.1.4), instead of
 *               the room-wide union.
 *   keepEmpty — no kit piece may land inside, and no kit's footprint disc
 *               may overlap (the entrance apron, the hall spine).
 */
export interface KitZones {
  hero?: KitZoneRect;
  heroKit?: string;
  clusters?: readonly KitClusterRect[];
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
  /** The world class furnishing this room — "interior" (default, today's
   *  behaviour byte-for-byte) or "nature" (§3.1 N4: the outdoor deck).
   *  Selects the kit pool via the same worldClasses gate everything else
   *  uses, and unlocks the nature-only hero redraw (dry-ground retry). */
  worldClass?: string;
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
  /** Room blueprints (v0.12-room-realism §2, the structure layer): a
   *  module that carries a hand-authored RoomSchematic furnishes by SLOT
   *  PLACEMENT — resolveSchematic turns each placement into synthetic
   *  kit groups whose pieces are seeded from the slots' accepts and whose
   *  offsets/facings the blueprint authors. The groups ride THIS SAME
   *  pushKit clearance machinery (walkable footprint, doorway + strand-
   *  door strips, path, water, keep-empty, gap discs, the coverage
   *  budget) — no geometry rule is re-implemented (§7.3). A failed
   *  REQUIRED group rolls the whole placement back and the module
   *  furnishes with the generic orchestration below, exactly as it did
   *  before blueprints. Modules WITHOUT a schematic and every room with
   *  an absent/empty list stage byte-for-byte as today. */
  schematics?: readonly SchematicPlacement[];
  /** The 随机区域 open fields (§8.2) of a COMPOSED room, in the scaled
   *  plan's coordinates: each field dresses with 0–3 seeded pieces drawn
   *  from the same (module-filtered) deck — sparse by construction, never
   *  equidistant (uniform draws inside the rect), under the same
   *  clearance, coverage, and path promises as every other piece. The
   *  fields are NOT keep-empty zones; omitting this reproduces the empty
   *  fields of the pre-dressing build. */
  openFields?: readonly KitZoneRect[];
  /** Terrain snap for piece y (the shared heightfield). */
  heightAt: (x: number, z: number) => number;
}

/** One staged piece, ready for the renderer's prop dispatcher. */
export interface StagedKitPiece extends PlacedKitPiece {
  y: number;
  kitId: string;
  /** Serial of the kit PLACEMENT this piece belongs to (the same kit type
   *  can be set down several times in one room) — also a stable render
   *  key. The hero placement is 0. The §4.4 trace rides its HOST's id and
   *  index (it is not a placement of its own). */
  kitIndex: number;
  /** §4.4: this piece is the room's one trace — a small calm kind set ON
   *  the host piece (same x/z, lifted by the host's top). At most one per
   *  staged room; absent on every other piece. */
  trace?: boolean;
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

/** The §4.4 trace whitelist — small CALM pieces only (I4): the open
 *  book, the tea tray with its cups, the folded towel. Toppled / broken /
 *  bloody / hand-printed props are §6 bans and must never join this
 *  list. Exported for the renderer's probe mirror and the tests. */
export const TRACE_KINDS: readonly KitKind[] = ["bookpile", "tray", "towelstack"];

/** Host pieces a trace may rest on — the kind plus its top surface height
 *  above the floor (m, human scale; multiplied by the host piece's own
 *  scale at placement). Tops come from the established dy precedents
 *  (bookpile on bench 0.45, desklamp on desk 0.80, tray on diningtable
 *  0.78, bell on counter 0.96 — the v0.12 worktop height) and the nature
 *  kinds' authored geometry. Cluttered tops (nightstand's vase, the
 *  vanity and sideboard dressing) are deliberately excluded — a trace
 *  must own its spot. */
export const TRACE_HOST_TOPS: Readonly<Record<string, number>> = {
  bench: 0.45,
  desk: 0.8,
  diningtable: 0.78,
  counter: 0.96,
  poolbench: 0.4,
  log: 0.46,
  jettydeck: 0.45,
  boulder: 0.6,
};

/** §4.4 visibility: is (x, z) inside the trace's visible band — within
 *  TRACE_VIEW_MARGIN of the cleared walk path (beyond its half-width), of
 *  the hero's clearing, or in the far third of the room (the depth the
 *  eyes land on when entering — open sightlines, nothing to hide a trace
 *  behind)? The one rule the selector and every probe share, so "the
 *  trace is visible" is asserted against the same geometry that chose
 *  it. */
export function traceVisible(
  comp: Composition,
  x: number,
  z: number,
  propScale: number,
  extent: number,
): boolean {
  const margin = TRACE_VIEW_MARGIN * propScale;
  return (
    distToPath(comp, x, z) <= comp.pathHalf + margin ||
    Math.hypot(x - comp.hero.x, z - comp.hero.z) <=
      (HERO_CLEAR + TRACE_VIEW_MARGIN) * propScale ||
    z >= extent * (HERO_Z_MIN - 0.04)
  );
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

  // Shore kits (jetty, reeds): the origin lands ON the water rectangle's
  // edge — the piece offsets were authored to straddle the shoreline — on
  // a seeded side and a seeded spot along it, facing the water. The
  // entrance side (z small, near the door axis) is kept out so the
  // doorway apron stays readable; waterRectFor guarantees a walkable
  // deck on every side, so the root piece always has dry ground behind
  // it. All the usual clearance checks still run in pushKit.
  if (kit.shore) {
    if (!water) return null;
    const start = Math.floor(rng() * 4);
    for (let i = 0; i < 4; i++) {
      const side = (start + i) % 4;
      const t = 0.3 + rng() * 0.4; // mid-band of the side, never a corner
      let x: number;
      let z: number;
      if (side === 0) {
        x = water.cx - water.halfX;
        z = water.cz - water.halfZ + t * water.halfZ * 2;
      } else if (side === 1) {
        x = water.cx + water.halfX;
        z = water.cz - water.halfZ + t * water.halfZ * 2;
      } else if (side === 2) {
        z = water.cz - water.halfZ;
        // South shore can sit near the entrance on small tiers: fold the
        // draw to the east/west halves, outside the doorway strip.
        const half = t < 0.5 ? -1 : 1;
        const u = ((t < 0.5 ? t : t - 0.5) / 0.5) * 0.95;
        const lo = Math.max(2.6, 0.5 * water.halfX);
        const hi = Math.max(lo + 0.1, water.halfX * 0.95);
        x = water.cx + half * (lo + u * (hi - lo));
      } else {
        z = water.cz + water.halfZ;
        x = water.cx - water.halfX + t * water.halfX * 2;
      }
      if (!planContains(plan, x, z, wallInset)) continue;
      return { x, z, rotY: facingRotY(kit.facing, x, z, comp, water), scale };
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
 *  3. OPEN FIELDS (§8.2 随机区域): a composed room's module-scale voids
 *     dress with 0–3 seeded pieces each — from the same deck, under the
 *     same clearances and coverage budget; most fields stay empty.
 *  4. CLEARANCES: every piece stays inside the walkable footprint, out of
 *     the doorway strip AND out of every strand door's approach strip
 *     (B.11 — a door must stay walkable-to), off the cleared path
 *     (pathHalf + KIT_PATH_CLEAR — the ≥1.4 m promise is measured to kit
 *     geometry), and out of the water — except shore kits (jetty, reeds),
 *     whose pieces straddle the shoreline on their posts and roots. Kits
 *     are supported; nothing hangs, nothing floats (I2). When door
 *     approaches shrink a small room past what its density target wants,
 *     the room places FEWER kits — a clearance is never violated to hit
 *     the target.
 *  5. THE TRACE (§4.4): the room's one calm trace — a whitelisted kind
 *     set ON a visible host (path/hero band) — chosen from the seeded
 *     stream; zero when no eligible host exists.
 *
 * Pure function of the inputs: same rng stream, same room (A6).
 */
export function stageInteriorKits(o: KitStaging): StagedKitPiece[] {
  const worldClass = o.worldClass ?? "interior";
  const { rng, plan, comp, propScale, water } = o;
  const gated = kitsFor(worldClass, o.archetype, o.baseExtent);
  const drawable = (k: Kit) =>
    // Shore kits are water-bound: no basin, no draw.
    !k.shore || water !== null;
  let kits = gated.filter(
    (k) => (!o.kitIds || o.kitIds.includes(k.id)) && drawable(k),
  );
  if (kits.length === 0 && o.kitIds && o.kitIds.length > 0) {
    // 牌堆非空回退 (v0.12 declarations audit): a module whose whitelist ∩
    // the room's own gating draws NOTHING must never furnish NOTHING — an
    // empty deck hands the room back to the archetype's bare legacy管线
    // (the bath rendered as a pure pool basin: four declared kits, zero
    // placed). The fallback relaxes ONLY the module whitelist (the kitIds
    // filter), keeping the world-class/archetype gate and the shore rule
    // intact: the room still furnishes from its archetype's real, gated
    // vocabulary, never from everything.
    kits = gated.filter(drawable);
  }
  if (kits.length === 0) return [];
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
    /** Optional discs override (the schematic pass): ISOLATED blueprint
     *  groups check only against non-schematic discs — their pieces
     *  relate by AUTHORED offsets (a coffee table 0.4m in front of its
     *  sofa is the composition, not a violation), while everything
     *  outside the blueprint still guards the full set. */
    guardDiscs?: readonly { x: number; z: number; r: number }[],
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
      if (water && !kit.intoWater && insideWater(p.x, p.z, water, pieceClear)) {
        return null;
      }
      // Template keep-empty zones (§7): the entrance apron, the hall
      // spine — authored voids the furnishing must respect.
      if (o.zones?.keepEmpty) {
        for (const r of o.zones.keepEmpty) {
          if (inZoneRect(p.x, p.z, r)) return null;
        }
      }
    }
    const r = kit.footprint * t.scale;
    for (const d of guardDiscs ?? discs) {
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

  // 0. ROOM SCHEMATICS (v0.12 §2 — the structure layer). Modules that
  //    carry a blueprint furnish by slot placement: resolveSchematic
  //    turns each placement into synthetic kit groups (seeded accepts,
  //    authored anchors/facings — all draws ride this same stream in
  //    declaration order, A6), and each group is pushed through THE SAME
  //    pushKit clearance machinery as a hand-written kit. A failed
  //    optional group drops alone; a failed required group (or a failed
  //    resolution) rolls EVERY schematic piece back — the module then
  //    furnishes with the generic orchestration below, never a half-
  //    furnished room. On success the schematic's rect owns its module's
  //    floor: the generic hero and the module's cluster zones stand down
  //    there (the blueprint's required groups ARE the centrepiece; a
  //    generic hero would double-furnish the floor). Rooms without
  //    schematics skip this whole block — zero draws, byte-for-byte.
  let schemRects: readonly KitZoneRect[] = [];
  if (o.schematics && o.schematics.length > 0) {
    const preOut = out.length;
    const preDiscs = discs.length;
    const preCovered = covered;
    const schemDiscs = new Set<{ x: number; z: number; r: number }>();
    let aborted = false;
    for (const placement of o.schematics) {
      const resolved: ResolvedSchematicGroup[] | null = resolveSchematic(
        placement,
        rng,
        propScale,
      );
      if (!resolved) {
        aborted = true;
        break;
      }
      for (const g of resolved) {
        const kit: Kit = {
          id: g.id,
          worldClasses: ["interior"],
          facing: "center",
          footprint: g.footprint,
          pieces: g.pieces.map((p) => ({
            kind: p.kind,
            dx: p.dx,
            dz: p.dz,
            rotY: p.rotY,
            dy: p.dy,
            scale: p.scale,
          })),
        };
        const t: KitTransform = { x: g.x, z: g.z, rotY: g.rotY, scale: 1 };
        // Isolated groups (one authored composition) guard only against
        // non-schematic discs; the optional groups guard against all.
        const guard = g.isolated
          ? discs.filter((d) => !schemDiscs.has(d))
          : discs;
        const pieces = pushKit(kit, t, { skipPathCheck: g.skipPath }, nextKitIndex, guard);
        if (!pieces) {
          if (g.required) {
            aborted = true;
            break;
          }
          continue;
        }
        nextKitIndex += 1;
        out.push(...pieces);
        const d = { x: t.x, z: t.z, r: g.footprint };
        discs.push(d);
        schemDiscs.add(d);
        covered += Math.PI * g.footprint * g.footprint;
      }
      if (aborted) break;
    }
    if (aborted) {
      out.length = preOut;
      discs.length = preDiscs;
      covered = preCovered;
    } else {
      schemRects = o.schematics.map((p) => p.rect);
    }
  }

  // 1. The hero: composed centrepiece at the far-third slot. The path
  //    leads TO it, so the path check is skipped for the hero itself; the
  //    hero's clearing keeps everything else off its stage.
  //    Template zones (§7) may pin the hero's kit and stand it at the
  //    template's hero rect instead of the seeded slot.
  //    FAILED FIRST DRAWS REDRAW (v0.12): nature retries a water-blocked
  //    focal point along the far-third band; interiors redraw inside the
  //    authored hero zone (see below). A hero that places on the first
  //    candidate consumes no retry draws — staging stays byte-for-byte.
  const heroKits = kits.filter((k) => k.heroSlot);
  if (heroKits.length > 0) {
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
    // v0.12 §2: a hero slot OWNED by a succeeded schematic stands down —
    // the blueprint's required groups ARE the composed centrepiece (the
    // seating answers the media wall on the module's axis); a generic
    // hero would double-furnish the floor. Suppressed heroes consume no
    // draws; a rolled-back schematic leaves schemRects empty and the
    // hero places exactly as before.
    const heroOwned = schemRects.some((r) => inZoneRect(hx, hz, r));
    if (!heroOwned) {
    const pinned = o.zones?.heroKit
      ? heroKits.find((k) => k.id === o.zones!.heroKit)
      : undefined;
    const kit = pinned ?? heroKits[Math.floor(rng() * heroKits.length)];
    const heroCandidates: { x: number; z: number }[] = [{ x: hx, z: hz }];
    if (worldClass === "nature") {
      const halfW = plan.width / 2;
      if (water) {
        // Waterside hero: the composed focal point of a flooded room is
        // the FAR BANK, not a random dry corner. Candidates stand on the
        // deck just past the basin's far edge (origin far enough inland
        // that the kit's front pieces — which face the door, toward the
        // water — stay clear of the shoreline), seeded along the bank.
        const farEdge = water.cz + water.halfZ;
        for (let i = 0; i < Math.ceil(KIT_HERO_ATTEMPTS / 2); i++) {
          heroCandidates.push({
            x: (rng() * 2 - 1) * halfW * 0.3,
            z: farEdge + 1.8 + rng() * 1.5,
          });
        }
      }
      // Generic dry far-third draws fill the rest of the budget (dry
      // biomes retry here too — a colonnade's focal slot can still land
      // on an abandoned quadrant or a door approach).
      for (
        let i = 0;
        i < (water ? Math.floor(KIT_HERO_ATTEMPTS / 2) : KIT_HERO_ATTEMPTS);
        i++
      ) {
        heroCandidates.push({
          x: (rng() * 2 - 1) * halfW * 0.25,
          z: plan.extent * (0.68 + rng() * 0.2),
        });
      }
    }
    if (o.zones?.hero) {
      // Interior hero redraw (v0.12 declarations audit): the pinned hero's
      // first candidate is the zone center, and when that single draw
      // failed, interiors used to settle for NO centrepiece at all — the
      // bedroom lost its bed over a 5cm keep-empty disc graze, the kitchen
      // its table, the pool-deck its loungers. The interior hero now gets
      // the same bounded redraw the nature class always had: seeded draws
      // INSIDE the authored hero zone (the module promised the kit fits
      // there), same pushKit clearance for every candidate. Draws are
      // consumed only after the center fails, so a hero that already
      // placed keeps byte-for-byte staging; A6 unchanged (same stream).
      const hr = o.zones.hero;
      for (let i = 0; i < KIT_HERO_ATTEMPTS; i++) {
        heroCandidates.push({
          x: hr.x0 + rng() * (hr.x1 - hr.x0),
          z: hr.z0 + rng() * (hr.z1 - hr.z0),
        });
      }
    }
    for (const c of heroCandidates) {
      const t: KitTransform = {
        x: c.x,
        z: c.z,
        rotY: Math.atan2(-c.x, -c.z),
        scale: propScale,
      };
      const pieces = pushKit(kit, t, { skipPathCheck: true }, nextKitIndex);
      if (pieces) {
        nextKitIndex += 1;
        out.push(...pieces);
        const r = Math.max(kit.footprint, HERO_CLEAR) * propScale;
        discs.push({ x: t.x, z: t.z, r });
        covered += Math.PI * kit.footprint * propScale * kit.footprint * propScale;
        break;
      }
    }
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
  // §6's anti-warehouse rule, as two cooperating mechanisms (2026-10 XL
  // repetition audit — the "same kit N times in one room" readings):
  //  (a) ZONE DECKS. When a cluster rect carries its own kitIds (a composed
  //      room's modules — room-modules.ts compositionKitZonesFor), the kit
  //      that STANDS in that zone is re-dealt from the ZONE's whitelist: a
  //      kit repeats only inside its own module (a reading room keeps
  //      several reading corners), never sprawls across the whole room
  //      (§8.1.4). The re-deal happens AFTER the transform draw and keeps
  //      the transform — the position/rng economy (and so the placement hit
  //      rate, i.e. B.12's density) is exactly the legacy flow's; only the
  //      kit's identity is steered. Rooms whose zones carry no decks (the
  //      legacy templates) keep the union deal byte-for-byte.
  //  (b) A ROOM-WIDE CAP (KIT_ROOM_CAP = 3). No kit id more than three
  //      times per room: the draw re-rolls onto an uncapped kit — the
  //      zone's own deck first, then any room kit, then the zone deck's
  //      least-used, where the B.12 density promise outranks the cap; a
  //      deck that cannot honour both is a deck-size problem, and the
  //      whitelists own that.
  // v0.12 §2: cluster zones OWNED by a succeeded schematic stand down —
  // the module's floor is furnished by the blueprint; only the OTHER
  // modules' zones deal. An empty schemRects filter is the identity, so
  // rooms without schematics keep the zone set byte-for-byte.
  const rectInside = (a: KitZoneRect, b: KitZoneRect) =>
    a.x0 >= b.x0 - 1e-9 &&
    a.x1 <= b.x1 + 1e-9 &&
    a.z0 >= b.z0 - 1e-9 &&
    a.z1 <= b.z1 + 1e-9;
  const activeClusters =
    o.zones?.clusters?.filter(
      (c) => !schemRects.some((r) => rectInside(c, r)),
    ) ?? o.zones?.clusters;
  const zoneDecks =
    activeClusters && activeClusters.some((r) => (r.kitIds?.length ?? 0) > 0)
      ? activeClusters
      : null;
  const counts = new Map<string, number>();
  const drawKit = (deck: readonly Kit[]): Kit => {
    const countOf = (k: Kit) => counts.get(k.id) ?? 0;
    // Precedence: (1) an uncapped kit OF THE ZONE'S DECK — the module's
    // own vocabulary first; (2) any uncapped kit of the ROOM — the cap is
    // room-wide even when one module's short list is exhausted (a borrowed
    // sibling beats a 4th repeat); (3) the zone deck's LEAST-USED kit —
    // only a fully saturated room lands here, and then the B.12 density
    // promise outranks the cap: a deck that cannot honour both is a
    // deck-size problem, and the whitelists own that.
    const uncapped = deck.filter((k) => countOf(k) < KIT_ROOM_CAP);
    const pool =
      uncapped.length > 0
        ? uncapped
        : (() => {
            const room = kits.filter((k) => countOf(k) < KIT_ROOM_CAP);
            if (room.length > 0) return room;
            const min = Math.min(...deck.map(countOf));
            return deck.filter((k) => countOf(k) === min);
          })();
    let kit = pool[Math.floor(rng() * pool.length)];
    // Variety re-roll: the same kit twice in a row reads as a warehouse
    // aisle, not an arrangement (§6: kits are never equidistant repeats).
    if (kit.id === prevId && pool.length > 1) {
      kit = pool[Math.floor(rng() * pool.length)];
    }
    return kit;
  };
  const zoneDeckFor = (zone: KitClusterRect): readonly Kit[] => {
    const ids = zone.kitIds;
    return ids && ids.length > 0 ? kits.filter((k) => ids.includes(k.id)) : [];
  };
  for (let slot = 0; slot < target; slot++) {
    if (covered + minCov > coverageCap) break;
    for (let a = 0; a < KIT_PLACE_ATTEMPTS; a++) {
      let kit = drawKit(kits);
      const t = drawKitTransform(rng, kit, plan, comp, water, propScale, wallInset);
      if (!t) continue;
      // Template cluster zones (§7): side kits live where the template put
      // its content areas — the shelf walls' feet, the bedroom wing. The
      // membership test runs against the ACTIVE (schematic-owning modules'
      // zones filtered out) set while the gate stays on the DECLARED set:
      // a room whose clusters are ALL schematic-owned must place NOTHING
      // here — an empty active list is a total filter, not an open floor.
      if (o.zones?.clusters && o.zones.clusters.length > 0) {
        const hit = activeClusters?.find((r) => inZoneRect(t.x, t.z, r));
        if (!hit) continue;
        // Zone deck: the kit standing in a module's zone speaks that
        // module's vocabulary. The drawn kit already belongs → keep;
        // otherwise re-deal from the zone's whitelist (seeded, capped),
        // keeping the transform — clearance below re-validates everything.
        if (zoneDecks) {
          const zdeck = zoneDeckFor(hit);
          if (zdeck.length > 0 && !zdeck.includes(kit)) {
            kit = drawKit(zdeck);
          }
        }
      }
      const cov = Math.PI * (kit.footprint * propScale) ** 2;
      if (covered + cov > coverageCap) continue;
      const pieces = pushKit(kit, t, { skipPathCheck: false }, nextKitIndex);
      if (!pieces) continue;
      nextKitIndex += 1;
      out.push(...pieces);
      discs.push({ x: t.x, z: t.z, r: kit.footprint * t.scale });
      covered += cov;
      prevId = kit.id;
      counts.set(kit.id, (counts.get(kit.id) ?? 0) + 1);
      break;
    }
  }

  // 3. Open fields (§8.2 随机区域): each module-scale void inside a composed
  //    room draws 0–3 seeded pieces — sparse by construction (most fields
  //    draw none), never a grid (positions are uniform draws inside the
  //    rect, never equidistant §6), never a warehouse (the deck is the
  //    room's module-filtered whitelist, with the same variety of small
  //    "trace" pieces as the module floors). Every piece rides the SAME
  //    pushKit clearance machinery as the side kits — walkable footprint,
  //    doorway and strand-door approaches, the cleared path, the water,
  //    the authored keep-empty zones, the kit-gap discs — and counts
  //    against the SAME 65% coverage budget, so §6's bans bind in the
  //    fields exactly as on the module floors. A field too small for the
  //    margins, or a draw that finds no legal spot, simply dresses lighter:
  //    少而准 beats 塞满.
  if (o.openFields) {
    for (const field of o.openFields) {
      const wanted = Math.floor(rng() * (OPEN_FIELD_PIECE_MAX + 1));
      for (let slot = 0; slot < wanted; slot++) {
        if (covered + minCov > coverageCap) break;
        for (let a = 0; a < KIT_PLACE_ATTEMPTS; a++) {
          // The room-wide cap binds in the fields exactly like the module
          // floors — a 随机区域 is not a warehouse loophole (§6).
          const kit = drawKit(kits);
          const cov = Math.PI * (kit.footprint * propScale) ** 2;
          if (covered + cov > coverageCap) continue;
          const m = wallInset + 0.2 * propScale;
          // The margin must swallow the kit's own pieces, not just its
          // origin: a bed-corner's lamp stands ~1.9 m from the origin, and
          // the field's promise is that every piece CENTER stays inside
          // the rect (piece bodies may overhang an edge the way a rug
          // overhangs — dressing, not a leak). Reach is the farthest any
          // piece center can sit after the placement's rotation.
          const reach =
            Math.max(
              ...kit.pieces.map((p) => Math.hypot(p.dx, p.dz)),
            ) * propScale;
          const xLo = field.x0 + m + reach;
          const xHi = field.x1 - m - reach;
          const zLo = field.z0 + m + reach;
          const zHi = field.z1 - m - reach;
          if (xHi - xLo < 0.4 || zHi - zLo < 0.4) break;
          const x = xLo + rng() * (xHi - xLo);
          const z = zLo + rng() * (zHi - zLo);
          const t: KitTransform = {
            x,
            z,
            rotY: facingRotY(kit.facing, x, z, comp, water),
            scale: propScale,
          };
          const pieces = pushKit(kit, t, { skipPathCheck: false }, nextKitIndex);
          if (!pieces) continue;
          nextKitIndex += 1;
          out.push(...pieces);
          discs.push({ x: t.x, z: t.z, r: kit.footprint * t.scale });
          covered += cov;
          counts.set(kit.id, (counts.get(kit.id) ?? 0) + 1);
          break;
        }
      }
    }
  }
  // 4. THE TRACE (§4.4) — the room's exactly-one calm trace, chosen, not
  //    baked into some kit: a whitelisted kind set ON a host piece that
  //    stands inside the visibility band of the walk path or the hero
  //    (the trace must be SEEN from where the walker actually is — a
  //    trace tucked behind the far wall would be set dressing, not a
  //    trace). Hosts are flat-topped pieces (TRACE_HOST_TOPS); a host
  //    whose placement already carries a trace-kind piece on it (the
  //    gallery bench's own open book) is skipped so two books never pile
  //    onto one seat. No eligible host ⇒ no trace (空场 / 极小的房 grow
  //    none) — one otherwise. The draw rides the same seeded stream:
  //    same slice, same trace (A6).
  const carriedBy = new Set<number>();
  for (const p of out) {
    if ((TRACE_KINDS as readonly string[]).includes(p.kind) && p.dy > 0) {
      carriedBy.add(p.kitIndex);
    }
  }
  const hosts = out.filter(
    (p) =>
      TRACE_HOST_TOPS[p.kind] !== undefined && !carriedBy.has(p.kitIndex),
  );
  const visibleHosts = hosts.filter((p) =>
    traceVisible(comp, p.x, p.z, propScale, plan.extent),
  );
  if (visibleHosts.length > 0) {
    const host = visibleHosts[Math.floor(rng() * visibleHosts.length)];
    const kind = TRACE_KINDS[Math.floor(rng() * TRACE_KINDS.length)];
    out.push({
      kind,
      x: host.x,
      z: host.z,
      rotY: host.rotY + (rng() * 2 - 1) * 0.6,
      scale: propScale,
      dy: 0,
      y: o.heightAt(host.x, host.z) + TRACE_HOST_TOPS[host.kind] * host.scale,
      kitId: host.kitId,
      kitIndex: host.kitIndex,
      trace: true,
    });
  }
  return out;
}
