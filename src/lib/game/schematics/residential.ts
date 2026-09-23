/**
 * The residential family — Lane A's blueprints (v0.12b P2b).
 *
 * Lane A owns THIS FILE and nothing else: bedroom, study and reading-room
 * join the living pilot here, each a `RoomSchematic` against the shared
 * vocabulary in ./types. The family array keeps its historical relative
 * order; the global catalogue order (residential → service → public) is
 * fixed by ./index.ts, so appending here never disturbs another lane.
 */
import type { RoomSchematic } from "./types";

/**
 * The living room (v0.12-room-specs §1, the P1 pilot): a conversation
 * group on one axis with its media wall. Every slot's numbers are the
 * spec's: the sofa 2.4–3.6m off the focal wall facing it; the coffee
 * table 0.35–0.5m in front of the sofa (sofa half-depth 0.425 + table
 * half-depth 0.275 ⇒ dz 1.05–1.2) carrying 1–2 tabletop pieces; the rug
 * under sofa + table + chair; the reading chair at the table's corner in
 * an L (45° side-on, facing the table); the floor lamp within a seat's
 * reach (≤1.2m of the sofa center, opposite the chair for balance); the
 * media unit against the focal wall with the TV on it, on the sofa's
 * axis. The sideboard / shelf run / planted corner / console are optional
 * (§1 可选) and each degrades alone.
 *
 * 禁止栏 (§1): no bench / poolbench / lounger / towel stack / towel rail /
 * bucket / luggage cart / locker row / chair stack anywhere in the
 * accepts — the whitelist holds no kit that stages them either (v0.12
 * declarations audit), and the schematic's vocabulary is its accepts
 * lists, so the ban holds by construction.
 */
const LIVING_SCHEMATIC: RoomSchematic = {
  moduleId: "living",
  focalWall: "n",
  symmetry: "axial",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 沙发 — the seat, facing the media wall 2.4–3.6m off it.
      role: "sofa",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [2.4, 3.6], along: 0.5, alongTol: 0.6 },
      facing: { kind: "focal" },
      accepts: ["sofa"],
      clearance: 1.15,
    },
    {
      // 茶几 — 0.35–0.5m in front of the sofa, on its axis.
      role: "coffeetable",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "sofa", dx: [-0.1, 0.1], dz: [1.05, 1.2] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.04 },
      accepts: ["coffeetable"],
      clearance: 0.6,
      scale: [0.95, 1.05],
    },
    {
      // 台面摆件 — the "someone lives here" signal (§0 rule 2), 1–2
      // pieces on the coffee table's top (lift rides the table's scale).
      role: "tabletop",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "coffeetable",
        dx: [-0.28, -0.08],
        dz: [-0.16, 0.16],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["vase", "frame", "candle", "bookpile", "tray"],
      count: [1, 2],
      lift: 0.4,
      clearance: 0.15,
    },
    {
      // 单椅 — the L: beside the sofa's front corner, square at the
      // table (45° side-on by position). Seeded side.
      role: "armchair",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sofa",
        dx: [1.35, 1.7],
        dz: [0.8, 1.15],
        side: "seeded",
      },
      facing: { kind: "toward", slot: "coffeetable" },
      accepts: ["readingchair"],
      clearance: 0.55,
    },
    {
      // 地毯 — under the three seats (flat: walked over, no disc).
      role: "rug",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: {
        kind: "center",
        slots: ["sofa", "coffeetable", "armchair"],
        dx: [-0.12, 0.12],
        dz: [-0.05, 0.2],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      scale: [1.35, 1.55],
      clearance: 0,
    },
    {
      // 落地灯 — a seat's reach (≤1.2m of the sofa center), opposite
      // the chair so the pair balances.
      role: "floorlamp",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sofa",
        dx: [0.95, 1.1],
        dz: [-0.3, 0.05],
        side: { opposite: "armchair" },
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 电视柜 — against the focal wall, on the sofa's axis.
      role: "mediaunit",
      group: "media",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "wallAligned",
        wall: "focal",
        withAnchor: "seating",
        dist: [0.7, 0.95],
        alongTol: 0.3,
      },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["mediaunit"],
      clearance: 0.85,
      scale: [0.95, 1.1],
    },
    {
      // 电视 — ON the media unit, facing the sofa.
      role: "tv",
      group: "media",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "mediaunit", dx: [-0.04, 0.04], dz: [-0.02, 0.08] },
      facing: { kind: "toward", slot: "sofa" },
      accepts: ["tv"],
      lift: 0.5,
      clearance: 0.35,
    },
    {
      // 餐边柜 — a non-focal wall, optional.
      role: "sideboard",
      group: "sideboard",
      required: false,
      chance: 0.65,
      at: { kind: "flankWall", dist: [0.7, 0.9], along: 0.5, alongTol: 2 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["sideboard"],
      clearance: 0.95,
    },
    {
      // 书架 — a flank wall, 1–3 shelves in a run, optional.
      role: "bookshelf",
      group: "shelf",
      required: false,
      chance: 0.5,
      at: { kind: "flankWall", dist: [0.65, 0.85], along: 0.5, alongTol: 2.2 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["bookshelf"],
      count: [1, 3],
      clearance: 0.95,
    },
    {
      // 角植 — pedestal + plant at a focal-edge corner, optional.
      role: "pedestal",
      group: "plant",
      required: false,
      chance: 0.6,
      at: { kind: "focalCorner", corner: "seeded", dist: [0.7, 1.0] },
      facing: { kind: "moduleCenter" },
      accepts: ["pedestal"],
      clearance: 0.4,
    },
    {
      role: "plant",
      group: "plant",
      required: false,
      at: {
        kind: "relative",
        slot: "pedestal",
        dx: [0.55, 0.75],
        dz: [-0.15, 0.2],
        side: "seeded",
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.85, 1.05],
    },
    {
      // 沙发背几 — behind the sofa, optional; stands only when it
      // clears the walk path (it usually doesn't in a 12×12 — an
      // honest degradation, never a blocked corridor).
      role: "console",
      group: "console",
      required: false,
      chance: 0.5,
      at: { kind: "relative", slot: "sofa", dx: [-0.25, 0.25], dz: [-1.05, -0.8] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.2 },
      accepts: ["nightstand"],
      clearance: 0.4,
    },
  ],
};

/** Lane A's blueprints — the residential family (today the living pilot). */
export const RESIDENTIAL_SCHEMATICS: readonly RoomSchematic[] = [LIVING_SCHEMATIC];
