"use client";

/**
 * SpaceScene — the deterministic renderer for the space behind a door.
 *
 * A corridor door opens outward onto a RECTANGULAR floor plan: for a north
 * door (door.z > 0) the space occupies z from +CORRIDOR_WIDTH/2 to
 * +CORRIDOR_WIDTH/2 + size.extent; for a south door it is mirrored to
 * negative z. The plan is centered on door.x and spans x ∈ [−width/2,
 * width/2], where `width` is seeded per recipe (0.66 / 1 / 1.5 × extent).
 *
 * Every space is an ENCLOSED ROOM — 4m perimeter walls (same height as the
 * corridor) run along all four edges, with a 2.4m doorway gap centered on
 * the entrance (local x = 0, z = 0) plus one doorway per STRAND passing
 * through the slice (v0.11 §B.8: `roomDoors` prop, placed on solid walls
 * by lib/game/room-doors.ts — composed like the doors of a home, clustered
 * and uneven, never on the entrance wall). Walls are fully opaque; the
 * interior stays visible from the fixed top-down camera via a dollhouse
 * cutaway — the walls whose outward face looks toward the camera are drawn
 * at WALL_SILL_HEIGHT (wallFacesCamera, lib/game/room-doors.ts). A clear strip at the
 * doorway (terrain flattened, no props near the door axis) means the
 * player can always walk in.
 *
 * v2 taxonomy — the recipe's worldClass picks the content family:
 *   - nature:   biomes (meadow/plains/pool/forest + ocean/lake/beach/
 *               snowfield) with trees, rocks, water, and biome motif props
 *   - interior: hotel-room / pool-hall / library / ballroom — flat floor,
 *               furnished by KITS (lib/game/kits.ts): composed, wall-
 *               anchored groupings that face the path/door/hero, staged
 *               area-densely with a hard empty-floor budget; the pool hall
 *               keeps its water-anchored fixtures; no vegetation
 *   - hybrid:   a nature biome dressed with hotel furniture that does not
 *               belong (a bed on the grass, a TV in the forest)
 *   - wonder:   ducks (a pool full of bobbing rubber ducks), cats, dogs,
 *               balloons — cute low-poly animals with seeded wander paths
 * Large (L/XL) plans of any class may grow an internal structure: a
 * partition wall with a door gap, or a column grid.
 *
 * ROOM LANGUAGE (v0.11 §3). Three seeded facets from lib/game/room-plan.ts
 * shape every space before any content is placed:
 *   - scale:  normal / colossal (×2.5–3.5) / miniature (×0.2–0.35), applied
 *             at CONSTRUCTION time — every plan dim and prop size is
 *             multiplied by the factor, so terrain, water, and the
 *             movement clamps stay in one coordinate system. The doorway
 *             (gap, slab, trim, glow) is always human-scale (axiom A4).
 *   - plan:   rect / l-shape / colonnade silhouettes; the entrance wall
 *             and its doorway are structurally identical on every plan.
 *   - composition: one hero element in the far third, a cleared walk path
 *             from the door to the hero, and clustered (not uniform)
 *             scatter around seeded centers.
 *
 * LAYOUT TEMPLATES (v0.11-room-interiors §7). Interior rooms may resolve a
 * pre-authored layout template (lib/game/room-templates.ts) from the slice,
 * its UNSCALED tier, and the real strand-door count (capacity measured on
 * each candidate's declared footprint — Finding A). The template only
 * DECLARES: its footprint feeds roomPlanFor, its permitted wall roles feed
 * placeRoomDoors, its content zones feed stageInteriorKits — the pure
 * modules keep owning all geometry, and an untemplated room passes
 * `undefined` everywhere, behaving byte-for-byte as before. The template's
 * declared feature slots (niche / pilaster-rhythm / floor-inlay) are built
 * HERE, after the door split, as opaque architecture lit only by the
 * room's own fixtures (buildRoomFeatures — never on cutaway sills, never
 * across a doorway or a strand-door approach, never fighting the parquet).
 *
 * Everything rendered here is a pure function of the resolved recipe plus
 * the door position — rebuilding a space from the same recipe yields the
 * identical scene. Layout (positions, counts, waypoints, phases) is seed-
 * deterministic; only visual motion (bobbing, sway, snowfall, wandering)
 * reads the clock. Scene fog and background are owned by the integrator's
 * canvas; the room's own lights live HERE, on their fixtures (B.13
 * 「摄影棚论」: motivated light — the lamp's point light, the window's
 * spot, the skylight's column — while the canvas's directional sun drops
 * to a fill in interior rooms).
 *
 * Terrain heights come from src/lib/game/terrain.ts — the single shared
 * heightfield the avatar physics also snaps to. This file never re-derives
 * height math; it only consumes terrainHeight/waterRectFor.
 *
 * Local frame: the root group sits at (door.x, 0, door.z) — i.e. ON the
 * corridor wall at the door — and is rotated π about Y for south doors, so
 * inside the group +z always points OUTWARD from the corridor wall and x is
 * centered on the door axis. The floor plan occupies local z ∈ [0, extent]:
 * the doorway edge is z = 0 (flush with the wall line). Nothing may cross
 * into z < 0 — that is corridor floor, coplanar at y = 0 — so the ground is
 * lifted to y = 0.02 and every placement is kept inside the plan.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MutableRefObject,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { WALL_HEIGHT, type DoorRef } from "@/lib/game/hotel";
import { PLATE_BG, PLATE_INK } from "@/lib/game/tuning/hotel";
import { GAME_DEBUG } from "./debug";
import { smoothstep } from "@/lib/game/math";
import { createRng, deriveSubSeed, hashString, WORLD_SEED } from "@/lib/game/seed";
import { doorGlowColor } from "@/lib/game/space-recipe";
import {
  GROUND_Y,
  terrainHeight,
  waterRectFor,
  type WaterRect,
} from "@/lib/game/terrain";
import {
  ARCHETYPES,
  type ArchetypeId,
  type SpaceRecipe,
} from "@/lib/game/space-types";
import {
  composeRoom,
  distToPath,
  planContains,
  roomPlanFor,
  scaledRecipeFor,
  scaledWallHeight,
  wallRoleFor,
  wallSegmentsFor,
  type Composition,
  type RoomPlan,
  type WallSegment,
} from "@/lib/game/room-plan";
import {
  doorAffordanceFor,
  resolveRoomTemplate,
  templatePlanFor,
  templateZonesFor,
  type RoomTemplate,
} from "@/lib/game/room-templates";
import type { SplitWall } from "@/lib/game/room-doors";
import {
  crossedRoomDoor,
  doorCapacityFor,
  hostableWallsFor,
  inDoorApproach,
  placeRoomDoors,
  plaqueLabelFor,
  splitWallsForDoors,
  wallFacesCamera,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import {
  createSurfaceMaterial,
  createWaterSurfaceMaterial,
  sharedRadialGlowTexture,
  sharedWallWashTexture,
} from "@/lib/game/materials";
import {
  SUN_SHADOW_BIAS,
  SUN_SHADOW_NORMAL_BIAS,
  SUN_OFFSET,
} from "@/lib/game/tuning/render";
import {
  planArea,
  stageInteriorKits,
  type StagedKitPiece,
} from "@/lib/game/kits";
import {
  BALLOON_BUNCHES,
  BALLOON_COLORS,
  COLONNADE_BAY,
  CONCRETE_NORMAL_SCALE,
  CREATURE_SCALE_EXP,
  DADO_BASE_HEIGHT,
  DADO_BASE_PROJECT,
  DADO_FULL_MARGIN,
  DADO_PANEL_MAX,
  DADO_PANEL_SPAN,
  DADO_RAIL_HEIGHT,
  DADO_RAIL_PROJECT,
  DADO_STILE_PROJECT,
  DADO_STILE_WIDTH,
  DADO_TOP,
  DOOR_GAP_HALF,
  DOOR_GLOW_INTENSITY,
  DOOR_HALO_OPACITY,
  DOOR_HEIGHT,
  DOOR_OPEN_ANGLE,
  DOOR_OPEN_DIST,
  DOOR_SEAM_INTENSITY,
  DOOR_SWING_RATE,
  DOOR_TRIM_COLOR,
  DOOR_WIDTH,
  DUCK_COUNT,
  ENTRANCE_CLEAR_RADIUS,
  ENTRANCE_DEPTH,
  GROUND_SEGMENTS,
  GROUND_SEGMENTS_MAX,
  HERO_CLEAR,
  HERO_SCALE,
  INLAY_BAND_WIDTH,
  INLAY_LIFT,
  INLAY_MIN_SPAN,
  LAMP_BULB_EMISSIVE,
  LAMP_BULB_Y,
  LAMP_COLOR,
  LAMP_LIGHT_DISTANCE,
  LAMP_LIGHT_INTENSITY,
  LAMP_POOL_OPACITY,
  LAMP_POOL_RADIUS,
  LAMP_POLE_HEIGHT,
  LAMP_SHADE_EMISSIVE,
  LAMP_SHADE_Y,
  LONE_PROB,
  NICHE_DOOR_CLEAR,
  NICHE_HEIGHT,
  NICHE_MAX_DEPTH,
  NICHE_PEDESTAL_FILL,
  NICHE_PEDESTAL_HEIGHT,
  NICHE_WIDTH,
  PARQUET_CELL,
  PARQUET_TONE_LIFT,
  PET_COUNT,
  PET_NEAR_RADIUS_MAX,
  PILASTER_CAP_HEIGHT,
  PILASTER_END_PAD,
  PILASTER_MIN_RUN,
  PILASTER_MIN_STRIP,
  PILASTER_PROJECT,
  PILASTER_SPAN,
  PILASTER_WIDTH,
  PORTAL_HEIGHT,
  PROP_COUNT,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  PROP_SCALE_EXP,
  ROCK_DIVISOR,
  ROCK_MIN,
  ROOM_DOOR_CLEAR_DEPTH,
  ROOM_DOOR_CLEAR_HALF,
  ROOM_WALL_THICKNESS,
  SKIRT_OVERHANG,
  SKIRT_OVERHANG_MIN,
  SKIRT_Y,
  SKYLIGHT_HALF,
  SKYLIGHT_LIFT,
  SKYLIGHT_PANE_EMISSIVE,
  SKYLIGHT_POOL_OPACITY,
  SKYLIGHT_POOL_RADIUS,
  SKYLIGHT_SHAFT_OPACITY,
  SKYLIGHT_SPOT_ANGLE,
  SKYLIGHT_SPOT_INTENSITY,
  SKYLIGHT_SPOT_PENUMBRA,
  SNOW_COUNT_MAX,
  SPACE_FADE_S,
  STRUCTURE_MIN_EXTENT,
  TILE_NORMAL_SCALE,
  TREE_DIVISOR,
  TREE_MIN,
  WALL_CLEARANCE,
  WALL_SILL_HEIGHT,
  WATER_Y,
  WINDOW_DOOR_CLEAR,
  WINDOW_HEIGHT,
  WINDOW_PANE_EMISSIVE,
  WINDOW_SILL_Y,
  WINDOW_SPILL_LENGTH,
  WINDOW_SPILL_OPACITY,
  WINDOW_SPOT_ANGLE,
  WINDOW_SPOT_INTENSITY,
  WINDOW_SPOT_PENUMBRA,
  WINDOW_SPOT_SHADOW_FAR,
  WINDOW_SPOT_SHADOW_MAP,
  WINDOW_SPOT_SHADOW_NEAR,
  WINDOW_WIDTH,
} from "@/lib/game/tuning/room";

/**
 * dado-band (v0.11-room-interiors §3.2): a baseboard plus a panelled
 * wainscot band along the INNER face of one perimeter wall segment — a
 * geometric feature, not a texture, and fully opaque (hard requirement
 * #5). The band breaks at the doorway for free: the entrance wall is
 * already two segments split around the 2.4m gap. It follows the
 * cutaway: every part is derived from the wall's DRAWN height, so a
 * camera-side sill keeps only what fits under its top (the baseboard
 * always; the rail and panel stiles only when the full dado clears the
 * top by DADO_FULL_MARGIN — a band running past a short wall is a bug).
 * Heights ride the wall scale ratio, so a colossal room gets a colossal
 * dado and a miniature room a dollhouse one.
 */
function DadoBand({
  wall,
  height,
  plan,
  wallScale,
  trimColor,
  panelColor,
}: {
  wall: WallSegment;
  height: number;
  plan: RoomPlan;
  wallScale: number;
  trimColor: THREE.Color;
  panelColor: THREE.Color;
}) {
  // Inward normal (toward the walkable plan) via the same probe trick as
  // the cutaway test: the side where planContains answers true is inside.
  const horizontal = wall.sizeZ <= wall.sizeX;
  let nx = 0;
  let nz = 0;
  if (horizontal) {
    nz = planContains(plan, wall.x, wall.z + 0.5, 0) ? 1 : -1;
  } else {
    nx = planContains(plan, wall.x + 0.5, wall.z, 0) ? 1 : -1;
  }
  const len = horizontal ? wall.sizeX : wall.sizeZ;
  const thick = horizontal ? wall.sizeZ : wall.sizeX;

  const k = wallScale;
  const baseH = DADO_BASE_HEIGHT * k;
  if (height < baseH) return null;

  // One band box: `along` is the offset along the wall's run from its
  // center; the box hugs the inner face (a 2mm sink into the wall kills
  // any z-fight with the wall surface).
  const band = (
    key: string,
    along: number,
    y: number,
    h: number,
    proj: number,
    w: number,
    color: THREE.Color,
  ) => {
    const off = thick / 2 + proj / 2 - 0.002;
    const x = wall.x + (horizontal ? along : nx * off);
    const z = wall.z + (horizontal ? nz * off : along);
    return (
      <mesh key={key} position={[x, y, z]} castShadow receiveShadow>
        <boxGeometry
          args={horizontal ? [w, h, proj] : [proj, h, w]}
        />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>
    );
  };

  const parts: ReactNode[] = [
    band("base", 0, baseH / 2, baseH, DADO_BASE_PROJECT * k, len, trimColor),
  ];

  // Rail + panel stiles, only when the drawn wall height clears the full
  // dado top by the margin (the cutaway rule above).
  if (height >= (DADO_TOP + DADO_FULL_MARGIN) * k) {
    const railH = DADO_RAIL_HEIGHT * k;
    const railTop = DADO_TOP * k;
    parts.push(
      band(
        "rail",
        0,
        railTop - railH / 2,
        railH,
        DADO_RAIL_PROJECT * k,
        len,
        trimColor,
      ),
    );
    // Panel stiles between baseboard and rail: evenly spaced bays, the
    // count capped so a colossal XL wall widens its bays instead of
    // emitting hundreds of boxes.
    const endPad = thick;
    const run = len - endPad * 2;
    const stileTop = railTop - railH;
    const stileH = stileTop - baseH;
    if (run > 0 && stileH > 0.02) {
      const n = Math.max(
        1,
        Math.min(DADO_PANEL_MAX, Math.round(run / (DADO_PANEL_SPAN * k))),
      );
      const spacing = run / n;
      for (let i = 0; i <= n; i++) {
        const along = -len / 2 + endPad + i * spacing;
        parts.push(
          band(
            `stile${i}`,
            along,
            baseH + stileH / 2,
            stileH,
            DADO_STILE_PROJECT * k,
            DADO_STILE_WIDTH * k,
            panelColor,
          ),
        );
      }
    }
  }
  return <group>{parts}</group>;
}

/* ------------------------------------------------------------------ */
/* Template feature slots (v0.11-room-interiors §7.2): niche,           */
/* pilaster-rhythm, floor-inlay. The templates DECLARE these slots as   */
/* data; this section resolves them against the plan's wall roles and   */
/* the door-split wall runs (the existing modules' outputs — nothing    */
/* re-implements their math) and builds the geometry. Every feature is  */
/* architecture: opaque, wall/floor-material, lit only by the room's    */
/* own fixtures (B.13 — a niche must NOT glow). No RNG anywhere: the    */
/* same slice under the same template always grows the same features    */
/* (A6), and a room without a template builds nothing here.             */
/* ------------------------------------------------------------------ */

/** A resolved niche: the host wall RUN is rebuilt around the opening. */
interface NicheFeature {
  /** Index into wallRuns. */
  run: number;
  /** Opening center offset along the run from its center (m). */
  along: number;
  width: number;
  height: number;
  /** Recess depth into the wall (m), capped to keep a real back panel. */
  depth: number;
  pedestalH: number;
}

/** A resolved pilaster rhythm: strip positions along one wall run. */
interface PilasterFeature {
  /** Index into wallRuns. */
  run: number;
  alongs: number[];
}

