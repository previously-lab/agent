/**
 * Tests for the room fixture resolver (src/lib/game/room-fixtures.ts)
 * and the prop OBB geometry it runs on (src/lib/game/prop-geometry.ts).
 * The contract under test:
 *
 *  - OBB math honours rotation and scale: a rotated bookshelf sweeps
 *    its real diamond footprint (never an unrotated AABB), and two
 *    rotated/scaled bodies intersect exactly when SAT says so.
 *  - The generic LAMP clears every physical prop OBB, the entrance,
 *    every door approach, the water, and keeps the FULL path corridor
 *    (pathHalf + the lamp's real radius + margin — never relaxed); when
 *    nothing survives it is NONE, never an illegal fallback point.
 *  - An existing floorlamp / desklamp / sconce resolves to REUSE, so
 *    space.tsx lights the real source instead of growing a second lamp.
 *  - The generic WINDOW fills the gap (authored glass spans/windows
 *    turn it to null), prefers the vertical full-height wall, keeps its
 *    frame inside the legal intervals between corners, doors, the
 *    entrance gap and other openings' frames, and yields only when no
 *    candidate wall has a legal, clear spot. Tall furniture in the
 *    window's clearance zone blocks; low furniture under the sill does
 *    not. One blocked wall must not blind the whole room.
 *  - The CLERESTORY avoids the window's and every authored opening's
 *  frames, prefers a different wall, and is null when nothing fits.
 *  - Same inputs + same rng stream ⇒ byte-identical result (A6), and
 *    the resolver never touches any stream but the one it is handed.
 */
import { describe, it, expect } from "vitest";
import {
  propObbFor,
  propObbsForPieces,
  obbCorners,
  obbsIntersect,
  obbIntersectsRect,
  BOOKSHELF_DIMENSIONS,
  BOOKSHELF_RUN_SPACING,
  PROP_DIMENSIONS,
  type PropObb,
} from "@/lib/game/prop-geometry";
import {
  resolveRoomFixtures,
  legalWindowIntervals,
  windowZoneRect,
  propBlocksWindowZone,
  planContainsObb,
  windowFrameHalf,
  windowVerticalSpan,
  clerestoryVerticalSpan,
  genericLampObbAt,
  lampBoundingRadius,
  lampCandidateClear,
  propWindowCut,
  WINDOW_CLEAR_DEPTH_RATIO,
  GENERIC_LAMP_RADIUS,
  LAMP_PATH_MARGIN_RATIO,
  type RoomFixtureInput,
  type FixtureOpenings,
} from "@/lib/game/room-fixtures";
import {
  planContains,
  distToPath,
  wallSegmentsFor,
  type Composition,
  type RoomPlan,
  type WallSegment,
} from "@/lib/game/room-plan";
import type { RoomDoorPlacement } from "@/lib/game/room-doors";
import { createRng, hashString } from "@/lib/game/seed";
import { KITS, placeKit, type StagedKitPiece } from "@/lib/game/kits";
import {
  DOOR_GAP_HALF,
  DOOR_WIDTH,
  ENTRANCE_CLEAR_RADIUS,
  ENTRANCE_DEPTH,
  CLERESTORY_DROP,
  CLERESTORY_HEIGHT,
  ROOM_WALL_THICKNESS,
  WINDOW_DOOR_CLEAR,
  WINDOW_HEIGHT,
  WINDOW_SILL_Y,
} from "@/lib/game/tuning/room";

/* ------------------------------------------------------------------ */
/* Input builders                                                      */
/* ------------------------------------------------------------------ */

function rectPlan(width: number, extent: number): RoomPlan {
  return { id: "rect", width, extent, lSide: 1, stepZ: 0, columns: [] };
}

function lPlan(width: number, extent: number, lSide: 1 | -1, stepZ: number): RoomPlan {
  return { id: "l-shape", width, extent, lSide, stepZ, columns: [] };
}

function comp(pathBendZ = 5, heroZ = 12): Composition {
  return {
    hero: { x: 0, z: heroZ },
    path: { bx: 0, bz: pathBendZ },
    pathHalf: 1.4,
    clusters: [],
  };
}

let rngSerial = 0;
function fixtureInput(overrides: Partial<RoomFixtureInput> = {}): RoomFixtureInput {
  const plan = rectPlan(12, 16);
  return {
    plan,
    comp: comp(),
    walls: wallSegmentsFor(plan, ROOM_WALL_THICKNESS),
    wallHeight: 4,
    dir: 1,
    water: null,
    doors: [],
    propScale: 1,
    wallScale: 1,
    hasClerestory: false,
    props: [],
    openings: {},
    lights: [],
    featureSources: new Set(),
    // A fresh stream per default input — determinism tests pass their own.
    rng: createRng(hashString(`fixture-test:${rngSerial++}`)),
    ...overrides,
  };
}

/** Wall indices in wallSegmentsFor's emission order for a rect plan:
 *  [0,1] entrance pair, 2 left (−x), 3 right (+x), 4 far. */
const W = { entranceL: 0, entranceR: 1, left: 2, right: 3, far: 4 };

function doorOn(wall: WallSegment, wallIndex: number, along: number): RoomDoorPlacement {
  const horizontal = wall.sizeZ <= wall.sizeX;
  return {
    index: 0,
    wall: wallIndex,
    x: horizontal ? wall.x + along : wall.x,
    z: horizontal ? wall.z : wall.z + along,
    nx: horizontal ? 0 : 1,
    nz: horizontal ? 1 : 0,
    along,
    row: 0,
  };
}

