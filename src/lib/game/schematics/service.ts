/**
 * The service family — Lane B's blueprints (v0.12b P2b).
 *
 * Lane B owns THIS FILE and nothing else: foyer, kitchen, bath, storage
 * and workshop join here, each a `RoomSchematic` against the shared
 * vocabulary in ./types. The family array keeps the MODULE_ORDER relative
 * order (foyer → kitchen → bath → storage → workshop); the global
 * catalogue order (residential → service → public) is fixed by
 * ./index.ts, so appending here never disturbs another lane.
 *
 * Design sources: doc/design/room-plans/{foyer,kitchen,bath,storage,
 * workshop}.txt (the layout truth), v0.12-room-specs.md §5–§7/§12–§13,
 * v0.12-room-realism.md §2. Where a room's own plan legitimately draws a
 * kind from the default 禁止栏 (the bath's lockers, the storage room's
 * cart, the workshop's chair stack, the foyer's waiting bench), the
 * blueprint declares its own `bans` list — per-room lists replaced the
 * one-size ban (schematics/types.ts). Declared (even as []) the room's
 * list REPLACES the default entirely; each declaration keeps exactly the
 * kinds that still have no purpose chain in that room.
 */
import type { RoomSchematic } from "./types";

/**
 * 门厅 (v0.12-room-specs §12, room-plans/foyer.txt — variant A, the
 * 对门前台): the arrival hub. The module's keep-empty spine has narrowed
 * to the entrance half (z < 4), so the reception counter now stands ON
 * THE ROOM AXIS as an island podium — walking in, you meet the desk
 * (foyer.txt A: F row 03, register + bell on the slab, path leading to
 * it). The waiting bench answers it across the room on the east wall
 * (G rows 05–06 — bench is §6.4-legal in a foyer, so this room drops it
 * from the ban list), the coat/umbrella/plant threshold takes the west
 * wall's entrance third (the entrance wall itself stays bare — the
 * doorway strip and the composition's entrance apron make it
 * unanchorable by design), the lobby clock optional against the far wall
 * behind the desk, the entry mat optional at the door's east jamb.
 *
 * bans: the default list minus bench (this room's plan accounts for the
 * waiting bench) — towel/housekeeping words, the luggage cart (§12) and
 * the pool/changing vocabulary stay unjustifiable in a threshold.
 */
