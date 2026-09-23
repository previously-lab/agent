/**
 * The residential family — Lane A's modules: bedroom, study, reading-room,
 * living (their historical relative order).
 *
 * The v0.12b split: a lane that needs to touch its room's zones / kits /
 * features / heroKit asks the main agent in its report — this data feeds
 * seed draws and staging pins, so it never changes unilaterally. The
 * GLOBAL catalogue order is pinned by MODULE_ORDER in ../room-modules.
 */
import type { RoomModule } from "../room-modules";

export const RESIDENTIAL_MODULES: readonly RoomModule[] = [
  {
    // 卧室 — the hotel-room signature: the bed corner against the far wall,
    // a desk under the window side, the room's calm arranged around sleep.
    id: "bedroom",
    label: "卧室",
    worldClasses: ["interior"],
    archetypes: ["hotel-room"],
    // v0.13 用户尺度裁决: 1×2 (6×12). The bed row is 4.6m wide at most —
    // 6m carries it without waste — while the depth carries the wardrobe,
    // the window corner and the vanity as a real 主卧套间 (the plan's own
    // variant-B character). Stock zones need no edit: the keep-empty spine
    // scales to x ±0.84, z ≤ 6.6, and the bed corner's disc clears it by
    // an authored 1.8m.
    size: { w: 6, d: 12 },
    openings: ["s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 3,
    floor: "carpet",
    wall: "plaster",
    light: "quiet",
    features: [{ kind: "niche", at: "e", span: [0.35, 0.65] }],
    // §2: wardrobe 必备 against the non-door, non-headboard wall; the tv
    // corner leaves (the spec bans tv + sofa from the bedroom — the §6.4
    // audit's "说不出用途链" bar — and §2's variant ask is the schematic
    // lane's to pin).
    // §6.4 逐件问责: no `luggage` here — §2's ban list names the
    // luggagecart (and the cart IS the kit's centrepiece), and the
    // wardrobe is the §2 必备 this wall exists for.
    kits: [
      "bed-corner",
      "writing-desk",
      "wardrobe-wall",
      "reading",
      "vanity-corner",
    ],
    heroKit: "bed-corner",
    zones: [
      // The hero zone sits deep enough that the bed corner's footprint
      // disc clears the keep-empty spine on the first draw — at 0.62 the
      // disc grazed the void's edge and the whole centrepiece was
      // forfeited (v0.12 declarations audit; kits.ts now also redraws a
      // failed hero inside this zone).
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.72, 0.92] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.6] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.55] } },
    ],
    weight: 3,
  },
  {
    // 书房 — the writing desk is the altar: shelves on the north wall.
    // §10.5: the north edge is the only legal door edge, and it is the
    // shelf wall — so the study hosts NO doors at all.
    id: "study",
    label: "书房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library"],
    // v0.13 用户尺度裁决: 1×1 (6×6) — "一个人的书房" does not want a 70%-empty
    // floor; one desk against one shelf fills six metres honestly.
    size: { w: 6, d: 6 },
    openings: ["s", "e", "w"],
    doorEdges: [],
    doorCapacity: 0,
    floor: "timber",
    wall: "shelf",
    light: "task",
    features: [{ kind: "pilaster-rhythm", at: "n" }],
    kits: ["writing-desk", "bookshelf-run", "reading", "plant-pedestal"],
    heroKit: "reading",
    zones: [
      { kind: "hero", rect: { x: [0.3, 0.7], z: [0.56, 0.86] } },
      { kind: "cluster", rect: { x: [0.06, 0.94], z: [0.74, 0.96] } },
      { kind: "cluster", rect: { x: [0.04, 0.3], z: [0.12, 0.6] } },
      // The entrance spine shrinks with the room: at 1×1 the desk-and-chair
      // ARE the path's destination and must stand where a 12m room's spine
      // would forbid them. 1.8m deep keeps the door swing and the walkway
      // honest; the schematic's desk group disc still clears it by 0.5m.
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.3] } },
    ],
    weight: 2,
  },
  {
    // 阅览室 — the library hall in one unit: a shelf wall across the whole
    // north face, a bench to sit with a book, a reading corner. §10.5: the
    // shelf wall is the only legal door edge, so the room hosts none.
    id: "reading-room",
    label: "阅览室",
    worldClasses: ["interior"],
    archetypes: ["library", "ballroom"],
    // v0.13 用户尺度裁决: 1×2 (6×12). The fixed 3.5m entrance strip
    // amputates the south half of any 6m-deep room — the six-chair table
    // cannot survive 2×1 — so the reading room goes tall: a processional
    // 3.5m entry hall, then the furniture band. The long table now runs
    // east-west as the plan's own variant B draws it (TWIN laid tables,
    // 4.4m of run — three 2.2m tops would need ±2.9m of a ±2.35m floor),
    // with the shelf wall still north. Stock zones hold: the spine scales
    // to x ±0.72, z ≤ 5.28, and every piece stands clear of it.
    size: { w: 6, d: 12 },
    openings: ["s", "e", "w"],
    doorEdges: [],
    doorCapacity: 0,
    floor: "timber",
    wall: "shelf",
    light: "wash",
    features: [
      { kind: "pilaster-rhythm", at: "n" },
      { kind: "floor-inlay", at: "floor", span: [0.3, 0.7] },
      // The library gallery's processional end: free-standing columns
      // before the shelf wall (real stone where the old vocabulary drew
      // light shafts, §3.2's column order) and, between the stacks and
      // the colonnade, the round arch — its own ceiling (§3.2's arch
      // frame). The shelf wall hosts no doors (doorEdges is empty), so
      // the north face is the one wall the rhythm can always trust.
      { kind: "column-order", at: "n", span: [0.14, 0.86] },
      { kind: "arch-frame", at: "n", span: [0.38, 0.62] },
    ],
    kits: [
      "bookshelf-run",
      "reading",
      "gallery-bench",
      "clock-nook",
      "plant-pedestal",
    ],
    heroKit: "reading",
    zones: [
      { kind: "hero", rect: { x: [0.32, 0.68], z: [0.5, 0.76] } },
      { kind: "cluster", rect: { x: [0.04, 0.96], z: [0.76, 0.96] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.6] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.44] } },
    ],
    weight: 3,
  },
  {
    // 会客厅 — the conversation pair as the centrepiece, a tv corner to one
    // side, a reading chair to the other. A room for sitting with someone.
    id: "living",
    label: "会客厅",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom", "library"],
    size: { w: 12, d: 12 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 3,
    floor: "carpet",
    wall: "plaster",
    light: "quiet",
    features: [{ kind: "floor-inlay", at: "floor", span: [0.25, 0.75] }],
    // §6.4 逐件问责 (v0.12 declarations audit): no coat-bench here — the
    // bench + coat stand + umbrella stand is the park/threshold vocabulary,
    // and in a living room it read as a park bench moved indoors (the
    // user's own call-out). The living sits on the sofa group; its quiet
    // pieces are the sideboard, the plants, and the picture row (附录 A:
    // wallart 用在 gallery / living).
    kits: [
      "sofa-group",
      "tv-corner",
      "reading",
      "art-wall",
      "sideboard",
      "plant-pedestal",
    ],
    heroKit: "sofa-group",
    zones: [
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.52, 0.82] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.55] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.55] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.46] } },
    ],
    weight: 2,
  },
];