/** Run the resolver twice from identical fresh streams. */
function resolveTwice(input: Omit<RoomFixtureInput, "rng">) {
  const a = resolveRoomFixtures({ ...input, rng: createRng(hashString("twice")) });
  const b = resolveRoomFixtures({ ...input, rng: createRng(hashString("twice")) });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  return a;
}

/** The frames of the resolved fixtures must never overlap each other or
 *  an authored opening on the same wall. */
function expectFramesDisjoint(
  result: ReturnType<typeof resolveRoomFixtures>,
  walls: readonly WallSegment[],
  openings: FixtureOpenings,
) {
  const spans: { wall: number; lo: number; hi: number; what: string }[] = [];
  if (result.window) {
    spans.push({
      wall: result.window.wall,
      lo: result.window.along - result.window.width / 2,
      hi: result.window.along + result.window.width / 2,
      what: "window",
    });
  }
  if (result.clerestory) {
    spans.push({
      wall: result.clerestory.wall,
      lo: result.clerestory.along - result.clerestory.len / 2,
      hi: result.clerestory.along + result.clerestory.len / 2,
      what: "clerestory",
    });
  }
  for (const list of [
    openings.glassSpans ?? [],
    openings.windows ?? [],
    openings.clerestories ?? [],
  ]) {
    for (const o of list) {
      spans.push({ wall: o.wall, lo: o.along0, hi: o.along1, what: "authored" });
    }
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a.wall !== b.wall) continue;
      const clear =
        a.what === "clerestory" || b.what === "clerestory" ? 0.3 : 0;
      expect(
        a.hi + clear <= b.lo + 1e-9 || b.hi + clear <= a.lo + 1e-9,
        `${a.what} [${a.lo},${a.hi}] overlaps ${b.what} [${b.lo},${b.hi}] on wall ${a.wall}`,
      ).toBe(true);
    }
  }
  void walls;
}

/* ------------------------------------------------------------------ */
/* Prop OBB geometry                                                   */
/* ------------------------------------------------------------------ */

describe("prop OBBs", () => {
  it("uses the BookshelfProp's real dimensions and run spacing", () => {
    expect(BOOKSHELF_DIMENSIONS).toMatchObject({ width: 1.84, depth: 0.44, height: 2.2 });
    expect(BOOKSHELF_RUN_SPACING).toBeCloseTo(1.92, 9);
    expect(PROP_DIMENSIONS.bookshelf).toMatchObject({
      width: 1.84,
      depth: 0.44,
      height: 2.2,
    });
  });

  it("rotated + scaled OBB carries its real axes and half-extents", () => {
    const o = propObbFor({ kind: "bookshelf", x: 1, z: 2, rotY: Math.PI / 2, scale: 2 });
    // three.js convention: +x → (cos θ, −sin θ), +z → (sin θ, cos θ).
    expect(o.ux).toBeCloseTo(0, 9);
    expect(o.uz).toBeCloseTo(-1, 9);
    expect(o.vx).toBeCloseTo(1, 9);
    expect(o.vz).toBeCloseTo(0, 9);
    expect(o.hx).toBeCloseTo((1.84 * 2) / 2, 9); // width × scale / 2
    expect(o.hz).toBeCloseTo((0.44 * 2) / 2, 9); // depth × scale / 2
    expect(o.topY).toBeCloseTo(2.2 * 2, 9);
    const corners = obbCorners(o);
    // At θ=π/2 the 1.84 width runs along −z, the 0.44 depth along +x.
    expect(corners.some((c) => Math.abs(c.x - (1 + 0.44)) < 1e-9)).toBe(true);
    expect(corners.some((c) => Math.abs(c.z - (2 + 1.84)) < 1e-9)).toBe(true);
  });

  it("OBB/OBB intersection honours rotation (AABB would get it wrong)", () => {
    const shelf = propObbFor({ kind: "bookshelf", x: 0, z: 0, rotY: Math.PI / 4, scale: 1 });
    // A box parked at the shelf's empty corner: inside the shelf's AABB
    // (±0.81) but outside its OBB.
    const ghost = propObbFor({ kind: "chair", x: 0.8, z: 0.8, rotY: 0, scale: 1 });
    expect(obbsIntersect(shelf, ghost)).toBe(false);
    // Slide it onto the body: it intersects.
    const hit = propObbFor({ kind: "chair", x: 0.3, z: 0.3, rotY: 0, scale: 1 });
    expect(obbsIntersect(shelf, hit)).toBe(true);
  });

  it("OBB/rect intersection is not a degraded AABB test", () => {
    const shelf = propObbFor({ kind: "bookshelf", x: 0, z: 0, rotY: Math.PI / 4, scale: 1 });
    // (0.8, 0.8) is inside the shelf's axis-aligned bounding box…
    expect(obbIntersectsRect(shelf, { x0: 0.7, z0: 0.7, x1: 0.9, z1: 0.9 })).toBe(false);
    // …while a rect squarely on the body intersects.
    expect(obbIntersectsRect(shelf, { x0: -0.05, z0: -0.05, x1: 0.05, z1: 0.05 })).toBe(true);
  });

  it("planContainsObb tests the rotated corners, not the center", () => {
    const plan = lPlan(12, 16, 1, 8);
    // A long log straddling the l-shape's step wall: center in the kept
    // half, one corner poking into the abandoned quadrant.
    const log = propObbFor({ kind: "log", x: 0.5, z: 8.4, rotY: 0, scale: 1 });
    expect(planContains(plan, log.cx, log.cz, 0.3)).toBe(true); // center passes…
    expect(planContainsObb(plan, log, 0.3)).toBe(false); // …the body does not
    const book = propObbFor({ kind: "bookpile", x: 3, z: 12, rotY: 0.7, scale: 1 });
    expect(planContainsObb(plan, book, 0.3)).toBe(true);
  });

  it("walkable planes and tabletop dressing never block", () => {
    expect(propObbFor({ kind: "rug", x: 0, z: 0, rotY: 0, scale: 1 }).blocks).toBe(false);
    expect(propObbFor({ kind: "moss", x: 0, z: 0, rotY: 0, scale: 1 }).blocks).toBe(false);
    expect(propObbFor({ kind: "jettydeck", x: 0, z: 0, rotY: 0, scale: 1 }).blocks).toBe(false);
    expect(propObbFor({ kind: "tray", x: 0, z: 0, rotY: 0, scale: 1 }).blocks).toBe(false);
    expect(propObbFor({ kind: "bookshelf", x: 0, z: 0, rotY: 0, scale: 1 }).blocks).toBe(true);
  });

  it("every kind every kit can stage maps to an OBB", () => {
    for (const kit of KITS) {
      for (const piece of kit.pieces) {
        const o = propObbFor({ kind: piece.kind, x: 0, z: 0, rotY: piece.rotY, scale: piece.scale ?? 1 });
        expect(o.topY).toBeGreaterThan(o.baseY);
      }
    }
    expect(() => propObbFor({ kind: "nosuchkind", x: 0, z: 0, rotY: 0, scale: 1 })).toThrow();
  });
});