const FOYER_SCHEMATIC: RoomSchematic = {
  moduleId: "foyer",
  focalWall: "n",
  symmetry: "none",
  bans: [
    "poolbench",
    "lounger",
    "towelstack",
    "towelrail",
    "bucket",
    "luggagecart",
    "lockerrow",
    "chairstack",
  ],
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 前台 — the reception counter as an island podium ON the room
      // axis, 2.4–2.6m off the far wall (foyer.txt A's F@row 03): you
      // walk in and meet the desk. The walk path leads to it (terminus).
      role: "counter",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [2.4, 2.6], along: 0.5, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["counter"],
      clearance: 0.75,
    },
    {
      // 登记簿 — the ledger ON the countertop (lift rides the counter).
      // The counter faces the door (rotY π): its local +x maps to world
      // −x, so a NEGATIVE dx lands west — the mirror of intuition.
      role: "ledger",
      group: "desk",
      required: true,
      at: { kind: "relative", slot: "counter", dx: [-0.52, -0.3], dz: [-0.1, 0.1] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.3 },
      accepts: ["register"],
      lift: 0.96,
      clearance: 0.15,
    },
    {
      // 摇铃 — the bell beside the ledger, ON the counter.
      role: "bell",
      group: "desk",
      required: true,
      at: { kind: "relative", slot: "counter", dx: [0.3, 0.52], dz: [-0.1, 0.1] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.3 },
      accepts: ["bell"],
      lift: 0.96,
      clearance: 0.15,
    },
    {
      // 大堂钟 — the lobby clock against the far wall behind the desk,
      // its own optional group (degrades alone).
      role: "lobbyclock",
      group: "clock",
      required: false,
      chance: 0.5,
      at: { kind: "wall", wall: "focal", dist: [0.68, 0.78], along: 0.28, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["grandfatherclock"],
      clearance: 0.35,
    },
    {
      // 候客长椅 — the waiting bench against the east wall (foyer.txt's
      // G), facing the desk across the room — the check-in conversation
      // axis. bench is §6.4-legal in a foyer, hence this room's bans.
      role: "waitseat",
      group: "waiting",
      required: true,
      at: { kind: "wall", wall: "e", dist: [0.7, 0.8], along: 0.4, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["bench"],
      clearance: 0.75,
      scale: [1.05, 1.2],
    },
    {
      // 衣帽架 — the coat stand on the west wall's entrance third (the
      // apron + door strip keep the entrance wall itself bare — the
      // machinery never anchors there).
      role: "coatstand",
      group: "threshold",
      required: true,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.8], along: 0.3, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["coatstand"],
      clearance: 0.4,
    },
    {
      // 伞架 — beside the coat stand along the same wall.
      role: "umbrellastand",
      group: "threshold",
      required: true,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.8], along: 0.37, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["umbrellastand"],
      clearance: 0.4,
    },
    {
      // 门厅盆栽 — a plant breathing at the threshold corner, optional.
      role: "thresholdplant",
      group: "threshold",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.8], along: 0.22, alongTol: 0.04 },
      facing: { kind: "intoRoom", wall: "s" },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.85, 1.0],
    },
    {
      // 门垫 — the entry mat at the door's east jamb (the spine keeps the
      // axis itself clear), optional, flat.
      role: "entrymat",
      group: "mat",
      required: false,
      chance: 0.7,
      flat: true,
      at: { kind: "wall", wall: "s", dist: [1.15, 1.45], along: 0.79, alongTol: 0.02 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      clearance: 0,
      scale: [0.8, 1.0],
    },
  ],
};

/**
 * 备餐间 (specs §5, room-plans/kitchen.txt): the working wall and the
 * laid table. The counter runs two units on the focal wall with its tray
 * and vase ON the slab; the small dining table stands on the room axis
 * with 2–4 chairs around it (the seeded end chairs are the plan set's
 * A/B chair count); the sideboard waits along the east wall dressed; the
 * mop parks in the south-west corner (the plans' X — the bucket half is
 * audit-banned, the mop carries the corner alone). Table and counter
 * groups are BOTH the path's destination (terminus) — the walk path leads
 * to the working wall the way it leads to the generic hero.
 *
 * 禁止栏 (§5): no sofa/tv/bed/lounger/bookshelf — none appear; the
 * coat-bench and chair-stack kits left the whitelist in the declarations
 * audit, so the generic fallback cannot smuggle them either.
 */
