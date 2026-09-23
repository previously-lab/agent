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
      // north (plan row 02). At 1×2 the bed corner's footprint disc spans
      // x ∈ [−2.4, 1.4] and the wardrobe stands 1.35m past its edge — the
      // disc-to-disc guard (KIT_GAP included) is mathematically impossible
      // in a 6m width, so the group is isolated and the ring is carried
      // by the authored geometry (asserted in the family test) instead.
      role: "wardrobe",
      group: "wardrobe",
      required: true,
      isolated: true,
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
 * The study (v0.12-room-specs §3; room-plans/study.txt variant A,
 * 面壁式 — re-derived for the 1×1 (6×6) the user's scale ruling assigns):
 * the §3 signature survives at six metres — the writing desk faces the
 * shelf wall, the lamp and a book pile ON the desktop, the rug underfoot —
 * but the room now holds ONE wide bookcase where a long wall held a run
 * (a stepped run's footprint disc, ≥2.3m, would eat the 36m² floor's
 * whole 23.4m² coverage budget), and the desk sits close under the shelf
 * as a carrel (see the desk slot — the fixed 3.5m entrance strip leaves
 * no room for both a pulled chair and a browse channel). The west corner
 * keeps its chair + lamp, the east wall its sideboard. The shelf is
 * `terminus`: the walk path ends at the desk hard by the shelf face, and
 * without the flag the shared machinery rejects the wall for standing
 * inside its own destination's corridor. 禁止栏 (§3): no bed / sofa /
 * lounger / rows of seats / housekeeping kind — the accepts are the
 * vocabulary.
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
      // 书架 — the book wall at 1×1: ONE wide bookcase (scaled 1.4–1.55×,
      // ≈2.4–2.7m of shelving) west of the desk. A stepped run's footprint
      // disc (≥2.3m) would answer the 36m² floor's 23.4m² coverage budget
      // with nothing left for the desk. The K furniture carries the
      // wall:"shelf" register until it renders (INDEX 修正 7).
      role: "bookshelf",
      group: "shelf",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.65, 0.8], along: 0.28, alongTol: 0.06 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bookshelf"],
      scale: [1.4, 1.55],
      clearance: 0.5,
    },
    {
      // 书桌 — the carrel: at 1×1 the fixed entrance strip (|x| < 2.3m,
      // z < 3.5m — absolute, never scaled) leaves no room for a pulled-back
      // desk AND a browse channel: the chair must stand z > 3.5 while a
      // ≥0.9m channel needs the desk at z ≤ 3.715 — an empty interval. So
      // the desk hugs the bookcase like a library carrel (gap 0.07–0.47m,
      // logged as the scale ruling's casualty in the lane report) and the
      // chair takes the room between desk and door. Facing the shelf wall
      // is kept — §2 rule 1 survives; the channel does not.
      role: "desk",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [1.5, 1.7], along: 0.58, alongTol: 0.15 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["desk"],
      clearance: 1.0,
    },
    {
      // 座椅 — in the carrel gap between desk and door (z > 3.5 keeps it
      // out of the entrance strip), square at the desk.
      role: "chair",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "desk", dx: [-0.12, 0.12], dz: [0.45, 0.6] },
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
      // 地毯 — under the desk and chair, flat (z > 3.5 like everything
      // else in this little room).
      role: "rug",
      group: "desk",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: { kind: "relative", slot: "desk", dx: [-0.05, 0.05], dz: [0.4, 0.55] },
      facing: { kind: "fixed", rotY: 0, jitter: 0 },
      accepts: ["rug"],
      scale: [1.05, 1.2],
      clearance: 0,
    },
    {
      // 阅读角 — the west wall's north band (z 3.6–4.5 — everything in a
      // 1×1 room lives north of the entrance strip): the chair angled at
      // the room, the lamp a step south along the SAME wall (both
      // wall-anchored — a turned-frame offset could land in the corridor).
      // Isolated like the sideboard: at six metres the little discs reach
      // past each other and the guard would forfeit one of them; the
      // authored geometry keeps the truth.
      role: "chair-w",
      group: "corner",
      required: false,
      chance: 0.55,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.7, alongTol: 0.25 },
      facing: { kind: "moduleCenter" },
      accepts: ["readingchair"],
      clearance: 0.4,
    },
    {
      role: "lamp-w",
      group: "corner",
      required: false,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.63, alongTol: 0.2 },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.25,
    },
    {
      // 边柜 — the east wall's north band; isolated, same six-metre
      // arithmetic as the corner.
      role: "sideboard",
      group: "sideboard",
      required: false,
      chance: 0.5,
      isolated: true,
      at: { kind: "wall", wall: "e", dist: [0.7, 0.85], along: 0.65, alongTol: 0.25 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["sideboard"],
      clearance: 0.85,
    },
  ],
};

