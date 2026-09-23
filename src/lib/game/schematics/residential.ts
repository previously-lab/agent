/**
 * The residential family — Lane A's blueprints (v0.12b P2b).
 *
 * Lane A owns THIS FILE and nothing else: living (the P1 pilot, reworked
 * here after the user's screenshot review) plus bedroom, study and
 * reading-room, each a `RoomSchematic` against the shared vocabulary in
 * ./types. The family array keeps its historical relative order; the global
 * catalogue order (residential → service → public) is fixed by ./index.ts,
 * so appending here never disturbs another lane.
 *
 * LAYOUT TRUTH: doc/design/room-plans/<moduleId>.txt (FORMAT.md coordinates:
 * row 01 = far/focal wall, row d = entrance side, cols west→east; the
 * runtime consumes the same frame directly, no mirroring). Each room
 * realises its variant A as the canonical composition; the B variants'
 * topological deltas (a rotated bed, a window-side desk, twin tables) are
 * not expressible in the slot vocabulary and are logged in the lane notes.
 *
 * TWO HARD WALLS every group here is authored against (both enforced by
 * the shared pushKit machinery, so the numbers below carry the margins):
 *  - the module's keep-empty entrance spine (a centred void the group's
 *    FOOTPRINT DISC must not touch — this is what pinned the pilot's
 *    seating to the far wall, reading as "70% empty floor");
 *  - the walk path's cleared corridor (pathHalf + KIT_PATH_CLEAR ≈ 1.9m
 *    around door→bend→hero) — only the destination groups may stand in
 *    it, marked `terminus` exactly like the generic hero.
 *
 * RIGID GROUPS (the user's first call-out): within a group every relative
 * offset is authored at spec distance with a tight or zero tolerance —
 * the group may only translate (its wall anchor's draw) and mirror (a
 * seeded `side`), never let its pieces drift apart. Isolated groups skip
 * the mutual footprint-disc gap because their spacing IS the composition
 * (a chair 0.8m from its desk is not a violation); every optional group
 * stays non-schematic-guarding where it can (living sideboard/shelf,
 * bedroom wardrobe) so the clearance ring between groups is real.
 */
import type { RoomSchematic } from "./types";