const KITCHEN_SCHEMATIC: RoomSchematic = {
  moduleId: "kitchen",
  focalWall: "n",
  symmetry: "none",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 操作台 — the worktop run on the focal wall (two units stepped
      // along it, scaled into a contiguous counter).
      role: "worktop",
      group: "counter",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.9], along: 0.5, alongTol: 0.15 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["counter"],
      count: [2, 2],
      scale: [1.15, 1.3],
      clearance: 0.75,
    },
    {
      // 台面托盘 — the tray ON the slab's west unit.
      role: "slabtray",
      group: "counter",
      required: true,
      at: { kind: "relative", slot: "worktop", dx: [0.05, 0.2], dz: [-0.1, 0.1] },
      facing: { kind: "fixed", rotY: 0.4, jitter: 0.3 },
      accepts: ["tray"],
      lift: 0.96,
      clearance: 0.15,
    },
    {
      // 台面花瓶 — the vase ON the east unit. The run faces the door
      // (rotY π: local +x = world −x), so the east unit sits at a
      // NEGATIVE local dx from the first (west) unit.
      role: "slabvase",
      group: "counter",
      required: true,
      at: { kind: "relative", slot: "worktop", dx: [-1.35, -1.2], dz: [-0.1, 0.1] },
      facing: { kind: "fixed", rotY: 0.4, jitter: 0.3 },
      accepts: ["vase"],
      lift: 0.96,
      clearance: 0.15,
    },
    {
      // 餐桌 — the small laid table on the axis, dressed (1–2 pieces).
      role: "diningtable",
      group: "table",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [2.85, 2.95], along: 0.5, alongTol: 0.12 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["diningtable"],
      clearance: 0.9,
      scale: [0.95, 1.05],
    },
    {
      // 桌面摆设 — the table's own dressing (tray / vase / candle).
      role: "tabletray",
      group: "table",
      required: true,
      at: { kind: "relative", slot: "diningtable", dx: [-0.35, -0.05], dz: [-0.2, 0.2] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["tray", "vase", "candle"],
      count: [1, 2],
      lift: 0.78,
      clearance: 0.15,
    },
    {
      // 近门椅 — the chair between the door and the table, facing it.
      role: "approachchair",
      group: "chair-approach",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "diningtable", dx: [-0.55, -0.3], dz: [0.65, 0.72] },
      facing: { kind: "toward", slot: "diningtable" },
      accepts: ["chair"],
      clearance: 0.25,
      scale: [0.9, 1.0],
    },
    {
      // 近台椅 — the chair between the table and the counter, facing it.
      role: "counterchair",
      group: "chair-counter",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "diningtable", dx: [0.3, 0.55], dz: [-0.72, -0.65] },
      facing: { kind: "toward", slot: "diningtable" },
      accepts: ["chair"],
      clearance: 0.25,
      scale: [0.9, 1.0],
    },
    {
      // 端头椅·西 — the west end chair (the 4-chair variant), optional.
      role: "endchairw",
      group: "end-w",
      required: false,
      chance: 0.5,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "diningtable", dx: [-0.98, -0.85], dz: [-0.12, 0.12] },
      facing: { kind: "toward", slot: "diningtable" },
      accepts: ["chair"],
      clearance: 0.25,
      scale: [0.9, 1.0],
    },
    {
      // 端头椅·东 — the east end chair, optional.
      role: "endchare",
      group: "end-e",
      required: false,
      chance: 0.5,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "diningtable", dx: [0.85, 0.98], dz: [-0.12, 0.12] },
      facing: { kind: "toward", slot: "diningtable" },
      accepts: ["chair"],
      clearance: 0.25,
      scale: [0.9, 1.0],
    },
    {
      // 餐边柜 — the sideboard along the east wall, dressed.
      role: "credenza",
      group: "sideboard",
      required: true,
      at: { kind: "wall", wall: "e", dist: [0.75, 0.85], along: 0.5, alongTol: 0.2 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["sideboard"],
      clearance: 0.85,
    },
    {
      // 柜面摆设 — the sideboard's top dressing.
      role: "sidetray",
      group: "sideboard",
      required: true,
      at: { kind: "relative", slot: "credenza", dx: [-0.42, -0.05], dz: [-0.04, 0.04] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["vase", "tray", "candle"],
      count: [1, 2],
      lift: 0.8,
      clearance: 0.15,
    },
    {
      // 拖把 — the mop parked in the south-west corner (the plans' X).
      role: "mop",
      group: "cleaning",
      required: true,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.8], along: 0.19, alongTol: 0.12 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["mop"],
      clearance: 0.3,
    },
  ],
};