/** A resolved floor inlay: the figure's outer rectangle (local frame). */
interface InlayFeature {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface RoomFeatures {
  niches: NicheFeature[];
  pilasters: PilasterFeature[];
  inlay: InlayFeature | null;
}

/**
 * Resolve the template's declared feature slots into placements.
 *
 * Placement rules (the hard constraints from §7.2 and B.11):
 *  - NICHE: full-height runs of the declared wall role only — never a
 *    cutaway sill (a niche in a 1.1m wall is a hole in nothing) — and
 *    never where it would swallow a doorway: any strand door within
 *    NICHE_DOOR_CLEAR of the opening forfeits the niche (the template
 *    already bans doors on its niche wall; this is the backstop).
 *  - PILASTER: per door-split RUN, so the rhythm breaks at every opening
 *    for free; strips stand ON the dado band and need PILASTER_MIN_STRIP
 *    of shaft above the rail, which keeps them off cutaway sills; the end
 *    pad keeps corners and door frames clean.
 *  - INLAY: flat floors only (rolling terrain would clip through); the
 *    whole band is shrunk inside the walkable footprint (an l-shape's
 *    abandoned quadrant takes no stone), and the figure lifts 14mm —
 *    above the parquet's 6mm plane, so the two never z-fight.
 *
 * Exported (pure) for the unit tests in tests/lib/game/room-features.test.ts.
 */
export function buildRoomFeatures({
  template,
  plan,
  walls,
  wallRuns,
  wallHeights,
  wallHeight,
  wallThick,
  doors,
  flatFloor,
}: {
  template: RoomTemplate | null;
  plan: RoomPlan;
  walls: readonly WallSegment[];
  wallRuns: readonly SplitWall[];
  wallHeights: readonly number[];
  wallHeight: number;
  wallThick: number;
  doors: readonly RoomDoorPlacement[];
  flatFloor: boolean;
}): RoomFeatures {
  const out: RoomFeatures = { niches: [], pilasters: [], inlay: null };
  if (!template) return out;
  const ws = wallHeight / WALL_HEIGHT;

  for (const slot of template.features) {
    if (slot.kind === "niche") {
      const half = (NICHE_WIDTH * ws) / 2;
      for (let i = 0; i < wallRuns.length; i++) {
        const run = wallRuns[i];
        if (wallRoleFor(plan, walls[run.source]) !== slot.at) continue;
        // Never on a cutaway sill.
        if (wallHeights[i] < wallHeight - 1e-6) continue;
        const horizontal = run.wall.sizeZ <= run.wall.sizeX;
        const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
        const span = slot.span ?? [0.4, 0.6];
        const along = ((span[0] + span[1]) / 2 - 0.5) * len;
        // The opening must sit fully on the run, clear of its ends…
        if (Math.abs(along) + half > len / 2 - 0.3) continue;
        // …and never swallow a doorway or its approach. Door `along`s are
        // measured from the SOURCE segment's center, this run's `along`
        // from the run's center — shift into one frame before comparing
        // (a door-split run's center is not the wall's center).
        const src = walls[run.source];
        const runShift = horizontal
          ? run.wall.x - src.x
          : run.wall.z - src.z;
        if (
          doors.some(
            (d) =>
              d.wall === run.source &&
              Math.abs(d.along - runShift - along) <
                half + DOOR_GAP_HALF + NICHE_DOOR_CLEAR,
          )
        ) {
          continue;
        }
        const thick = horizontal ? run.wall.sizeZ : run.wall.sizeX;
        out.niches.push({
          run: i,
          along,
          width: NICHE_WIDTH * ws,
          height: NICHE_HEIGHT * ws,
          depth: Math.max(0.1, Math.min(NICHE_MAX_DEPTH, thick - 0.08)),
          pedestalH: NICHE_PEDESTAL_HEIGHT * ws,
        });
        break; // one niche per declared slot
      }
    } else if (slot.kind === "pilaster-rhythm") {
      const stripMin =
        (DADO_TOP + DADO_FULL_MARGIN + PILASTER_MIN_STRIP) * ws;
      for (let i = 0; i < wallRuns.length; i++) {
        const run = wallRuns[i];
        if (wallRoleFor(plan, walls[run.source]) !== slot.at) continue;
        // Breaking at the dado band: a pilaster stands ON the full band —
        // cutaway sills (baseboard only, no shaft room) get none.
        if (wallHeights[i] < stripMin) continue;
        const horizontal = run.wall.sizeZ <= run.wall.sizeX;
        const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
        const pad = PILASTER_END_PAD * ws;
        const runLen = len - pad * 2;
        if (runLen < PILASTER_MIN_RUN * ws) continue;
        const n = Math.max(1, Math.round(runLen / (PILASTER_SPAN * ws)));
        const spacing = runLen / n;
        // Runs are already split at door gaps; defensively drop any strip
        // that would still land on a door frame. Same frame shift as the
        // niche check above: door `along`s are source-segment-relative,
        // strip positions run-relative.
        const srcWall = walls[run.source];
        const runShift = horizontal
          ? run.wall.x - srcWall.x
          : run.wall.z - srcWall.z;
        const alongs: number[] = [];
        for (let k = 0; k < n; k++) {
          const a = -len / 2 + pad + (k + 0.5) * spacing;
          if (
            doors.some(
              (d) =>
                d.wall === run.source &&
                Math.abs(d.along - runShift - a) < DOOR_GAP_HALF + (PILASTER_WIDTH * ws) / 2 + 0.1,
            )
          ) {
            continue;
          }
          alongs.push(a);
        }
        if (alongs.length > 0) out.pilasters.push({ run: i, alongs });
      }
    } else if (slot.kind === "floor-inlay" && flatFloor && out.inlay === null) {
      const span = slot.span ?? [0.25, 0.75];
      const band = INLAY_BAND_WIDTH * ws;
      let x0 = (span[0] - 0.5) * plan.width;
      let x1 = (span[1] - 0.5) * plan.width;
      let z0 = span[0] * plan.extent;
      let z1 = span[1] * plan.extent;
      // An l-shape's abandoned quadrant takes no inlay: fold the figure
      // onto the kept wing when it would cross the step.
      if (plan.id === "l-shape" && z1 > plan.stepZ) {
        if (plan.lSide > 0) x0 = Math.max(x0, 0);
        else x1 = Math.min(x1, 0);
      }
      // Shrink toward the center until the whole band (outer edge plus
      // its width) sits inside the walkable footprint — a colonnade's
      // open bays keep the stone in.
      const margin = band + wallThick + 0.1;
      const fits = () =>
        (
          [
            [x0, z0],
            [x0, z1],
            [x1, z0],
            [x1, z1],
          ] as const
        ).every(([cx, cz]) => planContains(plan, cx, cz, margin));
      for (let tries = 0; tries < 8 && !fits(); tries++) {
        x0 += 0.25;
        x1 -= 0.25;
        z0 += 0.25;
        z1 -= 0.25;
      }
      if (
        fits() &&
        x1 - x0 >= INLAY_MIN_SPAN * ws &&
        z1 - z0 >= INLAY_MIN_SPAN * ws
      ) {
        out.inlay = { x0, x1, z0, z1 };
      }
    }
    // raised-platform / water-rill / mezzanine: no §7.5 template declares
    // them yet — the slot kinds are data for later milestones.
  }
  return out;
}

/**
 * The wall run hosting a niche, rebuilt around the opening: two flank
 * boxes plus a header above (the door-gap split generalized to an opening
 * that stops at NICHE_HEIGHT), so the alcove behind is a TRUE recess —
 * back panel and cheeks set into the wall's own thickness, capped to keep
 * 8cm of wall behind the back panel. A trim architrave frames the opening
 * and a low plinth stands inside (§3.2: 内部放长凳/盆/台座). Everything
 * is opaque wall/trim material — no emissive anywhere (B.13: the niche is
 * lit by the room's fixtures, never by itself). The cap rail still spans
 * the run: the header reaches the wall top, so the top edge stays one
 * straight line.
 */
function NicheWallRun({
  wall,
  height,
  niche,
  plan,
  material,
  trimColor,
  capColor,
  alcoveColor,
  stoneColor,
}: {
  wall: WallSegment;
  height: number;
  niche: NicheFeature;
  plan: RoomPlan;
  material: THREE.Material;
  trimColor: string;
  capColor: THREE.Color;
  alcoveColor: THREE.Color;
  stoneColor: THREE.Color;
}) {
  const horizontal = wall.sizeZ <= wall.sizeX;
  const len = horizontal ? wall.sizeX : wall.sizeZ;
  const thick = horizontal ? wall.sizeZ : wall.sizeX;
  // Inward normal via the dado/window probe trick.
  let nx = 0;
  let nz = 0;
  if (horizontal) {
    nz = planContains(plan, wall.x, wall.z + 0.5, 0) ? 1 : -1;
  } else {
    nx = planContains(plan, wall.x + 0.5, wall.z, 0) ? 1 : -1;
  }
  // Position from along-run offset + outward-perpendicular offset.
  const pos = (
    along: number,
    y: number,
    off: number,
  ): [number, number, number] =>
    horizontal
      ? [wall.x + along, y, wall.z + nz * off]
      : [wall.x + nx * off, y, wall.z + along];
  const box = (
    sizeAlong: number,
    h: number,
    sizePerp: number,
  ): [number, number, number] =>
    horizontal ? [sizeAlong, h, sizePerp] : [sizePerp, h, sizeAlong];

  const a0 = -len / 2;
  const a1 = len / 2;
  const n0 = niche.along - niche.width / 2;
  const n1 = niche.along + niche.width / 2;
  const face = thick / 2; // inner face offset from the wall line
  const parts: ReactNode[] = [];
  // Flanks + header, in the run's own wall material.
  if (n0 - a0 > 1e-3) {
    parts.push(
      <mesh key="fl" position={pos((a0 + n0) / 2, height / 2, 0)} castShadow receiveShadow material={material}>
        <boxGeometry args={box(n0 - a0, height, thick)} />
      </mesh>,
    );
  }
  if (a1 - n1 > 1e-3) {
    parts.push(
      <mesh key="fr" position={pos((n1 + a1) / 2, height / 2, 0)} castShadow receiveShadow material={material}>
        <boxGeometry args={box(a1 - n1, height, thick)} />
      </mesh>,
    );
  }
  parts.push(
    <mesh key="hd" position={pos(niche.along, (height + niche.height) / 2, 0)} castShadow receiveShadow material={material}>
      <boxGeometry args={box(niche.width, height - niche.height, thick)} />
    </mesh>,
  );
  // The alcove: back panel + cheeks, the wall's plaster in its own shadow.
  parts.push(
    <mesh key="bk" position={pos(niche.along, niche.height / 2, face - niche.depth + 0.025)} receiveShadow>
      <boxGeometry args={box(niche.width, niche.height, 0.05)} />
      <meshStandardMaterial color={alcoveColor} roughness={1} flatShading />
    </mesh>,
  );
  for (const side of [-1, 1] as const) {
    parts.push(
      <mesh
        key={`ck${side}`}
        position={pos(niche.along + side * (niche.width / 2 - 0.025), niche.height / 2, face - niche.depth / 2)}
        receiveShadow
      >
        <boxGeometry args={box(0.05, niche.height, niche.depth)} />
        <meshStandardMaterial color={alcoveColor} roughness={1} flatShading />
      </mesh>,
    );
  }
  // Trim architrave, proud of the inner face.
  for (const side of [-1, 1] as const) {
    parts.push(
      <mesh
        key={`tr${side}`}
        position={pos(niche.along + side * (niche.width / 2 + 0.05), niche.height / 2 + 0.05, face + 0.04)}
        castShadow
      >
        <boxGeometry args={box(0.1, niche.height + 0.1, 0.12)} />
        <meshStandardMaterial color={trimColor} roughness={1} flatShading />
      </mesh>,
    );
  }
  parts.push(
    <mesh key="tt" position={pos(niche.along, niche.height + 0.06, face + 0.04)} castShadow>
      <boxGeometry args={box(niche.width + 0.2, 0.12, 0.12)} />
      <meshStandardMaterial color={trimColor} roughness={1} flatShading />
    </mesh>,
  );
  // The plinth standing in the alcove (floor-supported, I2).
  const pedW = niche.width * NICHE_PEDESTAL_FILL;
  const pedD = niche.depth * 0.8;
  parts.push(
    <mesh
      key="pd"
      position={pos(niche.along, GROUND_Y + niche.pedestalH / 2, face - niche.depth + pedD / 2 + 0.01)}
      castShadow
      receiveShadow
    >
      <boxGeometry args={box(pedW, niche.pedestalH, pedD)} />
      <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
    </mesh>,
  );
  // Cap rail along the run top, identical to a plain run's.
  parts.push(
    <mesh key="cap" position={[wall.x, height - 0.05, wall.z]} castShadow receiveShadow>
      <boxGeometry args={[wall.sizeX + 0.06, 0.1, wall.sizeZ + 0.06]} />
      <meshStandardMaterial color={capColor} roughness={1} flatShading />
    </mesh>,
  );
  return <group>{parts}</group>;
}

/**
 * Pilaster rhythm along one wall run: flat strips standing ON the dado
 * band (from the chair-rail line to just under the cap rail), each
 * finished with a slightly wider, slightly prouder cap block. Positions
 * are precomputed by buildRoomFeatures — evenly spread within the run's
 * padded span, already broken at door gaps and never on cutaway sills.
 * Same plaster as the dado's panel stiles, fully opaque.
 */
function PilasterRun({
  wall,
  height,
  alongs,
  plan,
  wallScale,
  color,
}: {
  wall: WallSegment;
  height: number;
  alongs: readonly number[];
  plan: RoomPlan;
  wallScale: number;
  color: THREE.Color;
}) {
  const horizontal = wall.sizeZ <= wall.sizeX;
  const thick = horizontal ? wall.sizeZ : wall.sizeX;
  let nx = 0;
  let nz = 0;
  if (horizontal) {
    nz = planContains(plan, wall.x, wall.z + 0.5, 0) ? 1 : -1;
  } else {
    nx = planContains(plan, wall.x + 0.5, wall.z, 0) ? 1 : -1;
  }
  const k = wallScale;
  const w = PILASTER_WIDTH * k;
  const proj = PILASTER_PROJECT * k;
  const capH = PILASTER_CAP_HEIGHT * k;
  const y0 = DADO_TOP * k;
  const stripH = height - capH - y0;
  if (stripH <= 0.02) return null;
  const off = thick / 2 + proj / 2 - 0.002; // 2mm sink, the dado convention
  const capProj = proj * 1.35;
  const capOff = thick / 2 + capProj / 2 - 0.002;
  return (
    <group>
      {alongs.map((a, i) => {
        const x = wall.x + (horizontal ? a : nx * off);
        const z = wall.z + (horizontal ? nz * off : a);
        const cx = wall.x + (horizontal ? a : nx * capOff);
        const cz = wall.z + (horizontal ? nz * capOff : a);
        return (
          <group key={i}>
            <mesh position={[x, y0 + stripH / 2, z]} castShadow receiveShadow>
              <boxGeometry args={horizontal ? [w, stripH, proj] : [proj, stripH, w]} />
              <meshStandardMaterial color={color} roughness={1} flatShading />
            </mesh>
            <mesh position={[cx, height - capH / 2, cz]} castShadow receiveShadow>
              <boxGeometry
                args={horizontal ? [w * 1.3, capH, capProj] : [capProj, capH, w * 1.3]}
              />
              <meshStandardMaterial color={color} roughness={1} flatShading />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/**
 * Floor inlay: a border band of contrasting stone, flat on the floor —
 * a ShapeGeometry ring (outer rect minus the band-inset inner rect),
 * lifted INLAY_LIFT so it floats above the parquet's dressing plane with
 * no z-fight and reads as flush. Opaque, receiveShadow; the room's own
 * fixtures light it (A3: the band is stone, not a light effect).
 */
function FloorInlay({
  inlay,
  band,
  color,
}: {
  inlay: InlayFeature;
  band: number;
  color: THREE.Color;
}) {
  const geometry = useMemo(() => {
    // Shape (x, y) maps to local (x, -z) under the -π/2 rotation.
    const rect = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      path: THREE.Path,
    ) => {
      path.moveTo(x0, -z0);
      path.lineTo(x1, -z0);
      path.lineTo(x1, -z1);
      path.lineTo(x0, -z1);
      path.closePath();
    };
    const shape = new THREE.Shape();
    rect(inlay.x0, inlay.z0, inlay.x1, inlay.z1, shape);
    const hole = new THREE.Path();
    rect(
      inlay.x0 + band,
      inlay.z0 + band,
      inlay.x1 - band,
      inlay.z1 - band,
      hole,
    );
    shape.holes.push(hole);
    return new THREE.ShapeGeometry(shape);
  }, [inlay, band]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      position={[0, GROUND_Y + INLAY_LIFT, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
    >
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  );
}

/** One prop placement in the group's canonical local frame. */
interface Placement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

/**
 * Draw one scatter candidate: clustered around a seeded composition center
 * (with a LONE_PROB fraction of uniform draws — a solitary tree far from
 * any grouping reads as placed, not as leftover), uniform when the room
 * has no clusters. Positions live in the plan's (scaled) local frame.
 */
function drawCandidate(
  rng: () => number,
  plan: RoomPlan,
  comp: Composition,
  edge: number,
): { x: number; z: number } {
  if (comp.clusters.length > 0 && rng() >= LONE_PROB) {
    const c = comp.clusters[Math.floor(rng() * comp.clusters.length)];
    // Triangular offsets (sum of two uniforms) concentrate near the center.
    return {
      x: c.x + (rng() + rng() - 1) * c.radius,
      z: c.z + (rng() + rng() - 1) * c.radius,
    };
  }
  return {
    x: (rng() * 2 - 1) * Math.max(0.1, plan.width / 2 - edge),
    z: edge + rng() * Math.max(0.1, plan.extent - edge * 2),
  };
}

/** Shared placement rules: inside the walkable footprint, out of the
 *  doorway strip, off every strand door's approach strip (B.11), off the
 *  cleared path, and clear of the hero's clearing. */
function candidateOk(
  plan: RoomPlan,
  comp: Composition,
  x: number,
  z: number,
  edge: number,
  heroClear: number,
  doors: readonly RoomDoorPlacement[],
): boolean {
  if (!planContains(plan, x, z, edge)) return false;
  if (Math.abs(x) < ENTRANCE_CLEAR_RADIUS && z < ENTRANCE_DEPTH) return false;
  if (doors.length > 0 && inDoorApproach(x, z, doors)) return false;
  if (distToPath(comp, x, z) < comp.pathHalf) return false;
  if (heroClear > 0 && Math.hypot(x - comp.hero.x, z - comp.hero.z) < heroClear) {
    return false;
  }
  return true;
}

/**
 * Deterministic tree/rock scatter: count = max(minCount, round(density ·
 * extent² / divisor)) from the ORIGINAL (unscaled) tier — a colossal room
 * gets the same authored population, bigger and farther apart — positions
 * drawn from createRng(recipe.layoutSeed ^ salt), clustered around the
 * composition's centers, snapped to the shared terrainHeight of the SCALED
 * recipe view. Candidates outside the footprint, on the cleared path, in
 * the entrance strip, in a strand door's approach strip (B.11), or in the
 * water are rejected and redrawn (bounded
 * attempts guard the pathological case), so the placed count is exact.
 */
function scatter(
  recipe: SpaceRecipe,
  scaled: SpaceRecipe,
  density: number,
  divisor: number,
  minCount: number,
  water: WaterRect | null,
  plan: RoomPlan,
  comp: Composition,
  edge: number,
  propScale: number,
  salt: number,
  doors: readonly RoomDoorPlacement[],
): Placement[] {
  if (density <= 0) return [];
  // Counts come from the unscaled tier: the room's population is authored
  // at human scale, then the scale notation stretches the space it lives in.
  const baseExtent = recipe.size.extent;
  const count = Math.max(
    minCount,
    Math.round((density * baseExtent * baseExtent) / divisor),
  );
  const rng = createRng((recipe.layoutSeed ^ salt) >>> 0);
  const out: Placement[] = [];
  const heroClear = HERO_CLEAR * propScale;
  const maxAttempts = count * 50 + 200;
  let attempts = 0;
  while (out.length < count && attempts < maxAttempts) {
    attempts += 1;
    const { x: lx, z: lz } = drawCandidate(rng, plan, comp, edge);
    if (!candidateOk(plan, comp, lx, lz, edge, heroClear, doors)) continue;
    if (water && insideRect(lx, lz, water, 0.5)) {
      continue;
    }
    out.push({
      x: lx,
      y: terrainHeight(scaled, lx, lz),
      z: lz,
      scale: (0.8 + rng() * 0.5) * propScale,
      rotX: 0,
      rotY: rng() * Math.PI * 2,
      rotZ: 0,
    });
  }
  return out;
}

/** Plan dims shorthand. */
function dims(recipe: SpaceRecipe): { extent: number; width: number } {
  return { extent: recipe.size.extent, width: recipe.width };
}

/** Point-in-rect test with an optional margin. */
function insideRect(
  x: number,
  z: number,
  rect: WaterRect,
  margin: number,
): boolean {
  return (
    Math.abs(x - rect.cx) < rect.halfX + margin &&
    Math.abs(z - rect.cz) < rect.halfZ + margin
  );
}

/** Shadow opt-in for whole prop subtrees: r3f does not cascade
 *  castShadow/receiveShadow down the graph, and the prop/animal assemblies
 *  are dozens of tiny meshes each, so one traversal on mount flags every
 *  descendant mesh. Static subtrees only — geometry never mounts after the
 *  first render. */
function Shadowed({ children }: { children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    ref.current?.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
  }, []);
  return <group ref={ref}>{children}</group>;
}

/** Water surface: a REAL shallow-water material (materials/water-surface.ts)
 *  — three seamless ripple normal layers scrolling at different scales and
 *  directions, a rim-to-deep depth tint (ankle-clear at the edge, tinted at
 *  depth) that always lets the pool floor read through, and a near-glossy
 *  PBR finish so the environment and key light answer with a specular
 *  streak. The plane still bobs gently; ripple scroll is a pure function of
 *  the frame clock. The material is per-room (its tint is palette-derived)
 *  and disposed on unmount; the ripple textures it samples are shared
 *  app-lifetime singletons.
 *  Shadows: RECEIVES only — a shadow caster is rendered through a depth
 *  material that ignores transparency, so a casting water plane would paint
 *  an opaque slab shadow over the pool bottom it exists to reveal; receiving
 *  lets poolside props (ladder, board, loungers) land on the surface. */
function WaterSurface({
  halfX,
  halfZ,
  cz,
  color,
  shallowColor,
}: {
  halfX: number;
  halfZ: number;
  cz: number;
  color: THREE.Color;
  shallowColor: THREE.Color;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const water = useMemo(
    () =>
      createWaterSurfaceMaterial({
        color,
        shallowColor,
        spanX: halfX * 2,
        spanY: halfZ * 2,
      }),
    [color, shallowColor, halfX, halfZ],
  );
  useEffect(() => () => water.dispose(), [water]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    water.update(t);
    const mesh = meshRef.current;
    if (mesh) mesh.position.y = WATER_Y + Math.sin(t * 0.6) * 0.02;
  });
  return (
    <mesh
      ref={meshRef}
      position={[0, WATER_Y, cz]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={1}
      receiveShadow
      material={water.material}
    >
      <planeGeometry args={[halfX * 2, halfZ * 2]} />
    </mesh>
  );
}

/** One ripple patch: rings expand from `radius` and fade on a loop. */
interface RipplePatch {
  x: number;
  z: number;
  radius: number;
  phase: number;
}

/** Deterministic ripple patches scattered inside the water rectangle.
 *  Ring sizes ride the room's prop scale so a colossal pool's ripples
 *  read at its own scale. */
function scatterRipples(
  rng: () => number,
  water: WaterRect,
  sizeScale: number,
): RipplePatch[] {
  const count = Math.min(
    6,
    Math.max(2, Math.round((water.halfX * water.halfZ) / 45)),
  );
  const spanX = Math.max(0.5, water.halfX - 1.2);
  const spanZ = Math.max(0.5, water.halfZ - 1.2);
  const out: RipplePatch[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: water.cx + (rng() * 2 - 1) * spanX,
      z: water.cz + (rng() * 2 - 1) * spanZ,
      radius: (1.2 + rng() * 1.4) * sizeScale,
      phase: rng(),
    });
  }
  return out;
}

/** Expanding ripple rings: each ring scales up and fades out on a loop
 *  (staggered within its patch), so the water surface reads as alive. */
function WaterRipples({
  patches,
  color,
}: {
  patches: RipplePatch[];
  color: THREE.Color;
}) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    let k = 0;
    for (const p of patches) {
      for (let j = 0; j < 3; j++) {
        const mesh = refs.current[k];
        k += 1;
        if (!mesh) continue;
        const local = (t * 0.22 + p.phase + j * 0.33) % 1;
        const s = 0.7 + local * 1.2;
        mesh.scale.set(s, s, 1);
        (mesh.material as THREE.MeshStandardMaterial).opacity =
          0.3 + 0.35 * (1 - local);
      }
    }
  });
  return (
    <>
      {patches.map((p, i) =>
        [0, 1, 2].map((j) => (
          <mesh
            key={`${i}-${j}`}
            ref={(m) => {
              refs.current[i * 3 + j] = m;
            }}
            position={[p.x, WATER_Y + 0.04 + j * 0.004, p.z]}
            rotation={[-Math.PI / 2, 0, 0]}
            renderOrder={2}
          >
            <ringGeometry args={[Math.max(0.14, p.radius - 0.14), p.radius, 26]} />
            <meshStandardMaterial
              color={color}
              transparent
              opacity={0.55}
              roughness={0.4}
              depthWrite={false}
            />
          </mesh>
        )),
      )}
    </>
  );
}

/** Falling snow over the plan — seeded flake positions, recycled fall.
 *  Pure visual motion; layouts stay deterministic. Flake size rides the
 *  room's creature scale so snow reads at any room scale; the count is
 *  capped (the area formula explodes quadratically at colossal scale). */
function Snowfall({
  width,
  extent,
  seed,
  sizeScale,
}: {
  width: number;
  extent: number;
  seed: number;
  sizeScale: number;
}) {
  const count = Math.min(
    SNOW_COUNT_MAX,
    Math.max(140, Math.round((width * extent) / 10)),
  );
  const { geometry, speeds } = useMemo(() => {
    const rng = createRng(seed);
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rng() * 2 - 1) * (width / 2);
      positions[i * 3 + 1] = rng() * 6;
      positions[i * 3 + 2] = rng() * extent;
      speeds[i] = 0.5 + rng() * 0.5;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return { geometry, speeds };
  }, [seed, width, extent, count]);
  useFrame((_, delta) => {
    const attr = geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const dt = Math.min(delta, 0.05);
    for (let i = 0; i < count; i++) {
      arr[i * 3 + 1] -= speeds[i] * dt;
      if (arr[i * 3 + 1] < 0) arr[i * 3 + 1] = 6;
    }
    attr.needsUpdate = true;
  });
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points geometry={geometry}>
      <pointsMaterial
        color="#ffffff"
        size={0.16 * sizeScale}
        transparent
        opacity={0.9}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

/** Fireflies for dusk/night forests and lakes: warm points wandering slow
 *  circles around seeded centers. Size rides the room's creature scale. */
function Fireflies({
  width,
  extent,
  seed,
  sizeScale,
}: {
  width: number;
  extent: number;
  seed: number;
  sizeScale: number;
}) {
  const COUNT = 26;
  const { geometry, centers } = useMemo(() => {
    const rng = createRng(seed);
    const positions = new Float32Array(COUNT * 3);
    const centers = new Float32Array(COUNT * 4); // cx, cz, phase, radius
    for (let i = 0; i < COUNT; i++) {
      const cx = (rng() * 2 - 1) * (width / 2 - 2);
      const cz = 2 + rng() * (extent - 4);
      positions[i * 3] = cx;
      positions[i * 3 + 1] = 0.8;
      positions[i * 3 + 2] = cz;
      centers[i * 4] = cx;
      centers[i * 4 + 1] = cz;
      centers[i * 4 + 2] = rng() * Math.PI * 2;
      centers[i * 4 + 3] = 0.6 + rng() * 0.9;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return { geometry, centers };
  }, [seed, width, extent]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const attr = geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const ph = centers[i * 4 + 2];
      const r = centers[i * 4 + 3];
      arr[i * 3] = centers[i * 4] + Math.sin(t * 0.3 + ph) * r;
      arr[i * 3 + 1] = 0.8 + Math.sin(t * 0.7 + ph * 2) * 0.4;
      arr[i * 3 + 2] = centers[i * 4 + 1] + Math.cos(t * 0.27 + ph) * r;
    }
    attr.needsUpdate = true;
  });
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points geometry={geometry}>
      <pointsMaterial
        color="#ffe98a"
        size={0.15 * sizeScale}
        transparent
        opacity={0.9}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** Near-tone-on-tone checkerboard parquet for interior/wonder floors: a
 *  code-generated 2×2 canvas texture (no asset files), repeated at
 *  PARQUET_CELL meters. The light cell lifts the base color by only
 *  PARQUET_TONE_LIFT — visual review found a stronger contrast was the
 *  loudest thing in frame; at this level the floor reads as material and
 *  the furniture reads first. Only flat-floor interior/wonder rooms get
 *  it — nature ground stays untouched. Sits a hair above the ground plane. */
function FloorParquet({
  width,
  extent,
  base,
}: {
  width: number;
  extent: number;
  base: string;
}) {
  const texture = useMemo(() => {
    const light = new THREE.Color(base)
      .lerp(new THREE.Color("#ffffff"), PARQUET_TONE_LIFT)
      .getStyle();
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 2, 2);
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillRect(1, 1, 1, 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(
      Math.max(1, Math.round(width / PARQUET_CELL)),
      Math.max(1, Math.round(extent / PARQUET_CELL)),
    );
    return tex;
  }, [width, extent, base]);
  useEffect(() => () => texture?.dispose(), [texture]);
  if (!texture) return null;
  return (
    <mesh
      position={[0, GROUND_Y + 0.006, extent / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
    >
      <planeGeometry args={[width, extent]} />
      <meshStandardMaterial map={texture} roughness={1} />
    </mesh>
  );
}

/** Instanced trees: one trunk + one canopy mesh sharing the same
 *  placements. Matrices are written on mount and then swayed imperatively
 *  every frame (phase-offset gentle rotation); both instanced meshes are
 *  disposed on cleanup. */
function TreeInstances({
  placements,
  canopyColor,
}: {
  placements: Placement[];
  canopyColor: THREE.Color;
}) {
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const canopyRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    const trunk = trunkRef.current;
    const canopy = canopyRef.current;
    if (!trunk || !canopy) return;
    placements.forEach((p, i) => {
      dummy.rotation.set(0, p.rotY, 0);
      dummy.scale.setScalar(p.scale);
      dummy.position.set(p.x, p.y + 0.7 * p.scale, p.z);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, p.y + 1.9 * p.scale, p.z);
      dummy.updateMatrix();
      canopy.setMatrixAt(i, dummy.matrix);
    });
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    return () => {
      trunk.dispose();
      canopy.dispose();
    };
  }, [placements, dummy]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const trunk = trunkRef.current;
    const canopy = canopyRef.current;
    if (!trunk || !canopy) return;
    placements.forEach((p, i) => {
      const sway = Math.sin(t * 0.6 + i * 1.7) * 0.03;
      dummy.rotation.set(0, p.rotY, sway * 0.4);
      dummy.scale.setScalar(p.scale);
      dummy.position.set(p.x, p.y + 0.7 * p.scale, p.z);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(0, p.rotY, sway);
      dummy.position.set(p.x, p.y + 1.9 * p.scale, p.z);
      dummy.updateMatrix();
      canopy.setMatrixAt(i, dummy.matrix);
    });
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={trunkRef}
        args={[undefined, undefined, placements.length]}
        frustumCulled={false}
        castShadow
        receiveShadow
      >
        <cylinderGeometry args={[0.14, 0.2, 1.4, 6]} />
        <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
      </instancedMesh>
      <instancedMesh
        ref={canopyRef}
        args={[undefined, undefined, placements.length]}
        frustumCulled={false}
        castShadow
        receiveShadow
      >
        <coneGeometry args={[0.85, 1.7, 6]} />
        <meshStandardMaterial color={canopyColor} roughness={1} flatShading />
      </instancedMesh>
    </>
  );
}

/** Instanced low-poly rocks (dodecahedra at 0.2–0.6 scale). */
function RockInstances({ placements }: { placements: Placement[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    placements.forEach((p, i) => {
      dummy.rotation.set(p.rotX, p.rotY, p.rotZ);
      dummy.scale.setScalar(p.scale);
      dummy.position.set(p.x, p.y + 0.35 * p.scale, p.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    return () => mesh.dispose();
  }, [placements]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, placements.length]}
      frustumCulled={false}
      castShadow
      receiveShadow
    >
      <dodecahedronGeometry args={[0.5, 0]} />
      <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
    </instancedMesh>
  );
}

/** Motif prop kinds — every archetype has at least three (the flat
 *  interiors are furnished by kits instead; see lib/game/kits.ts and the
 *  furniture memo below). */
type MotifKind =
  // pool / water fixtures
  | "ladder"
  | "board"
  | "lounger"
  | "ring"
  // forest / meadow / plains
  | "log"
  | "mushroom"
  | "lantern"
  | "fence"
  | "flowers"
  | "bench"
  | "lonetree"
  | "cairn"
  | "signpost"
  // nature v2 (ocean / lake / beach / snowfield)
  | "buoy"
  | "driftwood"
  | "rowboat"
  | "umbrella"
  | "beachball"
  | "sandcastle"
  | "shell"
  | "snowman"
  | "icestone"
  // interior furniture (also scattered into hybrid nature rooms)
  | "bed"
  | "nightstand"
  | "tv"
  | "sofa"
  | "rug"
  | "bookshelf"
  | "readingchair"
  | "desklamp"
  | "chandelier"
  | "floorlamp"
  | "desk"
  | "giftbox"
  | "column"
  // hotel kit pieces (the rooms' crafted props — kits.ts)
  | "suitcase"
  | "luggagecart"
  | "bell"
  | "register"
  | "towelstack"
  | "lockerrow"
  | "chair"
  | "coatstand"
  | "umbrellastand"
  | "bucket"
  | "tray"
  | "bookpile"
  // wonder props
  | "yarn"
  | "cattree"
  | "scratchpost"
  | "doghouse"
  | "bone"
  | "ball";

const MOTIF_KINDS: Record<ArchetypeId, readonly MotifKind[]> = {
  pool: ["ladder", "board", "lounger", "ring"],
  forest: ["log", "mushroom", "lantern"],
  meadow: ["fence", "flowers", "bench"],
  plains: ["lonetree", "cairn", "signpost"],
  ocean: ["buoy", "driftwood"],
  lake: ["rowboat", "lantern", "driftwood"],
  beach: ["umbrella", "beachball", "sandcastle", "shell"],
  snowfield: ["snowman", "icestone", "log"],
  "hotel-room": [],
  "pool-hall": [],
  library: [],
  ballroom: [],
  ducks: ["ring"],
  cats: ["yarn", "cattree", "scratchpost"],
  dogs: ["doghouse", "bone", "ball"],
  balloons: ["giftbox"],
};

/** Furniture mixed into hybrid nature rooms — the "does not belong" gag. */
const HYBRID_FURNITURE: readonly MotifKind[] = [
  "bed",
  "tv",
  "sofa",
  "floorlamp",
  "desk",
];

/** Pool fixtures that belong ON the basin rim (they may overhang water). */
function isPoolside(kind: MotifKind): boolean {
  return kind === "ladder" || kind === "board";
}

/** One motif prop placement in the group's canonical local frame. */
interface PropPlacement {
  kind: MotifKind;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
}

/**
 * Deterministic motif staging. The HERO comes first: one element from the
 * archetype's kinds, placed at the composition's far-third focal point at
 * HERO_SCALE — the thing you see when you walk in (it floats if the focal
 * point lands on water). The remaining PROP_COUNT[extent] props (counted
 * from the ORIGINAL tier, like the vegetation scatter) cluster around the
 * composition's centers. Obstacle rules: the doorway corridor
 * (|x| < 1.8, z < 3m), every strand door's approach strip (B.11), the
 * walk path, the hero's clearing, the plan
 * footprint, and the wall boxes are always off-limits; so is the water
 * rectangle, except poolside fixtures, which are placed ON its rim facing
 * the water instead. Snapped to the shared terrainHeight of the SCALED
 * recipe view; sizes carry the room's prop scale.
 */
function scatterMotifs(
  rng: () => number,
  recipe: SpaceRecipe,
  scaled: SpaceRecipe,
  kinds: readonly MotifKind[],
  water: WaterRect | null,
  plan: RoomPlan,
  comp: Composition,
  edge: number,
  propScale: number,
  doors: readonly RoomDoorPlacement[],
): PropPlacement[] {
  if (kinds.length === 0) return [];
  const { extent, width } = dims(scaled);
  const out: PropPlacement[] = [];

  // (a) The hero: far-third focal element, unmistakably the set piece.
  const heroKind = kinds[Math.floor(rng() * kinds.length)];
  const heroOnWater = water !== null && insideRect(comp.hero.x, comp.hero.z, water, 0);
  out.push({
    kind: heroKind,
    x: comp.hero.x,
    y: heroOnWater ? WATER_Y : terrainHeight(scaled, comp.hero.x, comp.hero.z),
    z: comp.hero.z,
    rotY: rng() * Math.PI * 2,
    scale: (0.9 + rng() * 0.25) * HERO_SCALE * propScale,
  });

  // (b)+(c) The rest: clustered, off the cleared path, out of the hero's
  // clearing — grouped placement reads as authored, uniform draws as noise.
  const heroClear = HERO_CLEAR * propScale;
  const count = PROP_COUNT[recipe.size.extent] ?? Math.max(3, Math.round(recipe.size.extent / 12));
  const maxAttempts = count * 60 + 240;
  let attempts = 0;
  while (out.length < count + 1 && attempts < maxAttempts) {
    attempts += 1;
    const kind = kinds[Math.floor(rng() * kinds.length)];
    let lx: number;
    let lz: number;
    if (isPoolside(kind) && water) {
      // On the water rim: pick one of the three non-entrance sides, hug the
      // edge (a slight overhang reads as hooks/board over the rim), clamped
      // so the base stays just outside the perimeter wall.
      const side = Math.floor(rng() * 3); // 0:+x 1:-x 2:far(+z)
      const t = (rng() * 2 - 1) * Math.max(0.4, water.halfX - 0.8);
      const clampX = width / 2 - ROOM_WALL_THICKNESS - 0.25;
      const clampZ = extent - ROOM_WALL_THICKNESS - 0.25;
      const offX = water.halfX + 0.3;
      const offZ = water.halfZ + 0.3;
      if (side === 0) {
        lx = Math.min(offX, clampX);
        lz = Math.min(Math.max(water.cz + t * (water.halfZ / Math.max(water.halfX, 0.01)), 0.6), clampZ);
      } else if (side === 1) {
        lx = -Math.min(offX, clampX);
        lz = Math.min(Math.max(water.cz + t * (water.halfZ / Math.max(water.halfX, 0.01)), 0.6), clampZ);
      } else {
        lx = Math.min(Math.max(t, -clampX), clampX);
        lz = Math.min(water.cz + offZ, clampZ);
      }
    } else {
      ({ x: lx, z: lz } = drawCandidate(rng, plan, comp, edge));
    }
    if (Math.abs(lx) < PROP_DOOR_HALF && lz < PROP_DOOR_DEPTH) {
      continue;
    }
    if (!candidateOk(plan, comp, lx, lz, isPoolside(kind) ? 0 : edge, heroClear, doors)) {
      continue;
    }
    if (!isPoolside(kind) && water && insideRect(lx, lz, water, 0.3)) {
      continue;
    }
    const rotY =
      isPoolside(kind) && water
        ? Math.atan2(water.cx - lx, water.cz - lz) // face the water center
        : rng() * Math.PI * 2;
    out.push({
      kind,
      x: lx,
      y: terrainHeight(scaled, lx, lz),
      z: lz,
      rotY,
      scale: (0.9 + rng() * 0.25) * propScale,
    });
  }
  return out;
}

/**
 * Low-poly motif geometry for one prop kind, built from primitives at the
 * local origin (the wrapper group positions/rotates/scales it). No textures,
 * no model files — boxes, cones, cylinders, spheres, one torus, low segment
 * counts, flat shading throughout. Dynamic kinds (tv, chandelier) are
 * rendered by their own animated components instead (see MotifProp).
 */
function MotifGeometry({
  kind,
  accent,
  canopyColor,
}: {
  kind: MotifKind;
  accent: string;
  canopyColor: THREE.Color;
}) {
  switch (kind) {
    case "ladder":
      return (
        <group>
          {[-0.2, 0.2].map((x) => (
            <mesh key={x} position={[x, 0.65, 0]}>
              <cylinderGeometry args={[0.035, 0.035, 1.3, 6]} />
              <meshStandardMaterial
                color="#9aa0a6"
                roughness={0.5}
                metalness={0.3}
                flatShading
              />
            </mesh>
          ))}
          {[0.35, 0.65, 0.95].map((y) => (
            <mesh key={y} position={[0, y, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.025, 0.025, 0.4, 6]} />
              <meshStandardMaterial
                color="#9aa0a6"
                roughness={0.5}
                metalness={0.3}
                flatShading
              />
            </mesh>
          ))}
          {[-0.2, 0.2].map((x) => (
            <mesh
              key={`hook${x}`}
              position={[x, 1.3, 0.17]}
              rotation={[Math.PI / 2, 0, 0]}
            >
              <cylinderGeometry args={[0.035, 0.035, 0.35, 6]} />
              <meshStandardMaterial
                color="#9aa0a6"
                roughness={0.5}
                metalness={0.3}
                flatShading
              />
            </mesh>
          ))}
        </group>
      );
    case "board":
      return (
        <group>
          <mesh position={[0, 0.5, -0.2]}>
            <cylinderGeometry args={[0.2, 0.24, 1.0, 8]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.04, 0.5]}>
            <boxGeometry args={[0.55, 0.08, 1.7]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.72, -0.28]}>
            <boxGeometry args={[0.4, 0.06, 0.4]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "lounger":
      return (
        <group>
          <mesh position={[0, 0.32, 0.1]}>
            <boxGeometry args={[0.62, 0.1, 1.05]} />
            <meshStandardMaterial color="#e6e1d5" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.62, -0.52]} rotation={[-0.9, 0, 0]}>
            <boxGeometry args={[0.62, 0.1, 0.8]} />
            <meshStandardMaterial color="#e6e1d5" roughness={1} flatShading />
          </mesh>
          {[
            [-0.24, 0.4],
            [0.24, 0.4],
            [-0.24, -0.28],
            [0.24, -0.28],
          ].map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.16, z]}>
              <boxGeometry args={[0.08, 0.32, 0.08]} />
              <meshStandardMaterial
                color="#c9c2b2"
                roughness={1}
                flatShading
              />
            </mesh>
          ))}
        </group>
      );
    case "ring":
      return (
        <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.32, 0.11, 6, 14]} />
          <meshStandardMaterial color="#e0643c" roughness={1} flatShading />
        </mesh>
      );
    case "log":
      return (
        <group>
          <mesh position={[0, 0.2, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.26, 0.3, 2.6, 7]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[-0.8, 0.42, 0.12]} rotation={[0.6, 0, 0]}>
            <coneGeometry args={[0.07, 0.3, 5]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.9, 0.4, -0.1]} rotation={[-0.5, 0, 0]}>
            <coneGeometry args={[0.06, 0.26, 5]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "mushroom":
      return (
        <group>
          {[
            [-0.22, 0.06, 1],
            [0.18, 0.14, 0.75],
            [0.02, -0.18, 1.15],
          ].map(([x, z, s]) => (
            <group key={`${x}${z}`} position={[x, 0, z]} scale={s}>
              <mesh position={[0, 0.11, 0]}>
                <cylinderGeometry args={[0.05, 0.07, 0.22, 6]} />
                <meshStandardMaterial
                  color="#e3d9c2"
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 0.28, 0]} scale={[1, 0.72, 1]}>
                <sphereGeometry args={[0.16, 8, 6]} />
                <meshStandardMaterial
                  color="#c4553f"
                  roughness={1}
                  flatShading
                />
              </mesh>
            </group>
          ))}
        </group>
      );
    case "lantern":
      return (
        <group>
          <mesh position={[0, 0.07, 0]}>
            <boxGeometry args={[0.42, 0.14, 0.42]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.39, 0]}>
            <cylinderGeometry args={[0.1, 0.12, 0.5, 6]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.76, 0]}>
            <boxGeometry args={[0.26, 0.24, 0.26]} />
            <meshStandardMaterial
              color="#f2e6c8"
              emissive="#f2e6c8"
              emissiveIntensity={0.7}
              roughness={1}
              flatShading
            />
          </mesh>
          <mesh position={[0, 1.0, 0]}>
            <coneGeometry args={[0.32, 0.24, 4]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "fence":
      return (
        <group>
          {[-0.8, 0, 0.8].map((x) => (
            <mesh key={x} position={[x, 0.425, 0]}>
              <cylinderGeometry args={[0.045, 0.05, 0.85, 5]} />
              <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
            </mesh>
          ))}
          {[0.55, 0.8].map((y) => (
            <mesh key={y} position={[0, y, 0]}>
              <boxGeometry args={[1.72, 0.07, 0.07]} />
              <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "flowers":
      return (
        <group>
          {(
            [
              [0, 0, 1, 0],
              [0.16, 0.1, 0.8, 1],
              [-0.14, 0.12, 1.15, 2],
              [0.06, -0.15, 0.9, 0],
              [-0.1, -0.08, 1.05, 3],
            ] as const
          ).map(([x, z, s, c]) => (
            <group key={`${x}${z}`} position={[x, 0, z]} scale={s}>
              <mesh position={[0, 0.15, 0]}>
                <cylinderGeometry args={[0.02, 0.02, 0.3, 4]} />
                <meshStandardMaterial
                  color="#5a7a44"
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 0.36, 0]}>
                <coneGeometry args={[0.07, 0.14, 5]} />
                <meshStandardMaterial
                  color={[accent, "#f2ede2", "#e8c95a", "#d984a0"][c]}
                  roughness={1}
                  flatShading
                />
              </mesh>
            </group>
          ))}
        </group>
      );
    case "bench":
      return (
        <group>
          {[-0.66, 0.66].map((x) => (
            <mesh key={x} position={[x, 0.21, 0]}>
              <boxGeometry args={[0.08, 0.42, 0.5]} />
              <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0, 0.46, 0]}>
            <boxGeometry args={[1.6, 0.08, 0.55]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.82, -0.26]} rotation={[-0.14, 0, 0]}>
            <boxGeometry args={[1.6, 0.45, 0.07]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "lonetree":
      return (
        <group>
          <mesh position={[0, 1.3, 0]}>
            <cylinderGeometry args={[0.16, 0.24, 2.6, 6]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 3.4, 0]}>
            <coneGeometry args={[1.5, 2.6, 7]} />
            <meshStandardMaterial color={canopyColor} roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "cairn":
      return (
        <group>
          <mesh position={[0, 0.22, 0]} scale={0.9}>
            <dodecahedronGeometry args={[0.5, 0]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.05, 0.62, 0]} scale={0.65}>
            <dodecahedronGeometry args={[0.5, 0]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
          <mesh position={[-0.04, 0.94, 0]} scale={0.45}>
            <dodecahedronGeometry args={[0.5, 0]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "signpost":
      return (
        <group>
          <mesh position={[0, 0.95, 0]}>
            <cylinderGeometry args={[0.06, 0.07, 1.9, 6]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.6, 0]} rotation={[0, 0.3, 0]}>
            <boxGeometry args={[0.72, 0.16, 0.05]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.32, 0]} rotation={[0, -1.2, 0]}>
            <boxGeometry args={[0.72, 0.16, 0.05]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "buoy":
      return (
        <group>
          <mesh position={[0, 0.3, 0]}>
            <coneGeometry args={[0.3, 0.6, 8]} />
            <meshStandardMaterial color="#e0643c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.85, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.5, 5]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.12, 0]}>
            <sphereGeometry args={[0.08, 6, 5]} />
            <meshStandardMaterial
              color="#f2e6c8"
              emissive="#f2e6c8"
              emissiveIntensity={0.6}
              roughness={1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "driftwood":
      return (
        <group>
          <mesh position={[0, 0.12, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.1, 0.14, 1.7, 6]} />
            <meshStandardMaterial color="#a89880" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.3, 0.24, 0.08]} rotation={[0.7, 0, 0.4]}>
            <cylinderGeometry args={[0.04, 0.05, 0.5, 5]} />
            <meshStandardMaterial color="#a89880" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "rowboat":
      return (
        <group>
          <mesh position={[0, 0.22, 0]}>
            <boxGeometry args={[1.8, 0.4, 0.72]} />
            <meshStandardMaterial color="#8a6642" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.36, 0]}>
            <boxGeometry args={[1.5, 0.12, 0.5]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
          {[-0.4, 0.4].map((x) => (
            <mesh key={x} position={[x, 0.42, 0]}>
              <boxGeometry args={[0.24, 0.05, 0.5]} />
              <meshStandardMaterial color="#a88a62" roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "umbrella":
      return (
        <group>
          <mesh position={[0, 0.85, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 1.7, 6]} />
            <meshStandardMaterial color="#e8e4da" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.75, 0]}>
            <coneGeometry args={[1.35, 0.55, 8]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "beachball":
      return (
        <mesh position={[0, 0.28, 0]}>
          <sphereGeometry args={[0.28, 10, 8]} />
          <meshStandardMaterial color={accent} roughness={0.8} flatShading />
        </mesh>
      );
    case "sandcastle":
      return (
        <group>
          <mesh position={[0, 0.25, 0]}>
            <cylinderGeometry args={[0.5, 0.58, 0.5, 8]} />
            <meshStandardMaterial color="#e8cf9a" roughness={1} flatShading />
          </mesh>
          {[-0.38, 0.38].map((x) => (
            <group key={x} position={[x, 0, 0.1]}>
              <mesh position={[0, 0.45, 0]}>
                <cylinderGeometry args={[0.14, 0.16, 0.7, 6]} />
                <meshStandardMaterial
                  color="#e8cf9a"
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 0.86, 0]}>
                <coneGeometry args={[0.16, 0.2, 6]} />
                <meshStandardMaterial
                  color={accent}
                  roughness={1}
                  flatShading
                />
              </mesh>
            </group>
          ))}
        </group>
      );
    case "shell":
      return (
        <mesh position={[0, 0.08, 0]} scale={[1, 0.5, 1]}>
          <sphereGeometry args={[0.16, 7, 5]} />
          <meshStandardMaterial color="#f2d9c8" roughness={1} flatShading />
        </mesh>
      );
    case "snowman":
      return (
        <group>
          <mesh position={[0, 0.3, 0]}>
            <sphereGeometry args={[0.34, 9, 7]} />
            <meshStandardMaterial color="#f4f7fa" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.82, 0]}>
            <sphereGeometry args={[0.25, 9, 7]} />
            <meshStandardMaterial color="#f4f7fa" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.22, 0]}>
            <sphereGeometry args={[0.18, 9, 7]} />
            <meshStandardMaterial color="#f4f7fa" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.2, 0.2]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.045, 0.2, 6]} />
            <meshStandardMaterial color="#e8935c" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "icestone":
      return (
        <group>
          <mesh position={[0, 0.2, 0]} scale={[1, 0.8, 1]}>
            <dodecahedronGeometry args={[0.4, 0]} />
            <meshStandardMaterial color="#bcd8e8" roughness={0.7} flatShading />
          </mesh>
          <mesh position={[0.4, 0.14, 0.15]} scale={[0.7, 0.55, 0.7]}>
            <dodecahedronGeometry args={[0.4, 0]} />
            <meshStandardMaterial color="#cfe4f0" roughness={0.7} flatShading />
          </mesh>
        </group>
      );
    case "bed":
      return (
        <group>
          <mesh position={[0, 0.18, 0]}>
            <boxGeometry args={[1.7, 0.32, 2.2]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <boxGeometry args={[1.62, 0.2, 2.12]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.56, -0.72]}>
            <boxGeometry args={[1.1, 0.14, 0.5]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.68, -1.08]}>
            <boxGeometry args={[1.7, 0.72, 0.09]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "nightstand":
      return (
        <group>
          <mesh position={[0, 0.28, 0]}>
            <boxGeometry args={[0.5, 0.56, 0.45]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.62, 0]}>
            <cylinderGeometry args={[0.05, 0.08, 0.2, 6]} />
            <meshStandardMaterial color="#9aa0a6" roughness={0.6} flatShading />
          </mesh>
          <mesh position={[0, 0.8, 0]}>
            <sphereGeometry args={[0.13, 8, 6]} />
            <meshStandardMaterial
              color="#f2e6c8"
              emissive="#f2e6c8"
              emissiveIntensity={0.7}
              roughness={1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "tv":
      // Static fallback — real placements render via the animated TvProp.
      return (
        <group>
          <mesh position={[0, 0.2, 0]}>
            <boxGeometry args={[0.5, 0.4, 0.3]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.95, 0]}>
            <boxGeometry args={[1.25, 0.75, 0.08]} />
            <meshStandardMaterial
              color="#101014"
              emissive={accent}
              emissiveIntensity={0.7}
              roughness={1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "sofa":
      return (
        <group>
          <mesh position={[0, 0.32, 0]}>
            <boxGeometry args={[1.9, 0.4, 0.85]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.75, -0.34]}>
            <boxGeometry args={[1.9, 0.65, 0.22]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          {[-0.98, 0.98].map((x) => (
            <mesh key={x} position={[x, 0.55, 0]}>
              <boxGeometry args={[0.18, 0.65, 0.85]} />
              <meshStandardMaterial color={accent} roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "rug":
      return (
        <mesh position={[0, 0.02, 0]}>
          <cylinderGeometry args={[1.5, 1.5, 0.04, 20]} />
          <meshStandardMaterial color={accent} roughness={1} flatShading />
        </mesh>
      );
    case "bookshelf":
      return (
        <group>
          {[-0.85, 0.85].map((x) => (
            <mesh key={x} position={[x, 1.1, 0]}>
              <boxGeometry args={[0.07, 2.2, 0.42]} />
              <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0, 1.1, -0.19]}>
            <boxGeometry args={[1.77, 2.2, 0.05]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
          {[0.5, 1.1, 1.7].map((y, i) => (
            <group key={y}>
              <mesh position={[0, y, 0]}>
                <boxGeometry args={[1.7, 0.05, 0.4]} />
                <meshStandardMaterial
                  color="#7a6a55"
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, y + 0.19, 0.02]}>
                <boxGeometry
                  args={[1.55, 0.33 - 0.04 * ((i + 1) % 2), 0.3]}
                />
                <meshStandardMaterial
                  color={["#c4553f", "#5a7a44", "#e8c95a"][i % 3]}
                  roughness={1}
                  flatShading
                />
              </mesh>
            </group>
          ))}
        </group>
      );
    case "readingchair":
      return (
        <group>
          <mesh position={[0, 0.18, 0]}>
            <cylinderGeometry args={[0.32, 0.36, 0.36, 8]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.48, 0]}>
            <boxGeometry args={[0.72, 0.16, 0.72]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.82, -0.3]} rotation={[-0.16, 0, 0]}>
            <boxGeometry args={[0.72, 0.62, 0.14]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "desklamp":
      return (
        <group>
          <mesh position={[0, 0.03, 0]}>
            <cylinderGeometry args={[0.15, 0.18, 0.06, 8]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.025, 0.025, 0.55, 5]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.62, 0]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.16, 0.22, 8]} />
            <meshStandardMaterial
              color="#f2e6c8"
              emissive="#f2e6c8"
              emissiveIntensity={0.7}
              roughness={1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "chandelier":
      // Static fallback — real placements render via the animated
      // ChandelierProp (slow spin + emissive bulbs).
      return <ChandelierGeometry accent={accent} />;
    case "floorlamp":
      return (
        <group>
          <mesh position={[0, 0.9, 0]}>
            <cylinderGeometry args={[0.03, 0.05, 1.8, 6]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.95, 0]}>
            <coneGeometry args={[0.38, 0.45, 9]} />
            <meshStandardMaterial
              color="#f2e6c8"
              emissive="#f2e6c8"
              emissiveIntensity={0.55}
              roughness={1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "desk":
      return (
        <group>
          <mesh position={[0, 0.76, 0]}>
            <boxGeometry args={[1.5, 0.08, 0.75]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {[
            [-0.66, -0.28],
            [0.66, -0.28],
            [-0.66, 0.28],
            [0.66, 0.28],
          ].map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.37, z]}>
              <boxGeometry args={[0.08, 0.74, 0.08]} />
              <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "giftbox":
      return (
        <group>
          <mesh position={[0, 0.28, 0]}>
            <boxGeometry args={[0.55, 0.55, 0.55]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.6, 0]}>
            <boxGeometry args={[0.6, 0.12, 0.6]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <boxGeometry args={[0.1, 0.48, 0.58]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "column":
      return (
        <group>
          <mesh position={[0, 0.1, 0]}>
            <boxGeometry args={[0.9, 0.2, 0.9]} />
            <meshStandardMaterial color="#9a938a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, WALL_HEIGHT / 2 + 0.1, 0]}>
            <cylinderGeometry args={[0.3, 0.34, WALL_HEIGHT, 10]} />
            <meshStandardMaterial color="#b0a99e" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "suitcase":
      // Upright trolley case: shell, a proud lid-seam band around the
      // middle, and a two-stub handle on top.
      return (
        <group>
          <mesh position={[0, 0.33, 0]}>
            <boxGeometry args={[0.44, 0.62, 0.2]} />
            <meshStandardMaterial color="#8a6642" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <boxGeometry args={[0.46, 0.035, 0.22]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
          {[-0.1, 0.1].map((x) => (
            <mesh key={x} position={[x, 0.66, 0]}>
              <boxGeometry args={[0.03, 0.06, 0.03]} />
              <meshStandardMaterial
                color="#3a3a3e"
                roughness={0.6}
                metalness={0.3}
                flatShading
              />
            </mesh>
          ))}
          <mesh position={[0, 0.7, 0]}>
            <boxGeometry args={[0.23, 0.03, 0.04]} />
            <meshStandardMaterial
              color="#3a3a3e"
              roughness={0.6}
              metalness={0.3}
              flatShading
            />
          </mesh>
        </group>
      );
    case "luggagecart":
      // Bellhop trolley: a low deck on four castors, two brass uprights
      // and the stack rail across their tops.
      return (
        <group>
          <mesh position={[0, 0.2, 0]}>
            <boxGeometry args={[0.6, 0.06, 1.0]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {[-0.24, 0.24].flatMap((x) =>
            [-0.42, 0.42].map((z) => (
              <mesh key={`${x}${z}`} position={[x, 0.07, z]}>
                <sphereGeometry args={[0.07, 7, 5]} />
                <meshStandardMaterial
                  color="#3a3a3e"
                  roughness={0.6}
                  metalness={0.3}
                  flatShading
                />
              </mesh>
            )),
          )}
          {[-0.26, 0.26].map((x) => (
            <mesh key={x} position={[x, 0.98, -0.42]}>
              <cylinderGeometry args={[0.03, 0.03, 1.56, 6]} />
              <meshStandardMaterial
                color="#c8b06a"
                roughness={0.4}
                metalness={0.6}
                flatShading
              />
            </mesh>
          ))}
          <mesh
            position={[0, 1.76, -0.42]}
            rotation={[0, 0, Math.PI / 2]}
          >
            <cylinderGeometry args={[0.03, 0.03, 0.58, 6]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
        </group>
      );
    case "bell":
      // Reception bell: dark plinth, brass dome, button. Sits on a counter
      // (kits lift it with dy — supported, never floating).
      return (
        <group>
          <mesh position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.1, 0.12, 0.04, 10]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.055, 0]} scale={[1, 0.68, 1]}>
            <sphereGeometry args={[0.085, 10, 7]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.3}
              metalness={0.7}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.125, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.03, 5]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.3}
              metalness={0.7}
              flatShading
            />
          </mesh>
        </group>
      );
    case "register":
      // The ledger: cover boards around a cream page block, ribbon marker.
      return (
        <group>
          <mesh position={[0, 0.015, 0]}>
            <boxGeometry args={[0.4, 0.03, 0.3]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.055, 0]}>
            <boxGeometry args={[0.36, 0.05, 0.26]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.095, 0]}>
            <boxGeometry args={[0.4, 0.03, 0.3]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.12, 0.112, 0]}>
            <boxGeometry args={[0.03, 0.006, 0.3]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "towelstack":
      // Three folded towels, slightly uneven, one rolled on top.
      return (
        <group>
          <mesh position={[0, 0.05, 0]}>
            <boxGeometry args={[0.42, 0.1, 0.32]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.01, 0.145, 0]}>
            <boxGeometry args={[0.4, 0.09, 0.3]} />
            <meshStandardMaterial color="#e8e4da" roughness={1} flatShading />
          </mesh>
          <mesh position={[-0.01, 0.235, 0]} rotation={[0, 0.12, 0]}>
            <boxGeometry args={[0.36, 0.09, 0.28]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh
            position={[0, 0.34, 0]}
            rotation={[0, 0.35, Math.PI / 2]}
          >
            <cylinderGeometry args={[0.055, 0.055, 0.3, 8]} />
            <meshStandardMaterial color="#e8e4da" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "lockerrow":
      // A three-door locker cabinet on a plinth — the middle door ajar
      // (hinged at its left edge, swung into the room): the "someone was
      // just here" beat, baked into the geometry.
      return (
        <group>
          <mesh position={[0, 0.05, 0]}>
            <boxGeometry args={[1.64, 0.1, 0.54]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.0, 0]}>
            <boxGeometry args={[1.6, 1.9, 0.5]} />
            <meshStandardMaterial
              color="#8a949e"
              roughness={0.6}
              metalness={0.4}
              flatShading
            />
          </mesh>
          {[-0.53, 0.53].map((x) => (
            <group key={x}>
              <mesh position={[x, 1.0, 0.26]}>
                <boxGeometry args={[0.5, 1.78, 0.03]} />
                <meshStandardMaterial
                  color="#94a0aa"
                  roughness={0.55}
                  metalness={0.4}
                  flatShading
                />
              </mesh>
              <mesh position={[x + 0.19 * Math.sign(x) * -1, 1.0, 0.29]}>
                <boxGeometry args={[0.03, 0.12, 0.03]} />
                <meshStandardMaterial
                  color="#3a3a3e"
                  roughness={0.6}
                  flatShading
                />
              </mesh>
            </group>
          ))}
          {/* The ajar door: hinge group on its left jamb, swung open. */}
          <group position={[-0.26, 0, 0.26]} rotation={[0, -0.55, 0]}>
            <mesh position={[0.26, 1.0, 0]}>
              <boxGeometry args={[0.5, 1.78, 0.03]} />
              <meshStandardMaterial
                color="#94a0aa"
                roughness={0.55}
                metalness={0.4}
                flatShading
              />
            </mesh>
            <mesh position={[0.44, 1.0, 0.03]}>
              <boxGeometry args={[0.03, 0.12, 0.03]} />
              <meshStandardMaterial
                color="#3a3a3e"
                roughness={0.6}
                flatShading
              />
            </mesh>
          </group>
        </group>
      );
    case "chair":
      // A plain side chair — four legs, seat, backrest. Deliberately
      // sparer than the cushioned readingchair (cylinder base, wrap back)
      // so the two never read as the same piece.
      return (
        <group>
          {[-0.18, 0.18].flatMap((x) =>
            [-0.18, 0.18].map((z) => (
              <mesh key={`${x}${z}`} position={[x, 0.225, z]}>
                <boxGeometry args={[0.05, 0.45, 0.05]} />
                <meshStandardMaterial
                  color="#6b4f3a"
                  roughness={1}
                  flatShading
                />
              </mesh>
            )),
          )}
          <mesh position={[0, 0.48, 0]}>
            <boxGeometry args={[0.44, 0.06, 0.44]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.78, -0.19]}>
            <boxGeometry args={[0.44, 0.54, 0.06]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "coatstand":
      // Pole on a disc foot, three pegs near the top, a knob.
      return (
        <group>
          <mesh position={[0, 0.03, 0]}>
            <cylinderGeometry args={[0.24, 0.28, 0.06, 10]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.9, 0]}>
            <cylinderGeometry args={[0.035, 0.045, 1.75, 7]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.82, 0]}>
            <sphereGeometry args={[0.055, 7, 6]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          {[0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((a) => (
            <group key={a} rotation={[0, a, 0]}>
              <mesh
                position={[0.1, 1.58, 0]}
                rotation={[0, 0, -0.5]}
              >
                <cylinderGeometry args={[0.02, 0.02, 0.22, 5]} />
                <meshStandardMaterial
                  color="#6b4f3a"
                  roughness={1}
                  flatShading
                />
              </mesh>
            </group>
          ))}
        </group>
      );
    case "umbrellastand":
      // A tall cylindrical stand with two closed umbrellas — slim cones
      // tip-down, handles up, leaning against each other.
      return (
        <group>
          <mesh position={[0, 0.26, 0]}>
            <cylinderGeometry args={[0.16, 0.13, 0.52, 10]} />
            <meshStandardMaterial
              color="#3a3a3e"
              roughness={0.6}
              metalness={0.3}
              flatShading
            />
          </mesh>
          {(
            [
              [0.04, 0.03, 0.14, accent],
              [-0.05, -0.04, -0.18, "#f2ede2"],
            ] as const
          ).map(([x, z, lean, color]) => (
            <group
              key={`${x}${z}`}
              position={[x, 0, z]}
              rotation={[0, 0, lean]}
            >
              <mesh position={[0, 0.62, 0]}>
                <cylinderGeometry args={[0.015, 0.015, 0.95, 5]} />
                <meshStandardMaterial
                  color="#6b4f3a"
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 0.62, 0]} rotation={[Math.PI, 0, 0]}>
                <coneGeometry args={[0.055, 0.55, 6]} />
                <meshStandardMaterial
                  color={color}
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 1.13, 0]}>
                <sphereGeometry args={[0.03, 6, 5]} />
                <meshStandardMaterial
                  color="#6b4f3a"
                  roughness={1}
                  flatShading
                />
              </mesh>
            </group>
          ))}
        </group>
      );
    case "bucket":
      // Tapered pail, darker inset so it reads hollow, arched handle.
      return (
        <group>
          <mesh position={[0, 0.15, 0]}>
            <cylinderGeometry args={[0.2, 0.14, 0.3, 10]} />
            <meshStandardMaterial
              color="#9aa0a6"
              roughness={0.5}
              metalness={0.5}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.26, 0]}>
            <cylinderGeometry args={[0.17, 0.17, 0.03, 10]} />
            <meshStandardMaterial color="#3a4a52" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.3, 0]}>
            <torusGeometry args={[0.17, 0.015, 5, 10, Math.PI]} />
            <meshStandardMaterial
              color="#3a3a3e"
              roughness={0.6}
              metalness={0.3}
              flatShading
            />
          </mesh>
        </group>
      );
    case "tray":
      // Serving tray with a raised lip on the long sides and two cups —
      // the dining table's tableware (lifted onto it with dy).
      return (
        <group>
          <mesh position={[0, 0.015, 0]}>
            <boxGeometry args={[0.5, 0.03, 0.34]} />
            <meshStandardMaterial color="#8a6642" roughness={1} flatShading />
          </mesh>
          {[-0.16, 0.16].map((z) => (
            <mesh key={z} position={[0, 0.05, z]}>
              <boxGeometry args={[0.5, 0.04, 0.02]} />
              <meshStandardMaterial
                color="#6b4f3a"
                roughness={1}
                flatShading
              />
            </mesh>
          ))}
          {[-0.12, 0.12].map((x) => (
            <mesh key={x} position={[x, 0.075, 0]}>
              <cylinderGeometry args={[0.04, 0.032, 0.09, 8]} />
              <meshStandardMaterial
                color="#f2ede2"
                roughness={1}
                flatShading
              />
            </mesh>
          ))}
        </group>
      );
    case "bookpile":
      // A loose stack of books, each rotated a little, one leaning against
      // the pile — the bookshelf's colors, freed from the shelf.
      return (
        <group>
          {(
            [
              [0, 0.025, 0.34, 0.05, 0.26, 0, "#c4553f"],
              [0.01, 0.075, 0.3, 0.045, 0.24, 0.2, "#5a7a44"],
              [-0.01, 0.12, 0.32, 0.045, 0.25, -0.15, "#e8c95a"],
              [0, 0.165, 0.26, 0.04, 0.2, 0.35, "#7a6a55"],
            ] as const
          ).map(([x, y, w, h, d, r, color]) => (
            <mesh key={y} position={[x, y, 0]} rotation={[0, r, 0]}>
              <boxGeometry args={[w, h, d]} />
              <meshStandardMaterial
                color={color}
                roughness={1}
                flatShading
              />
            </mesh>
          ))}
          <mesh position={[0.26, 0.09, 0]} rotation={[0, 0.1, 0.35]}>
            <boxGeometry args={[0.05, 0.24, 0.2]} />
            <meshStandardMaterial color="#c4553f" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "yarn":
      return (
        <mesh position={[0, 0.18, 0]}>
          <sphereGeometry args={[0.18, 8, 6]} />
          <meshStandardMaterial color={accent} roughness={1} flatShading />
        </mesh>
      );
    case "cattree":
      return (
        <group>
          <mesh position={[0, 0.6, 0]}>
            <cylinderGeometry args={[0.09, 0.11, 1.2, 6]} />
            <meshStandardMaterial color="#a89880" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.25, 0]}>
            <cylinderGeometry args={[0.38, 0.38, 0.08, 9]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          <mesh position={[0.18, 0.7, 0.12]}>
            <boxGeometry args={[0.4, 0.35, 0.4]} />
            <meshStandardMaterial color="#a89880" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "scratchpost":
      return (
        <group>
          <mesh position={[0, 0.04, 0]}>
            <boxGeometry args={[0.45, 0.08, 0.45]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <cylinderGeometry args={[0.11, 0.11, 0.72, 7]} />
            <meshStandardMaterial color="#c9a26b" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "doghouse":
      return (
        <group>
          <mesh position={[0, 0.4, 0]}>
            <boxGeometry args={[0.9, 0.8, 1.0]} />
            <meshStandardMaterial color="#e0643c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.95, 0]} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[0.85, 0.4, 4]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.32, 0.51]}>
            <boxGeometry args={[0.34, 0.5, 0.04]} />
            <meshStandardMaterial color="#3a3230" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "bone":
      return (
        <group>
          <mesh position={[0, 0.09, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.05, 0.05, 0.42, 6]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          {[-0.21, 0.21].flatMap((x) =>
            [-0.045, 0.045].map((z) => (
              <mesh key={`${x}${z}`} position={[x, 0.09, z]}>
                <sphereGeometry args={[0.08, 6, 5]} />
                <meshStandardMaterial
                  color="#f2ede2"
                  roughness={1}
                  flatShading
                />
              </mesh>
            )),
          )}
        </group>
      );
    case "ball":
      return (
        <mesh position={[0, 0.15, 0]}>
          <sphereGeometry args={[0.15, 9, 7]} />
          <meshStandardMaterial color={accent} roughness={0.9} flatShading />
        </mesh>
      );
  }
}

/** Chandelier geometry shared by the static fallback and the animated
 *  prop: floats ~3.2m up (no ceiling — that is the surrealism), ring of
 *  warm emissive bulbs. */
function ChandelierGeometry({ accent }: { accent: string }) {
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 3.75, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.7, 5]} />
        <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 3.35, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.55, 0.05, 6, 14]} />
        <meshStandardMaterial color={accent} roughness={0.8} flatShading />
      </mesh>
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 0.55, 3.42, Math.sin(a) * 0.55]}
          >
            <sphereGeometry args={[0.09, 7, 6]} />
            <meshStandardMaterial
              color="#ffe9b0"
              emissive="#ffe9b0"
              emissiveIntensity={0.9}
              roughness={1}
              flatShading
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** Animated chandelier: slow spin around its chain. */
function ChandelierProp({ accent }: { accent: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    const g = ref.current;
    if (g) g.rotation.y += Math.min(delta, 0.05) * 0.15;
  });
  return (
    <group ref={ref}>
      <ChandelierGeometry accent={accent} />
    </group>
  );
}

/** Animated TV: the screen flickers (noise-driven emissive intensity) and
 *  slowly cycles its tint — a TV left on in an impossible room. */
function TvProp({ accent }: { accent: string }) {
  const screenRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const m = screenRef.current;
    if (!m) return;
    const n =
      Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.7) * Math.sin(t * 0.9 + 0.4);
    m.emissiveIntensity = 0.6 + 0.35 * (0.5 + 0.5 * n);
    m.emissive.setHSL((t * 0.025) % 1, 0.5, 0.55);
  });
  return (
    <group>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[0.5, 0.4, 0.3]} />
        <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.95, 0]}>
        <boxGeometry args={[1.25, 0.75, 0.08]} />
        <meshStandardMaterial
          ref={screenRef}
          color="#101014"
          emissive={accent}
          emissiveIntensity={0.7}
          roughness={1}
          flatShading
        />
      </mesh>
    </group>
  );
}