/**
 * The living room (v0.12-room-specs §1; room-plans/living.txt variant A,
 * 贴北墙的影院式, reworked after the user's three screenshot call-outs):
 * ONE rigid conversation group on the room's axis — sofa 4.4–4.55m off the
 * focal wall (plan row 05, NOT hugging the far wall: the disc now clears
 * the keep-empty spine at z ≤ 5.52 by an authored 7cm instead of the
 * pilot's 2.4–3.6m, which parked the group against the media wall and
 * emptied the south half), the coffee table locked 1.08–1.12m in front
 * (the 0.35–0.5m reach, spec §0-3), the reading chair at the sofa's front
 * corner in an L on a seeded side, the floor lamp opposite the chair so
 * the pair balances, the round rug under all three seats with NO spin
 * draw (a cylinder rug rotating reads as a half-covered floor). The media
 * group answers the seating on the SAME focal-wall solution: wallAligned
 * keeps the unit's lateral to the sofa's exact drawn u, so sofa, unit and
 * TV share one axis by construction (call-out two). Sideboard / shelf run
 * / planted corner flank the room (variant B's book wall survives as the
 * west shelf run); each degrades alone.
 *
 * 禁止栏 (§1): no bench / pool furniture / housekeeping kind anywhere in
 * the accepts — the vocabulary is the accepts lists, so the ban holds by
 * construction (and the module whitelist lost coat-bench in the v0.12
 * declarations audit).
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
      // 沙发 — the seat, 4.4–4.55m off the focal wall (plan row 05), facing
      // it; the group's anchor: the whole composition translates with this
      // draw and mirrors with the chair's seeded side, nothing else.
      role: "sofa",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.4, 4.55], along: 0.5, alongTol: 0.5 },
      facing: { kind: "focal" },
      accepts: ["sofa"],
      clearance: 1.15,
    },
    {
      // 茶几 — locked 1.08–1.12m in front of the sofa (sofa half-depth
      // 0.425 + table half-depth 0.275 ⇒ the 0.38–0.42m reach), on the axis.
      role: "coffeetable",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "sofa", dx: [-0.05, 0.05], dz: [1.08, 1.12] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.02 },
      accepts: ["coffeetable"],
      clearance: 0.5,
      scale: [0.95, 1.05],
    },
    {
      // 台面摆件 — 1–2 pieces on the coffee table's top (§0 rule 2's
      // "someone lives here" signal; lift rides the table's scale).
      role: "tabletop",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "coffeetable",
        dx: [-0.25, -0.1],
        dz: [-0.12, 0.12],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["vase", "frame", "candle", "bookpile", "tray"],
      count: [1, 2],
      lift: 0.4,
      clearance: 0.15,
    },
    {
      // 单椅 — the L: locked to the sofa's front corner (1.2–1.28m aside,
      // 0.5–0.58m forward), square at the table; the seeded side is the
      // group's mirror draw.
      role: "armchair",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sofa",
        dx: [1.2, 1.28],
        dz: [0.5, 0.58],
        side: "seeded",
      },
      facing: { kind: "toward", slot: "coffeetable" },
      accepts: ["readingchair"],
      clearance: 0.45,
    },
    {
      // 落地灯 — opposite the chair (the pair balances), ≤1.2m of the sofa
      // centre, a seat's reach; never the lone lamp on an empty floor.
      role: "floorlamp",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sofa",
        dx: [0.95, 1.05],
        dz: [-0.15, 0.02],
        side: { opposite: "armchair" },
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 地毯 — the round rug under the three seats, centred on the group,
      // NO rotation draw (a spinning circle reads as a half-covered floor).
      role: "rug",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: {
        kind: "center",
        slots: ["sofa", "coffeetable", "armchair"],
        dx: [-0.1, 0.1],
        dz: [-0.05, 0.1],
      },
      facing: { kind: "fixed", rotY: 0, jitter: 0 },
      accepts: ["rug"],
      scale: [1.35, 1.5],
      clearance: 0,
    },
    {
      // 电视柜 — against the focal wall on the seating group's exact axis
      // (wallAligned follows the sofa's drawn lateral — one focal-wall
      // solution, two consumers).
      role: "mediaunit",
      group: "media",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "wallAligned",
        wall: "focal",
        withAnchor: "seating",
        dist: [0.7, 0.9],
        alongTol: 0.25,
      },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["mediaunit"],
      clearance: 0.8,
      scale: [0.95, 1.1],
    },
    {
      // 电视 — ON the media unit, facing the sofa across 3.1–3.5m.
      role: "tv",
      group: "media",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "mediaunit", dx: [-0.04, 0.04], dz: [-0.05, 0.05] },
      facing: { kind: "toward", slot: "sofa" },
      accepts: ["tv"],
      lift: 0.5,
      clearance: 0.35,
    },
    {
      // 餐边柜 — the east flank (plan A's B at rows 06–07), optional; its
      // disc guards the seating group's ring, so it never creeps into the
      // conversation field.
      role: "sideboard",
      group: "sideboard",
      required: false,
      chance: 0.65,
      at: { kind: "wall", wall: "e", dist: [0.65, 0.85], along: 0.5, alongTol: 2 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["sideboard"],
      clearance: 0.9,
    },
    {
      // 书架 — the west flank run (plan A's K, 2–3 shelves stepped along
      // the wall), optional; variant B's north book wall is not expressible
      // alongside the media wall (see lane notes).
      role: "bookshelf",
      group: "shelf",
      required: false,
      chance: 0.5,
      at: { kind: "wall", wall: "w", dist: [0.65, 0.85], along: 0.5, alongTol: 0.9 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["bookshelf"],
      count: [2, 2],
      clearance: 0.5,
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
      // 盆栽 — beside the pedestal TOWARD the room (the pedestal faces the
      // centre, so a pure forward offset never leaves the plan, at either
      // corner).
      role: "plant",
      group: "plant",
      required: false,
      at: {
        kind: "relative",
        slot: "pedestal",
        dx: [-0.05, 0.05],
        dz: [0.55, 0.75],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.85, 1.05],
    },
  ],
};

/**
 * The bedroom (v0.12-room-specs §2; room-plans/bedroom.txt variant A,
 * 标准双人床角): the bed corner against the far wall — headboard north
 * (the focal wall; the bed faces the entrance, never its back), two
 * nightstands locked to the headboard side at ±1.3m, a desklamp and a
 * frame ON each (the §0 rule 2 dressing), the bedside rug at the foot's
 * west side; the wardrobe stands against the east wall (spec §2: a
 * non-door, non-headboard wall — P2a's wardrobe-wall kit is its
 * vocabulary). The west window corner takes the reading chair + lamp;
 * the vanity (variant B's M) degrades alone. 禁止栏 (§2): no tv, no sofa,
 * no bench, no housekeeping kind — the accepts are the vocabulary.
 */
