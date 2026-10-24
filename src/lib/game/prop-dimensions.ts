/**
 * Prop dimensions (2026-10 activity-trace lane) — the LEAF constant module
 * for the staged props' real measurements. No runtime dependencies: nothing
 * here imports three.js, React, kits, hotel, or any other module, so both
 * the renderer and every pure game module can read these numbers without
 * dragging a dependency graph along.
 *
 * prop-geometry.ts re-exports BOOKSHELF_DIMENSIONS / BOOKSHELF_RUN_SPACING
 * from here (it stays the OBB/footprint home; this file is the single place
 * the numbers are DEFINED). ACTIVITY_SURFACE_HEIGHTS is new: the height of
 * the REAL working top of each furniture kind an activity trace can rest
 * on — measured off the prop bodies, not the conservative footprint bounds
 * in prop-geometry's PROP_DIMENSIONS:
 *
 *   desk        0.80  DeskProp's grained top slab (0.76 + 0.08/2)
 *   diningtable .7875 the laid table's cloth slab top (.775 + .025/2)
 *   counter     0.96  the service counter's countertop
 *   workbench   0.90  the workshop slab ("top at 0.9m")
 *   coffeetable 0.40  the low table's top
 *   nightstand  0.56  the nightstand body's box top (0.28 + 0.56/2 —
 *                     the 0.9 footprint bound is the lamp globe ABOVE it)
 *   bench       0.50  the bench's seat board (.46 + .08/2)
 *   poolbench  .4075  the poolside slats (.385 + .045/2)
 */

/** The BookshelfProp's REAL case size (room-props.tsx: plinth GrainBox
 *  1.84 × 0.44, sides 2.2 tall, top board at 2.17 + 0.06). Every consumer
 *  of the bookshelf's footprint reads THESE numbers — the kit layer
 *  (kits.ts) and the fixture resolver included. */
export const BOOKSHELF_DIMENSIONS = {
  width: 1.84,
  depth: 0.44,
  height: 2.2,
  /** The prop's own shelf board heights ( BookSpines rows sit on them). */
  shelfYs: [0.5, 1.1, 1.7],
} as const;

/** Center-to-center spacing of adjacent shelves in a run: the real width
 *  plus an 8cm finger gap — three bodies at ±spacing never interleave
 *  (half-spacing 0.96 > half-width 0.92). */
export const BOOKSHELF_RUN_SPACING = BOOKSHELF_DIMENSIONS.width + 0.08; // 1.92

/** The real working-top height (meters, human scale) of each furniture
 *  kind an activity trace may rest on — see the file header for where each
 *  number was measured. Keyed by the host piece's `kind`; a kind missing
 *  from this table can never carry a trace. */
export const ACTIVITY_SURFACE_HEIGHTS: Readonly<Record<string, number>> = {
  desk: 0.8,
  diningtable: 0.7875,
  counter: 0.96,
  workbench: 0.9,
  coffeetable: 0.4,
  nightstand: 0.56,
  bench: 0.5,
  poolbench: 0.4075,
};

/** Measured support boards, not the props' contact shadows. All coordinates
 * are host-local meters; these small authored obstacles are built INTO the
 * prop meshes and therefore never occur as separate staged pieces. */
export const ACTIVITY_SUPPORTS: Readonly<Record<string, {
  hx: number; hz: number;
  obstacles: readonly { x: number; z: number; radius: number }[];
}>> = {
  desk: { hx: .75, hz: .375, obstacles: [] },
  diningtable: { hx: 1.1, hz: .475, obstacles: [
    ...[-.55, .55].flatMap((x) => [-.28, .28].flatMap((z) => [
      { x, z, radius: .11 }, { x: x + .14, z: z + .05, radius: .035 },
    ])),
    { x: -.25, z: 0, radius: .06 }, { x: .25, z: 0, radius: .06 },
    { x: 0, z: 0, radius: .14 },
  ] },
  counter: { hx: 1.275, hz: .35, obstacles: [] },
  workbench: { hx: .9, hz: .4, obstacles: [{ x: .76, z: .18, radius: .18 }] },
  coffeetable: { hx: .45, hz: .275, obstacles: [] },
  nightstand: { hx: .25, hz: .225, obstacles: [{ x: 0, z: 0, radius: .08 }] },
  bench: { hx: .8, hz: .275, obstacles: [] },
  poolbench: { hx: .8, hz: .24, obstacles: [] },
};

/** The renderer consumes these same sheet dimensions and offsets. */
export const ACTIVITY_SHEETS = {
  writing: [
    { width: .21, depth: .3, x: -.06, z: .01, rotY: .16, yBase: 0 },
    { width: .21, depth: .3, x: .04, z: .04, rotY: -.1, yBase: .004 },
    { width: .21, depth: .3, x: 0, z: -.05, rotY: .28, yBase: .008 },
  ],
  planning: [
    { width: .3, depth: .42, x: 0, z: 0, rotY: -.06, yBase: 0 },
    { width: .09, depth: .13, x: .06, z: .05, rotY: .2, yBase: .004 },
    { width: .09, depth: .13, x: -.05, z: -.07, rotY: -.35, yBase: .004 },
  ],
  making: [{ width: .24, depth: .17, x: 0, z: .01, rotY: .1, yBase: 0 }],
} as const;

export const ACTIVITY_CUPS = [
  { x: -.09, z: .02, yaw: .2 }, { x: .09, z: -.02, yaw: -.3 },
] as const;
export const ACTIVITY_CUP_RADIUS = .034;
export const ACTIVITY_DIARY_SIZE = { width: .14, depth: .2 } as const;

export type ActivityFootprint =
  | { shape: "rect"; x: number; z: number; hx: number; hz: number; rotY: number }
  | { shape: "circle"; x: number; z: number; radius: number };

const sheetFootprints = (sheets: readonly { width: number; depth: number; x: number; z: number; rotY: number }[]): ActivityFootprint[] =>
  sheets.map((s) => ({ shape: "rect", x: s.x, z: s.z, hx: s.width / 2, hz: s.depth / 2, rotY: s.rotY }));

/** Complete horizontal silhouettes, including the small pen/ruler/tools.
 * Rectangles retain their rotations: a narrow diary can fit beside a lamp
 * without pretending it occupies a large enclosing disc. */
export const ACTIVITY_FOOTPRINTS = {
  writing: [...sheetFootprints(ACTIVITY_SHEETS.writing),
    { shape: "rect", x: .02, z: .01, hx: .075, hz: .006, rotY: .5 }],
  research: [{ shape: "rect", x: 0, z: 0, hx: .169, hz: .12, rotY: 0 }],
  planning: sheetFootprints(ACTIVITY_SHEETS.planning),
  making: [...sheetFootprints(ACTIVITY_SHEETS.making),
    { shape: "rect", x: 0, z: .1, hx: .1, hz: .011, rotY: .04 },
    { shape: "rect", x: .04, z: -.1, hx: .045, hz: .01, rotY: -.3 },
    { shape: "rect", x: -.04, z: -.1, hx: .025, hz: .008, rotY: .4 }],
  conversation: ACTIVITY_CUPS.map((p) => ({ shape: "circle" as const, x: p.x, z: p.z, radius: ACTIVITY_CUP_RADIUS })),
  reflection: [{ shape: "rect", x: 0, z: 0, hx: ACTIVITY_DIARY_SIZE.width / 2, hz: ACTIVITY_DIARY_SIZE.depth / 2, rotY: 0 }],
} satisfies Record<string, readonly ActivityFootprint[]>;