/** Dispatch a placement to static geometry or its animated component. */
function MotifProp({
  kind,
  accent,
  canopyColor,
}: {
  kind: MotifKind;
  accent: string;
  canopyColor: THREE.Color;
}) {
  switch (kind) {
    case "tv":
      return <TvProp accent={accent} />;
    case "chandelier":
      return <ChandelierProp accent={accent} />;
    default:
      return (
        <MotifGeometry kind={kind} accent={accent} canopyColor={canopyColor} />
      );
  }
}

/**
 * Legacy seeded layout for the rooms kits do NOT cover: the pool-hall's
 * water-anchored fixtures (ladder on the rim, loungers on the far deck,
 * columns at the water corners — pool-side kits are milestone N2) and the
 * wonder dioramas' oversized accent rugs. The flat interior archetypes
 * (hotel-room / library / ballroom) are furnished by kits instead — see
 * stageInteriorKits (lib/game/kits.ts), which replaced this function's
 * old fixed checklists with composed, wall-anchored groupings.
 *
 * Positions come from the "furniture" seed stream and the SCALED recipe
 * view, clamped inside the plan's walkable footprint (an l-shape's
 * abandoned quadrant never receives furniture); returned scales are
 * ABSOLUTE (prop scale already folded in), matching the kit path.
 */