const BEDROOM_SCHEMATIC: RoomSchematic = {
  moduleId: "bedroom",
  focalWall: "n",
  symmetry: "axial",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 床 — headboard to the focal wall, 1.5–1.7m centre depth (plan
      // rows 02–03), slightly west of axis (plan cols 05–06); the group's
      // anchor and mirror-free translation draw.
      role: "bed",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [1.5, 1.7], along: 0.4167, alongTol: 0.15 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bed"],
      clearance: 1.5,
    },
    {
      // 床头柜×2 — locked to the headboard side (bed-local −z is north
      // when the bed faces the room), ±1.3m aside; the pair mirrors only
      // with the bed's own along draw. 床区对称 (§2 rule 6).
      role: "nightstand-w",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "bed", dx: [1.25, 1.35], dz: [-0.8, -0.73] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.06 },
      accepts: ["nightstand"],
      clearance: 0.4,
    },
    {
      role: "nightstand-e",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "bed", dx: [-1.35, -1.25], dz: [-0.8, -0.73] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.06 },
      accepts: ["nightstand"],
      clearance: 0.4,
    },
    {
      // 床头灯 — a desklamp read as the bedside lamp ON each nightstand
      // (lift 0.56 = the nightstand top, never floating).
      role: "lamp-w",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "nightstand-w", dx: [-0.02, 0.02], dz: [-0.02, 0.02] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["desklamp"],
      lift: 0.56,
      clearance: 0.15,
    },
    {
      role: "lamp-e",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "nightstand-e", dx: [-0.02, 0.02], dz: [-0.02, 0.02] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["desklamp"],
      lift: 0.56,
      clearance: 0.15,
    },
    {
      // 相框 — one frame on each nightstand (plan A's SURFACES), nudged to
      // the outer side so it clears the lamp.
      role: "frame-w",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "nightstand-w", dx: [0.14, 0.2], dz: [-0.02, 0.02] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["frame"],
      lift: 0.56,
      clearance: 0.12,
    },
    {
      role: "frame-e",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "nightstand-e", dx: [-0.2, -0.14], dz: [-0.02, 0.02] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["frame"],
      lift: 0.56,
      clearance: 0.12,
    },
    {
      // 地毯 — the bedside rug at the foot's west side (plan rows 04–05),
      // flat underfoot; its group rides the bed's terminus (a rug walked
      // over must not answer the path corridor).
      role: "rug",
      group: "bed",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: { kind: "relative", slot: "bed", dx: [0.4, 0.6], dz: [1.9, 2.1] },
      facing: { kind: "fixed", rotY: 0, jitter: 0 },
      accepts: ["rug"],
      scale: [1.2, 1.35],
      clearance: 0,
    },
    {
      // 衣柜 — the east wall (a non-door, non-headboard wall per §2), far
      // north (plan row 02); NOT isolated: its disc guards the bed group's
      // ring and everything else's — the clearance ring is real.
      role: "wardrobe",
      group: "wardrobe",
      required: true,
      at: { kind: "wall", wall: "e", dist: [0.65, 0.85], along: 0.84, alongTol: 0.35 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["wardrobe"],
      clearance: 1.0,
    },
    {
      // 阅读角 — the west window corner (plan row 04): chair angled at the
      // room, the floor lamp beside it within reach, both clear of the
      // entrance spine's disc by an authored 19cm.
      role: "chair",
      group: "corner-w",
      required: false,
      chance: 0.6,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.72, alongTol: 0.15 },
      facing: { kind: "moduleCenter" },
      accepts: ["readingchair"],
      clearance: 0.5,
    },
    {
      // 角灯 — anchored to the same wall a step south of the chair: a
      // relative offset would ride the chair's turned frame and can leave
      // the walkable footprint at the wall (the study corner's lesson).
      role: "lamp",
      group: "corner-w",
      required: false,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.63, alongTol: 0.15 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.3,
    },
    {
      // 梳妆台 — variant B's vanity, west wall mid-room (plan B rows
      // 04–05), its stool pulled up; degrades alone. Isolated like the
      // corner: the two optional groups' discs would otherwise overlap on
      // the flank and forfeit each other (they sit 0.8m+ apart in truth).
      role: "vanity",
      group: "vanity",
      required: false,
      chance: 0.45,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.52, alongTol: 0.55 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["vanity"],
      clearance: 0.7,
    },
    {
      role: "stool",
      group: "vanity",
      required: false,
      at: { kind: "relative", slot: "vanity", dx: [-0.1, 0.1], dz: [0.6, 0.75] },
      facing: { kind: "toward", slot: "vanity" },
      accepts: ["chair"],
      clearance: 0.4,
      scale: [0.9, 1],
    },
  ],
};

