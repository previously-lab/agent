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
      at: { kind: "wall", wall: "focal", dist: [0.72, 0.8], along: 0.28, alongTol: 0.06 },
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
      at: { kind: "wall", wall: "e", dist: [0.7, 0.8], along: 0.7, alongTol: 0.08 },
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
      at: { kind: "wall", wall: "w", dist: [0.72, 0.8], along: 0.21, alongTol: 0.08 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["coatstand"],
      clearance: 0.4,
    },
    {
      // 伞架 — beside the coat stand along the same wall.
      role: "umbrellastand",
      group: "threshold",
      required: true,
      at: { kind: "wall", wall: "w", dist: [0.72, 0.8], along: 0.27, alongTol: 0.06 },
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
      at: { kind: "wall", wall: "w", dist: [0.72, 0.8], along: 0.15, alongTol: 0.04 },
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
      at: { kind: "wall", wall: "s", dist: [1.25, 1.5], along: 0.79, alongTol: 0.02 },
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
      // 餐边柜 — the sideboard along the east wall's far half, dressed.
      // Isolated (a lone wall unit) and deep past the corridor's bends.
      // Terminus: in a 6m width the cleared corridor (pathHalf + clear
      // ≈ 1.9m each side of a seeded, weaving centerline) spans the whole
      // walkable width — no wall piece can guarantee the fringe clear in
      // every seed. It serves the working wall the path leads to; the
      // door strip itself stays asserted on every piece.
      role: "credenza",
      group: "sideboard",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [0.75, 0.85], along: 0.8, alongTol: 0.06 },
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
      // 拖把 — the mop on the west wall, deep in the galley. In a 6m
      // width the cleared corridor (pathHalf + clear ≈ 1.9m each side)
      // spans the room and the seeded path weaves — a wall-hugging
      // service piece rides the corridor check off (terminus) like the
      // cart in storage; the door strip stays asserted on every piece.
      role: "mop",
      group: "cleaning",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "w", dist: [0.68, 0.8], along: 0.38, alongTol: 0.06 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["mop"],
      clearance: 0.3,
    },
  ],
};

