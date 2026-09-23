/**
 * The public family — Lane C's blueprints (v0.12b P2b).
 *
 * Lane C owns THIS FILE and nothing else: gallery-module, dining-hall,
 * sunroom and pool-deck join here, each a `RoomSchematic` against the
 * shared vocabulary in ./types, laid out per doc/design/room-plans/
 * <moduleId>.txt (the authored A/B plans) and the shared constraints in
 * doc/design/room-specs.md (逐间槽位 + 禁止栏) and v0.12-room-realism.md §2
 * (the six "reads as a real room" rules — enforced as measurements in
 * tests/lib/game/schematics-public.test.ts).
 *
 * Composition notes (the lane's report carries the full rationale):
 *
 *  - The data model has no variant field, so the plans' A/B personalities
 *    blend through SEEDED OPTIONAL GROUPS (the same mechanism the living
 *    pilot uses): each optional group's anchor slot carries the chance,
 *    its dependent pieces ride along (a missing anchor's dependents skip
 *    via the failed relative anchor). Outer paintings / second sculpture /
 *    second umbrella / outer plants are the seeded accents; the required
 *    core is identical in both plans.
 *
 *  - `isolated` is used generously (every group Lane C authors is one
 *    authored composition, never islands): the generic breathing-disc
 *    model cannot express authored adjacency (a chair 1.0m from its table
 *    fails a disc-gap check against the table's own disc). Isolated
 *    groups still validate walkable footprint, door strips and strand
 *    approaches, water, keep-empty zones, and they still count their
 *    footprint discs against the coverage budget.
 *
 *  - The audit's per-room `bans` lists (types.ts) replace the old
 *    one-size default: gallery and pool-deck declare their own 禁止栏
 *    (the bench is the gallery's furniture; the lounger/poolbench/
 *    towelrail are the deck's), while dining-hall and sunroom let the
 *    shared DEFAULT_BANNED_KINDS bind them — §6.4's room-scoped
 *    legality, as data.
 */
import type { RoomSchematic } from "./types";

/**
 * The gallery (specs §8, room-plans/gallery-module.txt): the long north
 * LOOKING wall — 3–5 wallart frames hung flush (the art-wall vocabulary,
 * each frame its own small group so the row's coverage stays honest), a
 * pair of floor washers 2m off the wall, one pedestal + standingstone
 * sculpture on the room axis (a seeded second plinth doubles it, variant
 * B's island), two face-the-wall benches, and the reading corner that
 * keeps the wall company (optional, never the hero — §8's ban). No free
 * columns (INDEX 裁断 #6): the pilaster-rhythm feature stays a wall
 * treatment. 16×10, axially composed, focal north.
 */