describe("real footprints (legacy kinds and honest sizes)", () => {
  it("the legacy pool-hall ladder maps to an OBB (integration cannot crash)", () => {
    const o = propObbFor({ kind: "ladder", x: 5, z: 9, rotY: Math.PI / 2, scale: 1 });
    expect(o.hx).toBeCloseTo(0.25, 9); // rails ±0.2 + hook reach
    // The depth is the conservative full width: the model's hooks reach
    // z ≈ 0.345 off the origin, so the OBB spans ±0.35 and covers them.
    expect(o.hz).toBeCloseTo(0.35, 9);
    const corners = obbCorners(o);
    expect(Math.max(...corners.map((c) => Math.abs(c.x - 5)))).toBeCloseTo(0.35, 9);
    expect(o.topY).toBeCloseTo(1.4, 9);
    expect(o.blocks).toBe(true);
    // propObbsForPieces is TOTAL over the final furniture mix.
    const pieces = propObbsForPieces([
      { kind: "ladder", x: 5, z: 9, rotY: Math.PI / 2, scale: 1, y: 0 },
      { kind: "lounger", x: 0, z: 12, rotY: Math.PI, scale: 1, y: 0 },
      { kind: "column", x: 4, z: 8, rotY: 0, scale: 1, y: 0 },
      { kind: "rug", x: 0, z: 6, rotY: 0.4, scale: 1.6, y: 0 },
    ]);
    expect(pieces).toHaveLength(4);
  });

  it("floorlamp/plant/bookpile footprints cover the real bodies", () => {
    // The floor lamp's footprint is its 0.72m shade, not the 0.5m base.
    const lamp = propObbFor({ kind: "floorlamp", x: 0, z: 0, rotY: 0, scale: 1 });
    expect(lamp.hx).toBeCloseTo(0.36, 9);
    expect(lamp.light).toBe(true);
    // The plant's is the leaves' ~1m reach, not the pot's.
    const plant = propObbFor({ kind: "plant", x: 0, z: 0, rotY: 0, scale: 1 });
    expect(plant.hx).toBeCloseTo(0.5, 9);
    // The bookpile's width covers the leaning book at x 0.24 (its rotZ
    // lean reaches ≈0.33).
    const pile = propObbFor({ kind: "bookpile", x: 0, z: 0, rotY: 0, scale: 1 });
    expect(pile.hx).toBeGreaterThanOrEqual(0.3);
    const corners = obbCorners(pile);
    expect(corners.every((c) => c.x <= 0.34 + 1e-9)).toBe(true);
  });

  it("towelstack stands on the floor in kits — it blocks; wallart is real wall mass", () => {
    const towels = propObbFor({ kind: "towelstack", x: 0, z: 0, rotY: 0, scale: 1 });
    expect(towels.blocks).toBe(true);
    expect(towels.baseY).toBe(0);
    const art = propObbFor({ kind: "wallart", x: 0, z: 0, rotY: 0, scale: 1 });
    expect(art.blocks).toBe(true);
    // …while the tabletop dressing stays carried by its host.
    for (const kind of ["tray", "bell", "register", "vase", "frame", "candle"] as const) {
      expect(propObbFor({ kind, x: 0, z: 0, rotY: 0, scale: 1 }).blocks).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Lamp                                                                */
/* ------------------------------------------------------------------ */

describe("the lamp", () => {
  it("places a generic lamp clear of everything, keeping the full path corridor", () => {
    const input = fixtureInput({ hasClerestory: true });
    const result = resolveTwice(input);
    expect(result.lamp.kind).toBe("generic");
    if (result.lamp.kind !== "generic") return;
    const { x, z } = result.lamp;
    // The placed spot passes the SAME OBB predicate the sampler used.
    expect(
      lampCandidateClear(
        input.plan,
        input.comp,
        input.water,
        input.doors,
        input.props,
        x,
        z,
        input.propScale,
      ),
    ).toBe(true);
    expect(distToPath(input.comp, x, z)).toBeGreaterThanOrEqual(
      input.comp.pathHalf + lampBoundingRadius(input.propScale) + LAMP_PATH_MARGIN_RATIO - 1e-9,
    );
  });

  it("lampCandidateClear rejects each violation geometry directly (no lucky rng)", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const c = comp();
    const clear = (x: number, z: number, props: PropObb[] = [], doors: readonly RoomDoorPlacement[] = [], water: RoomFixtureInput["water"] = null) =>
      lampCandidateClear(plan, c, water, doors, props, x, z, 1);
    // Deep floor, clear sides.
    expect(clear(4.5, 3)).toBe(true);
    // A staged sofa in the way.
    const sofa = propObbFor({ kind: "sofa", x: 4.5, z: 3, rotY: 0.3, scale: 1 });
    expect(clear(4.5, 3, [sofa])).toBe(false);
    // The lamp's OBB overhangs the entrance rectangle even though its
    // center is past ENTRANCE_DEPTH.
    expect(clear(0, 2.7)).toBe(false);
    // A strand door's approach strip (left-wall door at the wall's
    // mid-point, z 8): the lamp body reaching into the strip is
    // rejected…
    const door = doorOn(walls[W.left], W.left, 0);
    expect(clear(-4.5, 8, [], [door])).toBe(false);
    // …while a lamp short of the strip is fine.
    expect(clear(-2.3, 8, [], [door])).toBe(true);
    // The water plus its margin.
    const water = { cx: -3, cz: 8, halfX: 1.5, halfZ: 1.5 };
    expect(clear(-3, 8, [], [], water)).toBe(false);
    expect(clear(-3, 5.4, [], [], water)).toBe(true);
    // The path corridor keeps pathHalf + the bounding radius + margin.
    expect(clear(1.5, 4)).toBe(false); // |x| 1.5 < 1.4 + hypot(.42,.42) + .3
    expect(clear(2.6, 4)).toBe(true);
    // A rug is walkable: it never blocks.
    const rug = propObbFor({ kind: "rug", x: 4.5, z: 3, rotY: 0.2, scale: 1.2 });
    expect(clear(4.5, 3, [rug])).toBe(true);
    // A floor-standing towelstack DOES block (it lands at dy 0 in kits).
    const towels = propObbFor({ kind: "towelstack", x: 4.5, z: 3, rotY: 0, scale: 1 });
    expect(towels.blocks).toBe(true);
    expect(clear(4.5, 3, [towels])).toBe(false);
    // …while tabletop dressing on the counter is carried by the host.
    const tray = propObbFor({ kind: "tray", x: 4.5, z: 3, rotY: 0, scale: 1, baseY: 0.96 });
    expect(tray.blocks).toBe(false);
  });

  it("genericLampObbAt carries the real shade radius and scales", () => {
    const obb = genericLampObbAt(1, 2, 1.5);
    expect(obb.hx).toBeCloseTo(GENERIC_LAMP_RADIUS * 1.5, 9);
    expect(obb.hz).toBeCloseTo(GENERIC_LAMP_RADIUS * 1.5, 9);
    expect(obb.topY).toBeGreaterThan(2);
    expect(lampBoundingRadius(1.5)).toBeCloseTo(
      Math.hypot(GENERIC_LAMP_RADIUS * 1.5, GENERIC_LAMP_RADIUS * 1.5),
      9,
    );
  });

  it("fails to NONE (never an illegal fallback) when props cover the room", () => {
    // A sofa scaled past every wall: width 30m × depth 14.7m swallows
    // the whole 12×16 floor — every candidate intersects it.
    const input = fixtureInput({
      props: [propObbFor({ kind: "sofa", x: 0, z: 8, rotY: 0, scale: 14 })],
    });
    const result = resolveTwice(input);
    expect(result.lamp).toEqual({ kind: "none" });
  });

  it("fails to NONE when only the entrance strip and path corridor remain", () => {
    // A centre slab past the doorway plus two flank slabs covering the
    // path corridor's sides: any candidate inside the plan either hits a
    // slab, the entrance strip, or the path corridor. The old builder's
    // midpoint fallback landed here; the resolver must return none.
    const input = fixtureInput({
      props: [
        propObbFor({ kind: "sofa", x: 0, z: 9.6, rotY: 0, scale: 8 }),
        propObbFor({ kind: "sofa", x: -3.4, z: 2.9, rotY: 0, scale: 4.4 }),
        propObbFor({ kind: "sofa", x: 3.4, z: 2.9, rotY: 0, scale: 4.4 }),
      ],
    });
    const result = resolveTwice(input);
    expect(result.lamp).toEqual({ kind: "none" });
  });

  it("stays out of the water and the door approaches", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const doors = [doorOn(walls[W.far], W.far, 0)];
    const input = fixtureInput({
      plan,
      walls,
      doors,
      // A basin covering everything past the plan margin: no dry legal
      // spot survives.
      water: { cx: 0, cz: 9, halfX: 5.2, halfZ: 7.3 },
    });
    const result = resolveTwice(input);
    expect(result.lamp).toEqual({ kind: "none" });
  });

  it("reuses an existing floorlamp, desk lamp, or sconce (floorlamp wins)", () => {
    const base = fixtureInput({ hasClerestory: true });
    const mk = (lights: RoomFixtureInput["lights"]) =>
      resolveTwice({ ...base, lights });
    const floor = mk([{ kind: "floorlamp", x: 2, z: 3, y: 0, scale: 1 }]);
    expect(floor.lamp).toEqual({ kind: "reuse", source: "floorlamp", x: 2, z: 3, y: 0, scale: 1 });
    const desk = mk([{ kind: "desklamp", x: -1, z: 4, y: 0.8, scale: 1 }]);
    expect(desk.lamp).toEqual({ kind: "reuse", source: "desklamp", x: -1, z: 4, y: 0.8, scale: 1 });
    const sconce = mk([{ kind: "sconce", x: -5.7, z: 8, y: 2.6, scale: 1 }]);
    expect(sconce.lamp).toEqual({ kind: "reuse", source: "sconce", x: -5.7, z: 8, y: 2.6, scale: 1 });
    const both = mk([
      { kind: "sconce", x: -5.7, z: 8, y: 2.6, scale: 1 },
      { kind: "floorlamp", x: 2, z: 3, y: 0, scale: 1 },
    ]);
    expect(both.lamp.kind).toBe("reuse");
    if (both.lamp.kind === "reuse") expect(both.lamp.source).toBe("floorlamp");
  });

  it("a reused desk lamp riding a desk keeps its real base height", () => {
    const input = fixtureInput({
      lights: [{ kind: "desklamp", x: 1, z: 6, y: 0.8, scale: 1 }],
    });
    const result = resolveTwice(input);
    expect(result.lamp).toEqual({ kind: "reuse", source: "desklamp", x: 1, z: 6, y: 0.8, scale: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

describe("the window", () => {
  it("fills the gap: an authored glass span or window turns it to null", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    for (const openings of [
      { glassSpans: [{ wall: W.far, along0: -2, along1: 2 }] },
      { windows: [{ wall: W.left, along0: -1.5, along1: 1.5 }] },
    ] as FixtureOpenings[]) {
      const result = resolveTwice(fixtureInput({ plan, walls, openings }));
      expect(result.window).toBeNull();
    }
  });

  it("prefers the vertical full-height wall and reports the render fields", () => {
    const input = fixtureInput({ hasClerestory: true });
    const result = resolveTwice(input);
    expect(result.window).not.toBeNull();
    if (!result.window) return;
    const wall = input.walls[result.window.wall];
    expect(result.window.wall).toBe(W.left);
    expect(wall.entrance).toBe(false);
    expect(wall.sizeZ > wall.sizeX).toBe(true); // vertical
    expect(result.window.nx).toBe(1); // probed inward, off the −x wall
    expect(result.window.nz).toBe(0);
    expect(result.window.drawnHeight).toBe(4);
    expect(result.window.width).toBeCloseTo(2.4 + 0.3, 9);
    // The glass's real vertical span rides the resolution (sill..sill+
    // glass height) — the shelf wall cuts around exactly this band.
    expect(result.window.bottom).toBeCloseTo(WINDOW_SILL_Y, 9);
    expect(result.window.top).toBeCloseTo(WINDOW_SILL_Y + WINDOW_HEIGHT, 9);
    expectFramesDisjoint(result, input.walls, input.openings);
  });

  it("never stacks on a feature wall", () => {
    const input = fixtureInput({ featureSources: new Set([W.left]) });
    const result = resolveTwice(input);
    expect(result.window).not.toBeNull();
    if (!result.window) return;
    expect(result.window.wall).not.toBe(W.left);
    expect(input.walls[result.window.wall].entrance).toBe(false);
  });

  it("tall furniture in the clearance zone blocks the wall; the room falls to another wall", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    // A bookshelf run flush along the ENTIRE left wall's legal window
    // span: bodies 1.84 wide packed edge to edge from z −8.3 to 14.5.
    const props: PropObb[] = [];
    for (let z = -7.36; z <= 14.5; z += 1.84) {
      props.push(propObbFor({ kind: "bookshelf", x: -5.55, z, rotY: Math.PI / 2, scale: 1 }));
    }
    const result = resolveTwice(fixtureInput({ plan, walls, props }));
    expect(result.window).not.toBeNull(); // the far wall takes it…
    if (!result.window) return;
    expect(result.window.wall).toBe(W.far);
    expect(input_walls_horizontal(walls[result.window.wall])).toBe(true);
  });

  it("low furniture under the sill does not block; tall furniture does", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const half = windowFrameHalf(1);
    const zone = windowZoneRect(plan, walls[W.left], 0, half, WINDOW_CLEAR_DEPTH_RATIO);
    const bottom = WINDOW_SILL_Y;
    const top = WINDOW_SILL_Y + WINDOW_HEIGHT;
    // A bench (top 0.82) may stand under the window…
    const bench = propObbFor({ kind: "bench", x: -5.5, z: 8, rotY: Math.PI / 2, scale: 1 });
    expect(bench.topY).toBeLessThan(bottom);
    expect(propBlocksWindowZone([bench], zone, bottom, top)).toBe(false);
    // …a bookshelf (top 2.2) may not.
    const shelf = propObbFor({ kind: "bookshelf", x: -5.5, z: 8, rotY: Math.PI / 2, scale: 1 });
    expect(propBlocksWindowZone([shelf], zone, bottom, top)).toBe(true);
    // …and neither may a hung wallart whose band crosses the glass (its
    // body rides the wall's inner face).
    const art = propObbFor({ kind: "wallart", x: -5.6, z: 8, rotY: Math.PI / 2, scale: 1, baseY: 1.5 });
    expect(propBlocksWindowZone([art], zone, bottom, top)).toBe(true);
    // A rug never blocks, whoever stands on it.
    const rug = propObbFor({ kind: "rug", x: -5.5, z: 8, rotY: 0, scale: 3 });
    expect(propBlocksWindowZone([rug], zone, bottom, top)).toBe(false);
  });

  it("blocking one wall's middle does not blind the room — the window shifts along the wall", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const props = [propObbFor({ kind: "bookshelf", x: -5.55, z: 2, rotY: Math.PI / 2, scale: 1 })];
    const clear = resolveTwice(fixtureInput({ plan, walls, props: [] }));
    const blocked = resolveTwice(fixtureInput({ plan, walls, props }));
    expect(clear.window?.wall).toBe(W.left);
    expect(blocked.window).not.toBeNull();
    if (!blocked.window) return;
    // Still the preferred wall — but at a spot whose clearance zone the
    // bookshelf does not intersect.
    expect(blocked.window.wall).toBe(W.left);
    const zone = windowZoneRect(
      plan,
      walls[blocked.window.wall],
      blocked.window.along,
      windowFrameHalf(1),
      WINDOW_CLEAR_DEPTH_RATIO,
    );
    expect(propBlocksWindowZone(props, zone, WINDOW_SILL_Y, WINDOW_SILL_Y + WINDOW_HEIGHT)).toBe(false);
  });

  it("keeps the frame clear of strand doors on the same wall", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const doors = [doorOn(walls[W.left], W.left, 3)];
    const input = fixtureInput({ plan, walls, doors });
    const result = resolveTwice(input);
    expect(result.window?.wall).toBe(W.left);
    if (!result.window) return;
    const doorClear = windowFrameHalf(1) + DOOR_WIDTH / 2 + WINDOW_DOOR_CLEAR;
    expect(Math.abs(result.window.along - 3)).toBeGreaterThanOrEqual(doorClear - 1e-6);
    expectFramesDisjoint(result, walls, input.openings);
  });

  it("two doors can close a wall entirely — the window takes another wall", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const doors = [doorOn(walls[W.left], W.left, -3), doorOn(walls[W.left], W.left, 3)];
    const result = resolveTwice(fixtureInput({ plan, walls, doors }));
    expect(result.window).not.toBeNull();
    if (!result.window) return;
    expect(result.window.wall).toBe(W.far);
  });

  it("a small room with doors everywhere gets NO window (no forced center)", () => {
    const plan = rectPlan(6, 8);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const doors = [
      doorOn(walls[W.left], W.left, 0),
      doorOn(walls[W.right], W.right, 0),
      doorOn(walls[W.far], W.far, 0),
    ];
    const result = resolveTwice(fixtureInput({ plan, walls, doors }));
    expect(result.window).toBeNull();
  });

  it("an entrance-hosted window guards the WORLD doorway axis (x = 0), not the flank's middle", () => {
    // 14 × 3.5: the vertical walls (3.5m) cannot hold the frame and the
    // far wall is a feature host — only the entrance flanks remain. Each
    // flank's local along-0 is NOT the doorway: the cut must center on
    // along = −wall.x. The old code cut around the flank's middle, found
    // nothing, and the room lost its window entirely.
    const plan = rectPlan(14, 3.5);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const input = fixtureInput({ plan, walls, featureSources: new Set([W.far]) });
    const result = resolveTwice(input);
    expect(result.window).not.toBeNull();
    if (!result.window) return;
    const wall = walls[result.window.wall];
    expect(wall.entrance).toBe(true);
    const worldX = (wall.sizeZ <= wall.sizeX ? wall.x : wall.z) + result.window.along;
    expect(Math.abs(worldX)).toBeGreaterThanOrEqual(DOOR_GAP_HALF + 0.6 - 1e-6);
    // The frame itself keeps clear of the doorway gap.
    expect(Math.abs(worldX) - result.window.width / 2).toBeGreaterThanOrEqual(
      DOOR_GAP_HALF - 1e-6,
    );
  });

  it("windowVerticalSpan matches RoomWindow's formula numerically", () => {
    // Expectations computed from space.tsx's RoomWindow lines verbatim
    // (h = min(WINDOW_HEIGHT·ws, max(0.6, drawn − 0.4)); sill = min(
    // WINDOW_SILL_Y·ws, max(0.15, drawn − h − 0.15)); top = sill + h).
    const via = (drawn: number, ws: number) => {
      const h = Math.min(WINDOW_HEIGHT * ws, Math.max(0.6, drawn - 0.4));
      const bottom = Math.min(WINDOW_SILL_Y * ws, Math.max(0.15, drawn - h - 0.15));
      return { bottom, top: bottom + h };
    };
    for (const [drawn, ws] of [
      [4, 1],
      [1.2, 1],
      [4, 1.5],
      [0.9, 1],
    ] as const) {
      expect(windowVerticalSpan(drawn, ws)).toEqual(via(drawn, ws));
    }
    // The headline numbers: a normal 4m wall…
    expect(windowVerticalSpan(4, 1)).toEqual({ bottom: 1, top: 2.9 });
    // …a low cutaway sill…
    const low = windowVerticalSpan(1.2, 1);
    expect(low.bottom).toBeCloseTo(0.25, 12);
    expect(low.top).toBeCloseTo(1.05, 12);
    // …and a scaled wall.
    const scaled = windowVerticalSpan(4, 1.5);
    expect(scaled.bottom).toBeCloseTo(1, 12);
    expect(scaled.top).toBeCloseTo(3.85, 12);
  });

  it("propWindowCut projects the OBB and only tall, in-depth props cut", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const wall = walls[W.left]; // center (x −5.85, z 8); along = z − 8
    const half = windowFrameHalf(1);
    const depth = WINDOW_CLEAR_DEPTH_RATIO;
    const { bottom, top } = windowVerticalSpan(4, 1);
    // A flush bookshelf at world z 10 (along +2) cuts exactly its
    // tangent projection ± the frame half.
    const shelf = propObbFor({ kind: "bookshelf", x: -5.55, z: 10, rotY: Math.PI / 2, scale: 1 });
    const cut = propWindowCut(plan, wall, shelf, half, depth, bottom, top);
    expect(cut).not.toBeNull();
    expect(cut![0]).toBeCloseTo(2 - 0.92 - half, 6);
    expect(cut![1]).toBeCloseTo(2 + 0.92 + half, 6);
    // A bench under the sill: no vertical intersection → no cut.
    const bench = propObbFor({ kind: "bench", x: -5.5, z: 10, rotY: Math.PI / 2, scale: 1 });
    expect(propWindowCut(plan, wall, bench, half, depth, bottom, top)).toBeNull();
    // A prop standing deeper than the clearance reach: no cut.
    const deep = propObbFor({ kind: "bookshelf", x: -3, z: 10, rotY: Math.PI / 2, scale: 1 });
    expect(propWindowCut(plan, wall, deep, half, depth, bottom, top)).toBeNull();
    // A rug never cuts.
    const rug = propObbFor({ kind: "rug", x: -5.5, z: 10, rotY: 0, scale: 2 });
    expect(propWindowCut(plan, wall, rug, half, depth, bottom, top)).toBeNull();
    // A hung wallart crossing the glass DOES cut.
    const art = propObbFor({ kind: "wallart", x: -5.6, z: 10, rotY: Math.PI / 2, scale: 1, baseY: 1.5 });
    expect(propWindowCut(plan, wall, art, half, depth, bottom, top)).not.toBeNull();
  });

  it("deterministic subtraction: local tall furniture leaves the rest of the wall open", () => {
    // One bookshelf at the window's favorite spot (z 8): the surviving
    // intervals guarantee a clear pick — no luck involved.
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const props = [propObbFor({ kind: "bookshelf", x: -5.55, z: 8, rotY: Math.PI / 2, scale: 1 })];
    const result = resolveTwice(fixtureInput({ plan, walls, props }));
    expect(result.window?.wall).toBe(W.left);
    if (!result.window) return;
    const zone = windowZoneRect(
      plan,
      walls[W.left],
      result.window.along,
      windowFrameHalf(1),
      WINDOW_CLEAR_DEPTH_RATIO,
    );
    expect(
      propBlocksWindowZone(props, zone, result.window.bottom, result.window.top),
    ).toBe(false);
  });

  it("deterministic subtraction: a fully covered room gets NO window", () => {
    const plan = rectPlan(6, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    // Every legal spot on every host wall is swallowed by tall furniture.
    const props: PropObb[] = [];
    for (let z = -7.36; z <= 14.5; z += 1.84) {
      props.push(propObbFor({ kind: "bookshelf", x: -2.55, z, rotY: Math.PI / 2, scale: 1 }));
    }
    for (let x = -2.7; x <= 2.71; x += 1.8) {
      props.push(propObbFor({ kind: "sideboard", x, z: 15.4, rotY: 0, scale: 1 }));
    }
    const result = resolveTwice(fixtureInput({ plan, walls, props }));
    expect(result.window).toBeNull();
  });

  it("resolves legally on l-shape (both sides) and colonnade plans", () => {
    for (const plan of [
      lPlan(12, 16, 1, 8),
      lPlan(12, 16, -1, 8),
      {
        id: "colonnade" as const,
        width: 12,
        extent: 16,
        lSide: 1 as const,
        stepZ: 0,
        columns: [
          { x: -6, z: 4 },
          { x: 6, z: 4 },
        ],
      },
    ]) {
      const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
      const input = fixtureInput({ plan, walls, hasClerestory: true });
      const result = resolveTwice(input);
      if (result.window) {
        const wall = walls[result.window.wall];
        expect(wall.entrance).toBe(false);
        const intervals = legalWindowIntervals(
          wall,
          result.window.wall,
          windowFrameHalf(1),
          input.doors,
          input.openings,
        );
        expect(
          intervals.some(
            ([lo, hi]) =>
              result.window!.along >= lo - 1e-6 && result.window!.along <= hi + 1e-6,
          ),
        ).toBe(true);
      }
      expectFramesDisjoint(result, walls, input.openings);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Clerestory                                                          */
/* ------------------------------------------------------------------ */

describe("the clerestory", () => {
  it("takes a different wall than the window and spans the run minus pads", () => {
    const input = fixtureInput({ hasClerestory: true });
    const result = resolveTwice(input);
    expect(result.window?.wall).toBe(W.left);
    expect(result.clerestory?.wall).toBe(W.far);
    expect(result.clerestory?.along).toBeCloseTo(0, 6);
    // Far run = width + 2·thick (12.6), minus the end pads.
    expect(result.clerestory?.len).toBeCloseTo(12.6 - 2 * 0.8, 6);
    expectFramesDisjoint(result, input.walls, input.openings);
  });

  it("stays off when hasClerestory is false", () => {
    const result = resolveTwice(fixtureInput({ hasClerestory: false }));
    expect(result.clerestory).toBeNull();
  });

  it("avoids the window's frame when the window nulls and glass owns the far wall", () => {
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const openings: FixtureOpenings = {
      glassSpans: [{ wall: W.far, along0: -2, along1: 2 }],
    };
    const input = fixtureInput({ plan, walls, openings, hasClerestory: true });
    const result = resolveTwice(input);
    expect(result.window).toBeNull(); // the glass span IS the window
    // The far wall's band is holed by the span's frame; the clerestory
    // moves to the left wall instead.
    expect(result.clerestory?.wall).toBe(W.left);
    expectFramesDisjoint(result, walls, openings);
  });

  it("yields null when every wall is too short for a window or a band", () => {
    // 4.6 × 5 at wallScale 1.5: the window frame (half 1.95 + pad 1)
    // needs a 5.9m run no wall has; the clerestory needs 5.85m.
    const plan = rectPlan(4.6, 5);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const input = fixtureInput({
      plan,
      walls,
      wallScale: 1.5,
      hasClerestory: true,
    });
    const result = resolveTwice(input);
    expect(result.window).toBeNull();
    expect(result.clerestory).toBeNull();
  });

  it("excludes feature walls — and falls back to the window's own wall rather than null", () => {
    // The far wall hosts a niche; it cannot take the band. The ONLY
    // remaining full-height wall is the window's own — the band still
    // lands there, its interval cut clear of the window's frame.
    const plan = rectPlan(12, 16);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const input = fixtureInput({
      plan,
      walls,
      hasClerestory: true,
      featureSources: new Set([W.far]),
    });
    const result = resolveTwice(input);
    expect(result.window?.wall).toBe(W.left);
    expect(result.clerestory?.wall).toBe(W.left);
    expect(result.clerestory?.bottom).toBeCloseTo(2.5, 9);
    expect(result.clerestory?.top).toBeCloseTo(3.55, 9);
    expectFramesDisjoint(result, walls, input.openings);
  });

  it("l-shape: every other full-height wall is a feature — the band takes the window's wall", () => {
    // Walls: 0/1 entrance, 2 left-near, 3 right-near (camera-facing),
    // 4 step, 5 inner, 6 outer, 7 far. Everything but the left-near
    // wall is a feature host, so the clerestory must fall back to the
    // window's own wall — wherever the window landed.
    const plan = lPlan(12, 20, 1, 10);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const input = fixtureInput({
      plan,
      walls,
      hasClerestory: true,
      featureSources: new Set([4, 5, 6, 7]),
    });
    const result = resolveTwice(input);
    expect(result.window).not.toBeNull();
    expect(result.clerestory?.wall).toBe(2);
    expectFramesDisjoint(result, walls, input.openings);
  });

  it("clerestoryVerticalSpan matches RoomClerestory's formula numerically", () => {
    // Expectations from space.tsx's RoomClerestory lines verbatim
    // (bandH = min(CLERESTORY_HEIGHT·ws, max(0.4, drawn·0.5)); bandY =
    // max(bandH/2 + 0.1, drawn − CLERESTORY_DROP·ws − bandH/2)).
    const via = (drawn: number, ws: number) => {
      const bandH = Math.min(CLERESTORY_HEIGHT * ws, Math.max(0.4, drawn * 0.5));
      const bandY = Math.max(bandH / 2 + 0.1, drawn - CLERESTORY_DROP * ws - bandH / 2);
      return { bottom: bandY - bandH / 2, top: bandY + bandH / 2 };
    };
    for (const [drawn, ws] of [
      [4, 1],
      [1.2, 1],
      [4, 1.5],
      [0.8, 1],
    ] as const) {
      expect(clerestoryVerticalSpan(drawn, ws)).toEqual(via(drawn, ws));
    }
    expect(clerestoryVerticalSpan(4, 1)).toEqual({ bottom: 2.5, top: 3.55 });
    const low = clerestoryVerticalSpan(1.2, 1);
    expect(low.bottom).toBeCloseTo(0.15, 12);
    expect(low.top).toBeCloseTo(0.75, 12);
    const scaled = clerestoryVerticalSpan(4, 1.5);
    expect(scaled.bottom).toBeCloseTo(1.75, 12);
    expect(scaled.top).toBeCloseTo(3.325, 12);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

describe("determinism (A6)", () => {
  it("same inputs + same stream ⇒ byte-identical result, across plans", () => {
    for (const plan of [
      rectPlan(12, 16),
      lPlan(12, 16, 1, 8),
      lPlan(12, 16, -1, 8),
    ]) {
      const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
      const props = propObbsForPieces([
        { kind: "bookshelf", x: -5.55, z: 2, rotY: Math.PI / 2, scale: 1, y: 0 },
        { kind: "bench", x: 5.4, z: 10, rotY: -Math.PI / 2, scale: 1, y: 0 },
      ]);
      const base = {
        plan,
        walls,
        comp: comp(),
        wallHeight: 4,
        dir: 1 as const,
        water: null,
        doors: [doorOn(walls[W.far], W.far, 1.5)],
        propScale: 1,
        wallScale: 1,
        hasClerestory: true,
        props,
        openings: {},
        lights: [],
        featureSources: new Set<number>(),
      };
      const a = resolveRoomFixtures({ ...base, rng: createRng(hashString("same")) });
      const b = resolveRoomFixtures({ ...base, rng: createRng(hashString("same")) });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expectFramesDisjoint(a, walls, {});
    }
  });
});

function input_walls_horizontal(wall: WallSegment): boolean {
  return wall.sizeZ <= wall.sizeX;
}

describe("clerestory furniture clearance", () => {
  it("does not draw a high band through furniture that fills its wall span", () => {
    const plan = rectPlan(12, 16);
    const wall = wallSegmentsFor(plan, ROOM_WALL_THICKNESS)[W.far];
    const input = fixtureInput({
      plan, walls: [wall], hasClerestory: true,
      // Suppress a second generic window using an authored opening on a
      // different wall; the far wall remains eligible for the band.
      openings: { windows: [{ wall: 99, along0: -1, along1: 1 }] },
      props: [propObbFor({ kind: "bookshelf", x: 0, z: 15.6, rotY: 0, scale: 10 })],
    });
    expect(resolveRoomFixtures(input).clerestory).toBeNull();
  });
});