function furnishInterior(
  rng: () => number,
  scaled: SpaceRecipe,
  water: WaterRect | null,
  plan: RoomPlan,
  propScale: number,
  doors: readonly RoomDoorPlacement[],
): PropPlacement[] {
  const { extent, width } = dims(scaled);
  const out: PropPlacement[] = [];
  const jitter = (amount: number) => (rng() * 2 - 1) * amount;
  // Clearances ride the prop scale: giant furniture needs giant margins,
  // dollhouse furniture keeps its dollhouse clearances.
  const m = Math.max(0.2, propScale);
  const put = (
    kind: MotifKind,
    x: number,
    z: number,
    rotY: number,
    scale = 1,
  ) => {
    let cx = Math.min(Math.max(x, -width / 2 + m), width / 2 - m);
    const cz = Math.min(Math.max(z, 1.2 * m), extent - 1.2 * m);
    if (plan.id === "l-shape" && cz > plan.stepZ) {
      // Beyond the step only the kept half exists.
      cx =
        plan.lSide > 0
          ? Math.min(Math.max(cx, m), width / 2 - m)
          : Math.min(Math.max(cx, -width / 2 + m), -m);
    }
    // Strand-door approaches (B.11): a solid fixture that lands in a door's
    // strip is dropped, never nudged (determinism: the draw is consumed
    // either way). Flat rugs are exempt — they are floor dressing you walk
    // OVER, and the entrance corridor already tolerates them.
    if (kind !== "rug" && inDoorApproach(cx, cz, doors)) return;
    out.push({
      kind,
      x: cx,
      y: terrainHeight(scaled, cx, cz),
      z: cz,
      rotY,
      scale: scale * propScale,
    });
  };

  switch (scaled.archetype) {
    case "balloons":
    case "cats":
    case "dogs": {
      // Big vivid floors need dressing too: 1–3 oversized accent rugs,
      // seeded, door corridor clear (put clamps both axes).
      const rugs = extent >= 64 ? 3 : extent >= 32 ? 2 : 1;
      for (let i = 0; i < rugs; i++) {
        put(
          "rug",
          (rng() * 2 - 1) * (width / 2 - 4),
          extent * (0.25 + rng() * 0.5),
          rng() * Math.PI * 2,
          1.4 + rng() * 0.8,
        );
      }
      break;
    }
    case "pool-hall": {
      if (water) {
        // Ladder on a non-entrance rim side, loungers along the far deck,
        // columns at the water corners.
        const side = rng() < 0.5 ? 1 : -1;
        put(
          "ladder",
          side * Math.min(water.halfX + 0.3, width / 2 - 0.55),
          water.cz + jitter(water.halfZ * 0.6),
          side > 0 ? Math.PI / 2 : -Math.PI / 2,
        );
        for (let i = 0; i < (extent >= 64 ? 4 : 2); i++) {
          put(
            "lounger",
            -width / 4 + i * (width / 2 / Math.max(1, (extent >= 64 ? 3 : 1))) + jitter(0.3),
            Math.min(water.cz + water.halfZ + 1.2, extent - 1.4),
            Math.PI + jitter(0.2),
          );
        }
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            put(
              "column",
              sx * Math.min(water.halfX + 1.1, width / 2 - 0.9),
              water.cz + sz * (water.halfZ + 1.1),
              0,
            );
          }
        }
      }
      break;
    }
  }
  return out;
}

/** Internal structure on big plans: a partition wall with a door gap, or
 *  a column grid — seeded, never blocking the entrance corridor, and kept
 *  inside the plan's footprint (an l-shape's abandoned quadrant never
 *  grows structure: partitions stop short of the step, column points
 *  outside the kept leg are dropped). Strand-door approaches (B.11) stay
 *  clear too: column points inside a door's strip are dropped, and a
 *  partition that would cross ANY door's strip is forfeited (the wall
 *  would split the approach off from the room — dropping it keeps the
 *  door walkable-to; nudging it would perturb the seeded stream). */
type Structure =
  | { kind: "none" }
  | { kind: "partition"; z: number; gapX: number }
  | { kind: "columns"; points: { x: number; z: number }[] };

/** Axis-aligned bounds of one door's approach strip (ROOM_DOOR_CLEAR_*
 *  shaping: half to each side along the wall, depth inward along the
 *  probed normal). */
function doorStripBounds(
  d: RoomDoorPlacement,
): { x0: number; x1: number; z0: number; z1: number } {
  return {
    x0: d.x + (d.nx !== 0 ? Math.min(0, d.nx * ROOM_DOOR_CLEAR_DEPTH) : -ROOM_DOOR_CLEAR_HALF),
    x1: d.x + (d.nx !== 0 ? Math.max(0, d.nx * ROOM_DOOR_CLEAR_DEPTH) : ROOM_DOOR_CLEAR_HALF),
    z0: d.z + (d.nz !== 0 ? Math.min(0, d.nz * ROOM_DOOR_CLEAR_DEPTH) : -ROOM_DOOR_CLEAR_HALF),
    z1: d.z + (d.nz !== 0 ? Math.max(0, d.nz * ROOM_DOOR_CLEAR_DEPTH) : ROOM_DOOR_CLEAR_HALF),
  };
}

/** Does a full-width partition at zp (gap at gapX) cross any door's
 *  approach strip? The partition's solid runs are [−halfW, gapX −
 *  DOOR_GAP_HALF] and [gapX + DOOR_GAP_HALF, halfW]. */
function partitionBlocksDoor(
  zp: number,
  gapX: number,
  halfW: number,
  doors: readonly RoomDoorPlacement[],
): boolean {
  // Conservative z band for the partition's thickness.
  const pz0 = zp - 0.5;
  const pz1 = zp + 0.5;
  for (const d of doors) {
    const s = doorStripBounds(d);
    if (s.z1 < pz0 || s.z0 > pz1) continue;
    const ox0 = Math.max(s.x0, -halfW);
    const ox1 = Math.min(s.x1, halfW);
    if (ox1 < ox0) continue;
    // The strip only survives the partition where the gap covers it.
    if (ox0 < gapX - DOOR_GAP_HALF || ox1 > gapX + DOOR_GAP_HALF) return true;
  }
  return false;
}