const GALLERY_SCHEMATIC: RoomSchematic = {
  moduleId: "gallery-module",
  focalWall: "n",
  symmetry: "axial",
  // The room's own 禁止栏 (replaces the shared default): the bench IS
  // the gallery's furniture (§6.4 names the gallery as its legal home) —
  // the pool/housekeeping vocabulary stays banned.
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
    // 挂画 — the art wall. Middle three frames are the required core
    // (both variants hang three); the outer pair is the variant-A
    // symmetry (chance 0.55). Each frame is its own group: the row is
    // ~11m end to end, and one group would stage a single ~6m breathing
    // disc that no honest coverage budget survives. dist hugs the wall
    // band (planContains needs ≥ wallInset off the frame edge; the
    // art-wall kit stages its frames the same hover).
    {
      role: "art-1",
      group: "art-1",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.85], along: 0.344, alongTol: 0.015 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["wallart"],
      clearance: 0.2,
    },
    {
      role: "art-2",
      group: "art-2",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.85], along: 0.531, alongTol: 0.015 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["wallart"],
      clearance: 0.2,
    },
    {
      role: "art-3",
      group: "art-3",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.85], along: 0.719, alongTol: 0.015 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["wallart"],
      clearance: 0.2,
    },
    {
      // The outer pair — variant A's five-frame symmetry.
      role: "art-4",
      group: "art-4",
      required: false,
      chance: 0.55,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.85], along: 0.156, alongTol: 0.015 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["wallart"],
      clearance: 0.2,
    },
    {
      role: "art-5",
      group: "art-5",
      required: false,
      chance: 0.55,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.85], along: 0.906, alongTol: 0.015 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["wallart"],
      clearance: 0.2,
    },
    {
      // 洗墙落地灯 — the pair of washers 2m off the art wall (the no-
      // ceiling substitute for picture lights, plans' L×2). North-wall
      // companions, so a north strand door in a composition may crowd
      // them — they are the room's vocabulary and the report notes the
      // pre-existing tension (the art-wall kit stages the same wall).
      role: "wash-w",
      group: "wash-w",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [1.9, 2.3], along: 0.094, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      role: "wash-e",
      group: "wash-e",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [1.9, 2.3], along: 0.906, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 雕塑 — pedestal + standingstone on the axis midway between the
      // washers (variant A's single island); the seeded second plinth
      // (variant B) offsets ±2m from the first. The stone rides ON the
      // pedestal cap (lift 0.98 — the cap top, never floating).
      role: "sculpture-1",
      group: "sculpture",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "center",
        slots: ["wash-w", "wash-e"],
        dx: [-0.3, 0.3],
        dz: [-1.55, -1.25],
      },
      facing: { kind: "moduleCenter" },
      accepts: ["pedestal"],
      clearance: 0.5,
    },
    {
      role: "sculpture-1-stone",
      group: "sculpture",
      required: false,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "sculpture-1", dx: [-0.02, 0.02], dz: [-0.02, 0.02] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["standingstone"],
      lift: 0.98,
      clearance: 0.3,
      scale: [0.7, 0.85],
    },
    {
      role: "sculpture-2",
      group: "sculpture",
      required: false,
      chance: 0.5,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sculpture-1",
        dx: [1.9, 2.4],
        dz: [-0.12, 0.12],
        side: "seeded",
      },
      facing: { kind: "moduleCenter" },
      accepts: ["pedestal"],
      clearance: 0.5,
    },
    {
      role: "sculpture-2-stone",
      group: "sculpture",
      required: false,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "sculpture-2", dx: [-0.02, 0.02], dz: [-0.02, 0.02] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["standingstone"],
      lift: 0.98,
      clearance: 0.3,
      scale: [0.7, 0.85],
    },
    {
      // 面墙长凳 — the gallery benches, pair flanking the walk axis
      // (variant A), facing the art ~6.8m away (18×12 — the viewing
      // band sits mid-south, discs clearing the z 3.6 corridor). The
      // door strip (z < 3.5) stays south of them.
      role: "bench-w",
      group: "bench-w",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "s", dist: [4.25, 4.5], along: 0.375, alongTol: 0.015 },
      facing: { kind: "focal" },
      accepts: ["bench"],
      clearance: 0.6,
    },
    {
      role: "bench-e",
      group: "bench-e",
      required: true,
      terminus: true,
      at: { kind: "wall", wall: "s", dist: [4.25, 4.5], along: 0.625, alongTol: 0.015 },
      facing: { kind: "focal" },
      accepts: ["bench"],
      clearance: 0.6,
    },
    {
      // 阅读角（陪伴）— the reading corner that keeps the wall company
      // (module data's own wording): armchair + side table + floor lamp
      // + a loose book pile on ONE rug, against a seeded flank wall —
      // optional, and never the hero (§8's ban is about the hero
      // position, which the schematic path suppresses anyway).
      role: "nook-chair",
      group: "nook",
      required: false,
      chance: 0.5,
      isolated: true,
      at: { kind: "flankWall", dist: [0.8, 1.0], along: 0.32, alongTol: 0.5 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["readingchair"],
      clearance: 0.55,
    },
    {
      role: "nook-table",
      group: "nook",
      required: false,
      isolated: true,
      at: {
        kind: "relative",
        slot: "nook-chair",
        dx: [0.8, 0.95],
        dz: [0.0, 0.15],
        side: "seeded",
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["nightstand"],
      clearance: 0.35,
    },
    {
      role: "nook-lamp",
      group: "nook",
      required: false,
      isolated: true,
      at: {
        kind: "relative",
        slot: "nook-chair",
        dx: [0.75, 0.9],
        dz: [-0.1, 0.1],
        side: { opposite: "nook-table" },
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      role: "nook-book",
      group: "nook",
      required: false,
      isolated: true,
      at: { kind: "relative", slot: "nook-chair", dx: [-0.2, 0.2], dz: [0.45, 0.65] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["bookpile"],
      clearance: 0.2,
    },
    {
      role: "nook-rug",
      group: "nook",
      required: false,
      isolated: true,
      flat: true,
      at: {
        kind: "center",
        slots: ["nook-chair", "nook-table", "nook-lamp"],
        dx: [-0.1, 0.1],
        dz: [0.05, 0.2],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      scale: [0.9, 1.05],
      clearance: 0,
    },
    {
      // 角植 — the pair by the entrance corners (plans' P×2, optional).
      // Isolated like the other lone pieces, and far enough north that
      // the disc clears the composition's entrance apron (z < 1.2 at
      // 1:1, scaled at colossal).
      role: "plant-w",
      group: "plant-w",
      required: false,
      chance: 0.6,
      isolated: true,
      at: { kind: "wall", wall: "s", dist: [1.8, 2.2], along: 0.094, alongTol: 0.015 },
      facing: { kind: "moduleCenter" },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
    {
      role: "plant-e",
      group: "plant-e",
      required: false,
      chance: 0.6,
      isolated: true,
      at: { kind: "wall", wall: "s", dist: [1.8, 2.2], along: 0.906, alongTol: 0.015 },
      facing: { kind: "moduleCenter" },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
  ],
};

/**
 * The dining hall (specs §11, room-plans/dining-hall.txt): ONE banquet
 * table down the room's axis — four diningtable segments pushed into an
 * ~8m run (the plan's O allows 2 cells deep; a segment is 2.2×0.95, the
 * cloth edges merge like variant B's 双拼), eight chairs in two facing
 * rows (0.98–1.08m off the table's axis — pulled up, not stacked spares;
 * the chair-stack kit leaves the whitelist story to the generic path),
 * two sideboards against the dais wall dressed with the serving trio,
 * and a pair of standing lamps flanking the table ends (the no-ceiling
 * substitute for the chandelier). 14×10, axially composed, focal north.
 */
const DINING_SCHEMATIC: RoomSchematic = {
  moduleId: "dining-hall",
  focalWall: "n",
  symmetry: "axial",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    // 长桌 — four segments, each its own isolated group (they are one
    // authored run: the generic disc gap would tear apart what the plan
    // draws as a single 8m top). The laid settings ride the second
    // segment (the plan's SURFACES: tray + candles on the cloth).
    {
      role: "table-1",
      group: "table-1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.4, 4.7], along: 0.285, alongTol: 0.008 },
      facing: { kind: "fixed", rotY: 0, jitter: 0.03 },
      accepts: ["diningtable"],
      clearance: 0.55,
      scale: [0.95, 1.05],
    },
    {
      role: "table-2",
      group: "table-2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.4, 4.7], along: 0.428, alongTol: 0.008 },
      facing: { kind: "fixed", rotY: 0, jitter: 0.03 },
      accepts: ["diningtable"],
      clearance: 0.55,
      scale: [0.95, 1.05],
    },
    {
      role: "table-2-setting",
      group: "table-2",
      required: false,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-2", dx: [-0.5, 0.5], dz: [-0.18, 0.18] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["tray", "candle"],
      count: [1, 2],
      lift: 0.78,
      clearance: 0.15,
    },
    {
      role: "table-3",
      group: "table-3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.4, 4.7], along: 0.571, alongTol: 0.008 },
      facing: { kind: "fixed", rotY: 0, jitter: 0.03 },
      accepts: ["diningtable"],
      clearance: 0.55,
      scale: [0.95, 1.05],
    },
    {
      role: "table-4",
      group: "table-4",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.4, 4.7], along: 0.714, alongTol: 0.008 },
      facing: { kind: "fixed", rotY: 0, jitter: 0.03 },
      accepts: ["diningtable"],
      clearance: 0.55,
      scale: [0.95, 1.05],
    },
    // 餐椅 — eight, one per segment per side, squared at the table.
    {
      role: "chair-n1",
      group: "chair-n1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-1", dx: [-0.12, 0.12], dz: [0.98, 1.08] },
      facing: { kind: "toward", slot: "table-1" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-n2",
      group: "chair-n2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-2", dx: [-0.12, 0.12], dz: [0.98, 1.08] },
      facing: { kind: "toward", slot: "table-2" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-n3",
      group: "chair-n3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-3", dx: [-0.12, 0.12], dz: [0.98, 1.08] },
      facing: { kind: "toward", slot: "table-3" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-n4",
      group: "chair-n4",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-4", dx: [-0.12, 0.12], dz: [0.98, 1.08] },
      facing: { kind: "toward", slot: "table-4" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-s1",
      group: "chair-s1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-1", dx: [-0.12, 0.12], dz: [-1.08, -0.98] },
      facing: { kind: "toward", slot: "table-1" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-s2",
      group: "chair-s2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-2", dx: [-0.12, 0.12], dz: [-1.08, -0.98] },
      facing: { kind: "toward", slot: "table-2" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-s3",
      group: "chair-s3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-3", dx: [-0.12, 0.12], dz: [-1.08, -0.98] },
      facing: { kind: "toward", slot: "table-3" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    {
      role: "chair-s4",
      group: "chair-s4",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-4", dx: [-0.12, 0.12], dz: [-1.08, -0.98] },
      facing: { kind: "toward", slot: "table-4" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.95, 1.0],
    },
    // 落地灯 — the flanking pair at the table ends (plans' L×2, 1m off
    // the end segments — the standing substitute for the banned
    // chandelier).
    {
      role: "lamp-w",
      group: "lamp-w",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-1", dx: [-1.2, -0.95], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      role: "lamp-e",
      group: "lamp-e",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-4", dx: [0.95, 1.2], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    // 餐边柜 — against the dais wall (north), flanking the raised
    // platform, dressed with the serving pieces (the plans' SURFACES).
    {
      role: "sideboard-w",
      group: "sideboard-w",
      required: true,
      at: { kind: "wall", wall: "focal", dist: [0.78, 0.9], along: 0.13, alongTol: 0.02 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["sideboard"],
      clearance: 0.8,
    },
    {
      role: "sideboard-w-top",
      group: "sideboard-w",
      required: false,
      at: { kind: "relative", slot: "sideboard-w", dx: [-0.35, 0.35], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["tray", "vase", "frame"],
      count: [1, 2],
      lift: 0.9,
      clearance: 0.15,
    },
    {
      role: "sideboard-e",
      group: "sideboard-e",
      required: true,
      at: { kind: "wall", wall: "focal", dist: [0.78, 0.9], along: 0.87, alongTol: 0.02 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["sideboard"],
      clearance: 0.8,
    },
    {
      role: "sideboard-e-top",
      group: "sideboard-e",
      required: false,
      at: { kind: "relative", slot: "sideboard-e", dx: [-0.35, 0.35], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["tray", "vase", "frame"],
      count: [1, 2],
      lift: 0.9,
      clearance: 0.15,
    },
    {
      // 桌毯 — under the run's middle (plans' R, optional), flat. The
      // walk path leads TO the table — the rug lies under it, so the
      // group rides the terminus exemption like the table itself.
      role: "rug",
      group: "rug",
      required: false,
      chance: 0.7,
      terminus: true,
      isolated: true,
      flat: true,
      at: {
        kind: "center",
        slots: ["table-1", "table-2", "table-3", "table-4"],
        dx: [-0.15, 0.15],
        dz: [-0.1, 0.1],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      scale: [1.35, 1.5],
      clearance: 0,
    },
  ],
};

/**
 * The sunroom (specs §9, room-plans/sunroom.txt): the north glass wall
 * is the focal wall — two reading chairs square on it (坐在玻璃前), the
 * plant band between the seats and the glass (the inner pair required,
 * the outer pair the variant-A spread), a tea table held between the
 * chairs on one rug, a floor lamp at a chair's reach, and the quiet
 * extras (west-wall sideboard dressed with a vase, the SE-corner
 * fountain) as seeded accents. 12×6 (v0.13 2×1, wide-and-shallow):
 * the seats' discs must clear the centre keep-empty band (z ≤ 3.3 of
 * the 6m depth), which puts the chairs 1.8–2.05m off the glass and the
 * plant band 0.8–1.2m off it — the signature holds, shallower. Axial.
 */
const SUNROOM_SCHEMATIC: RoomSchematic = {
  moduleId: "sunroom",
  focalWall: "n",
  symmetry: "axial",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    // 茶几 + 台面 — the group's anchor. The pair flanks it, the rug
    // centres on it. Each seat is its OWN group: one breathing disc per
    // piece (0.55m) — a combined seating group would stage a ~2.7m disc
    // that grazes the centre keep-empty band the chairs already clear.
    {
      role: "tea-table",
      group: "tea-table",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [1.85, 2.0], along: 0.5, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: 0.04 },
      accepts: ["coffeetable"],
      clearance: 0.55,
      scale: [0.95, 1.0],
    },
    {
      // 台面小物 — the candle/vase on the tea table (lift rides the
      // table top, the plans' SURFACES).
      role: "tea-top",
      group: "tea-table",
      required: false,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "tea-table", dx: [-0.2, 0.2], dz: [-0.12, 0.12] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["candle", "vase"],
      count: [1, 1],
      lift: 0.4,
      clearance: 0.15,
    },
    {
      // 双椅 — facing the glass, flanking the table ±1.3–1.5m (seeded
      // sides keep the pair mirrored). 12×6: the chairs ride z 3.95–4.2
      // (discs clearing the z 3.3 corridor), 1.8–2.05m off the glass.
      role: "chair-1",
      group: "chair-1",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "tea-table",
        dx: [1.3, 1.5],
        dz: [-0.05, 0.05],
        side: "seeded",
      },
      facing: { kind: "focal" },
      accepts: ["readingchair"],
      clearance: 0.55,
    },
    {
      role: "chair-2",
      group: "chair-2",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "tea-table",
        dx: [1.3, 1.5],
        dz: [-0.05, 0.05],
        side: { opposite: "chair-1" },
      },
      facing: { kind: "focal" },
      accepts: ["readingchair"],
      clearance: 0.55,
    },
    {
      // 落地灯 — a seat's reach from chair-2 (≤1.2m, realism §2-2).
      role: "lamp",
      group: "lamp",
      required: false,
      chance: 0.6,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "chair-2",
        dx: [0.85, 1.0],
        dz: [-0.1, 0.1],
        side: "seeded",
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 组毯 — under the three (plans' R, optional), flat. The path
      // arrives at the glass-side seats — the rug rides the terminus
      // exemption with them.
      role: "rug",
      group: "rug",
      required: false,
      chance: 0.7,
      terminus: true,
      isolated: true,
      flat: true,
      at: {
        kind: "center",
        slots: ["tea-table", "chair-1", "chair-2"],
        dx: [-0.1, 0.1],
        dz: [-0.05, 0.1],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      scale: [1.15, 1.3],
      clearance: 0,
    },
    // 植物带 — along the glass, between the seats and the view. Each
    // plant its own isolated group (a band-wide group would stage a
    // disc that grazes the centre keep-empty band the chairs already
    // clear; lone groups keep every disc at 0.4m). Terminus: the walk
    // path bends to the far-third hero INSIDE the band — the planting
    // is the path's destination, not an obstruction.
    {
      role: "plant-1",
      group: "plant-1",
      required: true,
      isolated: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.8, 1.2], along: 0.375, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
    {
      role: "plant-2",
      group: "plant-2",
      required: true,
      isolated: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.8, 1.2], along: 0.625, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
    {
      role: "plant-3",
      group: "plant-3",
      required: false,
      chance: 0.6,
      isolated: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.8, 1.2], along: 0.125, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
    {
      role: "plant-4",
      group: "plant-4",
      required: false,
      chance: 0.6,
      isolated: true,
      terminus: true,
      at: { kind: "wall", wall: "focal", dist: [0.8, 1.2], along: 0.875, alongTol: 0.015 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
    {
      // 边柜 — the solid west wall (plans' B), dressed with a vase (the
      // plans' SURFACES). Wall-anchored (the party wall reads the same
      // in compositions) and north of the entrance apron's reach.
      role: "sideboard",
      group: "sideboard",
      required: false,
      chance: 0.55,
      at: { kind: "wall", wall: "w", dist: [0.75, 0.95], along: 0.55, alongTol: 0.8 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["sideboard"],
      clearance: 0.85,
    },
    {
      role: "sideboard-top",
      group: "sideboard",
      required: false,
      at: { kind: "relative", slot: "sideboard", dx: [-0.25, 0.25], dz: [-0.06, 0.06] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["vase", "frame"],
      count: [1, 1],
      lift: 0.9,
      clearance: 0.15,
    },
    {
      // 喷泉 — the south-east corner (plans' f, optional), clear of the
      // entrance apron (z < 1.2 — the basin disc must stay north of it)
      // and of the west-flank sideboard.
      role: "fountain",
      group: "fountain",
      required: false,
      chance: 0.35,
      isolated: true,
      at: { kind: "wall", wall: "s", dist: [2.5, 3.0], along: 0.85, alongTol: 0.015 },
      facing: { kind: "moduleCenter" },
      accepts: ["fountain"],
      clearance: 1.0,
    },
  ],
};

/**
 * The pool deck (specs §10, room-plans/pool-deck.txt): the water is the
 * focus — the pool-hall basin sits centre-north (waterRectFor: 45%
 * coverage pushed to its north-most legal centre), so the deck furnishes
 * the DRY EDGES: two lounger pairs on the west/east flanks squared at
 * the water (facing moduleCenter — the basin), umbrellas between each
 * pair, a bench and the towel rail along the west rim, the ring post a
 * step from the water's west edge, and the working edge (ladder west,
 * board east-of-centre) on the north waterline strip facing the pool.
 * The east-flank slots keep west of the water-rill runnel (span x
 * 0.86–0.94 — geometry the WaterRill component builds) and every slot's
 * authored position stays out of the basin rectangle itself, so the
 * schematic validates with or without the water input. 16×10, focal
 * north, no axial symmetry (散点度假式).
 */
const POOL_DECK_SCHEMATIC: RoomSchematic = {
  moduleId: "pool-deck",
  focalWall: "n",
  symmetry: "none",
  // The room's own 禁止栏 (replaces the shared default): the lounger,
  // poolbench and towel rail ARE the deck's vocabulary (specs §10's
  // 必备 list) — the park bench and the changing-room/housekeeping
  // kinds stay banned.
  bans: ["bench", "towelstack", "bucket", "luggagecart", "lockerrow", "chairstack"],
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    // 躺椅 — the two flank pairs, staggered ~1.8m along each rim and
    // squared at the basin. West pair (18×12 — z authored on the 12m
    // depth: rim order plant 2.4, rail 4.0, pair 5.6/7.4, bench 8.7):
    {
      role: "lounger-w1",
      group: "lounger-w1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.8, 1.0], along: 0.467, alongTol: 0.1 },
      facing: { kind: "moduleCenter" },
      accepts: ["lounger"],
      clearance: 0.55,
    },
    {
      role: "lounger-w2",
      group: "lounger-w2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.8, 1.0], along: 0.617, alongTol: 0.12 },
      facing: { kind: "moduleCenter" },
      accepts: ["lounger"],
      clearance: 0.55,
    },
    // East pair — x 5.7–6.0 keeps the bodies off the water margin
    // (basin east edge 4.02 + piece clear) and off the rill runnel
    // (which starts at x 6.48 on the 18m width).
    {
      role: "lounger-e1",
      group: "lounger-e1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [3.0, 3.3], along: 0.467, alongTol: 0.1 },
      facing: { kind: "moduleCenter" },
      accepts: ["lounger"],
      clearance: 0.55,
    },
    {
      role: "lounger-e2",
      group: "lounger-e2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [3.0, 3.3], along: 0.617, alongTol: 0.12 },
      facing: { kind: "moduleCenter" },
      accepts: ["lounger"],
      clearance: 0.55,
    },
    // 遮阳伞 — between each pair (the plans' Y), z ≈ 6.5.
    {
      role: "umbrella-1",
      group: "umbrella-1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [1.7, 2.0], along: 0.542, alongTol: 0.15 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["umbrella"],
      clearance: 0.6,
    },
    {
      role: "umbrella-2",
      group: "umbrella-2",
      required: false,
      chance: 0.5,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [3.0, 3.3], along: 0.542, alongTol: 0.15 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["umbrella"],
      clearance: 0.6,
    },
    // 水缘长凳 — the west rim (required) with seeded companions east
    // and further west (the plans' G).
    {
      role: "bench-w",
      group: "bench-w",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.8, 1.0], along: 0.725, alongTol: 0.15 },
      facing: { kind: "moduleCenter" },
      accepts: ["poolbench"],
      clearance: 0.6,
    },
    {
      role: "bench-w2",
      group: "bench-w2",
      required: false,
      chance: 0.4,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.8, 1.0], along: 0.85, alongTol: 0.15 },
      facing: { kind: "moduleCenter" },
      accepts: ["poolbench"],
      clearance: 0.6,
    },
    {
      role: "bench-e",
      group: "bench-e",
      required: false,
      chance: 0.5,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [3.0, 3.3], along: 0.725, alongTol: 0.15 },
      facing: { kind: "moduleCenter" },
      accepts: ["poolbench"],
      clearance: 0.6,
    },
    // 救生圈柱 — a step off the water's west edge (the plans' I):
    // basin west edge −4.02, ring post x −4.8…−5.2.
    {
      role: "ring-post",
      group: "ring-post",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [3.8, 4.2], along: 0.433, alongTol: 0.2 },
      facing: { kind: "moduleCenter" },
      accepts: ["ringpost"],
      clearance: 0.4,
    },
    // 毛巾架 — on the west wall by the loungers (the plans' X).
    {
      role: "towel-rail",
      group: "towel-rail",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.9], along: 0.333, alongTol: 0.1 },
      facing: { kind: "moduleCenter" },
      accepts: ["towelrail"],
      clearance: 0.35,
    },
    // 水缘工位 — ladder (west) and board (east, short of the rill) on
    // the north waterline strip, squared at the pool.
    {
      role: "ladder",
      group: "ladder",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [1.1, 1.4], along: 0.17, alongTol: 0.3 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["poolladder"],
      clearance: 0.5,
    },
    {
      role: "board",
      group: "board",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [1.1, 1.4], along: 0.66, alongTol: 0.4 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["board"],
      clearance: 0.5,
    },
    {
      // 角植 — the south-west corner (the plans' P, optional). z sits
      // north of the composition's entrance apron (z < 1.2) with the
      // disc clearing it.
      role: "plant",
      group: "plant",
      required: false,
      chance: 0.5,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.8, 1.0], along: 0.2, alongTol: 0.2 },
      facing: { kind: "moduleCenter" },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.9, 1.05],
    },
  ],
};

/** Lane C's blueprints — the public family (historical module order). */
export const PUBLIC_SCHEMATICS: readonly RoomSchematic[] = [
  GALLERY_SCHEMATIC,
  DINING_SCHEMATIC,
  SUNROOM_SCHEMATIC,
  POOL_DECK_SCHEMATIC,
];
