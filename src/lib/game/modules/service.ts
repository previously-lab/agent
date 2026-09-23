/**
 * The service family — Lane B's modules: foyer, kitchen, bath, storage,
 * workshop (their historical relative order).
 *
 * The v0.12b split: a lane that needs to touch its room's zones / kits /
 * features / heroKit asks the main agent in its report — this data feeds
 * seed draws and staging pins, so it never changes unilaterally. The
 * GLOBAL catalogue order is pinned by MODULE_ORDER in ../room-modules.
 */
import type { RoomModule } from "../room-modules";

export const SERVICE_MODULES: readonly RoomModule[] = [
  {
    // 门厅 — the threshold: coats, umbrellas, someone's bags waiting by the
    // door. Deliberately empty down its spine so arrival reads as arrival.
    id: "foyer",
    label: "门厅",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom", "pool-hall"],
    size: { w: 10, d: 8 },
    openings: ["n", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 3,
    floor: "tile",
    wall: "panelling",
    light: "quiet",
    features: [{ kind: "floor-inlay", at: "floor", span: [0.35, 0.65] }],
    // §6.4 逐件问责 (v0.12 declarations audit): no housekeeping here — the
    // trolley + towel piles + bucket is floor-service semantics, and in the
    // threshold room it read as the cleaner working around your arrival.
    // The foyer keeps arrival: coats, the reception counter, a lobby clock.
    // No luggage cart either (§12 bans it): the blueprint never draws it,
    // but the generic fallback path would stage it in the threshold.
    // §12 bans the CART, not the waiting bags: the storage rack (rack + two
    // suitcases + tray) is the threshold's own trace — the module header's
    // "someone's bags waiting by the door". It also keeps the pool-hall
    // draw at two kits (reception/clock-nook's gates exclude pool-hall), so
    // a primary foyer never reads as the one fixed scene (§8.2's bar).
    kits: ["coat-bench", "reception", "clock-nook", "storage-rack"],
    zones: [
      { kind: "cluster", rect: { x: [0.04, 0.3], z: [0.1, 0.9] } },
      { kind: "cluster", rect: { x: [0.7, 0.96], z: [0.1, 0.9] } },
      // The spine narrows to the entrance half (z:[0, 0.5]) so the
      // reception counter can stand on the axis past the keep-empty
      // band — its 对门 read needs the centre axis free.
      { kind: "keep-empty", rect: { x: [0.34, 0.66], z: [0, 0.5] } },
    ],
    weight: 1,
  },
  {
    // 备餐间 — the working end of a meal: a laid table, the housekeeping
    // trolley parked mid-round. Tile floor, everything washable.
    id: "kitchen",
    label: "备餐间",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom"],
    size: { w: 10, d: 8 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 2,
    floor: "tile",
    wall: "tile",
    light: "task",
    features: [],
    // §5: the working counter (操作台) + the laid table are the room; the
    // kitchen-counter kit names the counter, its slab dressing AND the
    // bucket+mop corner. §6.4 逐件问责: chair-stack leaves (§13 names the
    // workshop the stack's ONE proper room), and the housekeeping trolley
    // + coat bench are floor-service/threshold vocabulary the §5 槽位
    // never lists for a working kitchen (the foyer audit's own reading).
    kits: ["dining", "kitchen-counter"],
    heroKit: "dining",
    zones: [
      // Deep enough for the laid table's footprint disc to clear the
      // keep-empty apron on the first draw (v0.12 declarations audit —
      // at 0.55 the disc grazed the void and the table never came).
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.6, 0.92] } },
      { kind: "cluster", rect: { x: [0.04, 0.28], z: [0.1, 0.55] } },
      { kind: "cluster", rect: { x: [0.72, 0.96], z: [0.1, 0.55] } },
      { kind: "keep-empty", rect: { x: [0.34, 0.66], z: [0, 0.5] } },
    ],
    weight: 1,
  },
  {
    // 更衣浴室 — lockers along the wall, towels folded and waiting, one
    // bench. The pool wing's changing room (its kits are all pool-side —
    // a hotel-room draw would leave it a single coat bench, not a room).
    // Sized 16×10 like the pool deck it serves: the pool-hall archetype
    // waters a fixed 45% of the floor, and at 8×8 the basin plus its rim
    // fixtures swallowed every dry spot — the four declared kits placed
    // nothing and the room rendered as a bare basin (v0.12 declarations
    // audit). At 16×10 the east/west rims are ~4.7m of dry deck: the
    // changing furniture owns the room and the basin reads as the bath's
    // plunge pool, not its whole identity. §6.4: every piece here can say
    // why it is in a changing room.
    id: "bath",
    label: "更衣浴室",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    size: { w: 16, d: 10 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 2,
    floor: "tile",
    wall: "tile",
    light: "wash",
    features: [],
    kits: ["lockers", "towel-station", "coat-bench", "towel-rail", "mop-corner"],
    zones: [
      // The dry rims beside the basin — lockers anchor to the flank
      // walls here, towel stations and rails stand between the water
      // margin and the wall.
      { kind: "cluster", rect: { x: [0.03, 0.2], z: [0.12, 0.88] } },
      { kind: "cluster", rect: { x: [0.8, 0.97], z: [0.12, 0.88] } },
      // The dry strip past the basin's far edge — small kits only.
      { kind: "cluster", rect: { x: [0.3, 0.7], z: [0.84, 0.96] } },
      // The entrance apron and the walk spine to the water stay clear.
      { kind: "keep-empty", rect: { x: [0.37, 0.63], z: [0, 0.5] } },
    ],
    weight: 2,
  },
  {
    // 行李房 — the calm trace made a room: luggage carts and suitcases in
    // waiting rows, a coat bench by the door. Storage, not abandonment (I4).
    id: "storage",
    label: "行李房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom", "pool-hall"],
    size: { w: 8, d: 8 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 2,
    floor: "timber",
    wall: "panelling",
    light: "quiet",
    features: [],
    // §6.4 逐件问责 (v0.12 declarations audit): no chair-stack here — the
    // stacked banquet chairs read as a function room's spares, not a
    // luggage room's. The room stores: bags, carts, the bench you set
    // them down on, the racks they wait on, and housekeeping mid-tidy
    // (the one room where the trolley genuinely belongs — it is being put
    // in order).
    kits: ["luggage", "housekeeping", "coat-bench", "storage-rack"],
    zones: [
      { kind: "cluster", rect: { x: [0.06, 0.45], z: [0.12, 0.9] } },
      { kind: "cluster", rect: { x: [0.55, 0.94], z: [0.12, 0.9] } },
      { kind: "keep-empty", rect: { x: [0.44, 0.56], z: [0, 1] } },
    ],
    weight: 1,
  },
  {
    // 工作间 — the room where something was being made: the desk with its
    // lamp, lockers of materials, the trolley parked mid-task. Paused,
    // never abandoned (I4).
    id: "workshop",
    label: "工作间",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom"],
    size: { w: 10, d: 10 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 2,
    floor: "timber",
    wall: "panelling",
    light: "task",
    features: [],
    // §13: the workbench corner (workbench + storagerack + chair + the
    // tools ON the slab) is the room's signature; the writing desk stays
    // for the paperwork end.
    kits: ["writing-desk", "workbench-corner", "lockers", "housekeeping", "coat-bench", "chair-stack"],
    // No heroKit pin: none of the workshop's whitelisted kits is a
    // heroSlot centrepiece, so the hero falls back to the seeded draw
    // among the room's hero-eligible kits (kits.ts's rule, unchanged).
    zones: [
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.55, 0.88] } },
      { kind: "cluster", rect: { x: [0.04, 0.28], z: [0.1, 0.6] } },
      { kind: "cluster", rect: { x: [0.72, 0.96], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.5] } },
    ],
    weight: 1,
  },
];