/**
 * The study (v0.12-room-specs §3; room-plans/study.txt variant A, 面壁式):
 * the writing desk faces the shelf wall — the §3 signature. The shelf run
 * hugs the north wall west-of-centre (the room forbids symmetry, §0-6;
 * the run's centre lands on the desk's axis, 1.3m+ of取书通道 behind the
 * desk), 3–4 shelves stepped along the wall. The desk 2.3–2.7m off the
 * wall, its chair pulled up square, the lamp and a book pile ON the
 * desktop (lift 0.8), the rug underfoot. The west window corner takes the
 * reading chair + lamp; the east wall takes the sideboard (plan row
 * 06–07). The shelf is `terminus` because the room's walk path ends at
 * the hero zone hard by the shelf face — without the flag the shared
 * machinery rejects the run for standing within its own destination's
 * corridor (the exact mechanism that kept the generic study shelfless in
 * the v0.12 inventory). 禁止栏 (§3): no bed / sofa / lounger / rows of
 * seats / housekeeping kind.
 */
const STUDY_SCHEMATIC: RoomSchematic = {
  moduleId: "study",
  focalWall: "n",
  symmetry: "none",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 书架 — the shelf wall: three shelves stepped 1.8m along the north
      // wall from a west-of-centre base (the room forbids symmetry). One
      // run again (the 2×2 room's coverage budget now absorbs its 4m
      // footprint disc, and a count-stepped run butts seamlessly — two
      // pair-groups could never butt, their pieces would interleave or
      // gape). The K furniture row IS the book wall until the wall:"shelf"
      // register renders (INDEX 修正 7).
      role: "bookshelf",
      group: "shelf",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.65, 0.8], along: 0.35, alongTol: 0.02 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bookshelf"],
      count: [3, 3],
      clearance: 0.35,
    },
    {
      // 书桌 — 2.5–2.8m off the shelf wall (plan row 03 of the 12-deep
      // room), west of axis (the asymmetric draw the room type demands),
      // facing the wall it works against.
      role: "desk",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [2.5, 2.8], along: 0.4, alongTol: 0.15 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["desk"],
      clearance: 1.0,
    },
    {
      // 座椅 — pulled up to the desk's front, square at it.
      role: "chair",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "desk", dx: [-0.12, 0.12], dz: [0.75, 0.9] },
      facing: { kind: "toward", slot: "desk" },
      accepts: ["chair"],
      clearance: 0.45,
    },
    {
      // 台灯 — ON the desktop at its west end (lift 0.8 = the desk top).
      role: "desklamp",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "desk", dx: [0.5, 0.65], dz: [-0.12, 0.12] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["desklamp"],
      lift: 0.8,
      clearance: 0.15,
    },
    {
      // 书堆 — the working pile ON the desktop's east end (plan A's second
      // A; §3 makes the bookpile required).
      role: "bookpile",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "desk", dx: [-0.65, -0.5], dz: [-0.1, 0.1] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["bookpile"],
      lift: 0.8,
      clearance: 0.15,
    },
    {
      // 地毯 — under the desk and chair, flat.
      role: "rug",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: { kind: "relative", slot: "desk", dx: [-0.05, 0.05], dz: [0.5, 0.7] },
      facing: { kind: "fixed", rotY: 0, jitter: 0 },
      accepts: ["rug"],
      scale: [1.05, 1.2],
      clearance: 0,
    },
    {
      // 阅读角 — the west window corner (plan row 07): the chair angled at
      // the room with the floor lamp a step south along the SAME wall — a
      // lamp offset from the chair's turned frame could land inside the
      // walk corridor around the path's bend, so both anchor to the wall.
      role: "chair-w",
      group: "corner",
      required: false,
      chance: 0.55,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.34, alongTol: 0.2 },
      facing: { kind: "moduleCenter" },
      accepts: ["readingchair"],
      clearance: 0.5,
    },
    {
      role: "lamp-w",
      group: "corner",
      required: false,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.26, alongTol: 0.2 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.3,
    },
    {
      // 边柜 — the east wall (plan rows 06–07); NOT isolated, so its disc
      // respects every other group's ring.
      role: "sideboard",
      group: "sideboard",
      required: false,
      chance: 0.5,
      at: { kind: "wall", wall: "e", dist: [0.65, 0.85], along: 0.35, alongTol: 0.95 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["sideboard"],
      clearance: 0.85,
    },
  ],
};