/**
 * The reading room (v0.12-room-specs §4; room-plans/reading-room.txt —
 * re-derived for the 1×2 (6×12) the user's scale ruling assigns): the
 * north face keeps its book wall as one wide bookcase, and the long
 * reading table stands centred on the room's axis 4.2–4.7m off it as the
 * plan's own variant B draws — TWIN laid tables butted into one 4.4m run
 * (three tops would need ±2.9m of a ±2.35m-wide floor). Six chairs face
 * the table three-a-side (the §4 count, inside the corrected ×4–8 band),
 * a floor lamp just inside each end; the round rug anchors the run, the
 * west window corner takes a reading chair + lamp (z 5–6.2 — the east
 * corner is the walk path's side at this depth and is dropped, noted at
 * the slots' end), and the plan's gallery bench takes the west wall's
 * south band, exactly where the plan draws its G. The plan's optional
 * grandfather clock does not survive the shrink — no corner clears the
 * walk corridor's end radius at this depth either — and is dropped (noted
 * at the slots' end). The table, its chairs and its lamps are the path's
 * destination — all `terminus`.
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
      // 书墙 — one wide bookcase on the north face (scaled 1.5–1.7×, a
      // 2.6–3m wall of shelves at 1×2); a stepped run's disc would tax the
      // narrow floor for little gain, and the single piece still reads as
      // THE book wall (the wall:"shelf" register renders plain plaster —
      // INDEX 修正 7). Non-terminus at this depth: the path ends 2m shy
      // of the shelf face, outside the 1.9m corridor.
      role: "bookshelf",
      group: "shelf",
      required: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [0.7, 0.85], along: 0.5, alongTol: 0.12 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["bookshelf"],
      scale: [1.5, 1.7],
      clearance: 0.5,
    },
    {
      // 长阅览桌 — the plan's own variant B: TWIN laid tables butted into
      // one 4.4m run on the room's axis (three 2.2m tops would need ±2.9m
      // of a ±2.35m floor), 4.2–4.7m off the shelf wall — the browse
      // channel keeps a real 2.2m+ at this depth.
      role: "table-w",
      group: "table-w",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.2, 4.7], along: 0.35, alongTol: 0.01 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["diningtable"],
      clearance: 0.8,
    },
    {
      role: "table-e",
      group: "table-e",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [4.2, 4.7], along: 0.65, alongTol: 0.01 },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["diningtable"],
      clearance: 0.8,
    },
    {
      // 毯 — under the twin-table run, centred on the pair's middle.
      role: "rug",
      group: "table-e",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: { kind: "relative", slot: "table-w", dx: [-0.95, -0.85], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: 0 },
      accepts: ["rug"],
      scale: [1.1, 1.3],
      clearance: 0,
    },
    {
      // 阅览椅×6 — locked three-a-side along the twin run, facing the
      // table they flank; each chair is its own group (a six-chair
      // composition's footprint disc would swallow the entrance spine's
      // void — the small discs clear it by an authored margin).
      role: "chair-n1",
      group: "chair-n1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [0.8, 0.9], dz: [-1.05, -0.95] },
      facing: { kind: "toward", slot: "table-w" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-n2",
      group: "chair-n2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [-0.08, 0.08], dz: [-1.05, -0.95] },
      facing: { kind: "toward", slot: "table-w" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-n3",
      group: "chair-n3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [-0.9, -0.8], dz: [-1.05, -0.95] },
      facing: { kind: "toward", slot: "table-w" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-s1",
      group: "chair-s1",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [0.8, 0.9], dz: [0.95, 1.05] },
      facing: { kind: "toward", slot: "table-w" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-s2",
      group: "chair-s2",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [-0.08, 0.08], dz: [0.95, 1.05] },
      facing: { kind: "toward", slot: "table-w" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      role: "chair-s3",
      group: "chair-s3",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [-0.9, -0.8], dz: [0.95, 1.05] },
      facing: { kind: "toward", slot: "table-w" },
      accepts: ["chair"],
      clearance: 0.4,
    },
    {
      // 桌端落地灯×2 — tucked just inside the twin run's ends (the 6m
      // width leaves no room beyond them; the lamps mark the run's ends
      // from the flanks instead — plan cols 03/10 in spirit).
      role: "endlamp-w",
      group: "lamp-w",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "table-w", dx: [1.25, 1.35], dz: [-0.05, 0.05] },
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
      at: { kind: "relative", slot: "table-w", dx: [-3.15, -3.05], dz: [-0.05, 0.05] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 窗角阅读椅×2 — west and east window corners (z 5–6.2, the band
      // between the door hall and the table), each with its lamp inside
      // the reach. The lamp's dx sign is fixed per corner so it always
      // lands room-ward (a seeded side would put it in the wall half the
      // time and forfeit the group).
      role: "chair-w",
      group: "corner-w",
      required: false,
      chance: 0.55,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.47, alongTol: 0.06 },
      facing: { kind: "moduleCenter" },
      accepts: ["readingchair"],
      clearance: 0.5,
    },
    {
      role: "cornerlamp-w",
      group: "corner-w",
      required: false,
      isolated: true,
      at: { kind: "relative", slot: "chair-w", dx: [0.7, 0.85], dz: [0, 0.15] },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.3,
    },
    // The plan's east window corner does not survive the 1×2 assignment:
    // the walk path (door → bend → table) hugs the east flank at this
    // depth and its 1.9m corridor swallows the whole band where the corner
    // would stand — 0 of 36 sweep samples placed it. One window corner
    // (west, off the path's drift side) keeps the plan's reading-corner
    // beat; the east wall's identity is the bench's instead.
    {
      // 阅览凳 — the plan's G (OPTIONAL, 西墙 — as the plan draws it): the
      // gallery bench faces the table across the room from the west wall's
      // south band (z 3.6–4.2), the one flank band the walk path leaves
      // alone (it drifts east). The east wall at this depth belongs to
      // the corridor, the west's north band to the window corner. Isolated:
      // the little discs reach past each other and the guard would forfeit
      // one of them.
      role: "bench",
      group: "bench",
      required: false,
      chance: 0.4,
      isolated: true,
      at: { kind: "wall", wall: "w", dist: [0.7, 0.85], along: 0.325, alongTol: 0.03 },
      facing: { kind: "moduleCenter" },
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
    // The plan's optional clock (落地钟, NE corner) does not survive the
    // 1×2 shrink either: at this depth its corner still sits inside the
    // walk corridor's end radius (the path terminates within 1.9m of the
    // shelf wall), and a corner prop would stand where the walk promises
    // air. The plan marks it OPTIONAL — dropped, logged here and in the
    // lane report.
  ],
};

/** Lane A's blueprints — the residential family. */
export const RESIDENTIAL_SCHEMATICS: readonly RoomSchematic[] = [
  LIVING_SCHEMATIC,
  BEDROOM_SCHEMATIC,
  STUDY_SCHEMATIC,
  READING_ROOM_SCHEMATIC,
];