/**
 * 更衣浴室 (specs §6, room-plans/bath.txt — the 16×10 redraw): a REAL
 * changing room again. The water owns the middle band (rows 03–05); the
 * dry rims take the furniture exactly as the plan draws it:
 *   west rim — the locker run (U@col 02, rows 03–06) mid-rim, the vanity
 *     station at its far end (M@col 02, row 02), the towel rail at the
 *     water's edge (X@col 03, row 05);
 *   north edge — the towel station (XGG@row 02): the bench with its
 *     folded towels ON the seat and the bucket beside it;
 *   east rim — the mirrored locker run and rail (variant A's double side,
 *     optional), the humidity plants at the far end (P@col 15, row 02).
 * The blueprint declares its own bans: the pool-DECK vocabulary
 * (poolbench/lounger), the luggage cart and the banquet chair stack have
 * no purpose chain in a changing room — everything else the plan names is
 * authored, so the locker row, bench, towel rail, towel stack and bucket
 * are all back (the per-room ban list replaced the one-size ban).
 */
const BATH_SCHEMATIC: RoomSchematic = {
  moduleId: "bath",
  focalWall: "n",
  symmetry: "none",
  bans: ["poolbench", "lounger", "luggagecart", "chairstack"],
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 更衣柜·西 — the locker run on the west rim, facing the water
      // side (you change looking at the pool).
      role: "lockerrow-w",
      group: "lockers-w",
      required: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.85], along: 0.58, alongTol: 0.15 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["lockerrow"],
      clearance: 0.5,
    },
    {
      // 毛巾架·西 — the towel rail at the water's edge on the west rim
      // (X@col 03, row 05): reach it from the pool, dry off walking out.
      role: "rail-w",
      group: "rail-w",
      required: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [2.35, 2.55], along: 0.55, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["towelrail"],
      clearance: 0.55,
    },
    {
      // 更衣长凳 — the bench on the north edge (GG@row 02), facing the
      // water; the walk path leads to it (terminus) — you cross the room
      // to sit and dry off.
      role: "drybench",
      group: "towelstation",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [1.3, 1.5], along: 0.44, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bench"],
      clearance: 0.75,
      scale: [1.05, 1.2],
    },
    {
      // 凳上毛巾 — the folded towels ON the bench seat (lift rides the
      // bench's own scale — the bench top rises with it, never floating).
      role: "benchtowels",
      group: "towelstation",
      required: true,
      at: { kind: "relative", slot: "drybench", dx: [-0.35, -0.15], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["towelstack"],
      count: [1, 2],
      lift: 0.45,
      clearance: 0.2,
    },
    {
      // 水桶 — the bucket beside the bench (X@col 06, row 02).
      role: "benchbucket",
      group: "towelstation",
      required: true,
      at: { kind: "relative", slot: "drybench", dx: [0.75, 0.95], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["bucket"],
      clearance: 0.3,
    },
    {
      // 更衣柜·东 — the mirrored run on the east rim (variant A's double
      // side; variant B's single run is the west one alone), optional.
      role: "lockerrow-e",
      group: "lockers-e",
      required: false,
      chance: 0.55,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [0.68, 0.85], along: 0.52, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["lockerrow"],
      clearance: 0.5,
    },
    {
      // 毛巾架·东 — the east rail at the water's edge, optional.
      role: "rail-e",
      group: "rail-e",
      required: false,
      chance: 0.5,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [2.35, 2.55], along: 0.52, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["towelrail"],
      clearance: 0.55,
    },
    {
      // 梳妆台 — the vanity station at the west rim's far end (M@col 02,
      // row 02), OPTIONAL as the specs list it. The host carries the
      // chance; its chair/screen/mat are chance-free — when the host
      // stays out, the children's anchors dangle and they skip cleanly
      // (the group places whole or not at all, never a lone floating
      // stool).
      role: "vanitytable",
      group: "vanity",
      required: false,
      chance: 0.7,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.85], along: 0.8, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["vanity"],
      clearance: 0.8,
    },
    {
      // 梳妆凳 — the stool in front, facing the mirror.
      role: "vanitychair",
      group: "vanity",
      required: false,
      at: { kind: "relative", slot: "vanitytable", dx: [-0.12, 0.12], dz: [0.7, 0.85] },
      facing: { kind: "toward", slot: "vanitytable" },
      accepts: ["chair"],
      clearance: 0.35,
      scale: [0.85, 0.95],
    },
    {
      // 更衣屏风 — the changing screen beside the vanity (seeded side).
      role: "vanityscreen",
      group: "vanity",
      required: false,
      at: {
        kind: "relative",
        slot: "vanitytable",
        dx: [0.95, 1.2],
        dz: [-0.1, 0.15],
        side: "seeded",
      },
      facing: { kind: "fixed", rotY: 0.4, jitter: 0.3 },
      accepts: ["screen"],
      clearance: 0.5,
    },
    {
      // 梳妆毯 — the flat mat under the stool (walked over, no disc).
      role: "vanityrug",
      group: "vanity",
      required: false,
      flat: true,
      at: { kind: "relative", slot: "vanitytable", dx: [-0.1, 0.1], dz: [0.5, 0.7] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      clearance: 0,
      scale: [0.8, 0.95],
    },
    {
      // 耐湿盆栽 — 1–2 humidity plants along the east rim's far end.
      role: "rimplant",
      group: "plants",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "e", dist: [0.7, 0.8], along: 0.8, alongTol: 0.05 },
      facing: { kind: "moduleCenter" },
      accepts: ["plant"],
      count: [1, 2],
      clearance: 0.4,
      scale: [0.8, 1.0],
    },
  ],
};