/**
 * 更衣浴室 (specs §6, room-plans/bath.txt — USER SCALE PASS 6×6): the
 * changing-room CORE, re-anchored into a 1×1 cell. The pool wing's
 * archetype waters ~45% of the floor (a central basin, x ≈ ±1.8); the
 * dry band past the 3.5m entrance strip takes the whole composition:
 *   far wall — the locker run (柜排贴墙), facing the room;
 *   far strip — the towel bench with its folded towels ON the seat and
 *     the bucket beside it (长凳可坐 + 水桶落服务角), the walk path's end;
 *   west rim at the basin's edge — the towel rail (毛巾杆在湿区边).
 * CUT at 36m² (the plan's optional column, in reverse): the vanity
 * station, the east-side mirror run and the humidity plants — a small
 * changing room cannot say why they are there. bans unchanged.
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
      // 更衣柜 — the locker run on the far wall, facing the room (you
      // change looking back at the door and the pool). The walk path
      // ends at this wall — terminus, like the living hero.
      role: "lockerrow",
      group: "lockers",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.72, 0.85], along: 0.6, alongTol: 0.1 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["lockerrow"],
      clearance: 0.5,
    },
    {
      // 毛巾架 — the towel rail at the basin's edge on the west rim: the
      // water starts at x ≈ −1.8, so the rail stands 0.95–1.15m off the
      // flank wall — reach it from the pool, dry off walking out.
      role: "rail",
      group: "rail",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.95, 1.15], along: 0.72, alongTol: 0.04 },
      facing: { kind: "intoRoom", wall: "w" },
      accepts: ["towelrail"],
      clearance: 0.55,
    },
    {
      // 更衣长凳 — the bench on the far strip (past the basin's far
      // edge), facing the water; the walk path leads to it (terminus) —
      // you cross the room to sit and dry off.
      role: "drybench",
      group: "towelstation",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.68, 0.75], along: 0.44, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bench"],
      clearance: 0.75,
      scale: [1.05, 1.2],
    },
    {
      // 凳上毛巾 — the folded towels ON the bench seat (lift rides the
      // bench's own scale — the bench top rises with it, never floating).
      // The bench faces intoRoom from the north wall (rotY π: local +z
      // maps to world −z — the mirror of intuition, see the foyer desk),
      // so a POSITIVE dz biases the piece INTO the room: the bench hugs the
      // far wall (dist 0.68–0.75 off a 6 m depth ⇒ z ≈ 5.25–5.32, and
      // planContains needs piece centers ≤ extent − wallInset ≈ 5.35), and
      // the old ± jitter rode the towels up to 5 cm PAST that walkable
      // margin — a 1 cm scrape that forfeits the whole placement (measured:
      // bath×shallows seed 5 staged an empty room off exactly this).
      role: "benchtowels",
      group: "towelstation",
      required: true,
      at: { kind: "relative", slot: "drybench", dx: [-0.35, -0.15], dz: [0.02, 0.12] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["towelstack"],
      count: [1, 2],
      lift: 0.45,
      clearance: 0.2,
    },
    {
      // 水桶 — the bucket on the floor beside the bench, biased INTO the
      // room (positive dz, same mirror) so its center stays off the far
      // wall's walkable-margin bound.
      role: "benchbucket",
      group: "towelstation",
      required: true,
      at: { kind: "relative", slot: "drybench", dx: [0.75, 0.95], dz: [0.04, 0.18] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["bucket"],
      clearance: 0.3,
    },
  ],
};

/**
 * 行李房 (specs §7, room-plans/storage.txt — USER SCALE PASS 6×6): the
 * being-tidied room in a 1×1 cell. One rack wall carries the whole
 * storage vocabulary (cases riding its two shelves, cases at its feet,
 * the small-stuff tray up top — the storage-rack kit's own composition);
 * the LUGGAGE CART hugs the east wall inside the doorway band (the
 * 3.5m entrance strip forbids anything nearer the door on the axis —
 * §7 allows "靠门侧 OR 居中", and the wall-hug is the closest legal
 * 靠门侧); the mop or bucket waits opposite. CUT: the second flank rack
 * — a 36m² room holds one rack honestly, not two.
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
      // 北架 — the rack against the far wall, west of the spine. The
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
      // 架下箱 — the floor cases at the rack's feet (1–2).
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
      // 下层板箱 — the case riding the rack's low shelf (lifted).
      role: "shelfcase-low",
      group: "rack-n",
      required: true,
      at: { kind: "relative", slot: "racknorth", dx: [-0.35, -0.25], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["suitcase"],
      lift: 0.14,
      clearance: 0.3,
      scale: [0.85, 1.0],
    },
    {
      // 上层板箱 — the case riding the high shelf.
      role: "shelfcase-high",
      group: "rack-n",
      required: true,
      at: { kind: "relative", slot: "racknorth", dx: [0.25, 0.35], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0.3, jitter: 0.3 },
      accepts: ["suitcase"],
      lift: 0.64,
      clearance: 0.3,
      scale: [0.8, 0.9],
    },
    {
      // 架顶托盘 — the tray holding the small stuff on the top shelf.
      role: "racktray",
      group: "rack-n",
      required: false,
      chance: 0.6,
      at: { kind: "relative", slot: "racknorth", dx: [-0.05, 0.05], dz: [0, 0.08] },
      facing: { kind: "fixed", rotY: 0.5, jitter: 0.4 },
      accepts: ["tray"],
      lift: 1.14,
      clearance: 0.15,
    },
    {
      // 行李车 — the luggage cart hugging the east wall beside the
      // doorway (V@col 08): the strip forbids |x| < 2.3 inside z 3.5,
      // so the cart stands 0.65–0.69m off the wall — the closest legal
      // 靠门侧. In a 1×1 cell the cleared corridor spans the room's
      // width (pathHalf 1.4 + clear 0.5 ≈ the whole 6m), so the cart —
      // met on the way in, grabbed on the way out — rides the corridor
      // check off (terminus) like every destination piece; the door
      // strip itself stays asserted on every piece.
      role: "cart",
      group: "cart",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "e", dist: [0.65, 0.69], along: 0.33, alongTol: 0.03 },
      facing: { kind: "intoRoom", wall: "e" },
      accepts: ["luggagecart"],
      clearance: 0.7,
    },
    {
      // 保洁角 — the service corner opposite the cart (the plan's X):
      // the mop or the bucket, seeded. Terminus for the same 1×1
      // corridor-span reason as the cart.
      role: "mop",
      group: "mop",
      required: false,
      chance: 0.6,
      terminus: true,
      at: { kind: "wall", wall: "w", dist: [0.6, 0.68], along: 0.33, alongTol: 0.03 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["mop", "bucket"],
      clearance: 0.3,
    },
  ],
};

/**
 * 工作间 (specs §13, room-plans/workshop.txt — USER SCALE PASS 12×6):
 * the wide shallow shed. The workbench corner owns the far 12m wall
 * (bench + lamp and tool tray ON the slab + the pulled-up chair, the
 * workbench-corner kit's vocabulary); the materials rack flanks it on
 * the west, the second materials group (sideboard or rack, seeded) and
 * the mop on the east; the writing desk keeps the paperwork end low on
 * the west; the CHAIR STACK (§13's one proper room for it) waits along
 * the east wall behind the credenza — the 3.5m doorway strip forbids
 * the plan's south-east corner inside a 6m depth. Deliberately
 * asymmetric (§2 rule 6 — a studio must not compose axially): bench
 * west-of-axis, credenza east, rack far west, desk low west.
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
      at: { kind: "wall", wall: "w", dist: [0.72, 0.85], along: 0.86, alongTol: 0.06 },
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
      at: { kind: "wall", wall: "w", dist: [0.7, 0.9], along: 0.34, alongTol: 0.04 },
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
      // 拖把 — the mop on the west wall between the desk and the
      // materials rack (the east wall is fully booked: credenza low,
      // stack high). The 12m width keeps it well clear of the corridor;
      // isolated — a lone corner piece, it guards nothing but the door
      // strip and the apron.
      role: "mop",
      group: "mop",
      required: false,
      chance: 0.6,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.66, alongTol: 0.05 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["mop"],
      clearance: 0.3,
    },
    {
      // 叠椅 — the half-finished chair stack along the east wall behind
      // the credenza (j@col 08, row 08 — §13's one proper room for the
      // stack, so this blueprint drops it from the ban list). The south
      // end is doorway-strip inside a 6m depth; the stack stands just
      // past it, optional.
      role: "sparestack",
      group: "spares",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "e", dist: [0.72, 0.85], along: 0.68, alongTol: 0.04 },
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
