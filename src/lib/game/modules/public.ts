/**
 * The public family — Lane C's modules: gallery-module, sunroom, pool-deck,
 * dining-hall (their historical relative order).
 *
 * The v0.12b split: a lane that needs to touch its room's zones / kits /
 * features / heroKit asks the main agent in its report — this data feeds
 * seed draws and staging pins, so it never changes unilaterally. The
 * GLOBAL catalogue order is pinned by MODULE_ORDER in ../room-modules.
 */
import type { RoomModule } from "../room-modules";

export const PUBLIC_MODULES: readonly RoomModule[] = [
  {
    // 画廊 — the long wall built to LOOK at (and to carry a busy day's
    // doors): a pilastered north face, benches facing it, inlay underfoot.
    // The composition's door absorber — its north wall is the door wall.
    id: "gallery-module",
    label: "画廊",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    size: { w: 16, d: 10 },
    openings: ["e", "w"],
    doorEdges: ["n"],
    doorCapacity: 10,
    floor: "timber",
    wall: "plaster",
    light: "wash",
    features: [
      { kind: "pilaster-rhythm", at: "n" },
      { kind: "floor-inlay", at: "floor", span: [0.15, 0.85] },
    ],
    // §6.4 逐件问责: the shelf run and the lobby clock leave — §8's 槽位
    // is the long LOOKING wall (wallart + benches + sculptures) and the
    // reading corner that keeps it company; a bookcase row and a
    // grandfather clock are library vocabulary.
    kits: [
      "gallery-bench",
      "reading",
      "plant-pedestal",
      "art-wall",
    ],
    heroKit: "reading", // an armchair facing the long wall — gallery-bench
    // is the wall's companion, but kits.ts only grants the hero slot to
    // composed centrepieces, so the pin goes to the hero-eligible chair.
    zones: [
      { kind: "hero", rect: { x: [0.34, 0.66], z: [0.5, 0.76] } },
      { kind: "cluster", rect: { x: [0.08, 0.92], z: [0.2, 0.6] } },
      // v0.12b §8: the north band is the LOOKING wall — the blueprint's
      // wallart/washers own it (the band used to 100%-forfeit the
      // schematic; lane C report Z1). The corridor keeps an entrance
      // apron only; the benches' discs clear z 0.3 (Z2).
      { kind: "keep-empty", rect: { x: [0.4, 0.6], z: [0, 0.3] } },
    ],
    weight: 2,
  },
  {
    // 日光房 — the room whose north wall is glass (the daylight wall: never
    // a door, never an opening). §10.5: the only legal door edge is the
    // glass one, so the sunroom hosts NO doors — it is the room of light.
    id: "sunroom",
    label: "日光房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom", "library"],
    size: { w: 12, d: 8 },
    openings: ["s", "e", "w"],
    doorEdges: [],
    doorCapacity: 0,
    floor: "tile",
    wall: "plaster",
    light: "daylight",
    features: [{ kind: "floor-inlay", at: "floor", span: [0.2, 0.8] }],
    // The north edge IS the glass wall (v0.12 §9 + 附录 A): the exposed
    // span renders as a floor-to-top glass wall with the outside view, and
    // the daylight register's sconce falls back to a solid flank wall.
    glassWall: true,
    kits: [
      "reading",
      "coat-bench",
      "gallery-bench",
      "plant-pedestal",
      "fountain-court",
    ],
    heroKit: "reading",
    zones: [
      // Deep enough for the reading corner's footprint disc to clear the
      // keep-empty apron on the first draw (v0.12 declarations audit).
      { kind: "hero", rect: { x: [0.3, 0.7], z: [0.66, 0.92] } },
      { kind: "cluster", rect: { x: [0.04, 0.28], z: [0.15, 0.6] } },
      { kind: "cluster", rect: { x: [0.72, 0.96], z: [0.15, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.55] } },
    ],
    weight: 1,
  },
  {
    // 泳池甲板 — the dry edge of the water: the lounger pair facing the
    // pool, towels and ring posts along the sides. §10.5: the only legal
    // door edge is the north one, and that edge belongs to the water —
    // so the deck hosts NO doors.
    id: "pool-deck",
    label: "泳池甲板",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    size: { w: 16, d: 10 },
    openings: ["e", "w"],
    doorEdges: [],
    doorCapacity: 0,
    floor: "deck",
    wall: "tile",
    light: "pool-bounce",
    // The rill returns WITH its geometry (space.tsx's buildRoomFeatures
    // resolves it and the WaterRill component builds the runnel + its own
    // wave-driven water): the east-flank feed runnel — a shallow stone
    // channel running the deck's depth, real water on the room's own wave
    // machinery. The span hugs the deck's east edge, clear of the walk
    // spine AND the basin (the builder forfeits any rill rect touching
    // the water — the 2026-09 declaration reached z 0.68 of the depth and
    // straddled the basin, so the rill could never build; v0.12 audit),
    // and the z span runs the flank's full dry length.
    features: [
      {
        kind: "water-rill",
        at: "floor",
        span: [0.86, 0.94],
        spanZ: [0.1, 0.9],
      },
    ],
    kits: [
      "pool-loungers",
      "towel-station",
      "ring-post",
      "poolside-bench",
      "ladder-board",
      "towel-rail",
    ],
    heroKit: "pool-loungers",
    zones: [
      // The hero stands on the west rim, facing the door across the
      // water — the authored zone-center draw used to land INSIDE the
      // basin (forfeit: dry furniture may not stand in the pool), so the
      // loungers never appeared (v0.12 declarations audit).
      { kind: "hero", rect: { x: [0.1, 0.24], z: [0.4, 0.6] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.9] } },
      // The east cluster keeps off the runnel band (its span above).
      { kind: "cluster", rect: { x: [0.74, 0.82], z: [0.1, 0.9] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.5] } },
    ],
    weight: 3,
  },
  {
    // 长桌餐厅 — one long table down the room's axis, the service kept to
    // the flanks. The dining kit repeats along the table's run — several
    // settings of ONE meal, never a warehouse (§6).
    id: "dining-hall",
    label: "长桌餐厅",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "hotel-room"],
    size: { w: 14, d: 10 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n"],
    doorCapacity: 4,
    floor: "timber",
    wall: "panelling",
    light: "task",
    features: [
      { kind: "pilaster-rhythm", at: "n" },
      // The hall head: a railed dais for the head table, and above it a
      // mezzanine gallery overlooking the meal — the far wall's two
      // tiers, the dollhouse camera's second silhouette layer.
      { kind: "raised-platform", at: "n", span: [0.3, 0.7] },
      { kind: "mezzanine", at: "n", span: [0.24, 0.76] },
    ],
    // §6.4 逐件问责 (v0.12 declarations audit): no housekeeping here — a
    // trolley of towels and a bucket reads as the cleaner working AROUND
    // the meal, never the meal itself; the hall's service is the
    // sideboard and the stacked spares.
    kits: ["dining", "gallery-bench", "chair-stack", "sideboard"],
    heroKit: "dining",
    zones: [
      { kind: "hero", rect: { x: [0.32, 0.68], z: [0.5, 0.8] } },
      { kind: "cluster", rect: { x: [0.06, 0.28], z: [0.15, 0.85] } },
      { kind: "cluster", rect: { x: [0.72, 0.94], z: [0.15, 0.85] } },
      { kind: "keep-empty", rect: { x: [0, 1], z: [0, 0.12] } },
      // v0.12b §11: the corridor keeps the door approach only — the
      // banquet's south chair row lands at z ≥ 0.42 and its discs
      // always reached into z 0.44 (36/36 forfeits; lane C report Z3).
      { kind: "keep-empty", rect: { x: [0.4, 0.6], z: [0.12, 0.3] } },
    ],
    weight: 2,
  },
];