/**
 * The reading room (v0.12-room-specs §4; room-plans/reading-room.txt
 * variant A, 单长桌纵列): the whole north face is the book wall (5–6
 * shelves stepped along it — the inventory's "shelves on the east wall"
 * is corrected here), and the long reading table stands centred on the
 * room's axis 4.3–4.7m off it, built as three laid tables butted into one
 * 5.4m run. Six chairs face the table three-a-side (the §4 count, inside
 * the corrected ×4–8 band), a floor lamp past each end; the round rug
 * anchors the run, the two window corners take a reading chair + lamp
 * each, and the clock finds the north-east corner (optional). The plan's
 * optional gallery bench sits mid-west-wall — an open book left on its
 * seat (the calm-trace precedent the kit was authored around), facing the
 * table across the room. The table, its chairs and its lamps are the
 * path's destination — all `terminus`.
 *
 * 禁止栏: the plan accounts for every piece it draws, including the
 * `bench` the default list bans — the bench is the plan's own G, a seat
 * with its book, not park furniture. `bans` therefore replaces the
 * default list with DEFAULT_BANNED_KINDS minus `bench`; everything else
 * it banned still is, and the room's own plan-forbidden kinds (bed,
 * housekeeping, luggage — specs §4) are simply never drawn: the accepts
 * lists are the vocabulary.
 */