/**
 * 行李房 (specs §7, room-plans/storage.txt): the being-tidied room, by
 * composition not piece count. One rack anchors the north wall with
 * cases at its feet; a second rack stands on a seeded flank (the plan
 * set's A/B disagreement — north pair vs east-west pair — becomes the
 * "one rack back, one still out" mid-tidy reading), its shelves carrying
 * one case each; the LUGGAGE CART stands by the door, a metre in —
 * §12 bans the cart in the foyer, but this is the room it belongs to,
 * so this blueprint drops it from the ban list. The service corner
 * (mop or bucket, seeded) waits in the west.
 *
 * bans: the default list minus luggagecart — pool-deck words, the
 * changing-room vocabulary and the banquet chair stack (§7's own ban)
 * stay unjustifiable in a luggage room.
 */
const STORAGE_SCHEMATIC: RoomSchematic = {
  moduleId: "storage",
  focalWall: "n",
  symmetry: "none",
  bans: [
    "poolbench",
    "lounger",
    "lockerrow",
    "towelrail",
    "towelstack",
    "chairstack",
  ],
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 北架 — the rack against the north wall, west of the spine. The
      // group is the walk path's destination (the path leads to the rack
      // wall), so its pieces skip the corridor check the way the living
      // hero does.
      role: "racknorth",
      group: "rack-n",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.72, 0.85], along: 0.24, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["storagerack"],
      clearance: 0.75,
    },
    {
      // 架下箱 — the floor cases at the north rack's feet (1–2).
      role: "floorcases",
      group: "rack-n",
      required: true,
      at: { kind: "relative", slot: "racknorth", dx: [-0.25, 0.25], dz: [0.4, 0.55] },
      facing: { kind: "fixed", rotY: 0.6, jitter: 0.4 },
      accepts: ["suitcase"],
      count: [1, 2],
      clearance: 0.35,
      scale: [0.85, 1.0],
    },
    {
      // 侧架 — the second rack on a seeded flank (east or west), the
      // pulled-out rack mid-tidying.
      role: "rackside",
      group: "rack-flank",
      required: true,
      isolated: true,
      at: { kind: "flankWall", dist: [0.75, 0.95], along: 0.74, alongTol: 0.05 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["storagerack"],
      clearance: 0.75,
    },
    {
      // 下层板箱 — the case riding the flank rack's low shelf (lifted).
      role: "shelfcase-low",
      group: "rack-flank",
      required: true,
      at: { kind: "relative", slot: "rackside", dx: [-0.35, -0.25], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["suitcase"],
      lift: 0.14,
      clearance: 0.3,
      scale: [0.85, 1.0],
    },
    {
      // 上层板箱 — the case riding the high shelf.
      role: "shelfcase-high",
      group: "rack-flank",
      required: true,
      at: { kind: "relative", slot: "rackside", dx: [0.25, 0.35], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["suitcase"],
      lift: 0.64,
      clearance: 0.3,
      scale: [0.8, 0.9],
    },
    {
      // 架顶托盘 — the tray holding the small stuff on the top shelf.
      role: "racktray",
      group: "rack-flank",
      required: false,
      chance: 0.6,
      at: { kind: "relative", slot: "rackside", dx: [-0.05, 0.05], dz: [0, 0.08] },
      facing: { kind: "fixed", rotY: 0.5, jitter: 0.4 },
      accepts: ["tray"],
      lift: 1.14,
      clearance: 0.15,
    },
    {
      // 行李车 — the luggage cart by the door (V@col 08, row 07), a metre
      // in from the entrance wall, facing the room — grab it and go.
      role: "cart",
      group: "cart",
      required: true,
      at: { kind: "wall", wall: "e", dist: [0.75, 0.9], along: 0.24, alongTol: 0.05 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["luggagecart"],
      clearance: 0.7,
    },
    {
      // 保洁角 — the service corner in the west (the plan's X): the mop
      // or the bucket, seeded.
      role: "mop",
      group: "mop",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.19, alongTol: 0.06 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["mop", "bucket"],
      clearance: 0.3,
    },
  ],
};

/**
 * 工作间 (specs §13, room-plans/workshop.txt): the room where something
 * was being made. The workbench corner owns the focal wall (bench + lamp
 * and tool tray ON the slab + the pulled-up chair, the workbench-corner
 * kit's vocabulary); the west flank takes the materials rack, the east
 * wall the second materials group (sideboard or rack, seeded); the
 * writing desk stays for the paperwork end near the entrance; the mop
 * waits in the south-east, and the CHAIR STACK (j@col 08, row 08 — §13
 * names the workshop its ONE proper room) waits beside it: half-finished
 * pieces, not a function room's spares. Deliberately asymmetric (§2
 * rule 6 — a studio must not compose axially): bench west-of-axis,
 * credenza east, rack far west, desk low west.
 *
 * bans: the default list minus chairstack — pool-deck words, the
 * changing-room vocabulary and the luggage cart stay unjustifiable here.
 */
const WORKSHOP_SCHEMATIC: RoomSchematic = {
  moduleId: "workshop",
  focalWall: "n",
  symmetry: "none",
  bans: [
    "poolbench",
    "lounger",
    "lockerrow",
    "towelstack",
    "towelrail",
    "bucket",
    "luggagecart",
  ],
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 工作台 — the workbench against the focal wall, west of the axis.
      role: "workbench",
      group: "bench",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.75, 0.95], along: 0.38, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["workbench"],
      clearance: 0.95,
    },
    {
      // 台面灯 — the task lamp ON the slab's west half.
      role: "benchlamp",
      group: "bench",
      required: true,
      at: { kind: "relative", slot: "workbench", dx: [-0.55, -0.4], dz: [-0.06, 0.06] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["desklamp"],
      lift: 0.9,
      clearance: 0.15,
    },
    {
      // 工具盘 — the tool tray ON the slab's east half.
      role: "tooltray",
      group: "bench",
      required: true,
      at: { kind: "relative", slot: "workbench", dx: [0.4, 0.55], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["tray"],
      lift: 0.9,
      clearance: 0.15,
    },
    {
      // 台前椅 — the chair pulled up to the bench, facing it.
      role: "benchchair",
      group: "bench",
      required: true,
      at: { kind: "relative", slot: "workbench", dx: [-0.12, 0.12], dz: [0.85, 1.05] },
      facing: { kind: "toward", slot: "workbench" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      // 物料架 — the materials rack on the west flank's far end.
      role: "materialsrack",
      group: "materials",
      required: true,
      at: { kind: "wall", wall: "w", dist: [0.72, 0.85], along: 0.82, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["storagerack"],
      clearance: 0.75,
    },
    {
      // 架顶托盘 — the small-stuff tray on the materials rack.
      role: "racktray",
      group: "materials",
      required: false,
      chance: 0.6,
      at: { kind: "relative", slot: "materialsrack", dx: [-0.05, 0.05], dz: [0, 0.08] },
      facing: { kind: "fixed", rotY: 0.5, jitter: 0.4 },
      accepts: ["tray"],
      lift: 1.14,
      clearance: 0.15,
    },
    {
      // 东墙柜 — the second materials group on the east wall (sideboard
      // or a second rack, seeded), dressed with parts.
      role: "eastcredenza",
      group: "credenza",
      required: true,
      at: { kind: "wall", wall: "e", dist: [0.75, 0.85], along: 0.35, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["sideboard", "storagerack"],
      clearance: 0.85,
    },
    {
      // 柜面零件 — the parts on the credenza.
      role: "credenzatray",
      group: "credenza",
      required: true,
      at: { kind: "relative", slot: "eastcredenza", dx: [-0.42, -0.05], dz: [-0.04, 0.04] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["tray", "vase", "candle"],
      count: [1, 2],
      lift: 0.8,
      clearance: 0.15,
    },
    {
      // 写字台 — the writing desk for the paperwork end (west, low).
      // Required: the group's chair/lamp anchor to it, and a relative
      // slot may never outlive a chanced host (the resolver forfeits the
      // whole placement on a dangling anchor).
      role: "paperdesk",
      group: "paperwork",
      required: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.9], along: 0.27, alongTol: 0.04 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["desk"],
      clearance: 0.8,
    },
    {
      // 文书椅 — the desk's chair, facing the desk (kept close — the
      // cleared corridor is wide here, and a chair far out east sits in
      // its bend).
      role: "paperchair",
      group: "paperwork",
      required: true,
      at: { kind: "relative", slot: "paperdesk", dx: [-0.1, 0.1], dz: [0.5, 0.6] },
      facing: { kind: "toward", slot: "paperdesk" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      // 文书灯 — the lamp ON the desk.
      role: "paperlamp",
      group: "paperwork",
      required: true,
      at: { kind: "relative", slot: "paperdesk", dx: [0.4, 0.55], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["desklamp"],
      lift: 0.8,
      clearance: 0.15,
    },
    {
      // 图纸堆 — the paper pile on the floor beside the chair, optional.
      role: "papers",
      group: "paperwork",
      required: false,
      chance: 0.7,
      at: { kind: "relative", slot: "paperdesk", dx: [0.5, 0.75], dz: [0.35, 0.55] },
      facing: { kind: "fixed", rotY: 0.4, jitter: 0.4 },
      accepts: ["bookpile"],
      clearance: 0.2,
    },
    {
      // 拖把 — the mop in the south-east corner.
      role: "mop",
      group: "mop",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "e", dist: [0.7, 0.85], along: 0.18, alongTol: 0.1 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["mop"],
      clearance: 0.3,
    },
    {
      // 叠椅 — the half-finished chair stack by the south-east (j@col 08,
      // row 08), optional; §13's one proper room for the stack, so this
      // blueprint drops it from the ban list.
      role: "sparestack",
      group: "spares",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "s", dist: [1.85, 2.0], along: 0.78, alongTol: 0.04 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["chairstack"],
      clearance: 0.55,
    },
  ],
};

/** Lane B's blueprints — the service family. */
export const SERVICE_SCHEMATICS: readonly RoomSchematic[] = [
  FOYER_SCHEMATIC,
  KITCHEN_SCHEMATIC,
  BATH_SCHEMATIC,
  STORAGE_SCHEMATIC,
  WORKSHOP_SCHEMATIC,
];