function buildStructure(
  rng: () => number,
  scaled: SpaceRecipe,
  plan: RoomPlan,
  doors: readonly RoomDoorPlacement[],
): Structure {
  const { extent, width } = dims(scaled);
  if (extent < STRUCTURE_MIN_EXTENT) return { kind: "none" };
  const roll = rng();
  if (roll < 0.45) return { kind: "none" };
  if (roll < 0.75) {
    let z = extent * (0.42 + rng() * 0.16);
    if (plan.id === "l-shape") {
      // A partition spans the full width, so it only exists in the
      // full-width near zone — never across the abandoned quadrant.
      z = Math.min(z, plan.stepZ - 2);
    }
    if (z < extent * 0.25) return { kind: "none" };
    const gapX = (rng() * 2 - 1) * (width / 2 - 2.4);
    if (partitionBlocksDoor(z, gapX, width / 2, doors)) {
      return { kind: "none" };
    }
    return {
      kind: "partition",
      z,
      gapX,
    };
  }
  const n = rng() < 0.5 ? 2 : 3;
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -width / 4 + (i * width) / (2 * (n - 1) || 1);
      const z = extent * 0.3 + (j * extent * 0.5) / (n - 1 || 1);
      if (planContains(plan, x, z, 1) && !inDoorApproach(x, z, doors)) {
        points.push({ x, z });
      }
    }
  }
  if (points.length < 4) return { kind: "none" };
  return { kind: "columns", points };
}

/** One rubber duck's seeded base state (bobbing/drift are clock-driven). */
interface DuckSeed {
  x: number;
  z: number;
  phase: number;
  scale: number;
  spin: number;
  heading: number;
}

/** A pool full of rubber ducks: instanced body/head/beak, per-duck bob
 *  (phase-offset sine) and a very slow circular drift. Cute by decree:
 *  round body, big head, orange beak. */
function Ducks({ ducks }: { ducks: DuckSeed[] }) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const beakRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const count = ducks.length;

  // The beak cone points +Y by default; bake the forward-pointing rotation
  // into the shared geometry once so instance matrices stay translations.
  useLayoutEffect(() => {
    const beak = beakRef.current;
    if (beak) beak.geometry.rotateX(Math.PI / 2);
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const body = bodyRef.current;
    const head = headRef.current;
    const beak = beakRef.current;
    if (!body || !head || !beak) return;
    const surfaceY = WATER_Y + Math.sin(t * 0.6) * 0.02;
    ducks.forEach((d, i) => {
      const s = d.scale;
      const x = d.x + Math.sin(t * 0.05 + d.phase) * 0.4;
      const z = d.z + Math.cos(t * 0.04 + d.phase * 1.3) * 0.4;
      const y =
        surfaceY + 0.02 + Math.sin(t * 0.9 + d.phase) * 0.045;
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, d.heading + t * d.spin, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      m4.makeTranslation(0, 0.19 * s, 0.22 * s);
      head.setMatrixAt(i, m4.premultiply(dummy.matrix));
      m4.makeTranslation(0, 0.17 * s, 0.36 * s);
      beak.setMatrixAt(i, m4.premultiply(dummy.matrix));
    });
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    beak.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={bodyRef}
        args={[undefined, undefined, count]}
        frustumCulled={false}
        castShadow
        receiveShadow
      >
        <sphereGeometry args={[0.26, 9, 7]} />
        <meshStandardMaterial color="#ffd23f" roughness={0.9} flatShading />
      </instancedMesh>
      <instancedMesh
        ref={headRef}
        args={[undefined, undefined, count]}
        frustumCulled={false}
        castShadow
        receiveShadow
      >
        <sphereGeometry args={[0.15, 8, 6]} />
        <meshStandardMaterial color="#ffd23f" roughness={0.9} flatShading />
      </instancedMesh>
      <instancedMesh
        ref={beakRef}
        args={[undefined, undefined, count]}
        frustumCulled={false}
        castShadow
        receiveShadow
      >
        <coneGeometry args={[0.06, 0.14, 6]} />
        <meshStandardMaterial color="#f08a24" roughness={0.9} flatShading />
      </instancedMesh>
    </>
  );
}

/** Low-poly pet geometry — round body, oversized head: cute, not realistic. */
function PetGeometry({ kind, color }: { kind: "cat" | "dog"; color: string }) {
  if (kind === "cat") {
    return (
      <group>
        <mesh position={[0, 0.24, 0]} scale={[1, 0.8, 1.35]}>
          <sphereGeometry args={[0.21, 9, 7]} />
          <meshStandardMaterial color={color} roughness={1} flatShading />
        </mesh>
        <mesh position={[0, 0.4, 0.26]}>
          <sphereGeometry args={[0.15, 9, 7]} />
          <meshStandardMaterial color={color} roughness={1} flatShading />
        </mesh>
        {[-0.08, 0.08].map((x) => (
          <mesh key={x} position={[x, 0.53, 0.24]}>
            <coneGeometry args={[0.05, 0.11, 4]} />
            <meshStandardMaterial color={color} roughness={1} flatShading />
          </mesh>
        ))}
        <mesh position={[0, 0.36, -0.32]} rotation={[-0.7, 0, 0]}>
          <cylinderGeometry args={[0.03, 0.045, 0.4, 5]} />
          <meshStandardMaterial color={color} roughness={1} flatShading />
        </mesh>
      </group>
    );
  }
  return (
    <group>
      <mesh position={[0, 0.28, 0]} scale={[1, 0.85, 1.4]}>
        <sphereGeometry args={[0.25, 9, 7]} />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.46, 0.32]}>
        <sphereGeometry args={[0.18, 9, 7]} />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.4, 0.47]}>
        <boxGeometry args={[0.17, 0.11, 0.15]} />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>
      {[-0.11, 0.11].map((x) => (
        <mesh key={x} position={[x, 0.6, 0.3]} rotation={[0, 0, x > 0 ? -0.25 : 0.25]}>
          <boxGeometry args={[0.07, 0.16, 0.05]} />
          <meshStandardMaterial color={color} roughness={1} flatShading />
        </mesh>
      ))}
      <mesh position={[0, 0.44, -0.38]} rotation={[-0.9, 0, 0]}>
        <cylinderGeometry args={[0.035, 0.05, 0.38, 5]} />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>
    </group>
  );
}

/** One pet's seeded walk data. */
interface Pet {
  waypoints: [number, number][];
  speed: number;
  scale: number;
  color: string;
  phase: number;
}

const PET_COLORS = {
  cat: ["#e8935c", "#9aa0a6", "#4a4a50", "#f2ede2"],
  dog: ["#d9a05c", "#8a6642", "#f2ede2", "#5c5c60"],
} as const;

/** Seeded pet walking: polyline waypoints, walk → pause → sit cycles, a
 *  little bob while moving. Timing is visual (clock); the path layout is
 *  seed-fixed. */
function PetAnimals({ kind, pets }: { kind: "cat" | "dog"; pets: Pet[] }) {
  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const runtime = useRef(
    pets.map(() => ({
      wp: 0,
      timer: 0,
      mode: "walk" as "walk" | "pause" | "sit",
      px: 0,
      pz: 0,
      ready: false,
    })),
  );

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const dt = Math.min(delta, 0.05);
    pets.forEach((pet, i) => {
      const g = groupRefs.current[i];
      if (!g) return;
      const s = runtime.current[i];
      const target = pet.waypoints[s.wp];
      if (!s.ready) {
        s.px = target[0];
        s.pz = target[1];
        s.ready = true;
      }
      let y = GROUND_Y;
      if (s.mode === "walk") {
        const dx = target[0] - s.px;
        const dz = target[1] - s.pz;
        const d = Math.hypot(dx, dz);
        if (d < 0.15) {
          const modePick = (i + s.wp) % 3;
          s.mode = modePick === 0 ? "pause" : modePick === 1 ? "sit" : "walk";
          s.timer = s.mode === "pause" ? 1.4 : s.mode === "sit" ? 2.4 : 0;
          if (s.mode === "walk") s.wp = (s.wp + 1) % pet.waypoints.length;
        } else {
          const step = Math.min(pet.speed * dt, d);
          s.px += (dx / d) * step;
          s.pz += (dz / d) * step;
          g.rotation.y = Math.atan2(dx, dz);
          y += Math.abs(Math.sin(t * 9 + pet.phase)) * 0.035;
        }
      } else {
        s.timer -= dt;
        if (s.mode === "sit") y -= 0.04;
        if (s.timer <= 0) {
          s.wp = (s.wp + 1) % pet.waypoints.length;
          s.mode = "walk";
        }
      }
      g.position.set(s.px, y, s.pz);
      const targetScaleY = s.mode === "sit" ? 0.82 : 1;
      g.scale.y += (targetScaleY - g.scale.y) * Math.min(1, dt * 8);
    });
  });

  return (
    <>
      {pets.map((pet, i) => (
        <group
          key={i}
          ref={(g) => {
            groupRefs.current[i] = g;
          }}
          scale={pet.scale}
        >
          <Shadowed>
            <PetGeometry kind={kind} color={pet.color} />
          </Shadowed>
        </group>
      ))}
    </>
  );
}

/** One balloon bunch: balloons on strings anchored to a gift box — floats
 *  gently (intentionally airborne; everything else in the room stays put).
 *  `data` is authored at human scale; `scale` (the room's creature scale)
 *  sizes the visuals so a colossal room gets grand but readable bunches. */
interface BalloonData {
  x: number;
  z: number;
  phase: number;
  balloons: { dx: number; dz: number; y: number; r: number; color: string }[];
}

function BalloonBunch({ data, scale }: { data: BalloonData; scale: number }) {
  const floatRef = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = floatRef.current;
    if (!g) return;
    const t = clock.elapsedTime;
    g.position.y = Math.sin(t * 0.35 + data.phase) * 0.25 * scale;
    g.rotation.y = Math.sin(t * 0.12 + data.phase) * 0.2;
  });
  return (
    <Shadowed>
      <group position={[data.x, GROUND_Y, data.z]}>
        <group ref={floatRef}>
          {data.balloons.map((b, i) => (
            <group key={i}>
              <mesh position={[b.dx * scale, b.y * scale, b.dz * scale]}>
                <sphereGeometry args={[b.r * scale, 10, 8]} />
                <meshStandardMaterial color={b.color} roughness={0.6} flatShading />
              </mesh>
              <mesh position={[(b.dx * scale) / 2, (b.y * scale) / 2, (b.dz * scale) / 2]}>
                <cylinderGeometry args={[0.008 * scale, 0.008 * scale, b.y * scale, 4]} />
                <meshStandardMaterial color="#d8d4cc" roughness={1} flatShading />
              </mesh>
            </group>
          ))}
        </group>
        {/* The anchor: a gift box the strings are tied to. */}
        <group scale={scale}>
          <mesh position={[0, 0.28, 0]}>
            <boxGeometry args={[0.55, 0.55, 0.55]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.58, 0]}>
            <boxGeometry args={[0.6, 0.1, 0.6]} />
            <meshStandardMaterial color="#e0643c" roughness={1} flatShading />
          </mesh>
        </group>
      </group>
    </Shadowed>
  );
}

/** Wonder-room animal data, all from the "animals" seed stream. Creatures
 *  scale by the room's creature scale (S^0.5): they are characters whose
 *  readability matters more than their role as a scale cue — a colossal
 *  room gets noticeably-large ducks, not building-sized ones. Pet orbits
 *  are capped at PET_NEAR_RADIUS_MAX so animals stay near the door (where
 *  the player is) instead of wandering a colossal room's far reach. */
function buildAnimals(
  rng: () => number,
  recipe: SpaceRecipe,
  scaled: SpaceRecipe,
  water: WaterRect | null,
  plan: RoomPlan,
  creatureScale: number,
  doors: readonly RoomDoorPlacement[],
): {
  ducks: DuckSeed[];
  pets: { kind: "cat" | "dog"; pets: Pet[] };
  balloons: BalloonData[];
} {
  const { extent, width } = dims(scaled);
  const ducks: DuckSeed[] = [];
  const pets: Pet[] = [];
  const balloons: BalloonData[] = [];
  // Counts are authored per UNscaled tier, like every other population.
  const baseExtent = recipe.size.extent;
  const petCount = PET_COUNT[baseExtent] ?? 4;

  if (scaled.archetype === "ducks" && water) {
    const count = DUCK_COUNT[baseExtent] ?? 30;
    for (let i = 0; i < count; i++) {
      // Strand-door approaches (B.11): a duck's bob/drift is clock-driven
      // and may wander through a strip at runtime, but its seeded base
      // never STARTS parked in front of a door. Bounded redraw; rooms
      // without doors spend the exact same draws as before.
      let dx = water.cx;
      let dz = water.cz;
      for (let tries = 0; tries < 12; tries++) {
        dx = water.cx + (rng() * 2 - 1) * Math.max(0.3, water.halfX - 0.8);
        dz = water.cz + (rng() * 2 - 1) * Math.max(0.3, water.halfZ - 0.8);
        if (doors.length === 0 || !inDoorApproach(dx, dz, doors)) break;
      }
      ducks.push({
        x: dx,
        z: dz,
        phase: rng() * Math.PI * 2,
        scale: (0.8 + rng() * 0.45) * creatureScale,
        spin: (rng() - 0.5) * 0.4,
        heading: rng() * Math.PI * 2,
      });
    }
  }

  if (scaled.archetype === "cats" || scaled.archetype === "dogs") {
    const colors =
      PET_COLORS[scaled.archetype === "cats" ? "cat" : "dog"];
    // Waypoints concentrate around the doorway circle (radius extent·0.3,
    // capped for colossal rooms) so an animal crosses the player's view
    // soon after entering; a third of them roam wider to keep the room alive.
    const nearR = Math.min(extent * 0.3, PET_NEAR_RADIUS_MAX);
    for (let i = 0; i < petCount; i++) {
      const waypoints: [number, number][] = [];
      const n = 4 + Math.floor(rng() * 2);
      for (let w = 0; w < n; w++) {
        // Strand-door approaches (B.11): waypoints are where a pet walks
        // AND LINGERS — none may sit in a door's strip. Bounded redraw;
        // rooms without doors spend the exact same draws as before.
        let cand: [number, number] = [0, extent * 0.4];
        for (let tries = 0; tries < 12; tries++) {
          if (rng() < 0.7) {
            const a = rng() * Math.PI * 2;
            const r = Math.sqrt(rng()) * nearR;
            cand = [
              Math.cos(a) * r,
              Math.min(Math.max(extent * 0.12 + Math.sin(a) * r, 1.8), extent - 1.8),
            ];
          } else {
            cand = [
              (rng() * 2 - 1) * Math.max(8, (width / 2 - 1.8) * 0.75),
              2 + rng() * (extent - 4),
            ];
          }
          if (doors.length === 0 || !inDoorApproach(cand[0], cand[1], doors)) {
            break;
          }
        }
        waypoints.push(cand);
      }
      pets.push({
        waypoints,
        speed: 1.0 + rng() * 0.6,
        scale: (0.85 + rng() * 0.3) * creatureScale,
        color: colors[Math.floor(rng() * colors.length)],
        phase: rng() * Math.PI * 2,
      });
    }
  }

  if (scaled.archetype === "balloons") {
    const bunches = BALLOON_BUNCHES[baseExtent] ?? 8;
    for (let b = 0; b < bunches; b++) {
      const balloonCount = 3 + Math.floor(rng() * 5);
      const list: BalloonData["balloons"] = [];
      for (let i = 0; i < balloonCount; i++) {
        const a = rng() * Math.PI * 2;
        const r = 0.3 + rng() * 0.7;
        list.push({
          dx: Math.cos(a) * r,
          dz: Math.sin(a) * r,
          y: 2.7 + rng() * 1.2,
          r: 0.28 + rng() * 0.14,
          color: BALLOON_COLORS[Math.floor(rng() * BALLOON_COLORS.length)],
        });
      }
      // Spread bunches across the whole room; the door corridor, every
      // strand door's approach strip (B.11), the plan
      // footprint, and the wall margin stay clear (the gift-box anchor sits
      // on the floor).
      const okAnchor = (x: number, z: number) =>
        !(Math.abs(x) < PROP_DOOR_HALF && z < PROP_DOOR_DEPTH) &&
        planContains(plan, x, z, 1) &&
        !inDoorApproach(x, z, doors);
      let bx = 0;
      let bz = extent * 0.4;
      for (let tries = 0; tries < 24; tries++) {
        bx = (rng() * 2 - 1) * (width / 2 - 2);
        bz = extent * (0.12 + rng() * 0.78);
        if (okAnchor(bx, bz)) break;
      }
      if (!okAnchor(bx, bz)) {
        bz = PROP_DOOR_DEPTH + 1 + rng() * 2;
        // The nudge can itself land in a strand door's strip — bounded
        // redraw before giving up (a pathological micro-room keeps the
        // last draw, as before).
        for (let tries = 0; tries < 8 && !okAnchor(bx, bz); tries++) {
          bx = (rng() * 2 - 1) * (width / 2 - 2);
          bz = extent * (0.12 + rng() * 0.78);
        }
      }
      balloons.push({
        x: bx,
        z: bz,
        phase: rng() * Math.PI * 2,
        balloons: list,
      });
    }
  }

  return {
    ducks,
    pets: {
      kind: scaled.archetype === "dogs" ? "dog" : "cat",
      pets,
    },
    balloons,
  };
}

/**
 * The space-side face of the corridor door. Filler panels, lintel, and
 * trim frame are wall dressing and always render; the slab + glow + seams
 * + halo only mount once the corridor is fully gone (corridorGone, delayed
 * by the corridor's own HIDE_DELAY_MS) — while the corridor is still
 * visible its own DoorAssembly slab is the one physical door, seen from
 * behind, so the doorway never holds two slabs at once. The slab is real:
 * hinged on the left jamb, swinging away from the player as they come
 * within DOOR_OPEN_DIST.
 */