const READING_ROOM_SCHEMATIC: RoomSchematic = {
  moduleId: "reading-room",
  focalWall: "n",
  symmetry: "axial",
  // DEFAULT_BANNED_KINDS minus "bench" — the plan's G (below) carries the
  // bench's purpose chain; every other default ban stands.
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
      // 书墙 — four shelves in two butted pairs, west pair and east pair,
      // centred on the axis: one four-shelf group would answer the coverage
      // budget with a 5.8m footprint disc (the pair's anchor sits at the
      // run's west piece — the disc IS the span), so the run splits in two
      // and each pair's modest disc clears the entrance spine void.
      role: "bookshelf",
      group: "shelf-w",
      required: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.65, 0.85], along: 0.42, alongTol: 0.02 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bookshelf"],
      count: [2, 2],
      clearance: 0.4,
    },
    {
      role: "bookshelf",
      group: "shelf-e",
      required: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.65, 0.85], along: 0.58, alongTol: 0.02 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bookshelf"],
      count: [2, 2],
      clearance: 0.4,
    },
    {
      // 长阅览桌 — three laid tables butted into one run, centred on the
      // axis (plan row 07, pulled north of the entrance spine: the south
      // chair line stands z ≥ 6.3, the spine's disc ends at 5.28). The
      // 2×2 room takes 1.8m-centred tables (0.35/0.5/0.65 across the
      // wall), each piece beside its own pair of chairs.
      role: "table-w",
      group: "table-w",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.3, 4.7], along: 0.35, alongTol: 0.01 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["diningtable"],
      clearance: 0.8,
    },
    {
      role: "table-c",
      group: "table-c",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.3, 4.7], along: 0.5, alongTol: 0.01 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["diningtable"],
      clearance: 0.8,
    },
    {
      role: "rug",
      group: "table-c",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: { kind: "relative", slot: "table-c", dx: [-0.05, 0.05], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: 0 },
      accepts: ["rug"],
      scale: [1.3, 1.5],
      clearance: 0,
    },
    {
      role: "table-e",
      group: "table-e",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.3, 4.7], along: 0.65, alongTol: 0.01 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["diningtable"],
      clearance: 0.8,
    },
    {
      // 阅览椅×6 — locked three-a-side beside each table piece, facing
      // the run's centre; each chair is its own group (a six-chair
      // composition's footprint disc would swallow the entrance spine's
      // void — the small discs clear it by an authored 0.6m).
      role: "chair-n1",
      group: "chair-n1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [1.7, 1.9], dz: [-1.05, -0.95] },
      facing: { kind: "toward", slot: "table-c" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-n2",
      group: "chair-n2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [-0.1, 0.1], dz: [-1.05, -0.95] },
      facing: { kind: "toward", slot: "table-c" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-n3",
      group: "chair-n3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [-1.9, -1.7], dz: [-1.05, -0.95] },
      facing: { kind: "toward", slot: "table-c" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-s1",
      group: "chair-s1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [1.7, 1.9], dz: [0.95, 1.05] },
      facing: { kind: "toward", slot: "table-c" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-s2",
      group: "chair-s2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [-0.1, 0.1], dz: [0.95, 1.05] },
      facing: { kind: "toward", slot: "table-c" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-s3",
      group: "chair-s3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [-1.9, -1.7], dz: [0.95, 1.05] },
      facing: { kind: "toward", slot: "table-c" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      // 桌端落地灯×2 — just past the run's ends (plan row 07, cols 03/10).
      role: "endlamp-w",
      group: "lamp-w",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [3.2, 3.4], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      role: "endlamp-e",
      group: "lamp-e",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-c", dx: [-3.4, -3.2], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 窗角阅读椅×2 — west and east window corners (plan rows 04/09),
      // each with its lamp inside the reach; the lamp's dx sign is fixed
      // per corner so it always lands room-ward (a seeded side would put
      // it in the wall half the time and forfeit the group).
      role: "chair-w",
      group: "corner-w",
      required: false,
      chance: 0.55,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.25, alongTol: 0.55 },
      facing: { kind: "moduleCenter" },
      accepts: ["readingchair"],
      clearance: 0.5,
    },
    {
      role: "cornerlamp-w",
      group: "corner-w",
      required: false,
      at: { kind: "relative", slot: "chair-w", dx: [0.7, 0.85], dz: [0, 0.15] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.3,
    },
    {
      role: "chair-e",
      group: "corner-e",
      required: false,
      chance: 0.55,
      at: { kind: "wall", wall: "e", dist: [0.7, 0.85], along: 0.25, alongTol: 0.55 },
      facing: { kind: "moduleCenter" },
      accepts: ["readingchair"],
      clearance: 0.5,
    },
    {
      role: "cornerlamp-e",
      group: "corner-e",
      required: false,
      at: { kind: "relative", slot: "chair-e", dx: [-0.85, -0.7], dz: [0, 0.15] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.3,
    },
    {
      // 阅览凳 — the plan's G (OPTIONAL, 西墙): the gallery bench faces the
      // table across the room, mid-west-wall between the window corner and
      // the table's west lamp — it never blocks the focal axis and keeps
      // clear of the corner group (authored 1.4m+ apart, guarded by the
      // shared discs since this group is NOT isolated). The plan's
      // REQUIRED window corners keep their reading chairs; bench and
      // chairs coexist exactly as the plan draws them.
      role: "bench",
      group: "bench",
      required: false,
      chance: 0.4,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.46, alongTol: 0.8 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["bench"],
      clearance: 0.55,
    },
    {
      // 凳上书 — an open book left on the seat (lift 0.45 = the bench
      // top, the gallery-bench kit's own calm-trace precedent).
      role: "bench-book",
      group: "bench",
      required: false,
      at: { kind: "relative", slot: "bench", dx: [-0.2, 0.2], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["bookpile"],
      lift: 0.45,
      clearance: 0.15,
    },
    {
      // 落地钟 — the north-east corner (the plan's optional c), standing
      // before the shelf run's end; NOT isolated, so it respects the
      // shelf wall's discs, and tucked to the corner bands so it clears
      // the walk corridor that ends a door-to-shelf sight-line away.
      role: "clock",
      group: "clock",
      required: false,
      chance: 0.35,
      at: { kind: "focalCorner", corner: "seeded", dist: [0.65, 0.75] },
      facing: { kind: "moduleCenter" },
      accepts: ["grandfatherclock"],
      clearance: 0.5,
    },
  ],
};

/** Lane A's blueprints — the residential family. */
export const RESIDENTIAL_SCHEMATICS: readonly RoomSchematic[] = [
  LIVING_SCHEMATIC,
  BEDROOM_SCHEMATIC,
  STUDY_SCHEMATIC,
  READING_ROOM_SCHEMATIC,
];