function SpaceDoorway({
  accent,
  wallColor,
  playerRef,
  door,
  doorVisible,
}: {
  accent: string;
  wallColor: THREE.Color;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  door: DoorRef;
  doorVisible: boolean;
}): JSX.Element {
  const fillerWidth = DOOR_GAP_HALF - DOOR_WIDTH / 2;
  const fillerCenter = DOOR_WIDTH / 2 + fillerWidth / 2;

  // Hinged slab, same rule as the corridor face: open near the player,
  // rotating away from them. Player position is converted into the space's
  // local frame (south doors mirror both axes).
  //
  // HINGE SIDE. The corridor slab always hangs on the door.x − half-width
  // jamb in WORLD space. In the south door's π-rotated frame that jamb is
  // +x local, so the hinge, slab, knob, and swing sign all mirror — the
  // handover between the two slabs must never flip the door's handedness.
  const dir = door.z > 0 ? 1 : -1;
  const hingeX = -dir * (DOOR_WIDTH / 2 - 0.02);
  // Knob rides the slab's FREE edge: +0.50 local for north, −0.50 local for
  // south (π-rotated) — i.e. world door.x + 0.50 on both, same as the
  // corridor face. It offsets FROM the hinge, so its sign is +dir while
  // the hinge's is −dir.
  const knobX = dir * (DOOR_WIDTH - 0.22);
  const hingeRef = useRef<THREE.Group>(null);
  const angleRef = useRef(0);
  const snappedRef = useRef(false);
  useFrame((_, delta) => {
    const hinge = hingeRef.current;
    if (!hinge) return;
    const p = playerRef.current;
    const lx = (p.x - door.x) * dir;
    const lz = (p.z - door.z) * dir;
    const near = Math.hypot(lx, lz) < DOOR_OPEN_DIST;
    const away = lz > 0 ? 1 : -1; // inside → swings to the corridor, and back
    const target = near ? away * dir * DOOR_OPEN_ANGLE : 0;
    const dt = Math.min(delta, 0.05);
    if (!snappedRef.current) {
      angleRef.current = target;
      snappedRef.current = true;
    } else {
      angleRef.current += (target - angleRef.current) * (1 - Math.exp(-DOOR_SWING_RATE * dt));
    }
    hinge.rotation.y = angleRef.current;
  });

  return (
    <group>
      {/* Filler panels closing the 2.4m gap down to the 1.4m door. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * fillerCenter, PORTAL_HEIGHT / 2, ROOM_WALL_THICKNESS / 2]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[fillerWidth, PORTAL_HEIGHT, ROOM_WALL_THICKNESS]} />
          <meshStandardMaterial color={wallColor} roughness={1} flatShading />
        </mesh>
      ))}
      {/* Lintel above the slab, up to portal height. */}
      <mesh
        position={[0, (PORTAL_HEIGHT + DOOR_HEIGHT) / 2, ROOM_WALL_THICKNESS / 2]}
        castShadow
        receiveShadow
      >
        <boxGeometry
          args={[DOOR_WIDTH, PORTAL_HEIGHT - DOOR_HEIGHT, ROOM_WALL_THICKNESS]}
        />
        <meshStandardMaterial color={wallColor} roughness={1} flatShading />
      </mesh>
      {/* Trim frame, proud of the wall face into the space (+z local). */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (DOOR_WIDTH / 2 + 0.05), DOOR_HEIGHT / 2 + 0.05, ROOM_WALL_THICKNESS + 0.06]}
          castShadow
        >
          <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
          <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
        </mesh>
      ))}
      <mesh
        position={[0, DOOR_HEIGHT + 0.11, ROOM_WALL_THICKNESS + 0.06]}
        castShadow
      >
        <boxGeometry args={[DOOR_WIDTH + 0.2, 0.12, 0.24]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      {doorVisible && (
        <>
          {/* The hinged slab — the way back out, swinging on its jamb. */}
          <group ref={hingeRef} position={[hingeX, 0, ROOM_WALL_THICKNESS / 2]}>
            <mesh position={[-hingeX, DOOR_HEIGHT / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[DOOR_WIDTH - 0.04, DOOR_HEIGHT - 0.04, 0.05]} />
              {/* Backlit slab: a whisper of the doorway glow on the wood so
                  the closed door never reads as a black hole from inside. */}
              <meshStandardMaterial
                color="#7b6d5c"
                emissive={accent}
                emissiveIntensity={0.32}
                roughness={1}
                flatShading
              />
            </mesh>
            <mesh position={[knobX, DOOR_HEIGHT / 2, 0.05]} castShadow>
              <boxGeometry args={[0.05, 0.16, 0.05]} />
              <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
            </mesh>
          </group>
          {/* Corridor light behind the gap, revealed when the slab opens. */}
          <mesh position={[0, DOOR_HEIGHT / 2, 0.02]}>
            <planeGeometry args={[DOOR_WIDTH, DOOR_HEIGHT]} />
            <meshStandardMaterial
              color="#000000"
              emissive={accent}
              emissiveIntensity={DOOR_GLOW_INTENSITY}
              roughness={1}
              metalness={0}
            />
          </mesh>
          {/* Light leak: thin emissive seams along the jambs and head,
              proud of the closed slab on the room side, so the way back
              reads as a glowing door outline even from deep inside the
              space (the slab itself occludes the glow plane when shut). */}
          {[-1, 1].map((side) => (
            <mesh
              key={`seam${side}`}
              position={[side * (DOOR_WIDTH / 2 - 0.02), DOOR_HEIGHT / 2, ROOM_WALL_THICKNESS + 0.05]}
            >
              <boxGeometry args={[0.05, DOOR_HEIGHT, 0.04]} />
              <meshStandardMaterial
                color="#000000"
                emissive={accent}
                emissiveIntensity={DOOR_SEAM_INTENSITY}
                roughness={1}
                metalness={0}
              />
            </mesh>
          ))}
          <mesh position={[0, DOOR_HEIGHT - 0.02, ROOM_WALL_THICKNESS + 0.05]}>
            <boxGeometry args={[DOOR_WIDTH, 0.05, 0.04]} />
            <meshStandardMaterial
              color="#000000"
              emissive={accent}
              emissiveIntensity={DOOR_SEAM_INTENSITY}
              roughness={1}
              metalness={0}
            />
          </mesh>
          {/* Faint additive halo around the opening, facing into the space. */}
          <mesh position={[0, DOOR_HEIGHT / 2, ROOM_WALL_THICKNESS + 0.2]}>
            <planeGeometry args={[DOOR_WIDTH + 0.5, DOOR_HEIGHT + 0.4]} />
            <meshBasicMaterial
              color={accent}
              transparent
              opacity={DOOR_HALO_OPACITY}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Strand doors (v0.11-hotel-rooms §B.8/B.11)                           */
/* ------------------------------------------------------------------ */

/**
 * Split a strand door's label into the NAME half (strand + destination
 * date, for the existing name plaque) and the door NUMBER (B.14 rule 1).
 * The data lane (game-shell.tsx) appends the destination slice's 4-digit
 * clock as a `#HHMM` suffix; the greedy match takes the LAST `#`, so a `#`
 * inside a strand name can never eat the number. Splitting happens BEFORE
 * plaqueLabelFor's length cap runs on the name, so the number can never be
 * ellipsized away. No date maths here — the number arrives pre-derived.
 */
function splitStrandLabel(label: string): { name: string; clock: string | null } {
  const m = /^([\s\S]*)#(\d{4})$/.exec(label);
  return m ? { name: m[1], clock: m[2] } : { name: label, clock: null };
}

/** A strand door's label plaque: the corridor's createPlaqueTexture
 *  approach (one dark canvas-textured plate, light monospace ink), wider
 *  with a shrink-to-fit font since strand labels are words, not times.
 *  The text itself is decided by plaqueLabelFor (lib/game/room-doors.ts,
 *  pure); this is only the rasterization. */
function createStrandPlaqueTexture(text: string): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 168;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = PLATE_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(236,226,204,0.45)";
  ctx.lineWidth = 7;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.fillStyle = PLATE_INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = 84;
  for (; size > 24; size -= 6) {
    ctx.font = `700 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    if (ctx.measureText(text).width <= canvas.width - 64) break;
  }
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The strand door's NUMBER plate (B.14 rule 1): the destination slice's
 * 4-digit clock on its own small plate, the corridor DoorPlate's twin —
 * same 384×192 canvas, same PLATE_BG field with the faint border, same
 * PLATE_INK 900-weight monospace digits, so a number read in a room is
 * unmistakably the same sign as the same number read in the corridor.
 * Four digits always fit at the corridor's own font size, so no
 * shrink-to-fit is needed.
 */
function createClockPlateTexture(clock: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = PLATE_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(236,226,204,0.45)";
    ctx.lineWidth = 8;
    ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
    ctx.fillStyle = PLATE_INK;
    ctx.font = "900 104px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(clock, canvas.width / 2, canvas.height / 2 + 6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * One strand door: a wormhole to the next slice on its strand (B.11). The
 * geometry speaks the corridor's door language at human scale (A4) —
 * filler panels dressing the 2.4m wall gap down to the 1.4m slab, lintel,
 * a transom closing the gap above the portal on full-height walls, a trim
 * frame proud of the inner face, a threshold strip at the floor, and a
 * plaque carrying the strand's label beside the frame — with the door
 * NUMBER plate (the destination slice's HHMM clock, B.14 rule 1) stacked
 * just under it, the corridor DoorPlate's twin. The whole assembly
 * stands from the floor, so a door placed on a cutaway sill wall still
 * reads as a doorframe, not a notch.
 *
 * LIT doors (the strand continues): a hinged slab that swings open away
 * from the approaching player (same rule as the corridor face), the next
 * room's light behind the gap, light-leak seams, and a faint halo.
 * UNLIT doors (the strand's unwritten continuation — B.4): the same door,
 * present but dark — closed static slab, no glow, no seams, no halo.
 * Every part is opaque geometry; only the halo is additive light (hard
 * requirement #5).
 */
function RoomDoorAssembly({
  placement,
  label,
  lit,
  accent,
  wallColor,
  thick,
  drawnHeight,
  playerRef,
  door,
}: {
  placement: RoomDoorPlacement;
  label: string;
  lit: boolean;
  accent: string;
  wallColor: THREE.Color;
  /** The host wall's thickness (minor axis). */
  thick: number;
  /** The host wall's DRAWN height (sill height on cutaway walls). */
  drawnHeight: number;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  door: DoorRef;
}): JSX.Element {
  const fillerWidth = DOOR_GAP_HALF - DOOR_WIDTH / 2;
  const fillerCenter = DOOR_WIDTH / 2 + fillerWidth / 2;
  // The group is rotated so local +z is the inward (room-side) normal;
  // the slab's hinge sits on the −x jamb and swings AWAY from the player.
  const dir = door.z > 0 ? 1 : -1;
  const hingeRef = useRef<THREE.Group>(null);
  const angleRef = useRef(0);
  const snappedRef = useRef(false);
  useFrame((_, delta) => {
    if (!lit) return; // an unlit door never opens — the seam stays dark
    const hinge = hingeRef.current;
    if (!hinge) return;
    const p = playerRef.current;
    const lx = (p.x - door.x) * dir - placement.x;
    const lz = (p.z - door.z) * dir - placement.z;
    const perp = lx * placement.nx + lz * placement.nz;
    const near = Math.hypot(lx, lz) < DOOR_OPEN_DIST;
    const away = perp > 0 ? 1 : -1;
    const target = near ? away * DOOR_OPEN_ANGLE : 0;
    const dt = Math.min(delta, 0.05);
    if (!snappedRef.current) {
      angleRef.current = target;
      snappedRef.current = true;
    } else {
      angleRef.current += (target - angleRef.current) * (1 - Math.exp(-DOOR_SWING_RATE * dt));
    }
    hinge.rotation.y = angleRef.current;
  });

  // The label carries the door number as a `#HHMM` suffix (B.14 rule 1);
  // the name plaque shows the rest, the number gets its own plate below it.
  const { name: plaqueName, clock } = splitStrandLabel(label);
  const plaque = useMemo(
    () => createStrandPlaqueTexture(plaqueLabelFor(plaqueName)),
    [plaqueName],
  );
  useEffect(() => () => plaque?.dispose(), [plaque]);
  const clockPlate = useMemo(
    () => (clock ? createClockPlateTexture(clock) : null),
    [clock],
  );
  useEffect(() => () => clockPlate?.dispose(), [clockPlate]);

  return (
    <group
      position={[placement.x, 0, placement.z]}
      rotation={[0, Math.atan2(placement.nx, placement.nz), 0]}
    >
      {/* Filler panels closing the 2.4m gap down to the 1.4m door. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * fillerCenter, PORTAL_HEIGHT / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[fillerWidth, PORTAL_HEIGHT, thick]} />
          <meshStandardMaterial color={wallColor} roughness={1} flatShading />
        </mesh>
      ))}
      {/* Lintel above the slab, up to portal height. */}
      <mesh
        position={[0, (PORTAL_HEIGHT + DOOR_HEIGHT) / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry
          args={[DOOR_WIDTH, PORTAL_HEIGHT - DOOR_HEIGHT, thick]}
        />
        <meshStandardMaterial color={wallColor} roughness={1} flatShading />
      </mesh>
      {/* Transom: closes the gap above the portal up to the wall top
          (full-height walls only — a sill wall leaves the portal standing
          free, which reads as the dollhouse it is). */}
      {drawnHeight > PORTAL_HEIGHT + 0.05 && (
        <mesh
          position={[0, (drawnHeight + PORTAL_HEIGHT) / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry
            args={[DOOR_GAP_HALF * 2, drawnHeight - PORTAL_HEIGHT, thick]}
          />
          <meshStandardMaterial color={wallColor} roughness={1} flatShading />
        </mesh>
      )}
      {/* Trim frame, proud of the wall's inner face. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (DOOR_WIDTH / 2 + 0.05), DOOR_HEIGHT / 2 + 0.05, thick / 2 + 0.06]}
          castShadow
        >
          <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
          <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
        </mesh>
      ))}
      <mesh
        position={[0, DOOR_HEIGHT + 0.11, thick / 2 + 0.06]}
        castShadow
      >
        <boxGeometry args={[DOOR_WIDTH + 0.2, 0.12, 0.24]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      {/* Threshold: a real sill strip across the doorway at floor level. */}
      <mesh position={[0, 0.022, 0]} receiveShadow>
        <boxGeometry args={[DOOR_WIDTH + 0.2, 0.045, thick + 0.4]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      {/* The slab: hinged and backlit when lit; a plain closed door when
          the strand's continuation is unwritten — present, never missing,
          never glowing. */}
      <group ref={hingeRef} position={[-(DOOR_WIDTH / 2 - 0.02), 0, 0]}>
        <mesh position={[DOOR_WIDTH / 2 - 0.02, DOOR_HEIGHT / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[DOOR_WIDTH - 0.04, DOOR_HEIGHT - 0.04, 0.05]} />
          {lit ? (
            <meshStandardMaterial
              color="#7b6d5c"
              emissive={accent}
              emissiveIntensity={0.32}
              roughness={1}
              flatShading
            />
          ) : (
            <meshStandardMaterial color="#564d43" roughness={1} flatShading />
          )}
        </mesh>
        <mesh position={[DOOR_WIDTH - 0.22, DOOR_HEIGHT / 2, 0.05]} castShadow>
          <boxGeometry args={[0.05, 0.16, 0.05]} />
          <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
        </mesh>
      </group>
      {lit && (
        <>
          {/* The next room's light behind the gap, revealed on the swing. */}
          <mesh position={[0, DOOR_HEIGHT / 2, -0.02]}>
            <planeGeometry args={[DOOR_WIDTH, DOOR_HEIGHT]} />
            <meshStandardMaterial
              color="#000000"
              emissive={accent}
              emissiveIntensity={DOOR_GLOW_INTENSITY}
              roughness={1}
              metalness={0}
            />
          </mesh>
          {/* Light leak around the closed slab, so the door reads as a way
              through from deep inside the space. */}
          {[-1, 1].map((side) => (
            <mesh
              key={`seam${side}`}
              position={[side * (DOOR_WIDTH / 2 - 0.02), DOOR_HEIGHT / 2, thick / 2 + 0.05]}
            >
              <boxGeometry args={[0.05, DOOR_HEIGHT, 0.04]} />
              <meshStandardMaterial
                color="#000000"
                emissive={accent}
                emissiveIntensity={DOOR_SEAM_INTENSITY}
                roughness={1}
                metalness={0}
              />
            </mesh>
          ))}
          <mesh position={[0, DOOR_HEIGHT - 0.02, thick / 2 + 0.05]}>
            <boxGeometry args={[DOOR_WIDTH, 0.05, 0.04]} />
            <meshStandardMaterial
              color="#000000"
              emissive={accent}
              emissiveIntensity={DOOR_SEAM_INTENSITY}
              roughness={1}
              metalness={0}
            />
          </mesh>
          {/* Faint additive halo facing into the room. */}
          <mesh position={[0, DOOR_HEIGHT / 2, thick / 2 + 0.2]}>
            <planeGeometry args={[DOOR_WIDTH + 0.5, DOOR_HEIGHT + 0.4]} />
            <meshBasicMaterial
              color={accent}
              transparent
              opacity={DOOR_HALO_OPACITY}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      )}
      {/* The plaque: the strand's name beside the frame at handle height,
          on the room face — lit or unlit, the door keeps its name (B.3.3). */}
      {plaque && (
        <group position={[DOOR_WIDTH / 2 + 0.55, 2.2, thick / 2 + 0.03]}>
          <mesh castShadow>
            <boxGeometry args={[1.0, 0.36, 0.03]} />
            <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0, 0.017]}>
            <planeGeometry args={[0.92, 0.3]} />
            <meshBasicMaterial map={plaque} transparent />
          </mesh>
        </group>
      )}
      {/* The door NUMBER (B.14 rule 1): the destination slice's HHMM clock
          on its own small plate — the corridor DoorPlate's geometry and
          texture, stacked just under the name plaque so the two signs read
          as one door's signage and never overlap. Unlit doors carry no
          number: no destination, nothing to match in the corridor (B.4). */}
      {clockPlate && (
        <group position={[DOOR_WIDTH / 2 + 0.55, 1.71, thick / 2 + 0.03]}>
          <mesh castShadow>
            <boxGeometry args={[0.84, 0.46, 0.03]} />
            <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0, 0.017]}>
            <planeGeometry args={[0.76, 0.38]} />
            <meshBasicMaterial map={clockPlate} transparent />
          </mesh>
        </group>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Motivated fixtures (v0.11-hotel-rooms B.13 「摄影棚论」, user        */
/* 2026-09-18): this world has NO outdoors. Every lit surface must     */
/* have a findable source — so every room grows a LAMP (shade + bulb   */
/* with a real point light and a floor pool) and a WINDOW (frame,      */
/* bright pane, spill on the floor; in interior rooms its spot is the  */
/* room's KEY light and casts the strong shadows), and outdoor-class   */
/* sets add a SKYLIGHT that justifies their overall key.               */
/* ------------------------------------------------------------------ */

/** Where one window hangs: center on the host wall's line, the probed
 *  inward normal, and the host's drawn dimensions. */
interface WindowFixture {
  x: number;
  z: number;
  nx: number;
  nz: number;
  thick: number;
  /** The host wall's DRAWN height (sill height on a cutaway wall). */
  drawnHeight: number;
}

interface RoomFixtures {
  lamp: { x: number; z: number };
  window: WindowFixture;
  skylight: { x: number; z: number } | null;
}

/**
 * Seeded fixture placement — a dedicated stream (`…:fixtures`, the
 * room-plan.ts facet convention) so adding fixtures never perturbs the
 * layout/prop/furniture draws around them (A6: same slice, same room,
 * fixtures included).
 *
 * LAMP: a piece of furniture — drawn inside the footprint, out of the
 * entrance strip, the strand-door approaches, the water, and (first pass)
 * the cleared path; it may stand near the hero (a lit set piece reads
 * well). WINDOW: wall dressing — prefers a FULL-HEIGHT non-entrance wall
 * (a window punched in a 1.1m dollhouse sill would float), falls back to
 * the entrance wall beside the door (architecturally natural, never cut),
 * and keeps clear of every door sharing the host wall. SKYLIGHT: overhead,
 * so only the plan footprint constrains it; center-third biased.
 */
function buildRoomFixtures(
  recipe: SpaceRecipe,
  scaled: SpaceRecipe,
  plan: RoomPlan,
  comp: Composition,
  walls: WallSegment[],
  wallHeight: number,
  dir: number,
  water: WaterRect | null,
  doors: readonly RoomDoorPlacement[],
  propScale: number,
  wallScale: number,
  hasSkylight: boolean,
): RoomFixtures {
  const rng = createRng(hashString(`${WORLD_SEED}:${recipe.sliceId}:fixtures`));
  const { extent } = scaled.size;
  const width = scaled.width;

  // --- Lamp -------------------------------------------------------------
  const lampEdge = ROOM_WALL_THICKNESS + 0.9 * propScale;
  let lamp: RoomFixtures["lamp"] | null = null;
  for (let pass = 0; pass < 2 && lamp === null; pass++) {
    for (let tries = 0; tries < 24 && lamp === null; tries++) {
      const x = (rng() * 2 - 1) * Math.max(0.5, width / 2 - lampEdge);
      const z = lampEdge + rng() * Math.max(0.5, extent - lampEdge * 2);
      if (!planContains(plan, x, z, lampEdge)) continue;
      if (Math.abs(x) < ENTRANCE_CLEAR_RADIUS && z < ENTRANCE_DEPTH) continue;
      if (doors.length > 0 && inDoorApproach(x, z, doors)) continue;
      if (water && insideRect(x, z, water, 0.6 * propScale)) continue;
      if (pass === 0 && distToPath(comp, x, z) < comp.pathHalf + 0.3 * propScale) {
        continue;
      }
      lamp = { x, z };
    }
  }
  // Footprint-safe fallback: beside the path bend, mid-depth.
  if (lamp === null) {
    lamp = {
      x: comp.path.bx <= 0 ? lampEdge + 0.6 * propScale : -(lampEdge + 0.6 * propScale),
      z: Math.min(Math.max(extent * 0.45, lampEdge + 0.5), extent - lampEdge),
    };
  }

  // --- Window -----------------------------------------------------------
  const winHalf = (WINDOW_WIDTH * wallScale) / 2 + 0.35; // frame margin
  const endPad = 1;
  const fits = (w: WallSegment) =>
    Math.max(w.sizeX, w.sizeZ) >= (winHalf + endPad) * 2;
  const fullHeight = walls.filter((w) => !w.entrance && !wallFacesCamera(plan, w, dir));
  let hostPool = fullHeight.filter(fits);
  if (hostPool.length === 0) hostPool = walls.filter((w) => w.entrance && fits(w));
  if (hostPool.length === 0) {
    // Pathological miniature: hang it on the longest wall regardless.
    hostPool = [...walls].sort(
      (a, b) => Math.max(b.sizeX, b.sizeZ) - Math.max(a.sizeX, a.sizeZ),
    ).slice(0, 1);
  }
  const host = hostPool[Math.floor(rng() * hostPool.length)];
  const hostIndex = walls.indexOf(host);
  const horizontal = host.sizeZ <= host.sizeX;
  const len = horizontal ? host.sizeX : host.sizeZ;
  let nx = 0;
  let nz = 0;
  if (horizontal) {
    nz = planContains(plan, host.x, host.z + 0.5, 0) ? 1 : -1;
  } else {
    nx = planContains(plan, host.x + 0.5, host.z, 0) ? 1 : -1;
  }
  const drawnHeight =
    host.entrance || !wallFacesCamera(plan, host, dir)
      ? wallHeight
      : Math.min(wallHeight, WALL_SILL_HEIGHT);
  // Offset along the run, clear of the entrance gap and of every strand
  // door sharing this wall.
  const doorClear = winHalf + DOOR_WIDTH / 2 + WINDOW_DOOR_CLEAR;
  const hostDoors = doors.filter((d) => d.wall === hostIndex);
  const lo = -len / 2 + winHalf + endPad;
  const hi = len / 2 - winHalf - endPad;
  let along = 0;
  for (let tries = 0; tries < 16; tries++) {
    const a = lo >= hi ? 0 : lo + rng() * (hi - lo);
    const cx = host.x + (horizontal ? a : 0);
    if (host.entrance && Math.abs(cx) < DOOR_GAP_HALF + winHalf + 0.6) continue;
    if (hostDoors.some((d) => Math.abs(a - d.along) < doorClear)) continue;
    along = a;
    break;
  }
  const window: WindowFixture = {
    x: host.x + (horizontal ? along : 0),
    z: host.z + (horizontal ? 0 : along),
    nx,
    nz,
    thick: horizontal ? host.sizeZ : host.sizeX,
    drawnHeight,
  };

  // --- Skylight ---------------------------------------------------------
  let skylight: RoomFixtures["skylight"] = null;
  if (hasSkylight) {
    const half = SKYLIGHT_HALF * wallScale + 0.6;
    let sx = 0;
    let sz = extent / 2;
    for (let tries = 0; tries < 24; tries++) {
      const x = (rng() * 2 - 1) * Math.max(0.5, width / 2 - half);
      const z = extent * (0.3 + rng() * 0.4);
      if (!planContains(plan, x, z, half)) continue;
      sx = x;
      sz = z;
      break;
    }
    skylight = { x: sx, z: sz };
  }

  return { lamp, window, skylight };
}

/**
 * The room's lamp: base, pole, an emissive shade over a hot bulb, the ONE
 * real point light, and an additive floor pool (the corridor sconce idiom —
 * the painted gradient does the falloff). Everything scales with the room's
 * prop scale, light included: with decay 2, a pool radius grown by k needs
 * intensity ×k² to land the same brightness, so a colossal room's giant
 * lamp actually reaches its giant floor. Calm incandescent — never
 * flickering (the anti-pattern list).
 */
function RoomLamp({
  x,
  z,
  y,
  scale,
}: {
  x: number;
  z: number;
  y: number;
  scale: number;
}): JSX.Element {
  return (
    <group position={[x, y, z]} scale={scale}>
      <mesh position={[0, 0.03, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.2, 0.26, 0.06, 10]} />
        <meshStandardMaterial color="#3a3a3e" roughness={0.6} metalness={0.3} flatShading />
      </mesh>
      <mesh position={[0, LAMP_POLE_HEIGHT / 2, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.045, LAMP_POLE_HEIGHT, 7]} />
        <meshStandardMaterial color="#3a3a3e" roughness={0.6} metalness={0.3} flatShading />
      </mesh>
      {/* Shade — emissive cone, apex up over the bulb like the sconce's. */}
      <mesh position={[0, LAMP_SHADE_Y, 0]} castShadow>
        <coneGeometry args={[0.42, 0.5, 9]} />
        <meshStandardMaterial
          color="#000000"
          emissive={LAMP_COLOR}
          emissiveIntensity={LAMP_SHADE_EMISSIVE}
          roughness={1}
          metalness={0}
          flatShading
        />
      </mesh>
      <mesh position={[0, LAMP_BULB_Y, 0]}>
        <sphereGeometry args={[0.09, 8, 6]} />
        <meshStandardMaterial
          color="#000000"
          emissive={LAMP_COLOR}
          emissiveIntensity={LAMP_BULB_EMISSIVE}
          roughness={1}
          metalness={0}
        />
      </mesh>
      {/* The real light in the lamp (its params ignore the group scale —
          intensity and distance are scaled explicitly). */}
      <pointLight
        position={[0, LAMP_BULB_Y, 0]}
        color={LAMP_COLOR}
        intensity={LAMP_LIGHT_INTENSITY * scale * scale}
        distance={LAMP_LIGHT_DISTANCE * scale}
        decay={2}
      />
      {/* Light pool on the floor: one radial-gradient quad, soft edge. */}
      <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[LAMP_POOL_RADIUS * 2, LAMP_POOL_RADIUS * 2]} />
        <meshBasicMaterial
          map={sharedRadialGlowTexture()}
          color={LAMP_COLOR}
          transparent
          opacity={LAMP_POOL_OPACITY}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * The room's window: a dark reveal sunk into the wall face, a bright
 * emissive pane (the source you can point at), an architrave frame and
 * sill in the door-trim material, and an additive spill quad on the floor
 * in front — brightest at the wall, dissolving into the room (the wall-
 * wash gradient, laid flat). In INTERIOR rooms the window is also the
 * key light: a real spot just inside the pane, aimed down into the room,
 * carrying the room's strong motivated shadows (the sun has dropped to a
 * fill — B.13 rule 2). Outdoor-class sets keep the window emissive-only:
 * their real light comes from the skylight and the overall key.
 */
function RoomWindow({
  fixture,
  wallScale,
  paneColor,
  isKey,
}: {
  fixture: WindowFixture;
  wallScale: number;
  paneColor: THREE.Color;
  isKey: boolean;
}): JSX.Element {
  const ws = wallScale;
  const w = WINDOW_WIDTH * ws;
  // Clamp the pane into the host wall's DRAWN height (a relaxed fallback
  // host may be a cutaway sill wall — the window then sits low and short).
  const h = Math.min(WINDOW_HEIGHT * ws, Math.max(0.6, fixture.drawnHeight - 0.4));
  const sill = Math.min(WINDOW_SILL_Y * ws, Math.max(0.15, fixture.drawnHeight - h - 0.15));
  const spillL = WINDOW_SPILL_LENGTH * ws;
  const [spotTarget] = useState(() => new THREE.Object3D());
  return (
    <group
      position={[fixture.x, 0, fixture.z]}
      rotation={[0, Math.atan2(fixture.nx, fixture.nz), 0]}
    >
      {/* Dark reveal — the opening reads as a hole in the wall. */}
      <mesh position={[0, sill + h / 2, fixture.thick / 2 - 0.02]}>
        <boxGeometry args={[w + 0.24, h + 0.24, 0.05]} />
        <meshStandardMaterial color="#101014" roughness={1} flatShading />
      </mesh>
      {/* The bright face. */}
      <mesh position={[0, sill + h / 2, fixture.thick / 2 + 0.011]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial
          color="#000000"
          emissive={paneColor}
          emissiveIntensity={WINDOW_PANE_EMISSIVE}
          roughness={1}
          metalness={0}
        />
      </mesh>
      {/* Architrave frame + sill, proud of the wall face. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (w / 2 + 0.06), sill + h / 2, fixture.thick / 2 + 0.05]}
          castShadow
        >
          <boxGeometry args={[0.12, h + 0.24, 0.12]} />
          <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
        </mesh>
      ))}
      <mesh position={[0, sill + h + 0.06, fixture.thick / 2 + 0.05]} castShadow>
        <boxGeometry args={[w + 0.24, 0.12, 0.12]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, sill - 0.04, fixture.thick / 2 + 0.08]} castShadow receiveShadow>
        <boxGeometry args={[w + 0.3, 0.08, 0.2]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      {/* Light spilling inward: the wall-wash gradient laid flat, bright
          edge at the wall (texture up maps to -z = the wall side). */}
      <mesh
        position={[0, 0.05, fixture.thick / 2 + spillL / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[w * 1.4, spillL]} />
        <meshBasicMaterial
          map={sharedWallWashTexture()}
          color={paneColor}
          transparent
          opacity={WINDOW_SPILL_OPACITY}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* The interior key: a real spot through the opening, casting the
          room's strong shadows. */}
      {isKey && (
        <>
          <primitive
            object={spotTarget}
            position={[0, 0, fixture.thick / 2 + spillL * 0.8]}
          />
          <spotLight
            position={[0, sill + h * 0.55, fixture.thick / 2 + 0.3]}
            target={spotTarget}
            color={paneColor}
            intensity={WINDOW_SPOT_INTENSITY * ws * ws}
            angle={WINDOW_SPOT_ANGLE}
            penumbra={WINDOW_SPOT_PENUMBRA}
            decay={2}
            castShadow
            shadow-mapSize={[WINDOW_SPOT_SHADOW_MAP, WINDOW_SPOT_SHADOW_MAP]}
            shadow-camera-near={WINDOW_SPOT_SHADOW_NEAR}
            shadow-camera-far={WINDOW_SPOT_SHADOW_FAR * ws}
            shadow-bias={SUN_SHADOW_BIAS}
            shadow-normalBias={SUN_SHADOW_NORMAL_BIAS}
          />
        </>
      )}
    </group>
  );
}

/**
 * The outdoor set's skylight: a square opening floating at the wall top
 * (the rooms have no ceilings — the chandelier already floats; that is the
 * grammar), a bright pane visible from both sides, two crossed additive
 * shaft quads descending ALONG THE SUN'S DIRECTION to the floor pool where
 * the column lands, and a real spot through the opening. This is what
 * justifies the set's overall key (B.13 rule 3): walk to the wall and the
 * "sun" was a stage light all along. The spot never casts — the sun owns
 * the outdoor shadows, and two near-coincident casters would double-print.
 */
function RoomSkylight({
  fixture,
  y,
  wallScale,
  paneColor,
}: {
  fixture: { x: number; z: number };
  y: number;
  wallScale: number;
  paneColor: THREE.Color;
}): JSX.Element {
  const ws = wallScale;
  const half = SKYLIGHT_HALF * ws;
  // Sun direction: light travels from SUN_OFFSET toward the origin, so the
  // column lands k·(SUN_OFFSET.x, SUN_OFFSET.z) back from the opening.
  const k = y / SUN_OFFSET.y;
  const fx = fixture.x - SUN_OFFSET.x * k;
  const fz = fixture.z - SUN_OFFSET.z * k;
  const sunLen = Math.hypot(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
  const shaftLen = y * (sunLen / SUN_OFFSET.y);
  const yaw = Math.atan2(SUN_OFFSET.x, SUN_OFFSET.z);
  const slant = Math.atan2(Math.hypot(SUN_OFFSET.x, SUN_OFFSET.z), SUN_OFFSET.y);
  const [spotTarget] = useState(() => new THREE.Object3D());
  return (
    <group>
      {/* The opening: dark frame ring + bright pane (both faces — the
          top-down camera sees its upper face). */}
      <group position={[fixture.x, y, fixture.z]}>
        {[-1, 1].map((side) => (
          <mesh key={`fx${side}`} position={[side * (half + 0.1), 0, 0]} castShadow>
            <boxGeometry args={[0.2, 0.14, half * 2 + 0.4]} />
            <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
          </mesh>
        ))}
        {[-1, 1].map((side) => (
          <mesh key={`fz${side}`} position={[0, 0, side * (half + 0.1)]} castShadow>
            <boxGeometry args={[half * 2 + 0.4, 0.14, 0.2]} />
            <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
          </mesh>
        ))}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[half * 2, half * 2]} />
          <meshStandardMaterial
            color="#000000"
            emissive={paneColor}
            emissiveIntensity={SKYLIGHT_PANE_EMISSIVE}
            roughness={1}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      {/* The light column: two crossed quads along the sun's direction,
          bright at the opening and dissolving toward the floor (the wall-
          wash gradient, hung from its bright edge). */}
      <group
        position={[(fixture.x + fx) / 2, y / 2, (fixture.z + fz) / 2]}
        rotation={[0, yaw, 0]}
      >
        <group rotation={[slant, 0, 0]}>
          {[0, Math.PI / 2].map((a) => (
            <mesh key={a} rotation={[0, a, 0]}>
              <planeGeometry args={[half * 2, shaftLen]} />
              <meshBasicMaterial
                map={sharedWallWashTexture()}
                color={paneColor}
                transparent
                opacity={SKYLIGHT_SHAFT_OPACITY}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}
        </group>
      </group>
      {/* The pool where the column lands, stretched along the throw. */}
      <group position={[fx, 0.06, fz]} rotation={[0, yaw, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} scale={[1, 1.35, 1]}>
          <planeGeometry args={[SKYLIGHT_POOL_RADIUS * 2 * ws, SKYLIGHT_POOL_RADIUS * 2 * ws]} />
          <meshBasicMaterial
            map={sharedRadialGlowTexture()}
            color={paneColor}
            transparent
            opacity={SKYLIGHT_POOL_OPACITY}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      </group>
      {/* The real light through the opening. */}
      <primitive object={spotTarget} position={[fx, 0, fz]} />
      <spotLight
        position={[fixture.x, y - 0.05, fixture.z]}
        target={spotTarget}
        color={paneColor}
        intensity={SKYLIGHT_SPOT_INTENSITY * ws * ws}
        angle={SKYLIGHT_SPOT_ANGLE}
        penumbra={SKYLIGHT_SPOT_PENUMBRA}
        decay={2}
      />
    </group>
  );
}

/**
 * Authored material state, recorded ONCE per material instance, keyed on the
 * material itself. The crossfade below mutates opacity/transparent in place,
 * and React may RE-RUN the capture layout effect on the same fiber with refs
 * intact — R3F mounts the whole scene under a Suspense boundary (react-three-
 * fiber.esm.js: `jsx(React.Suspense, …)`), so a sibling suspension hides and
 * re-reveals committed content and replays layout effects; measured live:
 * the effect fired twice, 1.6 s apart, the second run mid-fade. Without this
 * map the second run records the fade machinery's own mutations as
 * "authored" and the hand-back then faithfully restores the corrupted values
 * (every material stuck in the transparent pass — the "veil"). First capture
 * is always pristine because it runs before this file has touched the
 * material. Do NOT "simplify" this back to reading mat.opacity at capture.
 */
const AUTHORED_MATERIAL_STATE = new WeakMap<
  THREE.Material,
  { opacity: number; transparent: boolean }
>();

function authoredMaterialState(mat: THREE.Material): {
  opacity: number;
  transparent: boolean;
} {
  let authored = AUTHORED_MATERIAL_STATE.get(mat);
  if (!authored) {
    authored = { opacity: mat.opacity, transparent: mat.transparent };
    AUTHORED_MATERIAL_STATE.set(mat, authored);
  }
  return authored;
}

/**
 * Render the space described by a fully resolved recipe, extending outward
 * from the corridor wall at `door`. Pure function of (recipe, door) — no
 * fog, background, or lights (the integrator's canvas owns those).
 *
 * FADE. The room never pops: every material under the root is captured on
 * mount (authored opacity + transparency — see AUTHORED_MATERIAL_STATE) and
 * crossfaded over SPACE_FADE_S — `fade="in"` condenses the room out of its
 * shadow on entry, `fade="out"` dissolves it on exit and fires `onFadedOut`
 * so the integrator can unmount. Once the fade-in completes, materials are
 * restored to their authored transparency so steady-state rendering is
 * untouched.
 */
/** One strand door the room should grow (v0.11 §B.8): arrives RESOLVED
 *  and ORDERED from the data lane — `label` is pre-formatted plaque text
 *  with the destination slice's door number as a `#HHMM` suffix (B.14
 *  rule 1; split off here — see splitStrandLabel), `lit` marks whether the
 *  strand has a next slice within the corridor window (unlit = the
 *  unwritten continuation: the door is present but dark, never missing,
 *  and carries no number). Placement, geometry, signage, and crossing
 *  detection are the room's own job (lib/game/room-doors.ts). */
export interface SpaceRoomDoor {
  key: string;
  label: string;
  lit: boolean;
}

/**
 * The room's layout template for a given strand-door count — the ONE
 * selection both door-placement call sites share (the mounted SpaceScene
 * below and the movement clamp's placement derivation in game-canvas.tsx):
 * selection steers the template's declared plan silhouette AND its wall-role
 * door affordance, so two copies of this logic would place two different
 * door sets (the clamp would relax at doors the room never drew). Pure:
 * deterministic in (recipe, scaled dims, scale, wallThick, count).
 */
export function roomTemplateForDoorCount(
  recipe: SpaceRecipe,
  width: number,
  extent: number,
  scaleFactor: number,
  wallThick: number,
  roomDoorCount: number,
): RoomTemplate | null {
  const bay = COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35));
  const capacityFor = (t: RoomTemplate) => {
    const p = roomPlanFor(
      recipe.sliceId,
      width,
      extent,
      bay,
      WORLD_SEED,
      templatePlanFor(t),
    );
    const w = wallSegmentsFor(p, wallThick);
    return doorCapacityFor(p, w, null, doorAffordanceFor(t));
  };
  return resolveRoomTemplate(
    recipe.sliceId,
    recipe.worldClass,
    recipe.archetype,
    recipe.size.extent,
    roomDoorCount,
    WORLD_SEED,
    capacityFor,
  );
}

export function SpaceScene({
  recipe,
  door,
  playerRef,
  corridorGone,
  fade,
  onFadedOut,
  roomDoors,
  onRoomDoor,
}: {
  recipe: SpaceRecipe;
  door: DoorRef;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  corridorGone: boolean;
  fade: "in" | "out";
  onFadedOut: () => void;
  /** Strand doors for this slice — absent/empty = today's single-entrance
   *  room. */
  roomDoors?: readonly SpaceRoomDoor[];
  /** Fires once per strand door when the player walks through it (latched
   *  per door per mount; never fires for the entrance). */
  onRoomDoor?: (key: string) => void;
}): JSX.Element {
  const spec = ARCHETYPES[recipe.archetype];
  const dir = door.z > 0 ? 1 : -1;

  // ROOM LANGUAGE (v0.11 §3): scale notation, plan silhouette, and staging
  // are pure functions of the slice id (lib/game/room-plan.ts). Scaling is
  // applied at CONSTRUCTION time: `scaledRecipe` carries the factor in its
  // plan dims, so terrain, water, and the movement clamps all live in one
  // (scaled) coordinate system. The doorway is never scaled (axiom A4).
  const { recipe: scaledRecipe, scale } = useMemo(
    () => scaledRecipeFor(recipe),
    [recipe],
  );
  const scaleFactor = scale.factor;
  const propScale = Math.pow(scaleFactor, PROP_SCALE_EXP);
  const creatureScale = Math.pow(scaleFactor, CREATURE_SCALE_EXP);
  const wallHeight = scaledWallHeight(scaleFactor);
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  const { extent } = scaledRecipe.size;
  const width = scaledRecipe.width;

  // LAYOUT TEMPLATE (v0.11-room-interiors §7): the design layer above the
  // plan. Selection is a pure function of the slice, its class/archetype,
  // the UNSCALED extent tier, and the REAL strand-door count — a 20-door
  // day selects a template built to absorb 20 doors (room-templates.ts
  // owns the rule and its own seed stream). Capacity steers by MEASUREMENT
  // (Finding A): each candidate's graceful door load is measured on ITS
  // declared footprint at this room's scaled dims, so a miniature room's
  // shortened wall shrinks the claim (hostable flags stay out of the
  // measure — the cutaway is the camera's accident, not the wall's
  // length). null = no template fits (today: every non-interior class and
  // S-tier interiors) and every downstream call then gets `undefined`,
  // reproducing today's behaviour byte-for-byte. Consumption follows the
  // room-templates.test.ts chain: measured selection → declared plan →
  // walls → affordance doors → zone staging. Selection goes through the
  // exported roomTemplateForDoorCount so the movement clamp's door
  // derivation (game-canvas.tsx) selects the SAME template — two copies
  // of the capacity measure once placed two different door sets.
  const roomDoorCount = roomDoors?.length ?? 0;
  const template = useMemo(
    () =>
      roomTemplateForDoorCount(
        recipe,
        width,
        extent,
        scaleFactor,
        wallThick,
        roomDoorCount,
      ),
    [recipe, roomDoorCount, width, extent, scaleFactor, wallThick],
  );
  const plan = useMemo(
    () =>
      roomPlanFor(
        recipe.sliceId,
        width,
        extent,
        COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35)),
        WORLD_SEED,
        // The template DECLARES the silhouette; without one the legacy
        // probability-table draw runs unchanged.
        template ? templatePlanFor(template) : undefined,
      ),
    [recipe, width, extent, scaleFactor, template],
  );
  const comp = useMemo(
    () => composeRoom(recipe.sliceId, plan, scaleFactor),
    [recipe, plan, scaleFactor],
  );
  // Scatter clearances ride the prop scale: giant props need giant margins,
  // dollhouse props keep their dollhouse clearances.
  const scatterEdge = wallThick + WALL_CLEARANCE * propScale;

  // Crossfade machinery: capture every material once (the tree is static
  // per recipe), then scale opacity each frame toward the fade target.
  const rootRef = useRef<THREE.Group>(null);
  const fadeMatsRef = useRef<{ mat: THREE.Material; base: number; transparent: boolean }[]>([]);
  const fadeTRef = useRef(fade === "in" ? 0 : 1);
  const fadeDoneRef = useRef(false);
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mats: { mat: THREE.Material; base: number; transparent: boolean }[] = [];
    root.traverse((obj) => {
      const material = (obj as { material?: THREE.Material | THREE.Material[] }).material;
      if (material === undefined) return;
      for (const mat of Array.isArray(material) ? material : [material]) {
        // Idempotent capture: the authored state comes from the WeakMap
        // (first, pristine capture wins), NEVER from the material's current
        // — possibly already fade-mutated — fields. See the WeakMap comment.
        const authored = authoredMaterialState(mat);
        mats.push({ mat, base: authored.opacity, transparent: authored.transparent });
      }
    });
    fadeMatsRef.current = mats;
    // A re-run of this effect re-corrupts the materials below, so the
    // frame loop must re-run the hand-back when it next sees the end state.
    restoredRef.current = false;
    const k0 = fadeTRef.current;
    for (const { mat, base } of mats) {
      mat.transparent = true;
      // Multiply the AUTHORED base, not mat.opacity: on a mid-fade effect
      // replay mat.opacity is already faded and multiplying it again would
      // double-dim.
      mat.opacity = base * k0;
    }
  }, []);
  useFrame((_, delta) => {
    const mats = fadeMatsRef.current;
    if (mats.length === 0) return;
    // Probe mirror — the console reads live crossfade progress (and the
    // captured material count) to tell a stuck fade from fog.
    GAME_DEBUG.fadeMats = mats.length;
    const dirSign = fade === "in" ? 1 : -1;
    const t = fadeTRef.current;
    GAME_DEBUG.fadeT = t;
    // End states are STATES, not events: any frame that observes the end
    // value settles the side effects exactly once. (The old code did the
    // hand-back only inside the frame where `next` first crossed 1 — one
    // missed or replayed branch left materials stuck.)
    if (dirSign > 0 && t >= 1) {
      if (!restoredRef.current) {
        // Fade-in done: hand materials back to their authored state.
        restoredRef.current = true;
        for (const entry of mats) {
          entry.mat.opacity = entry.base;
          entry.mat.transparent = entry.transparent;
        }
      }
      return;
    }
    if (dirSign < 0 && t <= 0) {
      if (!fadeDoneRef.current) {
        fadeDoneRef.current = true;
        onFadedOut();
      }
      return;
    }
    const next = THREE.MathUtils.clamp(
      t + (dirSign * Math.min(delta, 0.05)) / SPACE_FADE_S,
      0,
      1,
    );
    fadeTRef.current = next;
    const k = smoothstep(0, 1, next);
    for (const entry of mats) {
      entry.mat.transparent = true;
      entry.mat.opacity = entry.base * k;
    }
  });
  // Slow probe sampler: every ~0.5s count materials still left transparent
  // or below their authored opacity after the crossfade should have handed
  // them back — a nonzero matsFaded pins the "veil" on a stuck material.
  const probeFrameRef = useRef(0);
  useFrame(() => {
    if (probeFrameRef.current++ % 30 !== 0) return;
    let transparent = 0;
    let faded = 0;
    for (const entry of fadeMatsRef.current) {
      if (entry.mat.transparent) transparent++;
      if (entry.mat.opacity < entry.base - 0.001) faded++;
    }
    GAME_DEBUG.matsTransparent = transparent;
    GAME_DEBUG.matsFaded = faded;
  });

  const waterRect = useMemo(() => waterRectFor(scaledRecipe), [scaledRecipe]);

  // Perimeter walls from the room plan: rect rooms get the legacy
  // five-segment enclosure; l-shape rooms narrow past a seeded step (two
  // near sides, a step wall, and the kept leg's own three sides); colonnade
  // rooms open both sides into column bays. Every plan keeps the entrance
  // edge as two segments around the 2.4m doorway gap at human thickness —
  // the door handoff is structurally untouchable. Heights ride the wall
  // scale (S^0.5, clamped) so colossal rooms stay readable from the fixed
  // camera. Segments overlap the corners so no seam shows between them.
  // Hoisted above every furnishing memo: strand doors are placed on THESE
  // walls, and every placement layer keeps their approaches clear (B.11).
  const walls = useMemo(
    () => wallSegmentsFor(plan, wallThick),
    [plan, wallThick],
  );

  // STRAND DOORS (B.8/B.11): compose one doorway per strand through the
  // slice onto the solid walls — seeded per slice (A6), clustered like the
  // doors of a home, never on the entrance wall, the colonnade's open
  // sides, or facing the l-shape's abandoned quadrant (room-doors.ts
  // probes planContains for every normal). Hostable walls are the solid
  // FULL-HEIGHT ones; the layout's spacing ladder may relax onto the
  // cutaway sills when a small room has many doors (never dropping one).
  // A resolved template additionally restricts hosting to its DECLARED
  // wall roles (doorAffordanceFor — the shelf-run and niche walls never
  // grow a door, on any ladder rung); positions stay seed-drawn either
  // way, so an untemplated room's doors are placed exactly as today.
  const doorLayout = useMemo(() => {
    if (roomDoorCount === 0) return { doors: [], relaxed: false };
    const hostable = hostableWallsFor(plan, walls, dir);
    return placeRoomDoors(
      recipe.sliceId,
      plan,
      walls,
      hostable,
      roomDoorCount,
      WORLD_SEED,
      template ? doorAffordanceFor(template) : undefined,
    );
  }, [recipe, plan, walls, dir, roomDoorCount, template]);

  // The perimeter cut around every doorway: each host wall becomes the
  // runs between its door gaps (the entrance-pair split generalized),
  // every run inheriting its source segment's drawn height and material.
  const wallRuns = useMemo(
    () => splitWallsForDoors(walls, doorLayout.doors),
    [walls, doorLayout],
  );

  const trees = useMemo(
    () =>
      scatter(
        recipe,
        scaledRecipe,
        spec.treeDensity,
        TREE_DIVISOR,
        TREE_MIN,
        waterRect,
        plan,
        comp,
        scatterEdge,
        propScale,
        0,
        doorLayout.doors,
      ),
    [recipe, scaledRecipe, spec, waterRect, plan, comp, scatterEdge, propScale, doorLayout],
  );
  const rocks = useMemo(
    () =>
      scatter(
        recipe,
        scaledRecipe,
        spec.rockDensity,
        ROCK_DIVISOR,
        ROCK_MIN,
        waterRect,
        plan,
        comp,
        scatterEdge,
        propScale,
        0x9e3779b9, // stream salt: rocks never share the trees' sequence
        doorLayout.doors,
      ),
    [recipe, scaledRecipe, spec, waterRect, plan, comp, scatterEdge, propScale, doorLayout],
  );

  // Motif layer: one dedicated "props" seed stream. Ripples draw first,
  // then the hero and motif props, in a fixed order, so the whole layer is
  // deterministic per recipe. Hybrids mix their biome's props with hotel
  // furniture.
  const motif = useMemo(() => {
    const rng = createRng(deriveSubSeed(WORLD_SEED, recipe.sliceId, "props"));
    const ripples = waterRect ? scatterRipples(rng, waterRect, propScale) : [];
    const base = MOTIF_KINDS[recipe.archetype];
    const kinds =
      recipe.worldClass === "hybrid"
        ? [...base, ...HYBRID_FURNITURE]
        : base;
    return {
      ripples,
      props: scatterMotifs(
        rng,
        recipe,
        scaledRecipe,
        kinds,
        waterRect,
        plan,
        comp,
        scatterEdge,
        propScale,
        doorLayout.doors,
      ),
    };
  }, [recipe, scaledRecipe, waterRect, plan, comp, scatterEdge, propScale, doorLayout]);

  // Interiors are furnished by KITS (v0.11-room-interiors §3.1): composed,
  // wall-anchored groupings that face the path/door/hero, staged by
  // lib/game/kits.ts (the "furniture" stream). The pool hall keeps its
  // water-anchored legacy fixtures — the pool IS its content and pool-side
  // kits are milestone N2 — and draws its deck kits around them, the
  // fixtures' positions handed over as obstacle discs. Wonder rooms keep
  // their seeded oversized rugs.
  const furniture = useMemo(() => {
    if (recipe.worldClass !== "interior" && recipe.worldClass !== "wonder") {
      return [];
    }
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "furniture"),
    );
    const toPlacement = (p: StagedKitPiece): PropPlacement => ({
      kind: p.kind,
      x: p.x,
      y: p.y,
      z: p.z,
      rotY: p.rotY,
      scale: p.scale,
    });
    if (recipe.worldClass === "interior") {
      const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
      const staging = {
        rng,
        archetype: recipe.archetype,
        plan,
        comp,
        baseExtent: recipe.size.extent,
        propScale,
        wallThick,
        water: waterRect,
        doors: doorLayout.doors,
        // The template's content zones (§7), resolved to absolute plan
        // coordinates: the hero's pin, the kit-cluster rects, the
        // keep-empty apron. Absent = today's seeded staging, byte-for-byte.
        zones: template ? templateZonesFor(template, plan) : undefined,
        heightAt: (x: number, z: number) => terrainHeight(scaledRecipe, x, z),
      };
      if (recipe.archetype === "pool-hall") {
        const legacy = furnishInterior(rng, scaledRecipe, waterRect, plan, propScale, doorLayout.doors);
        const obstacles = legacy.map((p) => ({
          x: p.x,
          z: p.z,
          r: Math.max(0.5, p.scale),
        }));
        const waterArea = waterRect
          ? (waterRect.halfX * 2 * waterRect.halfZ * 2) /
            (scaleFactor * scaleFactor)
          : 0;
        const kits = stageInteriorKits({
          ...staging,
          baseArea: Math.max(0, baseArea - waterArea),
          obstacles,
        });
        return [...legacy, ...kits.map(toPlacement)];
      }
      return stageInteriorKits({ ...staging, baseArea }).map(toPlacement);
    }
    return furnishInterior(rng, scaledRecipe, waterRect, plan, propScale, doorLayout.doors);
  }, [recipe, scaledRecipe, waterRect, plan, comp, propScale, scaleFactor, wallThick, doorLayout, template]);

  // Internal structure (L/XL only, on the scaled tier): partition or
  // column grid.
  const structure = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "structure"),
    );
    return buildStructure(rng, scaledRecipe, plan, doorLayout.doors);
  }, [recipe, scaledRecipe, plan, doorLayout]);

  // Wonder-room animals: ducks / cats+dogs / balloons from one stream.
  const animals = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "animals"),
    );
    return buildAnimals(rng, recipe, scaledRecipe, waterRect, plan, creatureScale, doorLayout.doors);
  }, [recipe, scaledRecipe, waterRect, plan, creatureScale, doorLayout]);

  // MOTIVATED FIXTURES (B.13): the lamp, the window, and (outdoor-class
  // sets + the pool hall) the skylight — the findable source of every lit
  // surface. The pool hall is interior by class but keeps §2's worked
  // example: its water needs a skylight to reflect.
  const hasSkylight =
    recipe.worldClass !== "interior" || recipe.archetype === "pool-hall";
  const fixtures = useMemo(
    () =>
      buildRoomFixtures(
        recipe,
        scaledRecipe,
        plan,
        comp,
        walls,
        wallHeight,
        dir,
        waterRect,
        doorLayout.doors,
        propScale,
        wallHeight / WALL_HEIGHT,
        hasSkylight,
      ),
    [recipe, scaledRecipe, plan, comp, walls, wallHeight, dir, waterRect, doorLayout, propScale, hasSkylight],
  );
  // Fixture faces take the palette's own sun color (the room's one light
  // register, A5), lifted toward white so the hue survives the bloom.
  const windowPaneColor = useMemo(
    () => new THREE.Color(recipe.palette.sunColor).lerp(new THREE.Color("#ffffff"), 0.25),
    [recipe],
  );
  const skylightPaneColor = useMemo(
    () => new THREE.Color(recipe.palette.sunColor).lerp(new THREE.Color("#ffffff"), 0.1),
    [recipe],
  );

  // Water tint: the raw accent reads as floor paint on some palettes
  // (dusk/warm are orange). Bias hard toward a bright blue-green so water
  // always reads as water, whatever the palette says.
  const waterColor = useMemo(
    () =>
      new THREE.Color(recipe.palette.accent)
        .lerp(new THREE.Color("#45a8c8"), 0.75)
        .lerp(new THREE.Color("#ffffff"), 0.08),
    [recipe],
  );
  const rippleColor = useMemo(
    () => waterColor.clone().lerp(new THREE.Color("#ffffff"), 0.55),
    [waterColor],
  );
  // Shallow rim tint for the depth gradient: ankle-deep water over tile
  // reads as the deep tint brightened toward clear; the shader eases
  // rim → deep across WATER_DEPTH_RAMP_METERS.
  const waterShallowColor = useMemo(
    () => waterColor.clone().lerp(new THREE.Color("#ffffff"), 0.65),
    [waterColor],
  );

  // Grounding skirt: a dark rectangular apron around the plan (hole cut for
  // the plan itself), darkened ~38% from the ground color. The overhang
  // rides the room scale (a colossal room needs a colossal apron) but never
  // drops below SKIRT_OVERHANG_MIN — a miniature room still grounds its
  // diorama in the mist.
  const skirtGeometry = useMemo(() => {
    const overhang = Math.max(SKIRT_OVERHANG_MIN, SKIRT_OVERHANG * scaleFactor);
    const sizeX = width + overhang * 2;
    const sizeZ = extent + overhang * 2;
    const halfW = width / 2;
    const halfE = extent / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-sizeX / 2, -sizeZ / 2);
    shape.lineTo(sizeX / 2, -sizeZ / 2);
    shape.lineTo(sizeX / 2, sizeZ / 2);
    shape.lineTo(-sizeX / 2, sizeZ / 2);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-halfW, -halfE);
    hole.lineTo(halfW, -halfE);
    hole.lineTo(halfW, halfE);
    hole.lineTo(-halfW, halfE);
    hole.closePath();
    shape.holes.push(hole);
    return new THREE.ShapeGeometry(shape);
  }, [width, extent, scaleFactor]);
  useEffect(() => () => skirtGeometry.dispose(), [skirtGeometry]);
  const skirtColor = useMemo(
    () => new THREE.Color(recipe.palette.ground).multiplyScalar(0.62),
    [recipe],
  );

  const canopyColor = useMemo(
    () =>
      new THREE.Color("#4e7a3a").lerp(
        new THREE.Color(recipe.palette.ground),
        0.3,
      ),
    [recipe],
  );
  const wallColor = useMemo(
    () => new THREE.Color(recipe.palette.ground).multiplyScalar(0.8),
    [recipe],
  );
  // Dado panel stiles sit a touch lighter than the wall they panel (the
  // baseboard and rail reuse the dark cap-rail trim color).
  const dadoPanelColor = useMemo(
    () => wallColor.clone().multiplyScalar(1.12),
    [wallColor],
  );
  // Feature materials: the alcove interior is the wall's own plaster in
  // its own shadow (darker, never emissive — B.13); the inlay is a
  // contrasting stone pulled from the room's existing stone register
  // (the column order's #9a938a) toward the floor's tone, so it reads as
  // the same quarry in a different cut and never fights the parquet (A5).
  const alcoveColor = useMemo(
    () => wallColor.clone().multiplyScalar(0.85),
    [wallColor],
  );
  const inlayColor = useMemo(
    () =>
      new THREE.Color(recipe.palette.ground).lerp(
        new THREE.Color("#9a938a"),
        0.6,
      ),
    [recipe],
  );

  // Strand-door crossing detection: the entrance's hysteresis-band pattern
  // (clamps.ts WALL_IN/WALL_OUT) applied per door — the player must be
  // between the jambs AND past the wall's inner face. Latched per door per
  // mount so a lingering player never re-fires, and structurally unable to
  // fire for the entrance (no placement exists on its wall). Waits for
  // corridorGone: before that the player is still at the corridor door.
  const crossedDoorsRef = useRef<Set<number>>(new Set());
  useFrame(() => {
    if (!onRoomDoor || doorLayout.doors.length === 0 || !corridorGone) return;
    const p = playerRef.current;
    const lx = (p.x - door.x) * dir;
    const lz = (p.z - door.z) * dir;
    const hit = crossedRoomDoor(lx, lz, doorLayout.doors);
    if (hit !== null && !crossedDoorsRef.current.has(hit)) {
      crossedDoorsRef.current.add(hit);
      onRoomDoor(roomDoors?.[hit]?.key ?? "");
    }
  });

  // Dollhouse cutaway: entrance segments always keep full height (the door
  // handoff depends on them); of the rest, the segments whose outward face
  // looks toward the fixed camera are drawn at sill height — opaque, but
  // low enough that the interior reads over them. Runs inherit their
  // source segment's orientation, so the test holds after the door splits.
  const wallHeights = useMemo(
    () =>
      wallRuns.map(({ wall }) =>
        wall.entrance || !wallFacesCamera(plan, wall, dir)
          ? wallHeight
          : Math.min(wallHeight, WALL_SILL_HEIGHT),
      ),
    [wallRuns, plan, dir, wallHeight],
  );

  // Drawn height per ORIGINAL wall index (every run of a source shares its
  // cutaway state) — the strand-door assemblies need it to close their
  // transom up to the wall top on full-height walls.
  const sourceWallHeights = useMemo(() => {
    const map = new Map<number, number>();
    wallRuns.forEach((run, i) => {
      if (!map.has(run.source)) map.set(run.source, wallHeights[i]);
    });
    return map;
  }, [wallRuns, wallHeights]);

  // TEMPLATE FEATURES (§7.2): the niche, pilaster rhythm, and floor inlay
  // the resolved template declares. Resolved AFTER the door split (wallRuns
  // + wallHeights) so features follow the cutaway and break at openings;
  // consumes only the plan/walls/doors the existing modules already
  // produced. No template → no features, and nothing else in this file
  // changes. Flat-floor gate keeps the inlay off rolling terrain.
  const roomFeatures = useMemo(
    () =>
      buildRoomFeatures({
        template,
        plan,
        walls,
        wallRuns,
        wallHeights,
        wallHeight,
        wallThick,
        doors: doorLayout.doors,
        flatFloor: spec.ground === "flat",
      }),
    [template, plan, walls, wallRuns, wallHeights, wallHeight, wallThick, doorLayout, spec],
  );
  const nicheByRun = useMemo(() => {
    const map = new Map<number, NicheFeature>();
    for (const n of roomFeatures.niches) map.set(n.run, n);
    return map;
  }, [roomFeatures]);

  /* MATERIAL WIRING (v0.11 §2) — procedural maps from lib/game/materials.
   * Sunken rooms (pool / pool-hall / ducks) are glazed-tile basins: deck
   * AND bowl sample the shared tile maps with one texture cell per physical
   * 0.3m tile (repeat = span / TILE_SPAN_METERS — see tuning/room.ts).
   * Perimeter walls: white tile for the pool rooms (the §2 空泳池 worked
   * example), board-formed concrete everywhere else. All materials keep the
   * palette colors as their average (the factory divides out each map's
   * albedo mean — A5 monochrome discipline); maps add the roughness/normal/
   * grain variation the PBR hard requirement demands. Materials are cheap
   * per-room instances (uniforms only) disposed on unmount; the textures
   * they sample are shared app-lifetime singletons. */
  const tiledGround = spec.ground === "sunken";
  const tiledWalls =
    recipe.archetype === "pool" || recipe.archetype === "pool-hall";
  const surfaceKind = tiledWalls ? ("tile" as const) : ("concrete" as const);
  const wallNormalScale = tiledWalls ? TILE_NORMAL_SCALE : CONCRETE_NORMAL_SCALE;
  const groundMaterial = useMemo(() => {
    if (!tiledGround) return null;
    return createSurfaceMaterial({
      kind: "tile",
      color: recipe.palette.ground,
      spanX: width,
      spanY: extent,
      flatShading: true,
      normalScale: TILE_NORMAL_SCALE,
    });
  }, [tiledGround, recipe, width, extent]);
  useEffect(() => () => groundMaterial?.dispose(), [groundMaterial]);
  const wallMaterials = useMemo(
    () =>
      wallRuns.map(({ wall }, i) =>
        createSurfaceMaterial({
          kind: surfaceKind,
          color: wallColor,
          // A wall box's long axis is its span (u on the box's main faces);
          // v is the drawn height (sill height on the cutaway sides).
          spanX: Math.max(wall.sizeX, wall.sizeZ),
          spanY: wallHeights[i],
          flatShading: true,
          normalScale: wallNormalScale,
        }),
      ),
    [wallRuns, wallHeights, wallColor, surfaceKind, wallNormalScale],
  );
  useEffect(
    () => () => {
      for (const m of wallMaterials) m.dispose();
    },
    [wallMaterials],
  );
  const partitionMaterials = useMemo(() => {
    if (structure.kind !== "partition") return null;
    const halfW = width / 2;
    return ([-1, 1] as const).map((side) => {
      const segLength =
        side < 0
          ? structure.gapX - DOOR_GAP_HALF + halfW
          : halfW - structure.gapX - DOOR_GAP_HALF;
      return createSurfaceMaterial({
        kind: surfaceKind,
        color: wallColor,
        spanX: Math.max(segLength, 0.1),
        spanY: wallHeight,
        flatShading: true,
        normalScale: wallNormalScale,
      });
    });
  }, [structure, width, wallColor, wallHeight, surfaceKind, wallNormalScale]);
  useEffect(
    () => () => {
      if (partitionMaterials) for (const m of partitionMaterials) m.dispose();
    },
    [partitionMaterials],
  );

  // The ground mesh (not the geometry) is rotated -π/2 about X, which maps
  // geometry (x, y, z) onto mesh-local (x, z, -y); the mesh then sits at
  // (0, GROUND_Y, extent/2), so a vertex lands at local (x, GROUND_Y + z,
  // extent/2 - y). The plane's local y spans the outward axis (lz =
  // extent/2 - y, doorway at lz = 0) and writing geometry z lifts the
  // vertex straight up. Terrain height comes from the shared terrain
  // module (the avatar physics snaps to the same field); the mesh position
  // already contributes GROUND_Y, so the geometry offset is terrainHeight
  // minus GROUND_Y.
  const groundRef = useRef<THREE.Mesh>(null);
  useLayoutEffect(() => {
    const mesh = groundRef.current;
    if (!mesh) return;
    const geometry = mesh.geometry as THREE.PlaneGeometry;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = extent / 2 - pos.getY(i);
      pos.setZ(i, terrainHeight(scaledRecipe, lx, lz) - GROUND_Y);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  }, [scaledRecipe, extent]);

  const snowing = recipe.archetype === "snowfield";
  const fireflies =
    (recipe.archetype === "forest" || recipe.archetype === "lake") &&
    (recipe.palette.id === "dusk" || recipe.palette.id === "night");
  // Parquet checkerboard for interior/wonder rooms with a flat floor
  // (sunken-basin rooms keep bare deck).
  const parquet =
    (recipe.worldClass === "interior" || recipe.worldClass === "wonder") &&
    spec.ground === "flat";
  const capColor = useMemo(
    () => new THREE.Color(recipe.palette.ground).multiplyScalar(0.45),
    [recipe],
  );
  // Terrain tessellation rides the prop scale (S^0.75) so colossal rolling
  // ground doesn't alias against its human-scale noise, capped so the
  // one-time vertex cost stays bounded.
  const groundSegments = Math.min(
    GROUND_SEGMENTS_MAX,
    Math.max(GROUND_SEGMENTS, Math.round(GROUND_SEGMENTS * propScale)),
  );

  return (
    <group
      ref={rootRef}
      key={recipe.sliceId}
      position={[door.x, 0, door.z]}
      rotation={[0, dir > 0 ? 0 : Math.PI, 0]}
    >
      {/* Grounding skirt: dark apron extending SKIRT_OVERHANG meters beyond
          the walls on every side (hole cut for the plan). Below the corridor
          floor at the threshold — no z-fight, and the space edge fades into
          dark ground in the mist instead of ending in a geometric cut. */}
      <mesh
        geometry={skirtGeometry}
        position={[0, SKIRT_Y, extent / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <meshStandardMaterial color={skirtColor} roughness={1} />
      </mesh>

      {/* Ground: width × extent plane (scaled dims), displaced by the
          archetype heightfield. Spans local z ∈ [0, extent] with the
          doorway edge at z = 0, flush against the corridor wall, and is
          lifted GROUND_Y above the corridor floor so the seam can never
          z-fight. */}
      <mesh
        ref={groundRef}
        position={[0, GROUND_Y, extent / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        {...(groundMaterial ? { material: groundMaterial } : {})}
      >
        <planeGeometry
          args={[width, extent, groundSegments, groundSegments]}
        />
        {groundMaterial ? null : (
          <meshStandardMaterial
            color={recipe.palette.ground}
            roughness={1}
            flatShading
          />
        )}
      </mesh>

      {/* Parquet dressing: low-contrast checkerboard so big interior/
          wonder floors never read as one solid slab of color. */}
      {parquet && (
        <FloorParquet
          width={width}
          extent={extent}
          base={recipe.palette.ground}
        />
      )}

      {/* Floor inlay (template feature, §7.2): a calm stone border band
          flat on the floor — lifted above the parquet's plane, never
          fighting its checker (A3). Flat-floor rooms only. */}
      {roomFeatures.inlay && (
        <FloorInlay
          inlay={roomFeatures.inlay}
          band={INLAY_BAND_WIDTH * (wallHeight / WALL_HEIGHT)}
          color={inlayColor}
        />
      )}

      {waterRect && (
        <>
          <WaterSurface
            halfX={waterRect.halfX}
            halfZ={waterRect.halfZ}
            cz={waterRect.cz}
            color={waterColor}
            shallowColor={waterShallowColor}
          />
          <WaterRipples patches={motif.ripples} color={rippleColor} />
        </>
      )}

      {trees.length > 0 && (
        <TreeInstances placements={trees} canopyColor={canopyColor} />
      )}
      {rocks.length > 0 && <RockInstances placements={rocks} />}

      {/* Motif props: seeded low-poly set pieces, kept clear of the doorway
          corridor, the walls, and (except poolside fixtures) the water. */}
      {motif.props.map((p, i) => (
        <group
          key={i}
          position={[p.x, p.y, p.z]}
          rotation={[0, p.rotY, 0]}
          scale={p.scale}
        >
          <Shadowed>
            <MotifProp
              kind={p.kind}
              accent={recipe.palette.accent}
              canopyColor={canopyColor}
            />
          </Shadowed>
        </group>
      ))}

      {/* Interior furnishing: kit-staged groupings (plus the pool hall's
          legacy water fixtures and the wonder rooms' rugs). Scales are
          ABSOLUTE — both paths bake the room's prop scale in — so a
          colossal hotel room gets colossal furniture; the door stays
          human. */}
      {furniture.map((p, i) => (
        <group
          key={`f${i}`}
          position={[p.x, p.y, p.z]}
          rotation={[0, p.rotY, 0]}
          scale={p.scale}
        >
          <Shadowed>
            <MotifProp
              kind={p.kind}
              accent={recipe.palette.accent}
              canopyColor={canopyColor}
            />
          </Shadowed>
        </group>
      ))}

      {/* Internal structure (L/XL): partition wall with a door gap, or a
          column grid. Same opaque wall dressing as the perimeter; heights
          ride the room's wall scale. */}
      {structure.kind === "partition" && (
        <>
          {([-1, 1] as const).map((side, si) => {
            const halfW = width / 2;
            const gapHalf = DOOR_GAP_HALF;
            const segLength =
              side < 0
                ? structure.gapX - gapHalf + halfW
                : halfW - structure.gapX - gapHalf;
            const segCenter =
              side < 0
                ? -halfW + segLength / 2
                : structure.gapX + gapHalf + segLength / 2;
            return (
              <group key={side}>
                <mesh
                  position={[segCenter, wallHeight / 2, structure.z]}
                  castShadow
                  receiveShadow
                  {...(partitionMaterials
                    ? { material: partitionMaterials[si] }
                    : {})}
                >
                  <boxGeometry
                    args={[segLength, wallHeight, wallThick]}
                  />
                  {partitionMaterials ? null : (
                    <meshStandardMaterial
                      color={wallColor}
                      roughness={1}
                      flatShading
                    />
                  )}
                </mesh>
                <mesh
                  position={[segCenter, wallHeight - 0.05, structure.z]}
                  castShadow
                  receiveShadow
                >
                  <boxGeometry
                    args={[segLength + 0.06, 0.1, wallThick + 0.06]}
                  />
                  <meshStandardMaterial
                    color={capColor}
                    roughness={1}
                    flatShading
                  />
                </mesh>
              </group>
            );
          })}
        </>
      )}
      {structure.kind === "columns" &&
        structure.points.map((pt, i) => (
          <group
            key={i}
            position={[pt.x, GROUND_Y, pt.z]}
            scale={wallHeight / WALL_HEIGHT}
          >
            <Shadowed>
              <MotifProp
                kind="column"
                accent={recipe.palette.accent}
                canopyColor={canopyColor}
              />
            </Shadowed>
          </group>
        ))}

      {/* Dynamic atmosphere layers. */}
      {snowing && (
        <Snowfall
          key={`snow-${recipe.sliceId}`}
          width={width}
          extent={extent}
          seed={recipe.lightSeed}
          sizeScale={creatureScale}
        />
      )}
      {fireflies && (
        <Fireflies
          key={`ff-${recipe.sliceId}`}
          width={width}
          extent={extent}
          seed={recipe.lightSeed}
          sizeScale={creatureScale}
        />
      )}

      {/* Wonder-room animals. */}
      {animals.ducks.length > 0 && (
        <Ducks key={`ducks-${recipe.sliceId}`} ducks={animals.ducks} />
      )}
      {animals.pets.pets.length > 0 && (
        <PetAnimals
          key={`pets-${recipe.sliceId}`}
          kind={animals.pets.kind}
          pets={animals.pets.pets}
        />
      )}
      {animals.balloons.map((b, i) => (
        <BalloonBunch key={`b${i}`} data={b} scale={creatureScale} />
      ))}

      {/* Perimeter walls from the room plan — the silhouette is no longer
          always a rectangle: l-shape rooms step down to one leg, colonnade
          rooms open their sides into column bays. The entrance pair is
          always human-thickness around the 2.4m doorway gap, and strand
          doors split their host walls the same way (wallRuns). Fully
          opaque; the camera-facing segments are cut to sill height
          (wallHeights) so the interior reads over them — the dollhouse
          cutaway. */}
      {wallRuns.map(({ wall }, i) => {
        const h = wallHeights[i];
        const niche = nicheByRun.get(i);
        // A run hosting a niche is rebuilt around the opening (flanks +
        // header + the recessed alcove) instead of drawn as one box.
        if (niche) {
          return (
            <NicheWallRun
              key={i}
              wall={wall}
              height={h}
              niche={niche}
              plan={plan}
              material={wallMaterials[i]}
              trimColor={DOOR_TRIM_COLOR}
              capColor={capColor}
              alcoveColor={alcoveColor}
              stoneColor={dadoPanelColor}
            />
          );
        }
        return (
          <group key={i}>
            <mesh
              position={[wall.x, h / 2, wall.z]}
              castShadow
              receiveShadow
              material={wallMaterials[i]}
            >
              <boxGeometry args={[wall.sizeX, h, wall.sizeZ]} />
            </mesh>
            {/* Dark cap rail along the wall top: rides the drawn height, so
                a cut sill keeps its rail and the room boundary stays
                readable from inside. */}
            <mesh
              position={[wall.x, h - 0.05, wall.z]}
              castShadow
              receiveShadow
            >
              <boxGeometry
                args={[wall.sizeX + 0.06, 0.1, wall.sizeZ + 0.06]}
              />
              <meshStandardMaterial color={capColor} roughness={1} flatShading />
            </mesh>
          </group>
        );
      })}

      {/* dado-band (§3.2): baseboard + panelled wainscot on the inner face
          of every perimeter wall — the room reads as a place at its
          boundary, which is where the eye looks for craft. Breaks at the
          doorway (the entrance segments already split around the gap) and
          follows the cutaway (short camera-side walls keep only the band
          parts that fit under their drawn top). A niche's host run skips
          the band: the wainscot would cross the alcove's opening — the
          architrave trim dresses that wall instead. */}
      {wallRuns.map(({ wall }, i) =>
        nicheByRun.has(i) ? null : (
          <DadoBand
            key={`dado${i}`}
            wall={wall}
            height={wallHeights[i]}
            plan={plan}
            wallScale={wallHeight / WALL_HEIGHT}
            trimColor={capColor}
            panelColor={dadoPanelColor}
          />
        ),
      )}

      {/* Pilaster rhythm (template feature, §7.2): strips standing on the
          dado band, evenly spread per run — the door-split runs break the
          rhythm at every opening for free, and cutaway sills are skipped
          (no shaft room above the rail). */}
      {roomFeatures.pilasters.map((p) => (
        <PilasterRun
          key={`pil${p.run}`}
          wall={wallRuns[p.run].wall}
          height={wallHeights[p.run]}
          alongs={p.alongs}
          plan={plan}
          wallScale={wallHeight / WALL_HEIGHT}
          color={dadoPanelColor}
        />
      ))}

      {/* Strand doors (B.8): one per strand through the slice, composed
          like the doors of a home — clustered, framed, with thresholds
          and name plaques. Unlit doors are the strand's unwritten
          continuation: present, closed, dark — never missing, never
          glowing. */}
      {roomDoors &&
        doorLayout.doors.map((placement) => {
          const spec = roomDoors[placement.index];
          if (!spec) return null;
          return (
            <RoomDoorAssembly
              key={spec.key}
              placement={placement}
              label={spec.label}
              lit={spec.lit}
              accent={doorGlowColor(recipe.palette)}
              wallColor={wallColor}
              thick={Math.min(
                walls[placement.wall].sizeX,
                walls[placement.wall].sizeZ,
              )}
              drawnHeight={sourceWallHeights.get(placement.wall) ?? wallHeight}
              playerRef={playerRef}
              door={door}
            />
          );
        })}

      {/* Colonnade bays: open column rows where the side walls would be —
          the room spills onto the mist skirt between the columns. Column
          height matches the walls (wall scale, not prop scale). A pier
          that lands in a strand door's approach strip (only possible when
          the spacing ladder relaxed a door near the corner, below the
          primary end pad) is dropped — the door stays walkable-to (B.11);
          one missing pier in the bay rhythm beats a buried door. */}
      {plan.columns
        .filter((c) => !inDoorApproach(c.x, c.z, doorLayout.doors))
        .map((c, i) => (
        <group
          key={`bay${i}`}
          position={[c.x, GROUND_Y, c.z]}
          scale={wallHeight / WALL_HEIGHT}
        >
          <Shadowed>
            <MotifProp
              kind="column"
              accent={recipe.palette.accent}
              canopyColor={canopyColor}
            />
          </Shadowed>
        </group>
        ))}

      {/* Motivated fixtures (B.13): the findable source of every lit
          surface — a lamp with a real point light, a window whose spot is
          the interior rooms' shadow-casting KEY, and (outdoor-class sets +
          pool hall) the skylight that justifies the overall key. */}
      <RoomLamp
        x={fixtures.lamp.x}
        z={fixtures.lamp.z}
        y={terrainHeight(scaledRecipe, fixtures.lamp.x, fixtures.lamp.z)}
        scale={propScale}
      />
      <RoomWindow
        fixture={fixtures.window}
        wallScale={wallHeight / WALL_HEIGHT}
        paneColor={windowPaneColor}
        isKey={recipe.worldClass === "interior"}
      />
      {fixtures.skylight && (
        <RoomSkylight
          fixture={fixtures.skylight}
          y={wallHeight + SKYLIGHT_LIFT * (wallHeight / WALL_HEIGHT)}
          wallScale={wallHeight / WALL_HEIGHT}
          paneColor={skylightPaneColor}
        />
      )}

      {/* The door from inside: same frame and glow as the corridor face;
          the hinged slab mounts once the corridor is gone — before that
          the corridor's own slab is the one physical door. */}
      <SpaceDoorway
        accent={doorGlowColor(recipe.palette)}
        wallColor={wallColor}
        playerRef={playerRef}
        door={door}
        doorVisible={corridorGone}
      />
    </group>
  );
}
