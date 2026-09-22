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
 * AXIAL SEMANTICS (§10.5): strand doors live on the NORTH/SOUTH (plan-
 * horizontal) walls — "change timeline" and "turn back" face the same way
 * as the corridor's own doors — while the east/west walls belong to
 * windows and light (buildRoomFixtures hosts the window there first).
 * When one axial wall can't hold the count, the same wall grows a SECOND
 * bank (门厅式): a freestanding screen ROOM_DOOR_ROW_DEPTH inward, built
 * here from the same opaque wall language and split by the same splitter
 * (doorScreens/screenRuns); east/west overflow is the last resort, never
 * the norm. Furniture clearance tests run against doorClearanceSet — the
 * doors plus a mirrored copy of each screen-row door — so the shallow
 * vestibule behind a screen stays walkable, not furnished.
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
 * spot, the clerestory band's wash — while the canvas's directional sun
 * drops to a fill in interior rooms).
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
import { GAME_DEBUG, WATER_DEBUG_MIRROR } from "./debug";
import { smoothstep } from "@/lib/game/math";
import { createRng, deriveSubSeed, hashString, WORLD_SEED } from "@/lib/game/seed";
import { doorGlowColor } from "@/lib/game/space-recipe";
import {
  GROUND_Y,
  POOL_DEPTH,
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
import { AnchorTerminal } from "@/lib/game/anchor-terminal";
import { roomTerminalFor } from "@/lib/game/anchor";
import {
  doorAffordanceFor,
  resolveRoomTemplate,
  templatePlanFor,
  templateZonesFor,
  type RoomTemplate,
} from "@/lib/game/room-templates";
import {
  compositionForRecipe,
  compositionKitZonesFor,
  compositionTemplateFor,
  moduleSconceFor,
  moduleWallForSegment,
  roomModuleById,
  seamPartitionsFor,
  type ModuleEdge,
  type ModuleSconceAnchor,
  type WallRoleM,
} from "@/lib/game/room-modules";
import { schematicPlacementsFor } from "@/lib/game/room-schematic";
import type { SplitWall } from "@/lib/game/room-doors";
import {
  crossedRoomDoor,
  doorCapacityFor,
  doorClearanceSet,
  hostableWallsFor,
  inDoorApproach,
  placeRoomDoors,
  plaqueLabelFor,
  splitWallsForDoors,
  wallFacesCamera,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import {
  applyPoolCaustics,
  buildWindowViewImage,
  createSurfaceMaterial,
  createWaterSurfaceMaterial,
  createWaveDriver,
  createWindowViewTexture,
  sharedRadialGlowTexture,
  sharedWallWashTexture,
  waveRectContains,
  type WaveDriver,
} from "@/lib/game/materials";
import {
  SUN_SHADOW_BIAS,
  SUN_SHADOW_NORMAL_BIAS,
} from "@/lib/game/tuning/render";
import {
  kitsFor,
  planArea,
  stageInteriorKits,
  type StagedKitPiece,
} from "@/lib/game/kits";
import {
  ARCH_HEADROOM,
  ARCH_MIN_RUN,
  ARCH_POST,
  ARCH_SPRING_Y,
  ARCH_TUBE,
  ARCH_WIDTH,
  ARCH_DOOR_CLEAR,
  BALLOON_BUNCHES,
  BALLOON_COLORS,
  COLONNADE_BAY,
  COLUMN_CAPITAL_HEIGHT,
  COLUMN_CAPITAL_SIZE,
  COLUMN_DOOR_CLEAR,
  COLUMN_END_PAD,
  COLUMN_MIN_RUN,
  COLUMN_OFF_WALL,
  COLUMN_PLINTH_HEIGHT,
  COLUMN_PLINTH_SIZE,
  COLUMN_SHAFT_HEIGHT,
  COLUMN_SHAFT_RADIUS,
  COLUMN_SPAN,
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
  LAMP_NIGHT_BOOST,
  LAMP_POOL_OPACITY,
  LAMP_POOL_RADIUS,
  LAMP_POLE_HEIGHT,
  LAMP_SHADE_EMISSIVE,
  LAMP_SHADE_Y,
  LIGHT_REGISTER_TINTS,
  LIGHT_REGISTER_WEIGHTS,
  LONE_PROB,
  MEZZANINE_DECK_Y,
  MEZZANINE_DEPTH,
  MEZZANINE_HEADROOM,
  MEZZANINE_MIN_RUN,
  MEZZANINE_PARAPET,
  MEZZANINE_SLAB,
  MODULE_LIGHT_FIXTURES,
  NICHE_DOOR_CLEAR,
  NICHE_HEIGHT,
  NICHE_MAX_DEPTH,
  NICHE_PEDESTAL_FILL,
  NICHE_PEDESTAL_HEIGHT,
  NICHE_WIDTH,
  PARQUET_CELL,
  PARQUET_TONE_LIFT,
  PATH_HALF,
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
  PLATFORM_DEPTH,
  PLATFORM_DOOR_CLEAR,
  PLATFORM_HEIGHT,
  PLATFORM_MIN_RUN,
  PLATFORM_RAIL_HEIGHT,
  PLATFORM_STEP_DEPTH,
  PROP_COUNT,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  PROP_SCALE_EXP,
  ROCK_DIVISOR,
  ROCK_MIN,
  ROOM_DOOR_CLEAR_DEPTH,
  ROOM_DOOR_CLEAR_HALF,
  ROOM_DOOR_ROW_DEPTH,
  ROOM_DOOR_SCREEN_THICK,
  ROOM_WALL_THICKNESS,
  RILL_BED,
  RILL_MIN_LENGTH,
  RILL_PATH_CLEAR,
  RILL_RIM_HEIGHT,
  RILL_WATER_DEPTH,
  RILL_WIDTH,
  SHELF_WALL_BAY,
  SHELF_WALL_BAY_MAX,
  SHELF_WALL_BOARD,
  SHELF_WALL_BOARD_COLOR,
  SHELF_WALL_DEPTH,
  SHELF_WALL_HEIGHT,
  SHELF_WALL_MIN_H,
  SHELF_WALL_PLINTH,
  SHELF_WALL_ROW_COLORS,
  SHELF_WALL_SHELF_GAP,
  SHELF_WALL_STILE,
  SHELF_WALL_WOOD,
  SKIRT_OVERHANG,
  SKIRT_OVERHANG_MIN,
  SKIRT_Y,
  CLERESTORY_DROP,
  CLERESTORY_END_PAD,
  CLERESTORY_HEIGHT,
  CLERESTORY_SPILL_LENGTH,
  CLERESTORY_SPILL_OPACITY,
  CLERESTORY_SPOT_ANGLE,
  CLERESTORY_SPOT_INTENSITY,
  CLERESTORY_SPOT_PENUMBRA,
  CLERESTORY_SPOT_THROW,
  CLERESTORY_UNIT,
  SNOW_COUNT_MAX,
  SPACE_FADE_S,
  STRUCTURE_MIN_EXTENT,
  TILE_NORMAL_SCALE,
  TREE_DIVISOR,
  TREE_MIN,
  WALL_CLEARANCE,
  WALL_SILL_HEIGHT,
  WATER_ROUGHNESS,
  WATER_Y,
  WINDOW_DOOR_CLEAR,
  WINDOW_HEIGHT,
  WINDOW_MULLION,
  WINDOW_NIGHT_SPOT_SCALE,
  WINDOW_SHEEN_OPACITY,
  WINDOW_SILL_Y,
  WINDOW_SPILL_LENGTH,
  WINDOW_SPILL_OPACITY,
  WINDOW_SPOT_ANGLE,
  WINDOW_SPOT_INTENSITY,
  WINDOW_SPOT_PENUMBRA,
  WINDOW_SPOT_SHADOW_FAR,
  WINDOW_SPOT_SHADOW_MAP,
  WINDOW_SPOT_SHADOW_NEAR,
  WINDOW_VIEW_DAY_GAIN,
  WINDOW_VIEW_NIGHT_GAIN,
  WINDOW_VIEW_NIGHT_TINT,
  WINDOW_WIDTH,
  roomOrientationFor,
  type LightRegister,
} from "@/lib/game/tuning/room";

/**
 * App dark mode, read from the <html> class. React context never crosses
 * the R3F Canvas boundary (the integrator reads `useTheme` OUTSIDE the
 * canvas for the same reason — game-canvas.tsx), so the room's fixtures
 * watch the class next-themes writes (attribute="class", app/layout.tsx)
 * and re-render on the flip. Day/night only re-tints fixture colors and
 * gains; geometry is theme-invariant.
 */
function useAppDark(): boolean {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(el.classList.contains("dark")),
    );
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** The room's light register (v0.11-hotel-rooms §3, design §11.2 item 4):
 *  one mood per room, drawn from the recipe's lightSeed on a dedicated
 *  stream so the fixtures never perturb snowfall/fireflies sharing that
 *  seed. */
function lightRegisterFor(recipe: SpaceRecipe): LightRegister {
  const r = createRng((recipe.lightSeed ^ 0x51f15e) >>> 0)();
  let acc = 0;
  for (const entry of LIGHT_REGISTER_WEIGHTS) {
    acc += entry.weight;
    if (r < acc) return entry.id;
  }
  return "tungsten";
}

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
/* Template feature slots (v0.11-room-interiors §3.2/§7.2): the        */
/* geometric dressing the template/module layer DECLARES as data —     */
/* dado + niche + pilaster rhythm + floor inlay + the N3/N4 set        */
/* (raised platform, mezzanine, arch frame, column order, water rill). */
/* This section resolves the declared slots against the plan's wall    */
/* roles and the door-split wall runs (the existing modules' outputs — */
/* nothing re-implements their math) and builds the geometry. Every    */
/* feature is architecture: opaque, wall/floor-material, lit only by   */
/* the room's own fixtures (B.13 — a niche must NOT glow). No RNG      */
/* anywhere: the same slice under the same template always grows the   */
/* same features (A6), and a room without a template builds nothing    */
/* here.                                                               */
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

/** A resolved raised platform: a railed dais standing against one wall
 *  run, its center offset along the run. One per declared slot. */
interface PlatformFeature {
  run: number;
  along: number;
  width: number;
  depth: number;
  height: number;
  stepDepth: number;
  railH: number;
}

/** A resolved mezzanine: a half-floor ledge on one full-height run — the
 *  deck, its parapet height and the slab thickness. */
interface MezzanineFeature {
  run: number;
  along: number;
  width: number;
  deckY: number;
  depth: number;
  parapetH: number;
  slab: number;
}

/** A resolved arch frame: two posts + a round arch before one run. */
interface ArchFeature {
  run: number;
  along: number;
  width: number;
  springY: number;
  post: number;
  tube: number;
}

/** A resolved column order: free-standing column centers along one run. */
interface ColumnOrderFeature {
  run: number;
  alongs: number[];
  offWall: number;
}

/** A resolved water rill: the runnel's footprint rectangle (local frame).
 *  The channel runs along the rectangle's LONG axis, RILL_WIDTH across,
 *  centered on the short axis. */
interface RillFeature {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface RoomFeatures {
  niches: NicheFeature[];
  pilasters: PilasterFeature[];
  inlay: InlayFeature | null;
  platforms: PlatformFeature[];
  mezzanines: MezzanineFeature[];
  arches: ArchFeature[];
  columnOrders: ColumnOrderFeature[];
  rill: RillFeature | null;
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
 *  - RAISED-PLATFORM / MEZZANINE / ARCH-FRAME: single figures, each
 *    resolved to ONE door-split run of the declared role (a figure that
 *    fits its run never crosses a doorway by construction); the span
 *    centers the figure and is clamped inside the run's ends; the
 *    mezzanine and arch add their own drawn-height gates (a ledge you
 *    would crack your head on, or an arch that would pierce the wall
 *    top, is skipped — cutaway sills keep only what fits under them).
 *  - COLUMN-ORDER: per door-split run like the pilaster, but a
 *    free-standing rhythm filtered to the declared span and gated on the
 *    drawn height (a 3.3m column in a 1.1m sill is a stub).
 *  - WATER-RILL: flat floors only; the declared floor rectangle must stay
 *    wholly on one side of the walk-path corridor, inside the walkable
 *    footprint, out of the room's water and out of every door approach —
 *    any failure degrades the slot to nothing, never a clip.
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
  ground,
  water,
}: {
  template: RoomTemplate | null;
  plan: RoomPlan;
  walls: readonly WallSegment[];
  wallRuns: readonly SplitWall[];
  wallHeights: readonly number[];
  wallHeight: number;
  wallThick: number;
  doors: readonly RoomDoorPlacement[];
  /** The room's ground shape (archetype spec): the inlay needs a truly
   *  flat floor; the rill tolerates a sunken basin (its rectangle must
   *  simply avoid the water, which the resolver checks against the real
   *  basin) and only rolling terrain disqualifies it. */
  ground: "flat" | "rolling" | "sunken";
  /** The room's water rectangle (scaled, local frame) — the rill must
   *  never claim the basin's ground. Null when the room is dry. */
  water: { cx: number; cz: number; halfX: number; halfZ: number } | null;
}): RoomFeatures {
  const out: RoomFeatures = {
    niches: [],
    pilasters: [],
    inlay: null,
    platforms: [],
    mezzanines: [],
    arches: [],
    columnOrders: [],
    rill: null,
  };
  if (!template) return out;
  const ws = wallHeight / WALL_HEIGHT;
  // v0.12: runs already hosting a wall feature (niche, pilaster rhythm,
  // platform, mezzanine, arch, column order). The DECLARED-role pass never
  // consults it — same-role stacking is authored (the reading hall's
  // pilasters + arch + colonnade share the shelf wall). The FALLBACK pass
  // skips claimed runs: several features relocated off their cutaway wall
  // must spread across the walls that remain, never pile onto one.
  const claimedRuns = new Set<number>();

  // Single-figure wall features (platform, mezzanine, arch) resolve to ONE
  // run of the declared role: the first whose length holds the figure with
  // its end pads, whose DRAWN height passes the figure's own rule, and
  // whose span-center position is clear of every strand door (frame-
  // shifted, the niche discipline). Runs are already split at door gaps,
  // so a figure that fits its run never crosses a doorway. When `claimed`
  // is given and the declared role hosts nothing, the figure FALLS BACK
  // (v0.12, the arch/column half of the declarations audit) to the first
  // unclaimed non-entrance run tall enough — the declaration is a
  // preference, not a coin flip.
  const runCenterFor = (
    role: string,
    need: number,
    doorClear: number,
    minDrawn: number,
    span: readonly [number, number],
    claimed?: ReadonlySet<number>,
  ): { run: number; along: number } | null => {
    const tryAt = (i: number): { run: number; along: number } | null => {
      const run = wallRuns[i];
      if (wallRoleFor(plan, walls[run.source]) !== role) return null;
      if (wallHeights[i] < minDrawn - 1e-6) return null;
      const horizontal = run.wall.sizeZ <= run.wall.sizeX;
      const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
      if (len < need) return null;
      const pad = need / 2 + 0.3;
      const raw = ((span[0] + span[1]) / 2 - 0.5) * len;
      const along = Math.min(Math.max(raw, -len / 2 + pad), len / 2 - pad);
      const src = walls[run.source];
      const runShift = horizontal
        ? run.wall.x - src.x
        : run.wall.z - src.z;
      if (
        doors.some(
          (d) =>
            d.wall === run.source &&
            Math.abs(d.along - runShift - along) <
              need / 2 + DOOR_GAP_HALF + doorClear,
        )
      ) {
        return null;
      }
      return { run: i, along };
    };
    for (let i = 0; i < wallRuns.length; i++) {
      const hit = tryAt(i);
      if (hit) return hit;
    }
    if (!claimed) return null;
    for (let i = 0; i < wallRuns.length; i++) {
      if (claimed.has(i)) continue;
      if (walls[wallRuns[i].source].entrance) continue;
      // retarget the role filter at this run's own role
      const hit = tryAtWithRole(i);
      if (hit) return hit;
    }
    return null;

    function tryAtWithRole(i: number): { run: number; along: number } | null {
      // the fallback keeps every host rule but ignores the declared role
      const run = wallRuns[i];
      if (wallHeights[i] < minDrawn - 1e-6) return null;
      const horizontal = run.wall.sizeZ <= run.wall.sizeX;
      const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
      if (len < need) return null;
      const pad = need / 2 + 0.3;
      const raw = ((span[0] + span[1]) / 2 - 0.5) * len;
      const along = Math.min(Math.max(raw, -len / 2 + pad), len / 2 - pad);
      const src = walls[run.source];
      const runShift = horizontal
        ? run.wall.x - src.x
        : run.wall.z - src.z;
      if (
        doors.some(
          (d) =>
            d.wall === run.source &&
            Math.abs(d.along - runShift - along) <
              need / 2 + DOOR_GAP_HALF + doorClear,
        )
      ) {
        return null;
      }
      return { run: i, along };
    }
  };

  for (const slot of template.features) {
    if (slot.kind === "niche") {
      const half = (NICHE_WIDTH * ws) / 2;
      // v0.12 declarations audit: the declared wall role hosts the niche
      // when it can — but the dollhouse cutaway drops one or two roles to
      // sill height per room orientation, and a niche declared on such a
      // role used to vanish for every room hung on that corridor side
      // (the bedroom's alcove existed only half the time). The slot now
      // FALLS BACK to any full-height non-entrance run, keeping every
      // host rule; the declaration is a preference, not a coin flip.
      const tryRun = (i: number): boolean => {
        const run = wallRuns[i];
        if (walls[run.source].entrance) return false;
        // Never on a cutaway sill.
        if (wallHeights[i] < wallHeight - 1e-6) return false;
        const horizontal = run.wall.sizeZ <= run.wall.sizeX;
        const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
        const span = slot.span ?? [0.4, 0.6];
        const along = ((span[0] + span[1]) / 2 - 0.5) * len;
        // The opening must sit fully on the run, clear of its ends…
        if (Math.abs(along) + half > len / 2 - 0.3) return false;
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
          return false;
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
        return true;
      };
      const declared = wallRuns
        .map((_, i) => i)
        .filter((i) => wallRoleFor(plan, walls[wallRuns[i].source]) === slot.at);
      const fallback = wallRuns
        .map((_, i) => i)
        .filter(
          (i) =>
            !declared.includes(i) &&
            !claimedRuns.has(i) &&
            !walls[wallRuns[i].source].entrance &&
            wallHeights[i] >= wallHeight - 1e-6,
        );
      for (const i of [...declared, ...fallback]) {
        if (tryRun(i)) {
          claimedRuns.add(i);
          break; // one niche per declared slot
        }
      }
    } else if (slot.kind === "pilaster-rhythm") {
      const stripMin =
        (DADO_TOP + DADO_FULL_MARGIN + PILASTER_MIN_STRIP) * ws;
      // Same fallback discipline as the niche: the declared role first,
      // then any full-height non-entrance run (the study's pilasters now
      // land on a real wall whichever side of the corridor the room hangs
      // on). The fallback claims ONE run — a rhythm repeated on every
      // wall would read as wallpaper, not architecture.
      const tryRun = (i: number): number[] => {
        const run = wallRuns[i];
        if (walls[run.source].entrance) return [];
        // Breaking at the dado band: a pilaster stands ON the full band —
        // cutaway sills (baseboard only, no shaft room) get none.
        if (wallHeights[i] < stripMin) return [];
        const horizontal = run.wall.sizeZ <= run.wall.sizeX;
        const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
        const pad = PILASTER_END_PAD * ws;
        const runLen = len - pad * 2;
        if (runLen < PILASTER_MIN_RUN * ws) return [];
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
        return alongs;
      };
      const declared = wallRuns
        .map((_, i) => i)
        .filter((i) => wallRoleFor(plan, walls[wallRuns[i].source]) === slot.at);
      const fallback = wallRuns
        .map((_, i) => i)
        .filter(
          (i) =>
            !declared.includes(i) &&
            !claimedRuns.has(i) &&
            !walls[wallRuns[i].source].entrance &&
            wallHeights[i] >= stripMin,
        );
      let placedSlot = false;
      for (const i of declared) {
        const alongs = tryRun(i);
        if (alongs.length > 0) {
          out.pilasters.push({ run: i, alongs });
          claimedRuns.add(i);
          placedSlot = true;
        }
      }
      if (!placedSlot) {
        for (const i of fallback) {
          const alongs = tryRun(i);
          if (alongs.length > 0) {
            out.pilasters.push({ run: i, alongs });
            claimedRuns.add(i);
            break; // the fallback claims one run, never every wall
          }
        }
      }
    } else if (slot.kind === "floor-inlay" && ground === "flat" && out.inlay === null) {
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
    } else if (slot.kind === "raised-platform") {
      // The railed dais: fits any drawn height (36cm against a sill is a
      // step, not a story), needs a run long enough to hold it.
      const span = slot.span ?? [0.3, 0.7];
      const fit = runCenterFor(
        slot.at,
        PLATFORM_MIN_RUN * ws,
        PLATFORM_DOOR_CLEAR * ws,
        0,
        span,
      );
      if (fit) {
        const run = wallRuns[fit.run];
        const len = run.wall.sizeZ <= run.wall.sizeX ? run.wall.sizeX : run.wall.sizeZ;
        const width = Math.min(
          Math.max((span[1] - span[0]) * len, 1.4 * ws),
          len - 0.6,
        );
        if (width >= 1.4 * ws) {
          out.platforms.push({
            run: fit.run,
            along: fit.along,
            width,
            depth: PLATFORM_DEPTH * ws,
            height: PLATFORM_HEIGHT * Math.max(ws, 0.6),
            stepDepth: PLATFORM_STEP_DEPTH * Math.max(ws, 0.6),
            railH: PLATFORM_RAIL_HEIGHT * ws,
          });
          claimedRuns.add(fit.run);
        }
      }
    } else if (slot.kind === "mezzanine") {
      // The half-floor ledge: only a wall tall enough to hold the deck
      // above a person's head (deck + slab + margin) — cutaway sills and
      // low rooms skip.
      const fit = runCenterFor(
        slot.at,
        MEZZANINE_MIN_RUN * ws,
        0.3 * ws,
        (MEZZANINE_DECK_Y + MEZZANINE_SLAB + 0.2) * ws,
        slot.span ?? [0.25, 0.75],
      );
      if (fit) {
        const run = wallRuns[fit.run];
        const len = run.wall.sizeZ <= run.wall.sizeX ? run.wall.sizeX : run.wall.sizeZ;
        const width = Math.min(
          Math.max(((slot.span?.[1] ?? 0.75) - (slot.span?.[0] ?? 0.25)) * len, 2.2 * ws),
          len - 0.6,
        );
        out.mezzanines.push({
          run: fit.run,
          along: fit.along,
          width,
          deckY: MEZZANINE_DECK_Y * ws,
          depth: MEZZANINE_DEPTH * ws,
          parapetH: MEZZANINE_PARAPET * ws,
          slab: MEZZANINE_SLAB * ws,
        });
        claimedRuns.add(fit.run);
      }
    } else if (slot.kind === "arch-frame") {
      // The portal: needs its full height under the wall's drawn top. Like
      // the niche and the pilasters, the declared role is a preference —
      // when the dollhouse cutaway sinks it (the reading hall's north face
      // at one corridor side), the arch relocates to the first unclaimed
      // full-height run instead of vanishing; the claimedRuns discipline
      // keeps it off walls already hosting another feature's fallback.
      const fit = runCenterFor(
        slot.at,
        ARCH_WIDTH * ws,
        ARCH_DOOR_CLEAR * ws,
        (ARCH_SPRING_Y + ARCH_TUBE + ARCH_HEADROOM) * ws,
        slot.span ?? [0.4, 0.6],
        claimedRuns,
      );
      if (fit) {
        out.arches.push({
          run: fit.run,
          along: fit.along,
          width: ARCH_WIDTH * ws,
          springY: ARCH_SPRING_Y * ws,
          post: ARCH_POST * ws,
          tube: ARCH_TUBE * ws,
        });
        claimedRuns.add(fit.run);
      }
    } else if (slot.kind === "column-order") {
      // The free-standing colonnade rhythm: per door-split run (the rhythm
      // breaks at every opening for free), gated on the drawn height
      // (a 3.3m column in a 1.1m sill is a stub), positions filtered to the
      // declared span and kept clear of door frames.
      const colH =
        (COLUMN_PLINTH_HEIGHT + COLUMN_SHAFT_HEIGHT + COLUMN_CAPITAL_HEIGHT + 0.1) *
        ws;
      const span = slot.span ?? [0.1, 0.9];
      const tryRun = (i: number): number[] => {
        const run = wallRuns[i];
        if (wallHeights[i] < colH) return [];
        const horizontal = run.wall.sizeZ <= run.wall.sizeX;
        const len = horizontal ? run.wall.sizeX : run.wall.sizeZ;
        const pad = COLUMN_END_PAD * ws;
        const runLen = len - pad * 2;
        if (runLen < COLUMN_MIN_RUN * ws) return [];
        const n = Math.max(1, Math.round(runLen / (COLUMN_SPAN * ws)));
        const spacing = runLen / n;
        const srcWall = walls[run.source];
        const runShift = horizontal
          ? run.wall.x - srcWall.x
          : run.wall.z - srcWall.z;
        const alongs: number[] = [];
        for (let k = 0; k < n; k++) {
          const a = -len / 2 + pad + (k + 0.5) * spacing;
          const norm = (a + len / 2) / len;
          if (norm < span[0] || norm > span[1]) continue;
          if (
            doors.some(
              (d) =>
                d.wall === run.source &&
                Math.abs(d.along - runShift - a) <
                  DOOR_GAP_HALF + COLUMN_SHAFT_RADIUS * ws + COLUMN_DOOR_CLEAR * ws,
            )
          ) {
            continue;
          }
          alongs.push(a);
        }
        return alongs;
      };
      let placedSlot = false;
      for (let i = 0; i < wallRuns.length; i++) {
        if (wallRoleFor(plan, walls[wallRuns[i].source]) !== slot.at) continue;
        const alongs = tryRun(i);
        if (alongs.length > 0) {
          out.columnOrders.push({ run: i, alongs, offWall: COLUMN_OFF_WALL * ws });
          claimedRuns.add(i);
          placedSlot = true;
        }
      }
      if (!placedSlot) {
        // v0.12: the cutaway sank the declared role — relocate the
        // rhythm to the first unclaimed tall run (the arch's fallback
        // discipline), never piling onto a wall already hosting one.
        for (let i = 0; i < wallRuns.length; i++) {
          if (claimedRuns.has(i)) continue;
          if (walls[wallRuns[i].source].entrance) continue;
          if (wallRoleFor(plan, walls[wallRuns[i].source]) === slot.at) continue;
          const alongs = tryRun(i);
          if (alongs.length > 0) {
            out.columnOrders.push({ run: i, alongs, offWall: COLUMN_OFF_WALL * ws });
            claimedRuns.add(i);
            break; // the fallback claims one run, never every wall
          }
        }
      }
    } else if (slot.kind === "water-rill" && ground !== "rolling" && out.rill === null) {
      // The runnel: a declared floor rectangle carrying a shallow stone
      // channel of real water. Degrades to NOTHING (never clips) when:
      // the floor rolls, the rectangle crosses the walk-path corridor or
      // the room's water, sits inside a strand door's approach, or falls
      // outside the walkable footprint. The channel runs along the
      // rectangle's LONG axis.
      const span = slot.span ?? [0.2, 0.8];
      const spanZ = slot.spanZ ?? [0.2, 0.8];
      let x0 = (span[0] - 0.5) * plan.width;
      let x1 = (span[1] - 0.5) * plan.width;
      let z0 = spanZ[0] * plan.extent;
      let z1 = spanZ[1] * plan.extent;
      // Keep the runnel out of the walk-path corridor: it must lie wholly
      // on one side of the door→hero spine. A declaration that straddles
      // the spine is clipped to its wider side; clipped past a channel's
      // width, the slot degrades to nothing.
      const corridor = PATH_HALF + RILL_PATH_CLEAR * ws;
      if (x0 < corridor && x1 > -corridor) {
        if (x0 + x1 > 0) x0 = corridor;
        else x1 = -corridor;
        if (x1 - x0 < RILL_WIDTH * ws) continue;
      }
      const longX = x1 - x0 >= z1 - z0;
      const len = longX ? x1 - x0 : z1 - z0;
      if (len < RILL_MIN_LENGTH * ws) continue;
      // Whole footprint inside the walkable plan (l-shape's abandoned
      // quadrant takes no runnel), with the rim's own margin.
      const margin = wallThick + 0.15;
      const corners = [
        [x0, z0],
        [x0, z1],
        [x1, z0],
        [x1, z1],
      ] as const;
      if (!corners.every(([cx, cz]) => planContains(plan, cx, cz, margin))) {
        continue;
      }
      // Never the basin's ground, never a door's approach.
      if (water) {
        const overlap =
          Math.abs((x0 + x1) / 2 - water.cx) <
            (x1 - x0) / 2 + water.halfX &&
          Math.abs((z0 + z1) / 2 - water.cz) <
            (z1 - z0) / 2 + water.halfZ;
        if (overlap) continue;
      }
      const probe = longX
        ? ([
            [x0, (z0 + z1) / 2],
            [x1, (z0 + z1) / 2],
            [(x0 + x1) / 2, (z0 + z1) / 2],
          ] as const)
        : ([
            [(x0 + x1) / 2, z0],
            [(x0 + x1) / 2, z1],
            [(x0 + x1) / 2, (z0 + z1) / 2],
          ] as const);
      if (probe.some(([px, pz]) => inDoorApproach(px, pz, doors))) continue;
      out.rill = { x0, x1, z0, z1 };
    }
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
  front = 0,
}: {
  wall: WallSegment;
  height: number;
  alongs: readonly number[];
  plan: RoomPlan;
  wallScale: number;
  color: THREE.Color;
  front?: number;
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
  const off = thick / 2 + proj / 2 - 0.002 + front; // 2mm sink, the dado convention
  const capProj = proj * 1.35;
  const capOff = thick / 2 + capProj / 2 - 0.002 + front;
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
 * Shelf wall (书架墙): the wall-register treatment for a module whose wall
 * role is "shelf" (the study, the reading room — v0.12 declarations audit:
 * the register existed as a COLOUR only, so the declared book walls never
 * rendered). A low-poly bookcase skin stands on the floor against the
 * wall's inner face — fully opaque, wall-supported (I2), no hanging, no
 * transparency — bays of shelves and book rows in the exact material
 * language of the bookshelf prop (same woods, same three book colours).
 * Only FULL-HEIGHT runs host it (a bookcase rising out of a 1.1m cutaway
 * sill is the niche's "hole in nothing" failure); bays overlapping the
 * window's frame are left open. Where a pilaster rhythm shares the run,
 * the strips render proud of the shelves (PilasterRun's `front`) and
 * read as the bays' vertical divisions.
 */
function ShelfWallRun({
  wall,
  height,
  plan,
  wallScale,
  window,
}: {
  wall: WallSegment;
  height: number;
  plan: RoomPlan;
  wallScale: number;
  /** The room's one window — bays under its frame stay empty (the window
   *  never hangs on a feature host run by construction, but a host pool
   *  fallback can still land it beside one; the skip is the backstop). */
  window: WindowFixture;
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
  const len = horizontal ? wall.sizeX : wall.sizeZ;
  const bookH = Math.min(height - 0.06, SHELF_WALL_HEIGHT * k);
  if (bookH < SHELF_WALL_MIN_H * k) return null;
  const depth = SHELF_WALL_DEPTH * k;
  // The window's along-range on this wall (frame margin as built).
  const onThisWall = horizontal
    ? Math.abs(window.z - wall.z) < 0.2 && Math.abs(window.x - wall.x) <= len / 2
    : Math.abs(window.x - wall.x) < 0.2 && Math.abs(window.z - wall.z) <= len / 2;
  const winAlong = horizontal ? window.x - wall.x : window.z - wall.z;
  const winHalf = WINDOW_WIDTH * k;
  const n = Math.max(
    1,
    Math.min(SHELF_WALL_BAY_MAX, Math.round(len / (SHELF_WALL_BAY * k))),
  );
  const bayW = len / n;
  const stile = SHELF_WALL_STILE * k;
  const board = SHELF_WALL_BOARD * k;
  const plinth = SHELF_WALL_PLINTH * k;
  const gap = SHELF_WALL_SHELF_GAP * k;
  const off = thick / 2 + depth / 2 - 0.002;
  const pos = (along: number, y: number): [number, number, number] =>
    horizontal
      ? [wall.x + along, y, wall.z + nz * off]
      : [wall.x + nx * off, y, wall.z + along];
  const shelfYs: number[] = [];
  for (let y = plinth + gap; y <= bookH - board - 0.04; y += gap) {
    shelfYs.push(y);
  }
  const parts: ReactNode[] = [];
  // Bay-boundary stiles (n bays share n+1 boundaries — no doubled boxes).
  for (let i = 0; i <= n; i++) {
    const a = -len / 2 + i * bayW;
    parts.push(
      <mesh key={`st${i}`} position={pos(a, bookH / 2)} castShadow receiveShadow>
        <boxGeometry
          args={horizontal ? [stile, bookH, depth] : [depth, bookH, stile]}
        />
        <meshStandardMaterial color={SHELF_WALL_WOOD} roughness={1} flatShading />
      </mesh>,
    );
  }
  // Run-length boards: plinth, top, and every shelf.
  const boards: { key: string; y: number; t: number }[] = [
    { key: "plinth", y: plinth / 2, t: plinth },
    { key: "top", y: bookH - board / 2, t: board },
    ...shelfYs.map((y, i) => ({ key: `sh${i}`, y, t: board })),
  ];
  for (const b of boards) {
    parts.push(
      <mesh key={b.key} position={pos(0, b.y)} castShadow receiveShadow>
        <boxGeometry
          args={horizontal ? [len, b.t, depth] : [depth, b.t, len]}
        />
        <meshStandardMaterial color={SHELF_WALL_BOARD_COLOR} roughness={1} flatShading />
      </mesh>,
    );
  }
  // Book rows: one low box per bay per shelf gap, the prop's three colours
  // cycling, heights alternating like the prop's own rows.
  for (let i = 0; i < n; i++) {
    const a = -len / 2 + (i + 0.5) * bayW;
    if (onThisWall && Math.abs(a - winAlong) < winHalf / 2 + bayW / 2 + 0.35) {
      continue;
    }
    for (let s = 0; s < shelfYs.length; s++) {
      const shelfY = shelfYs[s];
      const rowH = gap - board - 0.1 * k - 0.04 * k * (s % 2);
      if (rowH <= 0.05) continue;
      parts.push(
        <mesh
          key={`bk${i}-${s}`}
          position={pos(a, shelfY + board / 2 + rowH / 2)}
          castShadow
        >
          <boxGeometry
            args={
              horizontal
                ? [bayW - stile * 2 - 0.04, rowH, depth * 0.72]
                : [depth * 0.72, rowH, bayW - stile * 2 - 0.04]
            }
          />
          <meshStandardMaterial
            color={SHELF_WALL_ROW_COLORS[(i + s) % SHELF_WALL_ROW_COLORS.length]}
            roughness={1}
            flatShading
          />
        </mesh>,
      );
    }
  }
  return <group>{parts}</group>;
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

/** A railing run standing on its own y=0 plane: posts at ~1.15m pitches
 *  plus a continuous top rail, in one colour. Local +x runs along the
 *  rail, centered. Shared by the raised platform and the mezzanine. */
function RailRun({
  length,
  height,
  color,
  post = 0.075,
}: {
  length: number;
  height: number;
  color: THREE.Color;
  post?: number;
}) {
  const n = Math.max(2, Math.round(length / 1.15) + 1);
  const parts: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + (i * length) / (n - 1);
    parts.push(
      <mesh key={`p${i}`} position={[x, height / 2, 0]} castShadow>
        <boxGeometry args={[post, height, post]} />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>,
    );
  }
  parts.push(
    <mesh key="rail" position={[0, height, 0]} castShadow>
      <boxGeometry args={[length + post, 0.08, post * 1.6]} />
      <meshStandardMaterial color={color} roughness={1} flatShading />
    </mesh>,
  );
  return <group>{parts}</group>;
}

/** Inward-normal helpers shared by the wall-bound N3/N4 features — the
 *  same probe trick as the dado and the niche. */
function wallFrameFor(wall: WallSegment, plan: RoomPlan) {
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
  // Y-rotation mapping a RailRun's local +x onto the wall's run / across.
  const alongRot = horizontal ? 0 : Math.PI / 2;
  const acrossRot = horizontal ? Math.PI / 2 : 0;
  return { horizontal, len, thick, pos, box, alongRot, acrossRot };
}

/**
 * Raised platform (§3.2 抬高平台): the railed dais against one wall —
 * the platform body, one intermediate step (two rises of height/2), and
 * RailRuns on the three open edges. Body in the room's panel tone, the
 * rails in the dark cap-rail trim — the same two-note material language
 * as the dado.
 */
function RaisedPlatform({
  wall,
  feature,
  plan,
  bodyColor,
  railColor,
}: {
  wall: WallSegment;
  feature: PlatformFeature;
  plan: RoomPlan;
  bodyColor: THREE.Color;
  railColor: THREE.Color;
}) {
  const { thick, pos, box, alongRot, acrossRot } = wallFrameFor(wall, plan);
  const { along, width, depth, height, stepDepth, railH } = feature;
  const face = thick / 2;
  const stepH = height / 2;
  const railY = GROUND_Y + height;
  return (
    <group>
      <mesh
        position={pos(along, GROUND_Y + height / 2, face + depth / 2)}
        castShadow
        receiveShadow
      >
        <boxGeometry args={box(width, height, depth)} />
        <meshStandardMaterial color={bodyColor} roughness={1} flatShading />
      </mesh>
      {/* The one intermediate step — the platform's own edge is the
          second rise. */}
      <mesh
        position={pos(along, GROUND_Y + stepH / 2, face + depth + stepDepth / 2)}
        castShadow
        receiveShadow
      >
        <boxGeometry args={box(width, stepH, stepDepth)} />
        <meshStandardMaterial color={bodyColor} roughness={1} flatShading />
      </mesh>
      {/* Railing on the open edges: the front + the two ends. */}
      <group
        position={pos(along, railY, face + depth - 0.04)}
        rotation={[0, alongRot, 0]}
      >
        <RailRun length={width} height={railH} color={railColor} />
      </group>
      {([-1, 1] as const).map((side) => (
        <group
          key={side}
          position={pos(
            along + side * (width / 2 - 0.04),
            railY,
            face + depth / 2,
          )}
          rotation={[0, acrossRot, 0]}
        >
          <RailRun length={depth - 0.08} height={railH} color={railColor} />
        </group>
      ))}
    </group>
  );
}

/**
 * Mezzanine (§3.2 夹层): the half-floor ledge — a slab on corbel brackets
 * along the wall, a solid parapet panel on its open edge, and cheek
 * walls closing the two ends. The second silhouette layer the dollhouse
 * camera reads as "a place", fully opaque, no ceiling above it (the sky
 * the room already has does that).
 */
function MezzanineDeck({
  wall,
  feature,
  plan,
  bodyColor,
  parapetColor,
  trimColor,
}: {
  wall: WallSegment;
  feature: MezzanineFeature;
  plan: RoomPlan;
  bodyColor: THREE.Color;
  parapetColor: THREE.Color;
  trimColor: THREE.Color;
}) {
  const { thick, pos, box, acrossRot } = wallFrameFor(wall, plan);
  const { along, width, deckY, depth, parapetH, slab } = feature;
  const face = thick / 2;
  const corbels = Math.min(4, Math.max(2, Math.round(width / 2.4)));
  return (
    <group>
      {/* The slab + a proud front fascia (the ledge's finished edge). */}
      <mesh
        position={pos(along, deckY + slab / 2, face + depth / 2)}
        castShadow
        receiveShadow
      >
        <boxGeometry args={box(width, slab, depth)} />
        <meshStandardMaterial color={bodyColor} roughness={1} flatShading />
      </mesh>
      <mesh
        position={pos(along, deckY + slab / 2, face + depth - 0.03)}
        castShadow
      >
        <boxGeometry args={box(width, slab + 0.05, 0.06)} />
        <meshStandardMaterial color={trimColor} roughness={1} flatShading />
      </mesh>
      {/* Corbels underneath, leaning into the wall. */}
      {Array.from({ length: corbels }, (_, i) => {
        const a = along - width / 2 + ((i + 0.5) * width) / corbels;
        return (
          <mesh
            key={i}
            position={pos(a, deckY - 0.16, face + depth * 0.35)}
            rotation={acrossRot !== 0 ? [0.55, 0, 0] : [0, 0, -0.55]}
            castShadow
          >
            <boxGeometry args={[0.12, 0.34, 0.12]} />
            <meshStandardMaterial color={trimColor} roughness={1} flatShading />
          </mesh>
        );
      })}
      {/* The parapet panel on the open edge + the end cheeks. */}
      <mesh
        position={pos(along, deckY + slab + parapetH / 2, face + depth - 0.06)}
        castShadow
        receiveShadow
      >
        <boxGeometry args={box(width, parapetH, 0.09)} />
        <meshStandardMaterial color={parapetColor} roughness={1} flatShading />
      </mesh>
      <mesh
        position={pos(along, deckY + slab + parapetH, face + depth - 0.06)}
        castShadow
      >
        <boxGeometry args={box(width + 0.06, 0.07, 0.15)} />
        <meshStandardMaterial color={trimColor} roughness={1} flatShading />
      </mesh>
      {([-1, 1] as const).map((side) => (
        <mesh
          key={side}
          position={pos(
            along + side * (width / 2 - 0.05),
            deckY + slab + parapetH / 2,
            face + depth / 2,
          )}
          castShadow
          receiveShadow
        >
          <boxGeometry args={box(0.09, parapetH, depth)} />
          <meshStandardMaterial color={parapetColor} roughness={1} flatShading />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Arch frame (§3.2 拱门框): two posts on plinths and a round arch
 * spanning them, standing before the wall — a portal that closes its
 * own top (no ceiling needed). The arch is a half-torus in the wall's
 * stone register, with a small keystone at the crown.
 */
function ArchFrame({
  wall,
  feature,
  plan,
  stoneColor,
}: {
  wall: WallSegment;
  feature: ArchFeature;
  plan: RoomPlan;
  stoneColor: THREE.Color;
}) {
  const { thick, pos, horizontal } = wallFrameFor(wall, plan);
  const { along, width, springY, post, tube } = feature;
  const face = thick / 2;
  const radius = width / 2 - post / 2;
  const postOff = face + post / 2 + 0.02;
  const archY = GROUND_Y + springY;
  const mat = (
    <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
  );
  return (
    <group>
      {([-1, 1] as const).map((side) => {
        const a = along + side * (width / 2 - post / 2);
        return (
          <group key={side}>
            <mesh position={pos(a, GROUND_Y + 0.09, postOff)} castShadow>
              <boxGeometry args={[post * 1.5, 0.18, post * 1.5]} />
              {mat}
            </mesh>
            <mesh
              position={pos(a, GROUND_Y + 0.18 + springY / 2, postOff)}
              castShadow
              receiveShadow
            >
              <boxGeometry args={[post, springY, post]} />
              {mat}
            </mesh>
          </group>
        );
      })}
      {/* The round arch: a half-torus spanning the posts, its plane
          aligned with the wall's run. */}
      <mesh
        position={pos(along, archY, postOff)}
        rotation={[0, horizontal ? 0 : Math.PI / 2, 0]}
        castShadow
      >
        <torusGeometry args={[radius, tube, 8, 20, Math.PI]} />
        {mat}
      </mesh>
      {/* Keystone at the crown, nosed toward the room. */}
      <mesh
        position={pos(along, archY + radius + tube * 0.2, postOff + tube * 0.35)}
        castShadow
      >
        <boxGeometry
          args={horizontal ? [post * 0.55, tube * 1.7, post * 0.8] : [post * 0.8, tube * 1.7, post * 0.55]}
        />
        {mat}
      </mesh>
    </group>
  );
}

/**
 * Column order (§3.2 柱式): the free-standing colonnade — for each
 * resolved center, a plinth, a gently tapering shaft, and a capital
 * with its abacus, standing off the wall in the room's quarry stone.
 */
function ColumnOrderRun({
  wall,
  feature,
  plan,
  stoneColor,
}: {
  wall: WallSegment;
  feature: ColumnOrderFeature;
  plan: RoomPlan;
  stoneColor: THREE.Color;
}) {
  const { thick, pos, box } = wallFrameFor(wall, plan);
  const off = thick / 2 + feature.offWall;
  const shaftBase = GROUND_Y + COLUMN_PLINTH_HEIGHT;
  const capitalBase = shaftBase + COLUMN_SHAFT_HEIGHT;
  return (
    <group>
      {feature.alongs.map((a, i) => (
        <group key={i}>
          <mesh
            position={pos(a, GROUND_Y + COLUMN_PLINTH_HEIGHT / 2, off)}
            castShadow
            receiveShadow
          >
            <boxGeometry
              args={box(COLUMN_PLINTH_SIZE, COLUMN_PLINTH_HEIGHT, COLUMN_PLINTH_SIZE)}
            />
            <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
          </mesh>
          <mesh
            position={pos(a, shaftBase + COLUMN_SHAFT_HEIGHT / 2, off)}
            castShadow
            receiveShadow
            rotation={[0, shaftTwist(i), 0]}
          >
            <cylinderGeometry
              args={[
                COLUMN_SHAFT_RADIUS,
                COLUMN_SHAFT_RADIUS * 1.18,
                COLUMN_SHAFT_HEIGHT,
                12,
              ]}
            />
            <meshStandardMaterial
              color={stoneColor.clone().multiplyScalar(1.08)}
              roughness={1}
              flatShading
            />
          </mesh>
          <mesh
            position={pos(a, capitalBase + COLUMN_CAPITAL_HEIGHT / 2, off)}
            castShadow
          >
            <boxGeometry
              args={box(COLUMN_CAPITAL_SIZE, COLUMN_CAPITAL_HEIGHT, COLUMN_CAPITAL_SIZE)}
            />
            <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
          </mesh>
          <mesh
            position={pos(a, capitalBase + COLUMN_CAPITAL_HEIGHT + 0.03, off)}
            castShadow
          >
            <boxGeometry
              args={box(COLUMN_CAPITAL_SIZE * 1.15, 0.06, COLUMN_CAPITAL_SIZE * 1.15)}
            />
            <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Deterministic per-column twist so the shafts' flat facets do not
 *  align into a visual moiré down the run. */
function shaftTwist(i: number): number {
  return (i % 3) * 0.35;
}

/** One face of the water rill's stone runnel. `WaterRill` orients this. */
function RillWater({
  rect,
  level,
  color,
  shallowColor,
  playerRef,
  door,
  dir,
}: {
  rect: { cx: number; cz: number; halfX: number; halfZ: number };
  level: number;
  color: THREE.Color;
  shallowColor: THREE.Color;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  door: DoorRef;
  dir: 1 | -1;
}) {
  const driver = useMemo(() => createWaveDriver(rect), [rect]);
  useEffect(() => () => driver.dispose(), [driver]);
  const water = useMemo(
    () =>
      createWaterSurfaceMaterial({
        color,
        shallowColor,
        spanX: rect.halfX * 2,
        spanY: rect.halfZ * 2,
        centerZ: rect.cz,
        waveTexture: driver.texture,
        waveTexelMeters: driver.texelMeters,
      }),
    [color, shallowColor, rect, driver],
  );
  useEffect(() => () => water.dispose(), [water]);
  // Wading impulses — the same discipline as the pool's WaterSurface:
  // a splash on entry, then a step every ~0.5m inside the runnel. No
  // mirror (the pool owns GAME_DEBUG.water) and no bob (a runnel's
  // water sits still; its life is the ripple, not the tide).
  const wadeRef = useRef({ x: 0, z: 0, acc: 0, inside: false });
  useFrame((_, delta) => {
    const p = playerRef.current;
    const lx = (p.x - door.x) * dir;
    const lz = (p.z - door.z) * dir;
    const w = wadeRef.current;
    if (waveRectContains(lx, lz, rect)) {
      if (!w.inside) {
        driver.addImpulse(lx, lz, -0.1, 0.22);
      } else {
        w.acc += Math.hypot(lx - w.x, lz - w.z);
        if (w.acc >= 0.5) {
          const speed = w.acc / Math.max(delta, 1e-3);
          driver.addImpulse(lx, lz, Math.max(-0.12, -0.04 - 0.015 * speed), 0.16);
          w.acc = 0;
        }
      }
      w.inside = true;
    } else {
      w.inside = false;
      w.acc = 0;
    }
    w.x = lx;
    w.z = lz;
    driver.step(delta);
  });
  return (
    <mesh
      position={[rect.cx, level, rect.cz]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={1}
      receiveShadow
      material={water.material}
    >
      <planeGeometry args={[rect.halfX * 2, rect.halfZ * 2]} />
    </mesh>
  );
}

/**
 * Water rill (§3.2 地面水渠): the stone runnel — bed, two side walls and
 * end caps in the room's quarry stone, capped stones along the rims,
 * carrying REAL water on its own wave driver (RillWater). The channel
 * runs the rectangle's long axis, RILL_WIDTH across.
 */
function WaterRill({
  rill,
  ws,
  stoneColor,
  bedColor,
  waterColor,
  waterShallowColor,
  playerRef,
  door,
  dir,
}: {
  rill: RillFeature;
  ws: number;
  stoneColor: THREE.Color;
  bedColor: THREE.Color;
  waterColor: THREE.Color;
  waterShallowColor: THREE.Color;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  door: DoorRef;
  dir: 1 | -1;
}) {
  const cx = (rill.x0 + rill.x1) / 2;
  const cz = (rill.z0 + rill.z1) / 2;
  const alongX = rill.x1 - rill.x0 >= rill.z1 - rill.z0;
  const len = alongX ? rill.x1 - rill.x0 : rill.z1 - rill.z0;
  const width = RILL_WIDTH * ws;
  const rim = RILL_RIM_HEIGHT * ws;
  const bedT = RILL_BED * ws;
  const wallT = 0.12 * Math.max(ws, 0.6);
  const waterLevel = RILL_WATER_DEPTH * ws;
  // Rotation mapping the runnel's local frame (channel along local z)
  // onto the room: an x-running rill turns 90°.
  const rotY = alongX ? Math.PI / 2 : 0;
  // Cap stones along both rims.
  const caps: number[] = [];
  const nCaps = Math.max(2, Math.floor(len / (0.9 * ws)));
  for (let i = 0; i < nCaps; i++) {
    caps.push(-len / 2 + ((i + 0.5) * len) / nCaps);
  }
  return (
    <>
      <group position={[cx, 0, cz]} rotation={[0, rotY, 0]}>
        {/* Bed + side walls + end caps. */}
        <mesh position={[0, GROUND_Y + bedT / 2, 0]} receiveShadow>
          <boxGeometry args={[width, bedT, len]} />
          <meshStandardMaterial color={bedColor} roughness={1} flatShading />
        </mesh>
        {([-1, 1] as const).map((side) => (
          <mesh
            key={side}
            position={[side * (width / 2 + wallT / 2), GROUND_Y + rim / 2, 0]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[wallT, rim, len]} />
            <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
          </mesh>
        ))}
        {([-1, 1] as const).map((side) => (
          <mesh
            key={`e${side}`}
            position={[0, GROUND_Y + rim / 2, side * (len / 2 - wallT / 2)]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[width + wallT * 2, rim, wallT]} />
            <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
          </mesh>
        ))}
        {/* Rim cap stones. */}
        {caps.map((z, i) =>
          ([-1, 1] as const).map((side) => (
            <mesh
              key={`c${i}${side}`}
              position={[
                side * (width / 2 + wallT / 2),
                GROUND_Y + rim + 0.035,
                z + (i % 2 === 0 ? 0.06 : -0.06) * ws,
              ]}
              rotation={[0, (i % 3) * 0.08, 0]}
              castShadow
            >
              <boxGeometry args={[wallT + 0.07 * ws, 0.07, 0.34 * ws]} />
              <meshStandardMaterial color={stoneColor} roughness={1} flatShading />
            </mesh>
          )),
        )}
      </group>
      {/* The water lives in the PLAN frame — the driver's impulses and
          the wading probe are measured in room-local coordinates, so the
          rectangle handed here stays unrotated. */}
      <RillWater
        rect={{
          cx,
          cz,
          halfX: (rill.x1 - rill.x0) / 2,
          halfZ: (rill.z1 - rill.z0) / 2,
        }}
        level={GROUND_Y + waterLevel}
        color={waterColor}
        shallowColor={waterShallowColor}
        playerRef={playerRef}
        door={door}
        dir={dir}
      />
    </>
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
 *  first render. Meshes tagged `userData.noCastShadow` (fountain water and
 *  other alpha surfaces) only RECEIVE: a shadow caster renders through a
 *  depth material that ignores transparency, so a casting water disc would
 *  paint an opaque slab shadow over the basin it exists to fill. */
function Shadowed({ children }: { children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    ref.current?.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        if (obj.userData.noCastShadow) {
          obj.castShadow = false;
          obj.receiveShadow = true;
          return;
        }
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
  }, []);
  return <group ref={ref}>{children}</group>;
}

/** Water surface: a REAL shallow-water material (materials/water-surface.ts)
 *  — Beer–Lambert depth absorption rebuilt analytically from the terrain
 *  bowl (ankle-clear at the corners, tinted at depth) that always lets the
 *  pool floor read through, and a near-glossy PBR finish so the environment
 *  and key light answer with a specular streak. A wave-equation sim
 *  (materials/wave-driver.ts) supplies the surface normals and the live
 *  wading ripples: a splash on entry, footsteps every ~0.5 m of travel
 *  inside the rect. The plane still bobs gently; all motion is a pure
 *  function of the frame clock plus the player's own steps. The material
 *  and driver are per-room and disposed on unmount; the textures they
 *  sample are shared app-lifetime singletons.
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
  playerRef,
  door,
  dir,
  driver,
}: {
  halfX: number;
  halfZ: number;
  cz: number;
  color: THREE.Color;
  shallowColor: THREE.Color;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  door: DoorRef;
  dir: 1 | -1;
  /** The room's wave driver — created (and disposed) by SpaceScene, which
   *  also hands the driver's texture to the pool-floor caustics patch. */
  driver: WaveDriver;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const rect = useMemo(() => ({ cx: 0, cz, halfX, halfZ }), [cz, halfX, halfZ]);
  const water = useMemo(
    () =>
      createWaterSurfaceMaterial({
        color,
        shallowColor,
        spanX: halfX * 2,
        spanY: halfZ * 2,
        centerZ: cz,
        waveTexture: driver.texture,
        waveTexelMeters: driver.texelMeters,
      }),
    [color, shallowColor, halfX, halfZ, cz, driver],
  );
  useEffect(() => () => water.dispose(), [water]);
  // Wading impulses: a step every ~0.5 m of travel inside the water rect,
  // amplitude ∝ speed; one splash on entry. Sim steps on a fixed clock.
  const wadeRef = useRef({ x: 0, z: 0, acc: 0, inside: false });
  // Probe/e2e mirror: hang the preallocated record off GAME_DEBUG while
  // mounted, drop it on unmount; the loop mutates it in place below.
  useEffect(() => {
    GAME_DEBUG.water = WATER_DEBUG_MIRROR;
    return () => {
      GAME_DEBUG.water = null;
    };
  }, []);
  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    water.update(t);
    const mesh = meshRef.current;
    if (mesh) mesh.position.y = WATER_Y + Math.sin(t * 0.6) * 0.02;

    const p = playerRef.current;
    const lx = (p.x - door.x) * dir;
    const lz = (p.z - door.z) * dir;
    const w = wadeRef.current;
    if (waveRectContains(lx, lz, rect)) {
      if (!w.inside) {
        driver.addImpulse(lx, lz, -0.12, 0.3); // entry splash
      } else {
        w.acc += Math.hypot(lx - w.x, lz - w.z);
        if (w.acc >= 0.5) {
          const speed = w.acc / Math.max(delta, 1e-3);
          driver.addImpulse(lx, lz, Math.max(-0.14, -0.05 - 0.02 * speed), 0.2);
          w.acc = 0;
        }
      }
      w.inside = true;
    } else {
      w.inside = false;
      w.acc = 0;
    }
    w.x = lx;
    w.z = lz;
    driver.step(delta);
    const m = GAME_DEBUG.water;
    if (m) {
      m.cx = rect.cx;
      m.cz = rect.cz;
      m.halfX = rect.halfX;
      m.halfZ = rect.halfZ;
      m.doorX = door.x;
      m.doorZ = door.z;
      m.dir = dir;
      m.awake = driver.awake;
    }
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
  // nature kits (§3.1 N4) — the worn outdoor vocabulary the nature set
  // composes: standing stones, boulders, water-edge reeds, the unlit fire
  // pit, jetty deck sections, moss patches, the eroded dry-stone wall.
  | "standingstone"
  | "boulder"
  | "reeds"
  | "firepit"
  | "jettydeck"
  | "moss"
  | "ruinwall"
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
  // craft pass (2026-10): the finer room dressing — real mirrors, plants,
  // a laid table, stacked chairs, a fountain, poolside furniture, the
  // hall clock and the true reception counter. 简化的 3D ≠ 简化的细节.
  | "vanity"
  | "plant"
  | "pedestal"
  | "diningtable"
  | "chairstack"
  | "fountain"
  | "poolbench"
  | "ringpost"
  | "grandfatherclock"
  | "counter"
  | "screen"
  | "sideboard"
  | "towelrail"
  | "poolladder"
  // The structure layer (v0.12-room-realism §2 — the living pilot's
  // vocabulary, consumed by room-schematic.ts's slots): the coffee table
  // and the media unit under the TV, and the tabletop dressing trio.
  | "coffeetable"
  | "mediaunit"
  | "vase"
  | "frame"
  | "candle"
  // wonder props
  | "yarn"
  | "cattree"
  | "scratchpost"
  | "doghouse"
  | "bone"
  | "ball"
  // wonder kits (§3.1 N4) — the diorama world's oversized playthings:
  // stud-topped toy blocks, the marble-run tower/chute, giant chessmen,
  // folded paper boats, warm paper ground lanterns, the self-supported
  // swing frame and its rope-hung seats.
  | "toyblock"
  | "marblerun"
  | "marblechute"
  | "chessking"
  | "chessrook"
  | "chesspawn"
  | "paperboat"
  | "paperlantern"
  | "swingframe"
  | "swingseat";

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
  /** §4.4: this piece is the room's one trace — a small calm kind set
   *  ON a host piece (same x/z, lifted to the host's top). Carried to the
   *  probe mirror so probes can count traces without the scene graph. */
  trace?: boolean;
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
    /* ------------------------------------------------------------ */
    /* The nature set (§3.1 N4): worn outdoor pieces at human scale,  */
    /* in the same material language as the scatter vocabulary —      */
    /* flat-shaded low-poly primitives, weathered stone and timber.   */
    /* ------------------------------------------------------------ */
    case "standingstone":
      // 立石 — a worn menhir: a low base drum, the tapered slab rising
      // from it, a capstone seated slightly askew (weather, not damage).
      return (
        <group>
          <mesh position={[0, 0.13, 0]}>
            <cylinderGeometry args={[0.34, 0.42, 0.26, 7]} />
            <meshStandardMaterial color="#7f8286" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.0, 0]}>
            <boxGeometry args={[0.46, 1.5, 0.3]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.03, 1.8, 0]} rotation={[0, 0.28, 0.04]}>
            <boxGeometry args={[0.34, 0.18, 0.24]} />
            <meshStandardMaterial color="#95918a" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "boulder":
      // 巨石 — a squat weathered boulder: a low-poly rock with a
      // flattened crown (a trace can rest on it) and a smaller brother
      // leaning at its foot.
      return (
        <group>
          <mesh position={[0, 0.26, 0]} scale={[1.2, 0.72, 1.05]}>
            <dodecahedronGeometry args={[0.5, 0]} />
            <meshStandardMaterial color="#8f8a7c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.52, 0.1, 0.3]} scale={[0.55, 0.4, 0.5]} rotation={[0, 0.7, 0]}>
            <dodecahedronGeometry args={[0.5, 0]} />
            <meshStandardMaterial color="#98917f" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "reeds":
      // 芦苇 — a clump rooted in the shallows: thin blades at seeded
      // tilts, three carrying their seed heads above the waterline.
      return (
        <group>
          {(
            [
              [0, 0, 1.45, 0],
              [0.12, 0.06, 1.2, 0.1],
              [-0.11, 0.03, 1.32, -0.12],
              [0.05, -0.12, 1.1, 0.16],
              [-0.07, -0.09, 1.4, -0.06],
              [0.16, -0.04, 0.95, 0.22],
              [-0.17, 0.1, 1.05, -0.2],
            ] as const
          ).map(([x, z, h, lean], i) => (
            <group key={i} position={[x, 0, z]} rotation={[lean, 0, lean * 0.7]}>
              <mesh position={[0, h / 2, 0]}>
                <cylinderGeometry args={[0.014, 0.02, h, 4]} />
                <meshStandardMaterial color="#5f7d48" roughness={1} flatShading />
              </mesh>
              {i % 2 === 0 && (
                <mesh position={[0, h + 0.09, 0]}>
                  <cylinderGeometry args={[0.028, 0.02, 0.2, 5]} />
                  <meshStandardMaterial color="#a4906a" roughness={1} flatShading />
                </mesh>
              )}
            </group>
          ))}
        </group>
      );
    case "firepit":
      // 火塘（不点火）— a ring of fire stones around an ash pan with two
      // charred logs crossed inside, cold by rule. Calm, never spent-in-
      // a-hurry: the wood is stacked, the stones settled.
      return (
        <group>
          {(
            [
              [0.42, 0, 1.1],
              [0.3, 0.3, 0.9],
              [0, 0.42, 1],
              [-0.3, 0.3, 1.15],
              [-0.42, 0, 0.95],
              [-0.3, -0.3, 1.05],
              [0, -0.42, 0.9],
              [0.3, -0.3, 1],
            ] as const
          ).map(([x, z, s], i) => (
            <mesh key={i} position={[x, 0.09, z]} rotation={[0.2 * i, 0.5 * i, 0]} scale={s}>
              <dodecahedronGeometry args={[0.11, 0]} />
              <meshStandardMaterial color="#7f8286" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0, 0.03, 0]}>
            <cylinderGeometry args={[0.3, 0.32, 0.05, 10]} />
            <meshStandardMaterial color="#6a655c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.1, 0]} rotation={[0, 0.5, Math.PI / 2]}>
            <cylinderGeometry args={[0.035, 0.045, 0.52, 5]} />
            <meshStandardMaterial color="#4a3f36" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.13, 0]} rotation={[0, -0.7, Math.PI / 2]}>
            <cylinderGeometry args={[0.03, 0.04, 0.44, 5]} />
            <meshStandardMaterial color="#544639" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "jettydeck":
      // 木栈道 — one deck section: plank boards on four posts. Authored
      // so the deck crown (local y 0.45) rides above the water surface
      // (WATER_Y 0.35) while the posts reach the bed — supported, never
      // floating (I2). Sections join into the jetty kit's walkway.
      return (
        <group>
          <mesh position={[0, 0.415, 0]}>
            <boxGeometry args={[1.5, 0.07, 1.25]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {[-0.31, 0, 0.31].map((x) => (
            <mesh key={x} position={[x, 0.462, 0]}>
              <boxGeometry args={[0.26, 0.024, 1.25]} />
              <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
            </mesh>
          ))}
          {(
            [
              [-0.66, -0.5],
              [0.66, -0.5],
              [-0.66, 0.5],
              [0.66, 0.5],
            ] as const
          ).map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.2, z]}>
              <cylinderGeometry args={[0.055, 0.065, 0.42, 6]} />
              <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "moss":
      // 苔藓 — a low cushion patch: flattened mounds hugging the ground
      // at the foot of logs and stones, in two forest-floor greens.
      return (
        <group>
          {(
            [
              [0, 0, 0.3, "#6a8a54"],
              [0.3, 0.14, 0.22, "#5f8048"],
              [-0.26, 0.1, 0.24, "#5f8048"],
              [0.05, -0.24, 0.2, "#6a8a54"],
            ] as const
          ).map(([x, z, r, color], i) => (
            <mesh key={i} position={[x, 0.035, z]} scale={[1, 0.24, 1]}>
              <sphereGeometry args={[r, 7, 5]} />
              <meshStandardMaterial color={color} roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "ruinwall":
      // 残破矮墙 — a run of worn dry-stone: three blocks at staggered
      // heights rounded by erosion. Calm decay — no fresh breaks, no
      // debris (§6's bans hold); the wall simply ran out of wall.
      return (
        <group>
          {(
            [
              [-0.35, 0.72, 0],
              [0, 0.5, 0.08],
              [0.35, 0.62, -0.06],
            ] as const
          ).map(([x, h, lean], i) => (
            <mesh key={i} position={[x, h / 2, 0]} rotation={[0, lean, 0]}>
              <boxGeometry args={[0.32, h, 0.4]} />
              <meshStandardMaterial
                color={["#8a8d90", "#95918a", "#7f8286"][i]}
                roughness={1}
                flatShading
              />
            </mesh>
          ))}
          <mesh position={[0.12, 0.76, 0]} rotation={[0, 0.2, 0]}>
            <boxGeometry args={[0.2, 0.08, 0.3]} />
            <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
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
    /* ------------------------------------------------------------ */
    /* The craft pass (2026-10): finer room dressing. Every piece is  */
    /* real geometry at human scale (the avatar is 1.7m), in the      */
    /* hotel's material language — oiled woods, brass, cream fabric,  */
    /* one dark gloss for mirrors and clock glass. The only alphas    */
    /* are water (the fountain's skin).                               */
    /* ------------------------------------------------------------ */
    case "vanity":
      // Dressing table: a slim top on two drawer stacks, the mirror
      // rising from its back edge — the "mirror" is a dark polished
      // panel (low roughness, high metalness — a sheen, never a real
      // reflection), plus a perfume bottle and a powder box on the top.
      return (
        <group>
          {[-0.48, 0.48].map((x) => (
            <mesh key={x} position={[x, 0.36, 0]}>
              <boxGeometry args={[0.24, 0.72, 0.42]} />
              <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
            </mesh>
          ))}
          {[-0.48, 0.48].map((x) =>
            [0.2, 0.42, 0.62].map((y) => (
              <mesh key={`${x}${y}`} position={[x, y, 0.215]}>
                <boxGeometry args={[0.05, 0.03, 0.02]} />
                <meshStandardMaterial
                  color="#c8b06a"
                  roughness={0.4}
                  metalness={0.6}
                  flatShading
                />
              </mesh>
            )),
          )}
          <mesh position={[0, 0.75, 0]}>
            <boxGeometry args={[1.2, 0.06, 0.46]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {/* Mirror frame + polished panel, standing on the top's back edge. */}
          <mesh position={[0, 1.35, -0.19]}>
            <boxGeometry args={[0.86, 1.1, 0.05]} />
            <meshStandardMaterial color="#463f36" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.35, -0.16]}>
            <boxGeometry args={[0.74, 0.98, 0.02]} />
            <meshStandardMaterial
              color="#232c38"
              roughness={0.08}
              metalness={0.85}
              flatShading
            />
          </mesh>
          {/* Dressing items: a perfume flacon and a powder box. */}
          <mesh position={[0.32, 0.85, 0.08]}>
            <cylinderGeometry args={[0.03, 0.04, 0.14, 7]} />
            <meshStandardMaterial
              color="#8a949e"
              roughness={0.25}
              metalness={0.5}
              flatShading
            />
          </mesh>
          <mesh position={[0.32, 0.94, 0.08]}>
            <sphereGeometry args={[0.02, 6, 5]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
          <mesh position={[-0.3, 0.81, 0.05]}>
            <cylinderGeometry args={[0.07, 0.07, 0.05, 10]} />
            <meshStandardMaterial color="#e8e4da" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "plant":
      // Potted floor plant: a tapered terracotta pot with its soil disc,
      // three stems carrying flattened foliage crowns in the room's
      // canopy color — the cheapest vertical rhythm a room can have.
      return (
        <group>
          <mesh position={[0, 0.18, 0]}>
            <cylinderGeometry args={[0.17, 0.22, 0.36, 10]} />
            <meshStandardMaterial color="#9c5f45" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.365, 0]}>
            <cylinderGeometry args={[0.15, 0.15, 0.03, 10]} />
            <meshStandardMaterial color="#3a2f26" roughness={1} flatShading />
          </mesh>
          {(
            [
              [0, 0.75, 0, 0.06],
              [0.1, 0.62, 0.08, -0.12],
              [-0.11, 0.6, -0.06, 0.14],
            ] as const
          ).map(([x, y, z, tilt], i) => (
            <mesh key={i} position={[x / 2, y / 2 + 0.18, z / 2]} rotation={[tilt, 0, tilt]}>
              <cylinderGeometry args={[0.018, 0.024, y - 0.36, 5]} />
              <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
            </mesh>
          ))}
          {(
            [
              [0, 0.98, 0, 0.34],
              [0.16, 0.78, 0.12, 0.24],
              [-0.17, 0.74, -0.1, 0.22],
              [0.02, 0.82, -0.16, 0.2],
            ] as const
          ).map(([x, y, z, r], i) => (
            <mesh key={i} position={[x, y, z]} scale={[1, 0.72, 1]}>
              <sphereGeometry args={[r, 8, 6]} />
              <meshStandardMaterial
                color={canopyColor}
                roughness={1}
                flatShading
              />
            </mesh>
          ))}
        </group>
      );
    case "pedestal":
      // Display pedestal: stepped base, a slight-entasis shaft, a cap —
      // and the little amphora it exists to show (accent-glazed, the
      // room's one quiet color tie).
      return (
        <group>
          <mesh position={[0, 0.07, 0]}>
            <boxGeometry args={[0.44, 0.14, 0.44]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.52, 0]}>
            <cylinderGeometry args={[0.13, 0.16, 0.76, 10]} />
            <meshStandardMaterial color="#c4c0b4" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.94, 0]}>
            <boxGeometry args={[0.38, 0.08, 0.38]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
          </mesh>
          {/* The amphora: belly, neck, lip. */}
          <mesh position={[0, 1.11, 0]} scale={[1, 1.15, 1]}>
            <sphereGeometry args={[0.11, 9, 7]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
          <mesh position={[0, 1.26, 0]}>
            <cylinderGeometry args={[0.045, 0.06, 0.12, 8]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
          <mesh position={[0, 1.33, 0]}>
            <cylinderGeometry args={[0.07, 0.05, 0.03, 8]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
        </group>
      );
    case "diningtable":
      // The laid table (一张摆着东西的桌子): a long top under a cloth
      // whose skirt hangs past the edge, four settings (plate + cup),
      // two candlesticks and a low bowl — "eating" reads at a glance.
      return (
        <group>
          {[-0.95, 0.95].flatMap((x) =>
            [-0.35, 0.35].map((z) => (
              <mesh key={`${x}${z}`} position={[x, 0.36, z]}>
                <boxGeometry args={[0.08, 0.72, 0.08]} />
                <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
              </mesh>
            )),
          )}
          <mesh position={[0, 0.73, 0]}>
            <boxGeometry args={[2.2, 0.06, 0.95]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          {/* The cloth: a slightly oversized slab plus a hanging skirt. */}
          <mesh position={[0, 0.775, 0]}>
            <boxGeometry args={[2.3, 0.025, 1.05]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={`sk${s}`} position={[0, 0.65, s * 0.52]}>
              <boxGeometry args={[2.3, 0.24, 0.02]} />
              <meshStandardMaterial color="#e8e4da" roughness={1} flatShading />
            </mesh>
          ))}
          {[-1, 1].map((s) => (
            <mesh key={`ske${s}`} position={[s * 1.14, 0.65, 0]}>
              <boxGeometry args={[0.02, 0.24, 1.05]} />
              <meshStandardMaterial color="#e8e4da" roughness={1} flatShading />
            </mesh>
          ))}
          {/* Four settings. */}
          {(
            [
              [-0.55, 0.28],
              [0.55, 0.28],
              [-0.55, -0.28],
              [0.55, -0.28],
            ] as const
          ).map(([x, z], i) => (
            <group key={i} position={[x, 0, z]}>
              <mesh position={[0, 0.8, 0]}>
                <cylinderGeometry args={[0.11, 0.09, 0.025, 12]} />
                <meshStandardMaterial color="#f2ede2" roughness={0.6} flatShading />
              </mesh>
              <mesh position={[0.14, 0.83, 0.05]}>
                <cylinderGeometry args={[0.035, 0.03, 0.07, 8]} />
                <meshStandardMaterial color="#e8e4da" roughness={0.6} flatShading />
              </mesh>
            </group>
          ))}
          {/* Candlesticks (unlit — the room's fixtures own the light, B.13). */}
          {[-0.25, 0.25].map((x) => (
            <group key={x} position={[x, 0, 0]}>
              <mesh position={[0, 0.8, 0]}>
                <cylinderGeometry args={[0.05, 0.06, 0.02, 8]} />
                <meshStandardMaterial
                  color="#c8b06a"
                  roughness={0.4}
                  metalness={0.6}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 0.87, 0]}>
                <cylinderGeometry args={[0.015, 0.03, 0.13, 6]} />
                <meshStandardMaterial
                  color="#c8b06a"
                  roughness={0.4}
                  metalness={0.6}
                  flatShading
                />
              </mesh>
              <mesh position={[0, 0.99, 0]}>
                <cylinderGeometry args={[0.018, 0.018, 0.12, 6]} />
                <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 0.81, 0]} scale={[1, 0.5, 1]}>
            <sphereGeometry args={[0.14, 10, 6]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "chairstack":
      // A stack of four side chairs against the wall (这里常有人聚):
      // three right-side-up, seat on seat with a little rotation, the
      // top one flipped — stored calmly, never toppled (I4).
      return (
        <group>
          {[0, 1, 2].map((i) => (
            <group key={i} position={[0, i * 0.47, 0]} rotation={[0, i * 0.16 - 0.12, 0]}>
              {[-0.17, 0.17].flatMap((x) =>
                [-0.17, 0.17].map((z) => (
                  <mesh key={`${x}${z}`} position={[x, 0.225, z]}>
                    <boxGeometry args={[0.045, 0.45, 0.045]} />
                    <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
                  </mesh>
                )),
              )}
              <mesh position={[0, 0.47, 0]}>
                <boxGeometry args={[0.42, 0.05, 0.42]} />
                <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
              </mesh>
              <mesh position={[0, 0.72, -0.18]}>
                <boxGeometry args={[0.42, 0.45, 0.05]} />
                <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
              </mesh>
            </group>
          ))}
          {/* The top chair, flipped onto the stack. */}
          <group position={[0, 1.78, 0]} rotation={[Math.PI, 0.3, 0]}>
            {[-0.17, 0.17].flatMap((x) =>
              [-0.17, 0.17].map((z) => (
                <mesh key={`${x}${z}`} position={[x, 0.225, z]}>
                  <boxGeometry args={[0.045, 0.45, 0.045]} />
                  <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
                </mesh>
              )),
            )}
            <mesh position={[0, 0.47, 0]}>
              <boxGeometry args={[0.42, 0.05, 0.42]} />
              <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
            </mesh>
            <mesh position={[0, 0.72, -0.18]}>
              <boxGeometry args={[0.42, 0.45, 0.05]} />
              <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
            </mesh>
          </group>
        </group>
      );
    case "fountain":
      // Fountain basin (§3.1 fountain, nearly dry): a stone ring wall
      // with its rim, the tiled basin floor, a SKIN of water (alpha —
      // the one sanctioned transparency besides glass), and the center
      // plinth with its upper bowl. The water never casts a shadow (the
      // pool-surface rule: a casting alpha plane paints an opaque slab).
      return (
        <group>
          <mesh position={[0, 0.25, 0]}>
            <cylinderGeometry args={[1.15, 1.22, 0.5, 18, 1, true]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, 0.51, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.16, 0.07, 8, 20]} />
            <meshStandardMaterial color="#c4c0b4" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[1.14, 18]} />
            <meshStandardMaterial color="#5f8a94" roughness={0.7} flatShading />
          </mesh>
          <mesh
            position={[0, 0.32, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            userData={{ noCastShadow: true }}
          >
            <circleGeometry args={[1.1, 18]} />
            <meshStandardMaterial
              color="#4a8f9b"
              transparent
              opacity={0.55}
              roughness={WATER_ROUGHNESS}
              metalness={0.1}
              flatShading
            />
          </mesh>
          {/* Center plinth and its upper bowl. */}
          <mesh position={[0, 0.45, 0]}>
            <cylinderGeometry args={[0.14, 0.2, 0.8, 10]} />
            <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.9, 0]}>
            <cylinderGeometry args={[0.44, 0.28, 0.16, 14]} />
            <meshStandardMaterial color="#c4c0b4" roughness={1} flatShading />
          </mesh>
          <mesh
            position={[0, 0.96, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            userData={{ noCastShadow: true }}
          >
            <circleGeometry args={[0.38, 14]} />
            <meshStandardMaterial
              color="#4a8f9b"
              transparent
              opacity={0.55}
              roughness={WATER_ROUGHNESS}
              metalness={0.1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "poolbench":
      // Poolside bench: two stone feet, three wood slats, no back — a
      // bench you sit on wet, reading toward the water.
      return (
        <group>
          {[-0.6, 0.6].map((x) => (
            <mesh key={x} position={[x, 0.18, 0]}>
              <boxGeometry args={[0.14, 0.36, 0.5]} />
              <meshStandardMaterial color="#b8b4a8" roughness={1} flatShading />
            </mesh>
          ))}
          {[-0.17, 0, 0.17].map((z) => (
            <mesh key={z} position={[0, 0.385, z]}>
              <boxGeometry args={[1.6, 0.045, 0.14]} />
              <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "ringpost":
      // Life ring on its post (救生圈立柱): a slim stand, the ring hung
      // vertically on a bracket — present and calm, never an alarm.
      return (
        <group>
          <mesh position={[0, 0.03, 0]}>
            <cylinderGeometry args={[0.16, 0.2, 0.06, 10]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.65, 0]}>
            <cylinderGeometry args={[0.035, 0.045, 1.25, 7]} />
            <meshStandardMaterial
              color="#9aa0a6"
              roughness={0.5}
              metalness={0.3}
              flatShading
            />
          </mesh>
          <mesh position={[0, 1.05, 0.1]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.22, 5]} />
            <meshStandardMaterial
              color="#9aa0a6"
              roughness={0.5}
              metalness={0.3}
              flatShading
            />
          </mesh>
          <mesh position={[0, 1.05, 0.2]}>
            <torusGeometry args={[0.3, 0.09, 6, 14]} />
            <meshStandardMaterial color="#e0643c" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "grandfatherclock":
      // Grandfather clock: stepped base, the long waist with its dark
      // glass door (the pendulum hinted behind it), the head with a real
      // face — hands, tick marks — under a little pediment. 2.2m tall.
      return (
        <group>
          <mesh position={[0, 0.12, 0]}>
            <boxGeometry args={[0.56, 0.24, 0.36]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.98, 0]}>
            <boxGeometry args={[0.46, 1.5, 0.3]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          {/* The waist's glass door, pendulum hinted behind the gloss. */}
          <mesh position={[0, 0.95, 0.14]}>
            <boxGeometry args={[0.28, 1.1, 0.03]} />
            <meshStandardMaterial
              color="#232c38"
              roughness={0.08}
              metalness={0.85}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.95, 0.13]}>
            <cylinderGeometry args={[0.012, 0.012, 0.7, 5]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.62, 0.13]}>
            <cylinderGeometry args={[0.07, 0.07, 0.02, 10]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
          {/* The head and its face. */}
          <mesh position={[0, 1.92, 0]}>
            <boxGeometry args={[0.56, 0.5, 0.34]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.92, 0.16]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.18, 0.18, 0.03, 16]} />
            <meshStandardMaterial color="#f2ede2" roughness={0.7} flatShading />
          </mesh>
          {[0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2].map((a) => (
            <mesh
              key={a}
              position={[Math.sin(a) * 0.14, 1.92 + Math.cos(a) * 0.14, 0.18]}
              rotation={[0, 0, -a]}
            >
              <boxGeometry args={[0.015, 0.04, 0.01]} />
              <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0.03, 1.95, 0.18]} rotation={[0, 0, -0.9]}>
            <boxGeometry args={[0.015, 0.09, 0.01]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[-0.01, 1.9, 0.18]} rotation={[0, 0, 0.5]}>
            <boxGeometry args={[0.02, 0.13, 0.01]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          {/* Pediment crown. */}
          <mesh position={[0, 2.2, 0]}>
            <boxGeometry args={[0.6, 0.06, 0.38]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 2.28, 0]} rotation={[0, 0, Math.PI / 4]} scale={[1, 0.5, 1]}>
            <boxGeometry args={[0.3, 0.3, 0.3]} />
            <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "counter":
      // The true reception counter (craft pass — no more desk stand-in):
      // a panelled body with a toe-kick, the top slab overhanging the
      // guest side, and the luggage-tag rack standing on the clerk's end
      // (brass rail, four tags waiting).
      return (
        <group>
          <mesh position={[0, 0.06, 0]}>
            <boxGeometry args={[2.3, 0.12, 0.5]} />
            <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.56, 0]}>
            <boxGeometry args={[2.4, 0.9, 0.55]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          {/* Panelled front: two inset fields, proud of the face. */}
          {[-0.6, 0.6].map((x) => (
            <mesh key={x} position={[x, 0.56, 0.283]}>
              <boxGeometry args={[0.9, 0.62, 0.02]} />
              <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0, 1.04, 0.02]}>
            <boxGeometry args={[2.55, 0.06, 0.68]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {/* The tag rack on the clerk's end. */}
          <mesh position={[-0.95, 1.24, -0.12]}>
            <boxGeometry args={[0.5, 0.34, 0.03]} />
            <meshStandardMaterial color="#463f36" roughness={1} flatShading />
          </mesh>
          <mesh position={[-0.95, 1.32, -0.1]} rotation={[Math.PI / 2, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.012, 0.012, 0.44, 5]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
          {[-1.09, -1.0, -0.9, -0.81].map((x, i) => (
            <mesh key={x} position={[x, 1.24, -0.09]} rotation={[0, 0, i % 2 === 0 ? 0.06 : -0.05]}>
              <boxGeometry args={[0.07, 0.1, 0.012]} />
              <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "screen":
      // Folding screen: three framed fabric panels hinged at slight
      // angles on little bar feet — the room's one piece of mid-air
      // layering that still stands on the floor (I2).
      return (
        <group>
          {(
            [
              [-0.62, 0, 0.32],
              [0, 0.1, 0],
              [0.62, 0, -0.32],
            ] as const
          ).map(([x, z, ry], i) => (
            <group key={i} position={[x, 0, z]} rotation={[0, ry, 0]}>
              <mesh position={[0, 0.9, 0]}>
                <boxGeometry args={[0.6, 1.7, 0.04]} />
                <meshStandardMaterial color="#463f36" roughness={1} flatShading />
              </mesh>
              <mesh position={[0, 0.9, 0.005]}>
                <boxGeometry args={[0.5, 1.58, 0.04]} />
                <meshStandardMaterial color="#ddd6c4" roughness={1} flatShading />
              </mesh>
              {[-0.22, 0.22].map((fx) => (
                <mesh key={fx} position={[fx, 0.03, 0]}>
                  <boxGeometry args={[0.06, 0.06, 0.3]} />
                  <meshStandardMaterial color="#463f36" roughness={1} flatShading />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      );
    case "sideboard":
      // Credenza with its leaning mirror and vase (§3.1 sideboard): two
      // door fronts on short legs; the mirror rests ON the top against
      // the wall behind (wall-supported, never hung); a little vase.
      return (
        <group>
          {[-0.75, 0.75].flatMap((x) =>
            [-0.15, 0.15].map((z) => (
              <mesh key={`${x}${z}`} position={[x, 0.06, z]}>
                <boxGeometry args={[0.06, 0.12, 0.06]} />
                <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
              </mesh>
            )),
          )}
          <mesh position={[0, 0.45, 0]}>
            <boxGeometry args={[1.8, 0.66, 0.45]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          {[-0.44, 0.44].map((x) => (
            <group key={x}>
              <mesh position={[x, 0.45, 0.23]}>
                <boxGeometry args={[0.8, 0.54, 0.02]} />
                <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
              </mesh>
              <mesh position={[x + 0.3 * Math.sign(x), 0.45, 0.25]}>
                <sphereGeometry args={[0.025, 6, 5]} />
                <meshStandardMaterial
                  color="#c8b06a"
                  roughness={0.4}
                  metalness={0.6}
                  flatShading
                />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 0.8, 0]}>
            <boxGeometry args={[1.86, 0.04, 0.48]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {/* The leaning mirror, resting on the top's back edge. */}
          <group position={[0.2, 0.82, -0.16]} rotation={[-0.12, 0, 0]}>
            <mesh position={[0, 0.48, 0]}>
              <boxGeometry args={[0.72, 0.96, 0.04]} />
              <meshStandardMaterial color="#463f36" roughness={1} flatShading />
            </mesh>
            <mesh position={[0, 0.48, 0.025]}>
              <boxGeometry args={[0.6, 0.84, 0.02]} />
              <meshStandardMaterial
                color="#232c38"
                roughness={0.08}
                metalness={0.85}
                flatShading
              />
            </mesh>
          </group>
          <mesh position={[-0.6, 0.9, 0.05]} scale={[1, 1.2, 1]}>
            <sphereGeometry args={[0.07, 8, 6]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
          <mesh position={[-0.6, 1.0, 0.05]}>
            <cylinderGeometry args={[0.03, 0.04, 0.08, 7]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
        </group>
      );
    case "towelrail":
      // Freestanding towel rail (§3.1 towel-rail): two posts, two bars,
      // fresh towels draped over the top bar — one cream, one in the
      // room's accent, hanging from their own rail (never the ceiling).
      return (
        <group>
          {[-0.45, 0.45].map((x) => (
            <group key={x}>
              <mesh position={[x, 0.03, 0]}>
                <cylinderGeometry args={[0.12, 0.15, 0.06, 8]} />
                <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
              </mesh>
              <mesh position={[x, 0.58, 0]}>
                <cylinderGeometry args={[0.025, 0.03, 1.1, 6]} />
                <meshStandardMaterial
                  color="#9aa0a6"
                  roughness={0.5}
                  metalness={0.3}
                  flatShading
                />
              </mesh>
            </group>
          ))}
          {[1.1, 0.75].map((y) => (
            <mesh key={y} position={[0, y, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.018, 0.018, 0.95, 6]} />
              <meshStandardMaterial
                color="#9aa0a6"
                roughness={0.5}
                metalness={0.3}
                flatShading
              />
            </mesh>
          ))}
          {/* Draped towels: a fold over the top bar, two hanging skirts. */}
          <mesh position={[-0.2, 1.1, 0]}>
            <boxGeometry args={[0.36, 0.04, 0.12]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          {[-0.045, 0.045].map((z) => (
            <mesh key={z} position={[-0.2, 0.78, z]}>
              <boxGeometry args={[0.36, 0.62, 0.03]} />
              <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0.22, 1.1, 0]}>
            <boxGeometry args={[0.3, 0.04, 0.12]} />
            <meshStandardMaterial color={accent} roughness={1} flatShading />
          </mesh>
          {[-0.045, 0.045].map((z) => (
            <mesh key={z} position={[0.22, 0.82, z]}>
              <boxGeometry args={[0.3, 0.54, 0.03]} />
              <meshStandardMaterial color={accent} roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "coffeetable":
      // The low table (v0.12 附录 A): top at 0.4m — the sofa's reach (0.35–
      // 0.5m gap) — on four square legs, an under-shelf for the book pile.
      // The room schematic's tabletop dressing rides this top (dy lift).
      return (
        <group>
          <mesh position={[0, 0.375, 0]}>
            <boxGeometry args={[0.9, 0.05, 0.55]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          {[
            [-0.39, -0.21],
            [0.39, -0.21],
            [-0.39, 0.21],
            [0.39, 0.21],
          ].map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.175, z]}>
              <boxGeometry args={[0.06, 0.35, 0.06]} />
              <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0, 0.12, 0]}>
            <boxGeometry args={[0.78, 0.03, 0.43]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "mediaunit":
      // The TV's low stand (v0.12 附录 A): a 0.5m credenza, back at local
      // −z (against the focal wall), two door fronts, brass knobs, the top
      // panel the TV piece stands on (the schematic lifts it by this top).
      return (
        <group>
          {[
            [-0.72, -0.2],
            [0.72, -0.2],
            [-0.72, 0.2],
            [0.72, 0.2],
          ].map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.035, z]}>
              <boxGeometry args={[0.07, 0.07, 0.07]} />
              <meshStandardMaterial color="#3a3a3e" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[0, 0.28, 0]}>
            <boxGeometry args={[1.6, 0.42, 0.55]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
          {[-0.4, 0.4].map((x) => (
            <group key={x}>
              <mesh position={[x, 0.28, 0.28]}>
                <boxGeometry args={[0.72, 0.34, 0.02]} />
                <meshStandardMaterial color="#5f452c" roughness={1} flatShading />
              </mesh>
              <mesh position={[x + 0.28 * Math.sign(x), 0.28, 0.295]}>
                <sphereGeometry args={[0.022, 6, 5]} />
                <meshStandardMaterial
                  color="#c8b06a"
                  roughness={0.4}
                  metalness={0.6}
                  flatShading
                />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[1.66, 0.04, 0.58]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "vase":
      // Tabletop amphora (v0.12 附录 A — the dressing trio): belly, neck,
      // lip, in the room's accent glaze (the pedestal amphora's idiom).
      return (
        <group>
          <mesh position={[0, 0.1, 0]} scale={[1, 1.15, 1]}>
            <sphereGeometry args={[0.09, 9, 7]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
          <mesh position={[0, 0.22, 0]}>
            <cylinderGeometry args={[0.038, 0.05, 0.1, 8]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
          <mesh position={[0, 0.28, 0]}>
            <cylinderGeometry args={[0.055, 0.04, 0.025, 8]} />
            <meshStandardMaterial color={accent} roughness={0.5} flatShading />
          </mesh>
        </group>
      );
    case "frame":
      // Small standing picture frame (v0.12 附录 A): a dark frame, a warm
      // "picture" panel, a kickstand behind — it RESTS on the top, leaning
      // back a touch (supported, never hung).
      return (
        <group>
          <mesh position={[0, 0.1, 0]} rotation={[-0.1, 0, 0]}>
            <boxGeometry args={[0.2, 0.26, 0.02]} />
            <meshStandardMaterial color="#463f36" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.1, 0.012]} rotation={[-0.1, 0, 0]}>
            <boxGeometry args={[0.15, 0.2, 0.008]} />
            <meshStandardMaterial
              color="#c8a86a"
              roughness={0.9}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.07, -0.045]} rotation={[0.35, 0, 0]}>
            <boxGeometry args={[0.16, 0.14, 0.015]} />
            <meshStandardMaterial color="#463f36" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "candle":
      // Candlestick (v0.12 附录 A): a brass base and stem, a cream candle,
      // a small steady flame (emissive, like the lamp shades' glow — no
      // real point light, B.13's source discipline).
      return (
        <group>
          <mesh position={[0, 0.015, 0]}>
            <cylinderGeometry args={[0.05, 0.06, 0.03, 8]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.09, 0]}>
            <cylinderGeometry args={[0.018, 0.024, 0.12, 7]} />
            <meshStandardMaterial
              color="#c8b06a"
              roughness={0.4}
              metalness={0.6}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.185, 0]}>
            <cylinderGeometry args={[0.024, 0.024, 0.07, 8]} />
            <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.24, 0]}>
            <sphereGeometry args={[0.018, 6, 5]} />
            <meshStandardMaterial
              color="#f2e6c8"
              emissive="#f2e6c8"
              emissiveIntensity={0.9}
              roughness={1}
              flatShading
            />
          </mesh>
        </group>
      );
    case "poolladder":
      // A-frame pool ladder (扶梯, freestanding — it reads as pool
      // equipment without leaning on any basin geometry): two inclined
      // rail pairs, steps up both sides, a little top platform with
      // grab rails.
      return (
        <group>
          {[-0.28, 0.28].map((x) =>
            [-1, 1].map((s) => (
              <mesh
                key={`${x}${s}`}
                position={[x, 0.72, s * 0.42]}
                rotation={[s * 0.42, 0, 0]}
              >
                <cylinderGeometry args={[0.028, 0.028, 1.65, 6]} />
                <meshStandardMaterial
                  color="#9aa0a6"
                  roughness={0.5}
                  metalness={0.3}
                  flatShading
                />
              </mesh>
            )),
          )}
          {[0.35, 0.7, 1.05].flatMap((y) =>
            [-1, 1].map((s) => (
              <mesh key={`${y}${s}`} position={[0, y, s * (0.62 - y * 0.32)]}>
                <boxGeometry args={[0.5, 0.035, 0.14]} />
                <meshStandardMaterial
                  color="#9aa0a6"
                  roughness={0.5}
                  metalness={0.3}
                  flatShading
                />
              </mesh>
            )),
          )}
          <mesh position={[0, 1.42, 0]}>
            <boxGeometry args={[0.6, 0.05, 0.44]} />
            <meshStandardMaterial
              color="#9aa0a6"
              roughness={0.5}
              metalness={0.3}
              flatShading
            />
          </mesh>
          {[-0.28, 0.28].map((x) => (
            <mesh key={x} position={[x, 1.68, 0]}>
              <cylinderGeometry args={[0.024, 0.024, 0.5, 6]} />
              <meshStandardMaterial
                color="#9aa0a6"
                roughness={0.5}
                metalness={0.3}
                flatShading
              />
            </mesh>
          ))}
          <mesh position={[0, 1.92, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.02, 0.02, 0.56, 6]} />
            <meshStandardMaterial
              color="#9aa0a6"
              roughness={0.5}
              metalness={0.3}
              flatShading
            />
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
    /* ------------------------------------------------------------ */
    /* The wonder set (§3.1 N4): oversized playthings at human scale, */
    /* same flat-shaded low-poly language, the palette's accent for   */
    /* the painted details. Calm and whole — played-with, never       */
    /* toppled (I4).                                                  */
    /* ------------------------------------------------------------ */
    case "toyblock":
      // 巨型积木 — a stud-topped cube: cream-painted wood, the accent
      // stud screwed on top. The kit stacks these with its dy.
      return (
        <group>
          <mesh position={[0, 0.36, 0]}>
            <boxGeometry args={[0.72, 0.72, 0.72]} />
            <meshStandardMaterial color="#f2ede2" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, 0.79, 0]}>
            <cylinderGeometry args={[0.16, 0.16, 0.14, 10]} />
            <meshStandardMaterial color={accent} roughness={0.8} flatShading />
          </mesh>
        </group>
      );
    case "marblerun":
      // 滚球塔 — the tower: a plinth, the central column, two disc ramps
      // winding down around it, and three marbles resting on the lower
      // ramp. Static, at rest — the run is paused, not abandoned (I4).
      return (
        <group>
          <mesh position={[0, 0.06, 0]}>
            <cylinderGeometry args={[0.55, 0.62, 0.12, 12]} />
            <meshStandardMaterial color="#b08a5e" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.95, 0]}>
            <cylinderGeometry args={[0.07, 0.07, 1.78, 8]} />
            <meshStandardMaterial color="#a98a68" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.78, 0]}>
            <cylinderGeometry args={[0.5, 0.5, 0.05, 14]} />
            <meshStandardMaterial color={accent} roughness={0.85} flatShading />
          </mesh>
          <mesh position={[0, 1.16, 0]}>
            <cylinderGeometry args={[0.72, 0.72, 0.05, 16]} />
            <meshStandardMaterial color={accent} roughness={0.85} flatShading />
          </mesh>
          {(
            [
              [0.42, 1.24, 0.1],
              [-0.2, 1.24, 0.48],
              [0.05, 1.86, -0.3],
            ] as const
          ).map(([x, y, z], i) => (
            <mesh key={i} position={[x, y, z]}>
              <sphereGeometry args={[0.07, 8, 6]} />
              <meshStandardMaterial
                color={["#e86a58", "#63c88e", "#5970a6"][i]}
                roughness={0.4}
                flatShading
              />
            </mesh>
          ))}
        </group>
      );
    case "marblechute":
      // 滚球滑道 — the exit chute: an inclined runway on two trestle
      // legs, running down to a shallow dish that holds two more marbles.
      return (
        <group>
          <mesh position={[0.25, 0.62, 0]} rotation={[0, 0, -0.42]}>
            <boxGeometry args={[1.5, 0.05, 0.22]} />
            <meshStandardMaterial color="#a98a68" roughness={1} flatShading />
          </mesh>
          {(
            [
              [-0.15, 0.28],
              [0.62, 0.5],
            ] as const
          ).map(([x, h], i) => (
            <mesh key={i} position={[x, h / 2, 0]}>
              <boxGeometry args={[0.06, h, 0.18]} />
              <meshStandardMaterial color="#8a705c" roughness={1} flatShading />
            </mesh>
          ))}
          <mesh position={[-0.62, 0.08, 0]}>
            <cylinderGeometry args={[0.24, 0.18, 0.12, 10]} />
            <meshStandardMaterial color={accent} roughness={0.85} flatShading />
          </mesh>
          {(
            [
              [-0.66, 0.02],
              [-0.55, 0.06],
            ] as const
          ).map(([x, z], i) => (
            <mesh key={`m${i}`} position={[x, 0.16, z]}>
              <sphereGeometry args={[0.06, 8, 6]} />
              <meshStandardMaterial
                color={["#e8c34e", "#a68cd0"][i]}
                roughness={0.4}
                flatShading
              />
            </mesh>
          ))}
        </group>
      );
    case "chessking":
      // 巨型棋子·王 — the alabaster king: stepped base, tapering body,
      // crown collar and the cross finial. Tall enough to read across
      // the room.
      return (
        <group>
          <mesh position={[0, 0.11, 0]}>
            <cylinderGeometry args={[0.52, 0.58, 0.22, 14]} />
            <meshStandardMaterial color="#ece5d8" roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 0.95, 0]}>
            <cylinderGeometry args={[0.24, 0.4, 1.44, 14]} />
            <meshStandardMaterial color="#f2ede2" roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 1.74, 0]}>
            <cylinderGeometry args={[0.32, 0.24, 0.18, 12]} />
            <meshStandardMaterial color="#ece5d8" roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 1.95, 0]}>
            <sphereGeometry args={[0.24, 10, 8]} />
            <meshStandardMaterial color="#f2ede2" roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 2.26, 0]}>
            <boxGeometry args={[0.06, 0.3, 0.06]} />
            <meshStandardMaterial color={accent} roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 2.28, 0]}>
            <boxGeometry args={[0.24, 0.06, 0.06]} />
            <meshStandardMaterial color={accent} roughness={0.8} flatShading />
          </mesh>
        </group>
      );
    case "chessrook":
      // 巨型棋子·车 — the slate rook: drum body, the battlement crown
      // cut from a wider cap in four merlons.
      return (
        <group>
          <mesh position={[0, 0.11, 0]}>
            <cylinderGeometry args={[0.5, 0.56, 0.22, 14]} />
            <meshStandardMaterial color="#3f3f48" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, 0.82, 0]}>
            <cylinderGeometry args={[0.36, 0.44, 1.2, 14]} />
            <meshStandardMaterial color="#4a4a52" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, 1.5, 0]}>
            <cylinderGeometry args={[0.44, 0.38, 0.16, 14]} />
            <meshStandardMaterial color="#3f3f48" roughness={0.9} flatShading />
          </mesh>
          {(
            [
              [0.3, 0],
              [-0.3, 0],
              [0, 0.3],
              [0, -0.3],
            ] as const
          ).map(([x, z], i) => (
            <mesh key={i} position={[x, 1.68, z]}>
              <boxGeometry args={[0.22, 0.2, 0.22]} />
              <meshStandardMaterial color="#4a4a52" roughness={0.9} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "chesspawn":
      // 巨型棋子·卒 — the alabaster pawn: plain base, the ball head on
      // its collar. The smallest of the three, advanced in the game.
      return (
        <group>
          <mesh position={[0, 0.1, 0]}>
            <cylinderGeometry args={[0.42, 0.48, 0.2, 12]} />
            <meshStandardMaterial color="#ece5d8" roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 0.68, 0]}>
            <cylinderGeometry args={[0.2, 0.34, 0.96, 12]} />
            <meshStandardMaterial color="#f2ede2" roughness={0.8} flatShading />
          </mesh>
          <mesh position={[0, 1.22, 0]}>
            <sphereGeometry args={[0.26, 10, 8]} />
            <meshStandardMaterial color="#ece5d8" roughness={0.8} flatShading />
          </mesh>
        </group>
      );
    case "paperboat":
      // 折纸船 — a folded paper boat: two slanted hull panels meeting at
      // the keel, the prow and stern peaks folded up, a thin accent
      // waterline stripe. Paper-white, crisp (折纸 reads as white).
      return (
        <group>
          <mesh position={[-0.16, 0.2, 0]} rotation={[0, 0, 0.62]}>
            <boxGeometry args={[0.52, 0.02, 0.34]} />
            <meshStandardMaterial color="#f6f2e8" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0.16, 0.2, 0]} rotation={[0, 0, -0.62]}>
            <boxGeometry args={[0.52, 0.02, 0.34]} />
            <meshStandardMaterial color="#f6f2e8" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, 0.14, 0]}>
            <boxGeometry args={[0.68, 0.03, 0.05]} />
            <meshStandardMaterial color={accent} roughness={0.9} flatShading />
          </mesh>
          <mesh position={[-0.36, 0.34, 0]} rotation={[0, 0, 0.5]}>
            <boxGeometry args={[0.2, 0.02, 0.3]} />
            <meshStandardMaterial color="#efe9dc" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0.36, 0.34, 0]} rotation={[0, 0, -0.5]}>
            <boxGeometry args={[0.2, 0.02, 0.3]} />
            <meshStandardMaterial color="#efe9dc" roughness={0.9} flatShading />
          </mesh>
        </group>
      );
    case "paperlantern":
      // 纸地灯 — a paper ground lantern: a squat foot ring, the warm
      // glow body (paper, lit from within — a small authored emissive,
      // the room's real light still comes from its fixtures, B.13), a
      // dark cap with a short hanging loop.
      return (
        <group>
          <mesh position={[0, 0.05, 0]}>
            <cylinderGeometry args={[0.2, 0.24, 0.1, 10]} />
            <meshStandardMaterial color="#8a5a3a" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 0.4, 0]}>
            <sphereGeometry args={[0.26, 10, 8]} />
            <meshStandardMaterial
              color="#ffd9a0"
              emissive="#ffbe78"
              emissiveIntensity={0.85}
              roughness={0.9}
              flatShading
            />
          </mesh>
          <mesh position={[0, 0.66, 0]}>
            <cylinderGeometry args={[0.12, 0.16, 0.08, 8]} />
            <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "swingframe":
      // 秋千支架 — the self-supported frame: two A-ends (each two legs
      // splayed in z and braced), joined by the crossbar the seats hang
      // from. Nothing touches a ceiling (I2) — the frame IS the support.
      return (
        <group>
          {(
            [
              [-2.05, 1],
              [2.05, -1],
            ] as const
          ).map(([x, flip]) => (
            <group key={x}>
              <mesh
                position={[x, 1.32, 0.42]}
                rotation={[0.42 * flip, 0, 0]}
              >
                <cylinderGeometry args={[0.055, 0.07, 2.9, 6]} />
                <meshStandardMaterial color="#a98a68" roughness={1} flatShading />
              </mesh>
              <mesh
                position={[x, 1.32, -0.42]}
                rotation={[-0.42 * flip, 0, 0]}
              >
                <cylinderGeometry args={[0.055, 0.07, 2.9, 6]} />
                <meshStandardMaterial color="#a98a68" roughness={1} flatShading />
              </mesh>
              <mesh position={[x, 0.5, 0]}>
                <boxGeometry args={[0.08, 0.08, 0.9]} />
                <meshStandardMaterial color="#8a705c" roughness={1} flatShading />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 2.62, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.06, 0.06, 4.35, 8]} />
            <meshStandardMaterial color="#b08a5e" roughness={1} flatShading />
          </mesh>
        </group>
      );
    case "swingseat":
      // 秋千座 — the seat at rest: two ropes from the crossbar down to
      // a small plank seat. Hung from the frame's bar (y 2.62), static.
      return (
        <group>
          <mesh position={[-0.28, 1.85, 0]}>
            <cylinderGeometry args={[0.015, 0.015, 1.54, 5]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0.28, 1.85, 0]}>
            <cylinderGeometry args={[0.015, 0.015, 1.54, 5]} />
            <meshStandardMaterial color="#7a6a55" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, 1.06, 0]}>
            <boxGeometry args={[0.7, 0.05, 0.3]} />
            <meshStandardMaterial color={accent} roughness={0.9} flatShading />
          </mesh>
        </group>
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

/** Swim-ripple gating: metres of drift per duck between wave impulses —
 *  the wading loop's ~0.5 m step discipline, tightened for the ducks'
 *  gentler press. Displacement-gated, never per-frame. */
const SWIM_RIPPLE_EVERY = 0.35;

/** A pool full of rubber ducks: instanced body/head/beak, per-duck bob
 *  (phase-offset sine) and a very slow circular drift. Cute by decree:
 *  round body, big head, orange beak. The drift presses the surface: each
 *  duck's travel injects a small impulse into the pool's wave driver
 *  (§12.2 — the wading discipline, displacement-gated per duck), so the
 *  water carries a gentle ambient shimmer instead of sitting painted. */
function Ducks({
  ducks,
  driver,
  rect,
}: {
  ducks: DuckSeed[];
  /** The pool's wave driver (SpaceScene owns it) — swim ripples inject
   *  here. Null when the room grew no wave field. */
  driver: WaveDriver | null;
  /** The driver's water rectangle, room-local — drift positions inject
   *  directly in this frame. */
  rect: { cx: number; cz: number; halfX: number; halfZ: number } | null;
}) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const beakRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const count = ducks.length;
  // Per-duck displacement accumulators — one impulse per SWIM_RIPPLE_EVERY
  // metres of travel, never per frame (the wading loop's discipline). The
  // arrays resize with the flock; positions seed on first sight so the
  // initial splat doesn't fire.
  const swimRef = useRef({ init: false, px: [] as number[], pz: [] as number[], acc: [] as number[] });

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
    const swim = swimRef.current;
    if (swim.px.length !== count) {
      swim.init = false;
      swim.px = new Array(count).fill(0);
      swim.pz = new Array(count).fill(0);
      swim.acc = new Array(count).fill(0);
    }
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

      // Swim ripples: accumulate this duck's drift, press the surface every
      // ~0.35 m — small, low, and rect-guarded (a drifting duck never
      // splats outside the water it floats on).
      if (driver && rect) {
        if (swim.init) {
          swim.acc[i] += Math.hypot(x - swim.px[i], z - swim.pz[i]);
          if (swim.acc[i] >= SWIM_RIPPLE_EVERY) {
            if (waveRectContains(x, z, rect)) {
              driver.addImpulse(
                x,
                z,
                Math.max(-0.05, -0.028 * s),
                0.12,
              );
            }
            swim.acc[i] = 0;
          }
        }
        swim.px[i] = x;
        swim.pz[i] = z;
      }
    });
    swim.init = true;
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
  const dir = roomOrientationFor(door).dir;
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
  const dir = roomOrientationFor(door).dir;
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
/* with a real point light and a floor pool) and a WINDOW (frame, a    */
/* layered view of the outside, spill on the floor; in interior rooms  */
/* its spot is the room's KEY light and casts the strong shadows), and */
/* outdoor-class sets add a CLERESTORY — a high window band on a       */
/* full-height wall — that justifies their overall key.                */
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

/** The clerestory is the same wall anchoring plus the host wall's run
 *  length — the band spans most of it. */
interface ClerestoryFixture extends WindowFixture {
  len: number;
}

interface RoomFixtures {
  lamp: { x: number; z: number };
  window: WindowFixture;
  clerestory: ClerestoryFixture | null;
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
 * and keeps clear of every door sharing the host wall. CLERESTORY: the
 * same anchoring rules, preferring a DIFFERENT full-height wall than the
 * window's so the room's two sources read from two directions.
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
  hasClerestory: boolean,
  /** Source wall indices whose run hosts a WALL FEATURE (niche, pilaster
   *  rhythm, arch, column order, platform, mezzanine) — the window never
   *  hangs there. The niche rebuilds its run into a recessed alcove (a
   *  view plane on the same run would z-fight the alcove back), and the
   *  pilaster strips project past the wall face (a pane behind a strip
   *  would clip through it); §7.2 moved the reading hall's niche onto a
   *  flank wall, exactly where the window prefers to hang, so the pool
   *  filter is what keeps the two apart. */
  featureSources: ReadonlySet<number>,
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
  const fullHeight = walls.filter(
    (w) =>
      !w.entrance &&
      !wallFacesCamera(plan, w, dir) &&
      !featureSources.has(walls.indexOf(w)),
  );
  const fitsFull = fullHeight.filter(fits);
  // AXIAL SEMANTICS (§10.5): the east/west (vertical) walls belong to
  // windows and light — the strand doors took the north/south
  // (horizontal) ones. Try vertical hosts first, then degrade through
  // the same ladder as before (any full-height fit, then the entrance
  // pair, then the longest wall).
  const verticalHosts = fitsFull.filter((w) => w.sizeZ > w.sizeX);
  let hostPool = verticalHosts.length > 0 ? verticalHosts : fitsFull;
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

  // --- Clerestory -------------------------------------------------------
  // A high window BAND, not an overhead opening: it hangs just under the
  // top of a full-height wall, so the set's overall key arrives from one
  // side and above — a source you can walk up to and point at.
  let clerestory: RoomFixtures["clerestory"] = null;
  if (hasClerestory) {
    const minRun = (CLERESTORY_END_PAD * 2 + CLERESTORY_UNIT) * wallScale;
    const runFits = (w: WallSegment) =>
      Math.max(w.sizeX, w.sizeZ) >= minRun;
    // Prefer a full-height wall that is NOT the window's host (two
    // sources, two directions); degrade gracefully to any run that fits.
    let bandPool = fullHeight.filter((w) => w !== host && runFits(w));
    if (bandPool.length === 0) bandPool = fullHeight.filter(runFits);
    if (bandPool.length === 0) {
      bandPool = walls.filter((w) => w.entrance && runFits(w));
    }
    if (bandPool.length > 0) {
      const bandHost = bandPool[Math.floor(rng() * bandPool.length)];
      const bandHorizontal = bandHost.sizeZ <= bandHost.sizeX;
      const bandLen = bandHorizontal ? bandHost.sizeX : bandHost.sizeZ;
      let bnx = 0;
      let bnz = 0;
      if (bandHorizontal) {
        bnz = planContains(plan, bandHost.x, bandHost.z + 0.5, 0) ? 1 : -1;
      } else {
        bnx = planContains(plan, bandHost.x + 0.5, bandHost.z, 0) ? 1 : -1;
      }
      // The band spans the host's run minus the end pads, centered — a
      // transom over the doorway reads naturally when the entrance wall
      // is the only host, and centering keeps the span inside the run
      // by construction.
      clerestory = {
        x: bandHost.x,
        z: bandHost.z,
        nx: bnx,
        nz: bnz,
        thick: bandHorizontal ? bandHost.sizeZ : bandHost.sizeX,
        drawnHeight:
          bandHost.entrance || !wallFacesCamera(plan, bandHost, dir)
            ? wallHeight
            : Math.min(wallHeight, WALL_SILL_HEIGHT),
        len: bandLen,
      };
    }
  }

  return { lamp, window, clerestory };
}

/**
 * The room's lamp: base, pole, an emissive shade over a hot bulb, the ONE
 * real point light, and an additive floor pool (the corridor sconce idiom —
 * the painted gradient does the falloff). Everything scales with the room's
 * prop scale, light included: with decay 2, a pool radius grown by k needs
 * intensity ×k² to land the same brightness, so a colossal room's giant
 * lamp actually reaches its giant floor. Calm incandescent — never
 * flickering (the anti-pattern list). After dark it burns a little
 * brighter (`boost`): the window cools and dims, and the lamp becomes the
 * room's primary so no corner ever goes unreadable.
 */
function RoomLamp({
  x,
  z,
  y,
  scale,
  boost = 1,
}: {
  x: number;
  z: number;
  y: number;
  scale: number;
  /** Night multiplier on the light and pool (geometry never changes). */
  boost?: number;
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
        intensity={LAMP_LIGHT_INTENSITY * scale * scale * boost}
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
          opacity={LAMP_POOL_OPACITY * boost}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * One module's light-register sconce (§8.2): a small backplate and an
 * emissive dome on the module's own wall, the register's real point
 * light, and an additive floor pool beneath — the corridor sconce idiom
 * scaled to a module, the findable source for that module's light mood
 * (warm task pool, cool shelf wash, pale daylight, the pool deck's aqua
 * bounce, a dim quiet corner). The register owns HOW the module is lit;
 * the palette never enters here. When every candidate wall is a cutaway
 * sill or door-bound the module grows no sconce (see moduleSconceFor) —
 * light never floats without a source (B.13).
 */
function ModuleSconce({
  anchor,
  wallScale,
}: {
  anchor: ModuleSconceAnchor;
  wallScale: number;
}) {
  const fixture = MODULE_LIGHT_FIXTURES[anchor.register] ?? MODULE_LIGHT_FIXTURES.quiet;
  const y = 2.05 * wallScale;
  // The group turns local +z onto the wall's inward normal: the plate sits
  // on the face, the dome proud of it, the light and pool inside the room.
  const rotY = Math.atan2(anchor.nx, anchor.nz);
  return (
    <group position={[anchor.x, 0, anchor.z]} rotation={[0, rotY, 0]}>
      <mesh position={[0, y, 0.02]} castShadow>
        <boxGeometry args={[0.22 * wallScale, 0.34 * wallScale, 0.06]} />
        <meshStandardMaterial color="#3a3a3e" roughness={0.6} metalness={0.3} flatShading />
      </mesh>
      <mesh position={[0, y + 0.06 * wallScale, 0.09]}>
        <sphereGeometry args={[0.085 * wallScale, 8, 6]} />
        <meshStandardMaterial
          color="#000000"
          emissive={fixture.color}
          emissiveIntensity={2.0}
          roughness={1}
        />
      </mesh>
      <pointLight
        position={[0, y, 0.4 * wallScale]}
        color={fixture.color}
        intensity={fixture.intensity * wallScale * wallScale}
        distance={8 * wallScale}
        decay={2}
      />
      {/* The register's pool on the module's floor. */}
      <mesh
        position={[0, 0.036, 0.95 * wallScale]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[2.4 * wallScale, 2.4 * wallScale]} />
        <meshBasicMaterial
          map={sharedRadialGlowTexture()}
          color={fixture.color}
          transparent
          opacity={fixture.pool}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * The room's window: a dark reveal sunk into the wall face, then a VIEW —
 * the layered outside baked by materials/window-view.ts (sky gradient +
 * sun halo + far/near silhouettes, all palette-driven) on an unlit plane,
 * crossed by mullions under a faint glass sheen — an architrave frame and
 * sill in the door-trim material, and an additive spill quad on the floor
 * in front — brightest at the wall, dissolving into the room (the wall-
 * wash gradient, laid flat). In INTERIOR rooms the window is also the
 * key light: a real spot just inside the pane, aimed down into the room,
 * carrying the room's strong motivated shadows (the sun has dropped to a
 * fill — B.13 rule 2). Outdoor-class sets keep the window view-only:
 * their real light comes from the clerestory band and the overall key.
 * `paneColor` is the light color (register- and theme-modulated, computed
 * by the scene); `viewColor` is the view plane's day/night multiplier.
 */
function RoomWindow({
  fixture,
  wallScale,
  paneColor,
  view,
  viewColor,
  isKey,
  night,
}: {
  fixture: WindowFixture;
  wallScale: number;
  paneColor: THREE.Color;
  view: THREE.Texture;
  viewColor: THREE.Color;
  isKey: boolean;
  night: boolean;
}): JSX.Element {
  const ws = wallScale;
  const w = WINDOW_WIDTH * ws;
  // Clamp the pane into the host wall's DRAWN height (a relaxed fallback
  // host may be a cutaway sill wall — the window then sits low and short).
  const h = Math.min(WINDOW_HEIGHT * ws, Math.max(0.6, fixture.drawnHeight - 0.4));
  const sill = Math.min(WINDOW_SILL_Y * ws, Math.max(0.15, fixture.drawnHeight - h - 0.15));
  const spillL = WINDOW_SPILL_LENGTH * ws;
  const mullion = WINDOW_MULLION * ws;
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
      {/* The outside: sky, sun halo, and two silhouette strata — unlit,
          so it never goes black in a shadowed corner; the scene's
          viewColor carries the day/night state. */}
      <mesh position={[0, sill + h / 2, fixture.thick / 2 + 0.011]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={view} color={viewColor} toneMapped />
      </mesh>
      {/* Glass sheen — one of the two sanctioned alpha materials. */}
      <mesh position={[0, sill + h / 2, fixture.thick / 2 + 0.018]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial
          map={sharedWallWashTexture()}
          color="#ffffff"
          transparent
          opacity={WINDOW_SHEEN_OPACITY}
          depthWrite={false}
        />
      </mesh>
      {/* Mullions: the cross that makes it a window, not a screen. They
          sit inside the spot's cone, so the key prints the cross on the
          floor — the cheapest motivated detail in the room. */}
      <mesh position={[0, sill + h / 2, fixture.thick / 2 + 0.03]} castShadow>
        <boxGeometry args={[mullion, h, mullion]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, sill + h / 2, fixture.thick / 2 + 0.03]} castShadow>
        <boxGeometry args={[w, mullion, mullion]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
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
          room's strong shadows. At night it cools and dims — the lamp
          takes over as the primary. */}
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
            intensity={
              WINDOW_SPOT_INTENSITY * ws * ws * (night ? WINDOW_NIGHT_SPOT_SCALE : 1)
            }
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
 * The outdoor set's clerestory: a window BAND hung just under the top of
 * a full-height wall — a dark reveal, the same layered outside view as
 * the window (tiled one bay per mullion), mullions and rails, an additive
 * floor wash along the wall, and a real spot aimed from the band down
 * into the room. This is what justifies the set's overall key (B.13
 * rule 3): light arrives from one side and above, and walking to the wall
 * reveals the "sun" was a row of high windows all along — a soundstage,
 * not a floating panel (the transparent ceiling made the old skylight
 * read as a levitating plate). The spot never casts — the sun owns the
 * outdoor shadows, and two near-coincident casters would double-print.
 */
function RoomClerestory({
  fixture,
  wallScale,
  paneColor,
  view,
  viewColor,
  night,
}: {
  fixture: ClerestoryFixture;
  wallScale: number;
  paneColor: THREE.Color;
  view: THREE.Texture;
  viewColor: THREE.Color;
  night: boolean;
}): JSX.Element {
  const ws = wallScale;
  // Clamp the band into the host wall's DRAWN height (a relaxed fallback
  // host may be a cutaway sill — the band then shrinks to what fits).
  const bandH = Math.min(CLERESTORY_HEIGHT * ws, Math.max(0.4, fixture.drawnHeight * 0.5));
  const bandY = Math.max(
    bandH / 2 + 0.1,
    fixture.drawnHeight - CLERESTORY_DROP * ws - bandH / 2,
  );
  const span = Math.max(CLERESTORY_UNIT * ws, fixture.len - 2 * CLERESTORY_END_PAD * ws);
  const bays = Math.max(1, Math.round(span / (CLERESTORY_UNIT * ws)));
  const spillL = CLERESTORY_SPILL_LENGTH * ws;
  const mullion = WINDOW_MULLION * 1.4 * ws;
  const [spotTarget] = useState(() => new THREE.Object3D());
  return (
    <group
      position={[fixture.x, 0, fixture.z]}
      rotation={[0, Math.atan2(fixture.nx, fixture.nz), 0]}
    >
      {/* Dark reveal behind the band. */}
      <mesh position={[0, bandY, fixture.thick / 2 - 0.02]}>
        <boxGeometry args={[span + 0.24, bandH + 0.24, 0.05]} />
        <meshStandardMaterial color="#101014" roughness={1} flatShading />
      </mesh>
      {/* The outside, tiled one view per bay (the texture's repeat was
          set by the scene to match the bay count). */}
      <mesh position={[0, bandY, fixture.thick / 2 + 0.011]}>
        <planeGeometry args={[span, bandH]} />
        <meshBasicMaterial map={view} color={viewColor} toneMapped />
      </mesh>
      {/* Top and bottom rails. */}
      <mesh position={[0, bandY + bandH / 2 + 0.05, fixture.thick / 2 + 0.05]} castShadow>
        <boxGeometry args={[span + 0.24, 0.1, 0.12]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, bandY - bandH / 2 - 0.05, fixture.thick / 2 + 0.05]} castShadow>
        <boxGeometry args={[span + 0.24, 0.1, 0.12]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      {/* Mullions, one per bay boundary. */}
      {Array.from({ length: bays + 1 }, (_, i) => (
        <mesh
          key={i}
          position={[-span / 2 + (span / bays) * i, bandY, fixture.thick / 2 + 0.03]}
          castShadow
        >
          <boxGeometry args={[mullion, bandH, mullion]} />
          <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
        </mesh>
      ))}
      {/* The floor wash below the band: the wall-wash gradient laid flat,
          bright edge at the wall. */}
      <mesh
        position={[0, 0.05, fixture.thick / 2 + spillL / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[span, spillL]} />
        <meshBasicMaterial
          map={sharedWallWashTexture()}
          color={paneColor}
          transparent
          opacity={CLERESTORY_SPILL_OPACITY}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* The real light through the band, aimed down and into the room. */}
      <primitive
        object={spotTarget}
        position={[0, 0, fixture.thick / 2 + CLERESTORY_SPOT_THROW * ws]}
      />
      <spotLight
        position={[0, bandY, fixture.thick / 2 + 0.4]}
        target={spotTarget}
        color={paneColor}
        intensity={
          CLERESTORY_SPOT_INTENSITY * ws * ws * (night ? WINDOW_NIGHT_SPOT_SCALE : 1)
        }
        angle={CLERESTORY_SPOT_ANGLE}
        penumbra={CLERESTORY_SPOT_PENUMBRA}
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

/**
 * Mount-cost trace (responsiveness probe): one record per room mount.
 * SpaceScene writes its own spans (render body = plan/scatter/material
 * creation, fade capture = the mount layout effect's full-tree traverse,
 * commit = door-manager request → first frame tick); the integrator
 * (game-canvas.tsx) writes tRequest and the per-frame gl.render times, and
 * mirrors the whole record onto window.__gameMountTrace so the teleport
 * probes can read where a room mount's milliseconds go. Numbers only — a
 * few performance.now() calls per mount, no per-frame cost here.
 */
export const MOUNT_TRACE = {
  seq: 0,
  sliceId: null as string | null,
  /** Door-manager mark: the wall plane was crossed (performance.now). */
  tRequest: -1,
  /** SpaceScene first render body: plan, scatter, materials (all useMemo). */
  bodyMs: -1,
  /** Fade material capture (the mount layout effect's full-tree traverse). */
  captureMs: -1,
  /** tRequest → first frame tick after mount (React commit + scheduling). */
  commitMs: -1,
  /** Door-manager mark: the prewarm (hidden) mount committed. */
  prewarmAt: -1,
  /** Main-thread block of the last LightConfigCompiler gl.compile run. */
  compileSyncMs: -1,
  /** Unused since the sync-compile redesign (field kept for probe compat). */
  compileMs: -1,
  /** gl.render wall time per frame: [t, ms, programCount], ring-buffered. */
  frames: [] as [number, number, number][],
};

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
 * The mounted room's root group (at most one SpaceScene exists — the
 * integrator's single room slot), exported so the integrator's
 * LightConfigCompiler can stage light configurations around it: flipped
 * visible for the span of a synchronous gl.compile it JOINS the light
 * gather (compile collects lights via traverseVisible), while every actual
 * RENDER keeps it hidden — the prewarmed room's programs get compiled
 * without the room ever drawing a pixel.
 */
export const ROOM_ROOT: { current: THREE.Group | null } = { current: null };

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
  // MODULAR COMPOSITION (§8): an interior room's template IS its module
  // composition folded into the renderer's existing input — the same
  // resolution scaledRecipeFor already sized the plan from, so the template
  // can never disagree with the floor it zones. The strand-door count the
  // caller hands in steers that resolution directly (§8.4 — a busy day
  // grows modules, and more modules ⇒ a longer north door wall); the
  // measured-capacity machinery below is the legacy catalogue's; the
  // composition's declared ceiling rides placeRoomDoors' ladder on
  // overflow, unchanged.
  const composition = compositionForRecipe(recipe, WORLD_SEED, roomDoorCount);
  if (composition) return compositionTemplateFor(composition);
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
  prewarm = false,
  onFadedOut,
  roomDoors,
  roomDoorCount: roomDoorCountProp,
  onRoomDoor,
}: {
  recipe: SpaceRecipe;
  door: DoorRef;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  corridorGone: boolean;
  fade: "in" | "out";
  /** Prewarm (responsiveness): the room is mounted while the player walks
   *  toward the door — fully built but with its root group visible=false,
   *  so it draws nothing, contributes no lights, and casts no shadows —
   *  letting the integrator precompile the scene's shader programs
   *  (LightConfigCompiler) before the threshold is crossed. The crossfade
   *  stays parked at 0 and onFadedOut never fires in this state; flipping
   *  prewarm off (the same mounted instance) shows the root and starts
   *  the ordinary fade-in from 0. */
  prewarm?: boolean;
  onFadedOut: () => void;
  /** Strand doors for this slice — absent/empty = today's single-entrance
   *  room. */
  roomDoors?: readonly SpaceRoomDoor[];
  /** The strand-door count the room was RESOLVED with — the integrator
   *  freezes it into the ActiveSpace at the wall crossing so the room
   *  cannot morph mid-stay when the strand lane resolves after the mount
   *  (§8.4: the composition grows by this count). Absent = the live list's
   *  length (standalone renders; the door list and the count cannot drift
   *  there). */
  roomDoorCount?: number;
  /** Fires once per strand door when the player walks through it (latched
   *  per door per mount; never fires for the entrance). */
  onRoomDoor?: (key: string) => void;
}): JSX.Element {
  const spec = ARCHETYPES[recipe.archetype];
  const { dir, rotationY } = roomOrientationFor(door);

  // Mount-cost trace (see MOUNT_TRACE): first render only.
  const traceT0Ref = useRef(-1);
  if (traceT0Ref.current < 0) {
    traceT0Ref.current = performance.now();
    MOUNT_TRACE.seq += 1;
    MOUNT_TRACE.sliceId = recipe.sliceId;
    MOUNT_TRACE.bodyMs = -1;
    MOUNT_TRACE.captureMs = -1;
    MOUNT_TRACE.commitMs = -1;
    MOUNT_TRACE.prewarmAt = prewarm ? traceT0Ref.current : -1;
    MOUNT_TRACE.frames.length = 0;
  }

  // ROOM LANGUAGE (v0.11 §3): scale notation, plan silhouette, and staging
  // are pure functions of the slice id (lib/game/room-plan.ts). Scaling is
  // applied at CONSTRUCTION time: `scaledRecipe` carries the factor in its
  // plan dims, so terrain, water, and the movement clamps all live in one
  // (scaled) coordinate system. The doorway is never scaled (axiom A4).
  //
  // The strand-door count (§8.4) steers BOTH the composition that sizes
  // these dims and the template/door placement below — ONE value for the
  // whole visit (the integrator freezes it into the ActiveSpace at the
  // crossing; see the prop docs), so the room the player walks is the room
  // the clamp contains, whatever the strand lane does later.
  const roomDoorCount = roomDoorCountProp ?? roomDoors?.length ?? 0;
  const { recipe: scaledRecipe, scale } = useMemo(
    () => scaledRecipeFor(recipe, roomDoorCount),
    [recipe, roomDoorCount],
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
  // length). null = no template fits (every non-interior class) and every
  // downstream call then gets `undefined`, reproducing today's behaviour
  // byte-for-byte. Consumption follows the room-templates.test.ts chain:
  // measured selection → declared plan → walls → affordance doors → zone
  // staging. Selection goes through the exported roomTemplateForDoorCount
  // so the movement clamp's door derivation (game-canvas.tsx) selects the
  // SAME template — two copies of the capacity measure once placed two
  // different door sets.
  //
  // MODULAR COMPOSITION (§8): an interior room no longer draws from the §7
  // catalogue — its template is the slice's MODULE COMPOSITION folded into
  // the same RoomTemplate shape (room-modules.ts compositionTemplateFor),
  // so the plan/walls/doors/zones chain below runs unchanged. The plan's
  // dims already ARE the composition's (scaledRecipeFor swapped them), and
  // the composition's own detail — the interior seams, the per-module kit
  // whitelist, the floor roles — rides `roomComposition` below. Same frozen
  // door count as the dims above: the template can never disagree with the
  // floor it zones.
  const roomComposition = useMemo(
    () => compositionForRecipe(recipe, WORLD_SEED, roomDoorCount),
    [recipe, roomDoorCount],
  );
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
    ROOM_ROOT.current = root;
    const captureT0 = performance.now();
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
    MOUNT_TRACE.captureMs = performance.now() - captureT0;
    return () => {
      if (ROOM_ROOT.current === root) ROOM_ROOT.current = null;
    };
  }, []);
  // Mount-cost trace: the first frame tick after mount closes the commit
  // span (door-manager request → React commit → rAF tick).
  const firstFrameRef = useRef(true);
  useFrame(() => {
    if (!firstFrameRef.current) return;
    firstFrameRef.current = false;
    MOUNT_TRACE.commitMs =
      MOUNT_TRACE.tRequest >= 0 ? performance.now() - MOUNT_TRACE.tRequest : -1;
  });
  useFrame((_, delta) => {
    const mats = fadeMatsRef.current;
    if (mats.length === 0) return;
    // Probe mirror — the console reads live crossfade progress (and the
    // captured material count) to tell a stuck fade from fog.
    GAME_DEBUG.fadeMats = mats.length;
    const dirSign = fade === "in" ? 1 : -1;
    const t = fadeTRef.current;
    GAME_DEBUG.fadeT = t;
    // Prewarm: parked invisible (root visible=false; opacity 0 from the
    // capture pass) while the player approaches — no fade runs and no
    // handshake can fire.
    if (prewarm) return;
    // A fade-in re-arms the exit handshake: a prewarmed instance may reuse
    // a fiber whose previous life already completed a fade-out (exit →
    // immediate re-approach), and its next fade-out must handshake again.
    if (dirSign > 0) fadeDoneRef.current = false;
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
  // THE ANCHOR TERMINAL (§13.1): every room grows the one machine beside
  // the doorway on the entrance wall — lib/game/anchor.ts resolves the
  // spot (seeded side, feasibility-clamped clear of the strip, the walk
  // path, the hero clearing, and the water); the integrator resolves the
  // SAME anchor through the same pure call for the proximity prompt and
  // the interaction (A6 — two call sites, one answer). Mounted inside the
  // room root, so the fade capture carries it through the crossfade; its
  // glow is emissive-only (no light), so the light configuration — and
  // the compile storm budget — is untouched.
  const terminalAnchor = useMemo(
    () =>
      roomTerminalFor({
        sliceId: recipe.sliceId,
        plan,
        comp,
        width,
        wallThick,
        propScale,
        water: waterRect,
      }),
    [recipe, plan, comp, width, wallThick, propScale, waterRect],
  );
  // The pool's wave-equation driver (materials/wave-driver.ts): created
  // HERE, not in the WaterSurface component, because the pool-floor
  // caustics patch below also samples the driver's height texture (the
  // floor refracts by the same field the surface floats on). The rect is
  // the same {cx: 0, cz, halfX, halfZ} the surface plane maps 1:1.
  const waveDriver = useMemo(
    () => (waterRect ? createWaveDriver(waterRect) : null),
    [waterRect],
  );
  useEffect(() => () => waveDriver?.dispose(), [waveDriver]);

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
    if (roomDoorCount === 0)
      return { doors: [], relaxed: false, doubleRow: false, axialOverflow: false };
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

  // Clearance consumers (scatter, kits, fixtures, structures, features)
  // test approaches against the clearance SET: the doors themselves plus a
  // mirrored copy of every second-row (screen) door, so the shallow
  // vestibule band between a screen and its host wall also stays
  // furniture-free (§10.5, room-doors.ts doorClearanceSet). Rendering, the
  // perimeter split, and the strand-crossing test keep the raw placements.
  const clearanceDoors = useMemo(
    () => doorClearanceSet(doorLayout.doors),
    [doorLayout],
  );

  // The perimeter cut around every doorway: each host wall becomes the
  // runs between its door gaps (the entrance-pair split generalized),
  // every run inheriting its source segment's drawn height and material.
  const wallRuns = useMemo(
    () => splitWallsForDoors(walls, doorLayout.doors),
    [walls, doorLayout],
  );

  // SECOND-ROW SCREENS (§10.5 fallback ② 门厅式): every host wall's row-1
  // doors hang on a freestanding screen ROOM_DOOR_ROW_DEPTH inward of the
  // wall — a shallow opaque slab in the perimeter's own material language,
  // split around its door gaps by the same splitter. The doors' `along`
  // offsets are measured from the host segment's center and the screen's
  // center differs only along the inward normal, so the run coordinates
  // transfer unchanged; only the wall index is re-origined for the split.
  const doorScreens = useMemo(() => {
    const byWall = new Map<number, RoomDoorPlacement[]>();
    for (const d of doorLayout.doors) {
      if (d.row !== 1) continue;
      const list = byWall.get(d.wall) ?? [];
      list.push(d);
      byWall.set(d.wall, list);
    }
    const out: {
      screen: WallSegment;
      source: number;
      doors: RoomDoorPlacement[];
    }[] = [];
    for (const [source, doors] of byWall) {
      const wall = walls[source];
      const horizontal = wall.sizeZ <= wall.sizeX;
      const len = Math.max(wall.sizeX, wall.sizeZ);
      const { nx, nz } = doors[0]; // probed inward normal, shared per wall
      const cx = wall.x + nx * ROOM_DOOR_ROW_DEPTH;
      const cz = wall.z + nz * ROOM_DOOR_ROW_DEPTH;
      let lo = Infinity;
      let hi = -Infinity;
      for (const d of doors) {
        lo = Math.min(lo, d.along);
        hi = Math.max(hi, d.along);
      }
      const pad = DOOR_GAP_HALF + 0.6;
      lo = Math.max(-len / 2, lo - pad);
      hi = Math.min(len / 2, hi + pad);
      const span = Math.max(ROOM_DOOR_SCREEN_THICK, hi - lo);
      const mid = (lo + hi) / 2;
      const screen: WallSegment = horizontal
        ? {
            x: cx + mid,
            z: cz,
            sizeX: span,
            sizeZ: ROOM_DOOR_SCREEN_THICK,
            entrance: false,
          }
        : {
            x: cx,
            z: cz + mid,
            sizeX: ROOM_DOOR_SCREEN_THICK,
            sizeZ: span,
            entrance: false,
          };
      out.push({
        screen,
        source,
        doors: doors.map((d) => ({ ...d, wall: 0, along: d.along - mid })),
      });
    }
    return out;
  }, [doorLayout, walls]);
  const screenRuns = useMemo(
    () =>
      doorScreens.map(({ screen, source, doors }) => ({
        runs: splitWallsForDoors([screen], doors),
        source,
      })),
    [doorScreens],
  );

  // INTERIOR SEAMS (§8): the partition walls between a composition's
  // joined modules — the visible evidence the room is a composition, not
  // one floor. Built by the ONE shared derivation clamps.ts also consumes
  // (room-modules.ts seamPartitionsFor): each consented seam draws a
  // real-thickness wall broken around its walkable opening — two jambs at
  // full height plus a header above (openings stay human-height, A4 — the
  // doorway never scales). Flank ends run wallThick PAST the seam line's
  // ends so the T-junctions with perimeter walls and crossing seams never
  // show a gap; the entrance doorway strip is carved at the same
  // derivation (门廊净空 — a seam on the door axis opens into a shared
  // vestibule instead of planting a post in the doorway). A seam too short
  // to hold a walkable opening at this room's scale (miniature dollhouse
  // rooms) is left open instead of growing an unenterable doorway.
  const seamPartitions = useMemo(
    () =>
      roomComposition
        ? seamPartitionsFor(roomComposition, scaleFactor, wallThick)
        : [],
    [roomComposition, scaleFactor, wallThick],
  );

  // Kit clearance (§8): the seam partitions are real walls — furniture
  // must not phase through them. Obstacle discs along the jamb runs (the
  // opening stays clear) feed stageInteriorKits' existing obstacle
  // channel, the same one the pool hall's water fixtures use.
  const seamObstacles = useMemo(() => {
    const discs: { x: number; z: number; r: number }[] = [];
    for (const sp of seamPartitions) {
      for (const seg of sp.flanks) {
        const len = Math.max(seg.sizeX, seg.sizeZ);
        const alongX = seg.sizeX >= seg.sizeZ;
        const n = Math.max(1, Math.ceil(len));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n - 0.5;
          discs.push({
            x: seg.x + (alongX ? t * len : 0),
            z: seg.z + (alongX ? 0 : t * len),
            r: Math.min(seg.sizeX, seg.sizeZ) / 2 + 0.3,
          });
        }
      }
    }
    return discs;
  }, [seamPartitions]);

  // MODULE LIGHT REGISTERS (§8.2): one sconce per module in the module's
  // own register (task/wash/daylight/pool-bounce/quiet), each a findable
  // source on the module's wall (B.13 — the register owns HOW the module
  // is lit, and the light is never sourceless). Cutaway sills (camera-
  // facing walls, no face at fixture height) and door-bound candidate
  // edges disqualify a wall; a module whose every candidate is
  // disqualified grows no sconce — its register still shows in the floor
  // tint, and no floating light appears.
  const moduleSconces = useMemo(() => {
    if (!roomComposition) return [];
    const blocked = new Set<ModuleEdge>();
    for (const w of walls) {
      if (w.entrance || !wallFacesCamera(plan, w, dir)) continue;
      const horizontal = w.sizeZ <= w.sizeX;
      if (horizontal) {
        if (Math.abs(w.z + w.sizeZ / 2 - extent) < 1e-6) blocked.add("n");
      } else if (Math.abs(w.x - w.sizeX / 2 + width / 2) < 1e-6) {
        blocked.add("w");
      } else if (Math.abs(w.x + w.sizeX / 2 - width / 2) < 1e-6) {
        blocked.add("e");
      }
    }
    const anchors: ModuleSconceAnchor[] = [];
    for (const placed of roomComposition.modules) {
      const anchor = moduleSconceFor(
        placed,
        roomComposition,
        scaleFactor,
        wallThick,
        doorLayout.doors,
        blocked,
      );
      if (anchor) anchors.push(anchor);
    }
    return anchors;
  }, [roomComposition, walls, plan, dir, extent, width, scaleFactor, wallThick, doorLayout]);

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
        clearanceDoors,
      ),
    [recipe, scaledRecipe, spec, waterRect, plan, comp, scatterEdge, propScale, clearanceDoors],
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
        clearanceDoors,
      ),
    [recipe, scaledRecipe, spec, waterRect, plan, comp, scatterEdge, propScale, clearanceDoors],
  );

  // v0.11 §3.1 N4: nature rooms draw from the nature kit deck — the same
  // staging machine as the interiors, worldClass "nature". The pool biome
  // is the one exception: its content IS the water, and it keeps its
  // rim-anchored fixture scatter on the motif layer below. Computed once
  // so the motif and furniture memos agree on which nature rooms kit.
  const natureKitDeck = useMemo(
    () =>
      recipe.worldClass === "nature"
        ? kitsFor("nature", recipe.archetype, recipe.size.extent)
        : [],
    [recipe],
  );

  // Motif layer: one dedicated "props" seed stream. The hero and motif
  // props draw in a fixed order, so the whole layer is deterministic per
  // recipe. Hybrids mix their biome's props with hotel furniture.
  const motif = useMemo(() => {
    // Nature rooms furnished by kits grow NO scattered motifs — the kit
    // hero is the focal set piece (I5), and doubling it with a scattered
    // hero would split the room's one focus. The pool biome (nature with
    // an empty kit deck) keeps its rim fixtures here.
    if (natureKitDeck.length > 0) return { props: [] as PropPlacement[] };
    const rng = createRng(deriveSubSeed(WORLD_SEED, recipe.sliceId, "props"));
    const base = MOTIF_KINDS[recipe.archetype];
    const kinds =
      recipe.worldClass === "hybrid"
        ? [...base, ...HYBRID_FURNITURE]
        : base;
    return {
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
        clearanceDoors,
      ),
    };
  }, [recipe, scaledRecipe, natureKitDeck, waterRect, plan, comp, scatterEdge, propScale, clearanceDoors]);

  // Interiors are furnished by KITS (v0.11-room-interiors §3.1): composed,
  // wall-anchored groupings that face the path/door/hero, staged by
  // lib/game/kits.ts (the "furniture" stream). NATURE rooms run the same
  // machine with the nature deck (§3.1 N4) — see the nature branch below —
  // and WONDER rooms with the wonder deck (§3.1 N4): the dioramas' authored
  // playthings keep the oversized accent rugs the legacy path seeded.
  // The pool hall draws its deck from the module layer (§8): a COMPOSED
  // pool room's modules furnish the deck with their own kits and the basin
  // stays water-only — the old rim scatter now survives only on the legacy
  // template path. The outdoor pool biome (a nature room with an empty
  // nature deck) keeps its rim fixtures on the motif layer.
  const furniture = useMemo(() => {
    if (
      recipe.worldClass !== "interior" &&
      recipe.worldClass !== "wonder" &&
      !(recipe.worldClass === "nature" && natureKitDeck.length > 0)
    ) {
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
      trace: p.trace,
    });
    if (recipe.worldClass === "nature") {
      // §3.1 N4: the outdoor biomes are furnished by the NATURE kits —
      // the same staging machine (hero far-third, side kits, clearances,
      // the 35% 留白, the §4.4 trace), only the deck and the world class
      // differ. Water biomes subtract their basin from the density area
      // (the pool hall's discipline); the shore kits (jetty, reeds) draw
      // their positions from the water rectangle inside staging.
      const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
      const waterArea = waterRect
        ? (waterRect.halfX * 2 * waterRect.halfZ * 2) /
          (scaleFactor * scaleFactor)
        : 0;
      return stageInteriorKits({
        rng,
        worldClass: "nature",
        archetype: recipe.archetype,
        plan,
        comp,
        baseExtent: recipe.size.extent,
        baseArea: Math.max(0, baseArea - waterArea),
        propScale,
        wallThick,
        water: waterRect,
        doors: clearanceDoors,
        heightAt: (x: number, z: number) => terrainHeight(scaledRecipe, x, z),
      }).map(toPlacement);
    }
    if (recipe.worldClass === "interior") {
      const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
      // §8: a composed room furnishes from its modules' OWN whitelists
      // (the union of the placed modules' kits — each module's character
      // is that short list, 少而准) and keeps its kit pieces off the seam
      // partitions (the opening stays walkable).
      const kitIds = roomComposition
        ? [...new Set(roomComposition.modules.flatMap((p) => p.module.kits))]
        : undefined;
      // v0.12 §2 (the structure layer): modules carrying a hand-authored
      // RoomSchematic furnish by SLOT PLACEMENT — staging's second input
      // (room-schematic.ts). Modules without one are untouched.
      const schematicPlacements = roomComposition
        ? schematicPlacementsFor(roomComposition.modules, scaleFactor)
        : [];
      // §8.2 随机区域: the composition's open fields dress sparsely (0–3
      // seeded pieces per field from this same deck) — scaled into the
      // plan's coordinates like the seams. The fields are deliberately NOT
      // keep-empty zones: the staging channel owns their dressing.
      const openFields = roomComposition?.openFields.map((f) => ({
        x0: f.x0 * scaleFactor,
        z0: f.z0 * scaleFactor,
        x1: f.x1 * scaleFactor,
        z1: f.z1 * scaleFactor,
      }));
      const staging = {
        rng,
        archetype: recipe.archetype,
        plan,
        comp,
        baseExtent: recipe.size.extent,
        propScale,
        wallThick,
        water: waterRect,
        doors: clearanceDoors,
        kitIds,
        schematics: schematicPlacements,
        openFields,
        // The composition's content zones (§7/§8), resolved to absolute plan
        // coordinates: the hero's pin, the kit-cluster rects, the
        // keep-empty apron. A COMPOSED room takes the module-attributed
        // fold (compositionKitZonesFor) — each cluster rect carries its
        // module's kit whitelist, which is what makes the side-kit draw
        // deal each module its OWN set (§8.1.4) instead of one union pool.
        // Legacy templates keep the plain fold, byte-for-byte.
        zones: roomComposition
          ? compositionKitZonesFor(roomComposition, plan)
          : template
            ? templateZonesFor(template, plan)
            : undefined,
        heightAt: (x: number, z: number) => terrainHeight(scaledRecipe, x, z),
      };
      if (recipe.archetype === "pool-hall") {
        // The basin rim scatter (ladder/loungers/columns) predates the
        // module layer, and in a COMPOSED pool room it fought the modules'
        // own furniture for the same dry rims — its obstacle discs blocked
        // the bath's declared lockers and towel stations out of existence
        // (the room rendered as a bare basin; v0.12 declarations audit).
        // §8's rule owns the composition: the modules' whitelists furnish
        // the deck, the basin stays water-only. Legacy TEMPLATE pool rooms
        // (no composition — the §7 catalogue) keep the rim fixtures,
        // byte-for-byte.
        const legacy = roomComposition
          ? []
          : furnishInterior(rng, scaledRecipe, waterRect, plan, propScale, clearanceDoors);
        const obstacles = [
          ...legacy.map((p) => ({
            x: p.x,
            z: p.z,
            r: Math.max(0.5, p.scale),
          })),
          ...seamObstacles,
        ];
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
      return stageInteriorKits({
        ...staging,
        baseArea,
        obstacles: seamObstacles.length > 0 ? seamObstacles : undefined,
      }).map(toPlacement);
    }
    if (recipe.worldClass === "wonder") {
      // §3.1 N4: the dioramas are furnished by the WONDER kits on the same
      // staging machine (hero far-third, side kits, the §4 facings, the
      // 35% 留白, the B.11 door strips) — the deck and the world class are
      // the only deltas. The oversized accent rugs the legacy path seeded
      // stay (placed first, as the pool hall's fixtures do), and the
      // animals remain their own layer below. Water rooms (the duck pond)
      // subtract their basin from the density area like the nature branch.
      const rugs = furnishInterior(
        rng,
        scaledRecipe,
        waterRect,
        plan,
        propScale,
        clearanceDoors,
      );
      const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
      const waterArea = waterRect
        ? (waterRect.halfX * 2 * waterRect.halfZ * 2) /
          (scaleFactor * scaleFactor)
        : 0;
      const kits = stageInteriorKits({
        rng,
        worldClass: "wonder",
        archetype: recipe.archetype,
        plan,
        comp,
        baseExtent: recipe.size.extent,
        baseArea: Math.max(0, baseArea - waterArea),
        propScale,
        wallThick,
        water: waterRect,
        doors: clearanceDoors,
        heightAt: (x: number, z: number) => terrainHeight(scaledRecipe, x, z),
      });
      return [...rugs, ...kits.map(toPlacement)];
    }
    return furnishInterior(rng, scaledRecipe, waterRect, plan, propScale, clearanceDoors);
  }, [recipe, scaledRecipe, natureKitDeck, waterRect, plan, comp, propScale, scaleFactor, wallThick, clearanceDoors, template, roomComposition, seamObstacles]);


  // Internal structure (L/XL only, on the scaled tier): partition or
  // column grid. A COMPOSED room (§8) already carries its interior
  // architecture — the module seams ARE the partitions — so the legacy
  // structure draw stands down (it would double-partition the suite).
  const structure = useMemo(() => {
    if (roomComposition) return { kind: "none" as const };
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "structure"),
    );
    return buildStructure(rng, scaledRecipe, plan, clearanceDoors);
  }, [recipe, scaledRecipe, plan, clearanceDoors, roomComposition]);

  // Wonder-room animals: ducks / cats+dogs / balloons from one stream.
  const animals = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "animals"),
    );
    return buildAnimals(rng, recipe, scaledRecipe, waterRect, plan, creatureScale, clearanceDoors);
  }, [recipe, scaledRecipe, waterRect, plan, creatureScale, clearanceDoors]);

  // Dollhouse cutaway: entrance segments always keep full height (the door
  // handoff depends on them); of the rest, the segments whose outward face
  // looks toward the fixed camera are drawn at sill height — opaque, but
  // low enough that the interior reads over them. Runs inherit their
  // source segment's orientation, so the test holds after the door split.
  // Declared above the template features and fixtures: both consume the
  // drawn heights (features gate on them; the niche host walls steer the
  // window's host pool).
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
  // This memo sits ABOVE the fixtures memo on purpose: the window's host
  // pool steps around a niche's host wall (a view plane and a rebuilt
  // alcove run cannot share a run), so buildRoomFixtures receives the
  // niche source walls as input.
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
        doors: clearanceDoors,
        ground: spec.ground,
        water: waterRect
          ? {
              cx: waterRect.cx,
              cz: waterRect.cz,
              halfX: waterRect.halfX,
              halfZ: waterRect.halfZ,
            }
          : null,
      }),
    [template, plan, walls, wallRuns, wallHeights, wallHeight, wallThick, clearanceDoors, spec, waterRect],
  );

  // MOTIVATED FIXTURES (B.13): the lamp, the window, and (outdoor-class
  // sets + the pool hall) the clerestory band — the findable source of
  // every lit surface. The pool hall is interior by class but keeps §2's
  // worked example: its water needs a bright source to reflect.
  const hasClerestory =
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
        clearanceDoors,
        propScale,
        wallHeight / WALL_HEIGHT,
        hasClerestory,
        new Set([
          ...roomFeatures.niches.map((n) => wallRuns[n.run].source),
          ...roomFeatures.pilasters.map((p) => wallRuns[p.run].source),
          ...roomFeatures.arches.map((a) => wallRuns[a.run].source),
          ...roomFeatures.columnOrders.map((c) => wallRuns[c.run].source),
          ...roomFeatures.platforms.map((p) => wallRuns[p.run].source),
          ...roomFeatures.mezzanines.map((m) => wallRuns[m.run].source),
        ]),
      ),
    [recipe, scaledRecipe, plan, comp, walls, wallHeight, dir, waterRect, clearanceDoors, propScale, hasClerestory, roomFeatures, wallRuns],
  );
  // DAY/NIGHT: the app theme drives the fixtures' mood — windows go dark
  // and cool at night while the lamp burns brighter (readability never
  // depends on the window).
  const night = useAppDark();
  // Fixture LIGHT takes the palette's own sun color (the room's one light
  // register, A5), lifted toward white so the hue survives the bloom, then
  // modulated by the room's seeded light register (§11.2 item 4: the
  // window's color never fights the room's mood). At night it lerps cool
  // and drops to WINDOW_NIGHT_SPOT_SCALE of its strength.
  const lightRegister = useMemo(() => lightRegisterFor(recipe), [recipe]);
  const windowPaneColor = useMemo(() => {
    const c = new THREE.Color(recipe.palette.sunColor)
      .lerp(new THREE.Color("#ffffff"), 0.25)
      .lerp(new THREE.Color(LIGHT_REGISTER_TINTS[lightRegister]), 0.45);
    if (night) c.lerp(new THREE.Color(WINDOW_VIEW_NIGHT_TINT), 0.55);
    return c;
  }, [recipe, lightRegister, night]);
  // The view plane's multiplier: daylight pushes the sky just past the
  // bloom threshold (scaled by the palette's own sun intensity); night is
  // a cool half-strength wash — dark, never black.
  const windowViewColor = useMemo(() => {
    if (night) {
      return new THREE.Color(WINDOW_VIEW_NIGHT_TINT).multiplyScalar(
        WINDOW_VIEW_NIGHT_GAIN,
      );
    }
    return new THREE.Color(recipe.palette.sunColor)
      .lerp(new THREE.Color("#ffffff"), 0.55)
      .multiplyScalar(
        WINDOW_VIEW_DAY_GAIN * Math.min(1.2, Math.max(0.6, recipe.palette.sunIntensity)),
      );
  }, [recipe, night]);
  // The baked outside, one per room: sky gradient + sun halo + far/near
  // silhouettes, every color from this room's palette (§11.2 — the blue
  // room admits pale-blue daylight). The window samples it once; the
  // clerestory tiles it one view per mullion bay.
  const windowView = useMemo(
    () =>
      createWindowViewTexture(
        buildWindowViewImage({
          seed: (recipe.lightSeed ^ 0x2c1b3d) >>> 0,
          sky: recipe.palette.sky,
          fog: recipe.palette.fog,
          ground: recipe.palette.ground,
          sunColor: recipe.palette.sunColor,
        }),
      ),
    [recipe],
  );
  useEffect(() => () => windowView.dispose(), [windowView]);
  // Probe/e2e aid (GAME_DEBUG is a plain object; the fixture block is
  // optional debug surface, typed loosely to keep debug.ts untouched).
  useEffect(() => {
    (GAME_DEBUG as unknown as Record<string, unknown>).fixtures = {
      register: lightRegister,
      lamp: fixtures.lamp,
      window: {
        x: fixtures.window.x,
        z: fixtures.window.z,
        nx: fixtures.window.nx,
        nz: fixtures.window.nz,
      },
      clerestory: fixtures.clerestory
        ? {
            x: fixtures.clerestory.x,
            z: fixtures.clerestory.z,
            nx: fixtures.clerestory.nx,
            nz: fixtures.clerestory.nz,
          }
        : null,
    };
  }, [fixtures, lightRegister]);
  const clerestoryBays = fixtures.clerestory
    ? Math.max(
        1,
        Math.round(
          Math.max(
            CLERESTORY_UNIT * (wallHeight / WALL_HEIGHT),
            fixtures.clerestory.len -
              2 * CLERESTORY_END_PAD * (wallHeight / WALL_HEIGHT),
          ) /
            (CLERESTORY_UNIT * (wallHeight / WALL_HEIGHT)),
        ),
      )
    : 1;
  const clerestoryView = useMemo(() => {
    const t = windowView.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = clerestoryBays;
    t.needsUpdate = true;
    return t;
  }, [windowView, clerestoryBays]);
  useEffect(() => () => clerestoryView.dispose(), [clerestoryView]);

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
  // Shallow tint for the Beer–Lambert depth absorption: ankle-clear water
  // over tile reads as the deep tint brightened toward clear; the shader
  // derives depth analytically from the terrain bowl (the old rim ramp no
  // longer exists).
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
  // The rill's bed: the same quarry stone a grade darker under the water
  // (it is never lit directly through 12cm of water).
  const rillBedColor = useMemo(
    () => inlayColor.clone().multiplyScalar(0.82),
    [inlayColor],
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

  const nicheByRun = useMemo(() => {
    const map = new Map<number, NicheFeature>();
    for (const n of roomFeatures.niches) map.set(n.run, n);
    return map;
  }, [roomFeatures]);

  // Probe/e2e mirror (GAME_DEBUG.room): the mounted room's composition and
  // its placed strand doors, so probes can assert §8/§10.5 facts — module
  // growth by door load, axial-only door walls, the sparse open fields —
  // without reaching into the scene graph. Cleared when the room unmounts.
  useEffect(() => {
    const tracePiece = furniture.find((p) => p.trace) ?? null;
    const roleOfRun = (runIndex: number): string =>
      wallRoleFor(plan, walls[wallRuns[runIndex].source]);
    GAME_DEBUG.room = {
      sliceId: recipe.sliceId,
      doorCount: roomDoorCount,
      cls: `${recipe.worldClass}/${recipe.archetype}/${recipe.size.id}`,
      modules: roomComposition?.modules.map((p) => p.module.id) ?? [],
      topology: roomComposition?.topology ?? "",
      width: scaledRecipe.width,
      extent: scaledRecipe.size.extent,
      doorWalls: template?.doorWalls ?? [],
      declaredCapacity: template?.doorCapacity ?? 0,
      openFields: roomComposition?.openFields.length ?? 0,
      fieldRects: (roomComposition?.openFields ?? []).map(
        (f) =>
          [f.x0 * scaleFactor, f.z0 * scaleFactor, f.x1 * scaleFactor, f.z1 * scaleFactor] as const,
      ),
      // §8 seam jamb walls (scaled plan coordinates) — the same boxes the
      // movement clamp consumes; probes assert containment/walkability
      // without entering the scene graph.
      seamRects: seamPartitions.flatMap((sp) =>
        sp.flanks.map(
          (f) => [f.x, f.z, f.sizeX, f.sizeZ] as const,
        ),
      ),
      placedDoors: doorLayout.doors.map((d) => ({
        role: wallRoleFor(plan, walls[d.wall]),
        row: d.row,
        along: d.along,
      })),
      furniture: furniture.length,
      pieces: furniture.map((p) => [p.x, p.z] as const),
      pieceKinds: furniture.map((p) => p.kind),
      // v0.12 §2: the modules furnishing by room schematic this mount
      // (empty = every module staged generically) — probes assert the
      // blueprint path took ownership of the living room's floor.
      schematics: roomComposition
        ? schematicPlacementsFor(roomComposition.modules, scaleFactor).map(
            (p) => p.schematic.moduleId,
          )
        : [],
      // The resolved features actually built this mount — the N3/N4 slots
      // included (probes assert they render where declared, and that a
      // slot which failed every host rule is absent rather than clipped).
      features: [
        ...roomFeatures.niches.map((n) => `niche@${roleOfRun(n.run)}`),
        ...roomFeatures.pilasters.map((p) => `pilaster-rhythm@${roleOfRun(p.run)}`),
        ...(roomFeatures.inlay ? ["floor-inlay@floor"] : []),
        ...roomFeatures.platforms.map((f) => `raised-platform@${roleOfRun(f.run)}`),
        ...roomFeatures.mezzanines.map((f) => `mezzanine@${roleOfRun(f.run)}`),
        ...roomFeatures.arches.map((f) => `arch-frame@${roleOfRun(f.run)}`),
        ...roomFeatures.columnOrders.map((f) => `column-order@${roleOfRun(f.run)}`),
        ...(roomFeatures.rill ? ["water-rill@floor"] : []),
      ],
      // §4.4: the room's one trace (null when the room grew none) — its
      // kind and XZ, and the host piece it rests on, so probes can assert
      // "exactly one, inside the path/hero visibility band" from data.
      trace: tracePiece
        ? {
            kind: tracePiece.kind,
            x: tracePiece.x,
            z: tracePiece.z,
            host: furniture.find(
              (p) => p.trace !== true && p.x === tracePiece.x && p.z === tracePiece.z,
            )?.kind ?? "",
          }
        : null,
    };
    return () => {
      if (GAME_DEBUG.room?.sliceId === recipe.sliceId) GAME_DEBUG.room = null;
    };
  }, [recipe, roomDoorCount, roomComposition, scaledRecipe, template, doorLayout, plan, walls, wallRuns, roomFeatures, furniture, scaleFactor, wallThick, seamPartitions]);
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
  // Pool-floor caustics (materials/caustics-surface.ts): a two-layer light
  // web patched onto the ground material's shader, masked to the water
  // rectangle. Uniforms only — nothing extra to dispose; per-frame scroll
  // is driven below, a pure function of the frame clock.
  const caustics = useMemo(() => {
    if (!groundMaterial || !waterRect) return null;
    return applyPoolCaustics(groundMaterial, {
      rect: waterRect,
      spanX: width,
      spanY: extent,
      // B.13: caustics are refracted KEY light — tint toward the
      // clerestory band's wash.
      color: "#ffffff",
      intensity: 1,
      // The floor rides the same wave field the surface floats on: tiles
      // refract and the light web wobbles with every wading ring (see
      // caustics-surface.ts's WAVE-DRIVEN REFRACTION doc).
      wave: waveDriver
        ? {
            texture: waveDriver.texture,
            texelMeters: waveDriver.texelMeters,
          }
        : undefined,
    });
  }, [groundMaterial, waterRect, width, extent, waveDriver]);
  useFrame((state) => caustics?.update(state.clock.elapsedTime));
  // PER-MODULE WALL REGISTERS (§8.2): in a composed room each perimeter
  // span belongs to one module's exposed edge, and the span takes THAT
  // module's wall role as an OPAQUE material colour (panelling → wood,
  // tile → the wall slot, shelf → fabric, plaster → the room default) —
  // the joined modules read as different rooms at eye level without
  // spending transparency (the budget stays water + glass). Spans no
  // single module covers keep the room default.
  const wallRoleColors = useMemo(() => {
    const p = recipe.palette;
    return {
      plaster: wallColor,
      panelling: new THREE.Color(p.wood),
      tile: new THREE.Color(p.wall),
      shelf: new THREE.Color(p.fabric),
    } as const;
  }, [wallColor, recipe]);
  const wallRunRoles = useMemo(
    () =>
      wallRuns.map(({ wall }) =>
        roomComposition
          ? moduleWallForSegment(roomComposition, wall, scaleFactor)
          : null,
      ),
    [wallRuns, roomComposition, scaleFactor],
  );
  // Role per ORIGINAL wall index, for the screens (each screen stands off
  // its host wall and inherits its tint) and the seam partitions.
  const sourceWallRoles = useMemo(() => {
    const map = new Map<number, WallRoleM | null>();
    wallRuns.forEach(({ source }, i) => {
      if (!map.has(source)) map.set(source, wallRunRoles[i]);
    });
    return map;
  }, [wallRuns, wallRunRoles]);
  const wallMaterials = useMemo(
    () =>
      wallRuns.map(({ wall }, i) =>
        createSurfaceMaterial({
          kind: surfaceKind,
          color: (wallRunRoles[i] && wallRoleColors[wallRunRoles[i]!]) || wallColor,
          // A wall box's long axis is its span (u on the box's main faces);
          // v is the drawn height (sill height on the cutaway sides).
          spanX: Math.max(wall.sizeX, wall.sizeZ),
          spanY: wallHeights[i],
          flatShading: true,
          normalScale: wallNormalScale,
        }),
      ),
    [wallRuns, wallHeights, wallColor, surfaceKind, wallNormalScale, wallRunRoles, wallRoleColors],
  );
  useEffect(
    () => () => {
      for (const m of wallMaterials) m.dispose();
    },
    [wallMaterials],
  );
  // The door screens' runs share the perimeter's material wiring exactly —
  // one surface material per run, drawn at the HOST wall's height (a
  // cutaway sill's screen stays low with it).
  const screenMaterials = useMemo(
    () =>
      screenRuns.map(({ runs, source }) =>
        runs.map(({ wall }) =>
          createSurfaceMaterial({
            kind: surfaceKind,
            color:
              (sourceWallRoles.get(source) && wallRoleColors[sourceWallRoles.get(source)!]) ||
              wallColor,
            spanX: Math.max(wall.sizeX, wall.sizeZ),
            spanY: sourceWallHeights.get(source) ?? wallHeight,
            flatShading: true,
            normalScale: wallNormalScale,
          }),
        ),
      ),
    [screenRuns, sourceWallHeights, wallHeight, wallColor, surfaceKind, wallNormalScale, sourceWallRoles, wallRoleColors],
  );
  useEffect(
    () => () => {
      for (const group of screenMaterials) for (const m of group) m.dispose();
    },
    [screenMaterials],
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
  // The seam partitions share the perimeter's material wiring exactly —
  // one surface material per segment (jambs + header), full room height.
  // The tint is the seam's a-side module's wall register (§8.2): the
  // partition is that module's wall continuing into the composition.
  const seamMaterials = useMemo(
    () =>
      seamPartitions.map((sp) => {
        const role = roomModuleById(sp.aId)?.wall;
        const color = (role && wallRoleColors[role]) || wallColor;
        return [...sp.flanks, sp.header].map((seg) =>
          createSurfaceMaterial({
            kind: surfaceKind,
            color,
            spanX: Math.max(seg.sizeX, seg.sizeZ),
            spanY: wallHeight,
            flatShading: true,
            normalScale: wallNormalScale,
          }),
        );
      }),
    [seamPartitions, surfaceKind, wallColor, wallHeight, wallNormalScale, wallRoleColors],
  );
  useEffect(
    () => () => {
      for (const group of seamMaterials) for (const m of group) m.dispose();
    },
    [seamMaterials],
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
  // Per-module floor roles (§8.2/A5): each module's floor MATERIAL role
  // tints its own footprint — timber/carpet/tile read off the palette's
  // four-layer slots (wood/fabric/wall), so the joined modules read as
  // different rooms underfoot. Translucent veils over the parquet, one
  // plane per module, flush-abutting (no overlap, no double blend).
  const moduleFloors = useMemo(() => {
    if (!roomComposition || !parquet) return [];
    const p = recipe.palette;
    const slotFor = { timber: p.wood, carpet: p.fabric, tile: p.wall, deck: p.wood };
    return roomComposition.modules.map((placed) => ({
      rect: placed.rect,
      color: new THREE.Color(slotFor[placed.module.floor] ?? p.ground),
    }));
  }, [roomComposition, parquet, recipe]);
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

  // BASIN CURB WALLS (F2's debt): the sunken basin's analytic field is
  // straight-walled (terrain.ts), but the ground MESH resolves that step on
  // a fixed grid, so the pool wall rendered as a ~one-cell steep band.
  // These freestanding vertical boxes ARE the pool walls: the inner face sits exactly
  // on the water rectangle's boundary (terrain, water plane, caustics mask,
  // wave boundary, and prop avoidance all keep reading waterRectFor — none
  // of them move), the body extends OUTWARD over the grid's residual slope
  // cell (hiding it), and the top rises just past the water surface so the
  // brimming slab's edge meets tile, not air — a raised pool curb, the same
  // language as the fountain's ring wall. The near side opens where the
  // entrance funnel's ramp walks down into the water (terrain.ts's
  // entranceMask), so the wade-in path is never walled off.
  const basinCurbs = useMemo(() => {
    if (!tiledGround || !waterRect) return null;
    const cell = Math.max(width / groundSegments, extent / groundSegments);
    const curb = Math.min(1.4, Math.max(0.5, cell + 0.25));
    const yBottom = GROUND_Y - POOL_DEPTH - 0.05;
    const yTop = WATER_Y + 0.02;
    const height = yTop - yBottom;
    const yMid = (yTop + yBottom) / 2;
    const { halfX, halfZ, cz } = waterRect;
    const segs: WallSegment[] = [];
    // Far side + flanks, extended `curb` past the side faces (corners).
    segs.push({
      x: 0, z: cz + halfZ + curb / 2,
      sizeX: (halfX + curb) * 2, sizeZ: curb, entrance: false,
    });
    const nearZ = cz - halfZ - curb / 2;
    const funnelReaches = cz - halfZ < ENTRANCE_DEPTH + 2.5;
    const gapHalf = DOOR_GAP_HALF + 1.2; // the funnel's full-width mark
    if (funnelReaches && halfX > gapHalf + 0.3) {
      const flankLen = halfX + curb - gapHalf;
      segs.push(
        { x: -(gapHalf + flankLen / 2), z: nearZ, sizeX: flankLen, sizeZ: curb, entrance: false },
        { x: gapHalf + flankLen / 2, z: nearZ, sizeX: flankLen, sizeZ: curb, entrance: false },
      );
    } else if (!funnelReaches) {
      segs.push({
        x: 0, z: nearZ,
        sizeX: (halfX + curb) * 2, sizeZ: curb, entrance: false,
      });
    }
    // Side walls between the far/near curbs (corners already covered).
    segs.push(
      { x: -halfX - curb / 2, z: cz, sizeX: curb, sizeZ: halfZ * 2, entrance: false },
      { x: halfX + curb / 2, z: cz, sizeX: curb, sizeZ: halfZ * 2, entrance: false },
    );
    return { segs, height, yMid };
  }, [tiledGround, waterRect, width, extent, groundSegments]);
  const basinMaterials = useMemo(
    () =>
      (basinCurbs?.segs ?? []).map((seg) =>
        createSurfaceMaterial({
          kind: "tile",
          color: recipe.palette.ground,
          spanX: Math.max(seg.sizeX, seg.sizeZ),
          spanY: basinCurbs?.height ?? 1,
          flatShading: true,
          normalScale: TILE_NORMAL_SCALE,
        }),
      ),
    [basinCurbs, recipe],
  );
  useEffect(
    () => () => {
      for (const m of basinMaterials) m.dispose();
    },
    [basinMaterials],
  );

  // Mount-cost trace: close the first render body span (all useMemo work:
  // plan, scatter, furniture, material creation).
  if (MOUNT_TRACE.bodyMs < 0 && traceT0Ref.current >= 0) {
    MOUNT_TRACE.bodyMs = performance.now() - traceT0Ref.current;
  }

  return (
    <group
      ref={rootRef}
      key={recipe.sliceId}
      position={[door.x, 0, door.z]}
      rotation={[0, rotationY, 0]}
      visible={!prewarm}
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

      {/* Per-module floor tint (§8.2): each joined module's footprint
          takes its floor role's palette slot — the composition reads as
          rooms-within-rooms underfoot. Sits between the parquet and the
          inlay planes; translucent, so the checker still textures it. */}
      {moduleFloors.map((mf, i) => {
        const w = (mf.rect.x1 - mf.rect.x0) * scaleFactor;
        const d = (mf.rect.z1 - mf.rect.z0) * scaleFactor;
        return (
          <mesh
            key={`modfloor${i}`}
            position={[
              ((mf.rect.x0 + mf.rect.x1) / 2) * scaleFactor,
              GROUND_Y + 0.009,
              ((mf.rect.z0 + mf.rect.z1) / 2) * scaleFactor,
            ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry args={[w, d]} />
            <meshStandardMaterial
              color={mf.color}
              roughness={1}
              transparent
              opacity={0.5}
            />
          </mesh>
        );
      })}

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

      {waterRect && waveDriver && (
        <WaterSurface
          halfX={waterRect.halfX}
          halfZ={waterRect.halfZ}
          cz={waterRect.cz}
          color={waterColor}
          shallowColor={waterShallowColor}
          playerRef={playerRef}
          door={door}
          dir={dir}
          driver={waveDriver}
        />
      )}

      {/* Basin curb walls (sunken rooms): the pool's true vertical sides —
          the heightfield's step is exact analytically but the ground mesh
          resolves it as a steep band; these boxes put a straight tiled face
          on the water rectangle's boundary and bury the residual slope cell
          inside the curb. */}
      {basinCurbs?.segs.map((s, i) => (
        <mesh
          key={`basin${i}`}
          position={[s.x, basinCurbs.yMid, s.z]}
          castShadow
          receiveShadow
          material={basinMaterials[i]}
        >
          <boxGeometry args={[s.sizeX, basinCurbs.height, s.sizeZ]} />
        </mesh>
      ))}

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
        <Ducks
          key={`ducks-${recipe.sliceId}`}
          ducks={animals.ducks}
          driver={waveDriver}
          rect={waterRect}
        />
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
          (no shaft room above the rail). On a shelf-wall run the strips
          stand proud of the bookcase (front = case depth) and read as
          the bays' divisions. */}
      {roomFeatures.pilasters.map((p, i) => (
        <PilasterRun
          key={`pil${p.run}-${i}`}
          wall={wallRuns[p.run].wall}
          height={wallHeights[p.run]}
          alongs={p.alongs}
          plan={plan}
          wallScale={wallHeight / WALL_HEIGHT}
          color={dadoPanelColor}
          front={
            wallRunRoles[p.run] === "shelf" &&
            wallHeights[p.run] >= wallHeight - 1e-6
              ? SHELF_WALL_DEPTH * (wallHeight / WALL_HEIGHT)
              : 0
          }
        />
      ))}

      {/* The shelf wall (书架墙): a module whose wall register is "shelf"
          gets a real bookcase wall on every FULL-HEIGHT run — bays of
          shelves and book rows standing on the floor against the wall
          (the register used to be a colour only; v0.12 declarations
          audit). Cutaway sills keep the plain tint: a bookcase cannot
          rise out of a 1.1m wall. */}
      {wallRuns.map(({ wall }, i) =>
        wallRunRoles[i] === "shelf" &&
        !nicheByRun.has(i) &&
        wallHeights[i] >= wallHeight - 1e-6 ? (
          <ShelfWallRun
            key={`shelf${i}`}
            wall={wall}
            height={wallHeights[i]}
            plan={plan}
            wallScale={wallHeight / WALL_HEIGHT}
            window={fixtures.window}
          />
        ) : null,
      )}

      {/* The N3/N4 wall features (§3.2): the railed dais, the mezzanine
          ledge, the arch portal and the free-standing column order —
          resolved to single door-split runs, scaled by the wall ratio,
          silent when their host cannot hold them. */}
      {roomFeatures.platforms.map((f, i) => (
        <RaisedPlatform
          key={`plat${i}`}
          wall={wallRuns[f.run].wall}
          feature={f}
          plan={plan}
          bodyColor={dadoPanelColor}
          railColor={capColor}
        />
      ))}
      {roomFeatures.mezzanines.map((f, i) => (
        <MezzanineDeck
          key={`mezz${i}`}
          wall={wallRuns[f.run].wall}
          feature={f}
          plan={plan}
          bodyColor={dadoPanelColor}
          parapetColor={wallColor}
          trimColor={capColor}
        />
      ))}
      {roomFeatures.arches.map((f, i) => (
        <ArchFrame
          key={`arch${i}`}
          wall={wallRuns[f.run].wall}
          feature={f}
          plan={plan}
          stoneColor={inlayColor}
        />
      ))}
      {roomFeatures.columnOrders.map((f, i) => (
        <ColumnOrderRun
          key={`col${i}`}
          wall={wallRuns[f.run].wall}
          feature={f}
          plan={plan}
          stoneColor={inlayColor}
        />
      ))}

      {/* The water rill (§3.2 地面水渠): the stone runnel carrying real
          water on its own wave driver — same material family and water
          colours as the pool, no claim on the basin's caustics. */}
      {roomFeatures.rill && (
        <WaterRill
          rill={roomFeatures.rill}
          ws={wallHeight / WALL_HEIGHT}
          stoneColor={inlayColor}
          bedColor={rillBedColor}
          waterColor={waterColor}
          waterShallowColor={waterShallowColor}
          playerRef={playerRef}
          door={door}
          dir={dir}
        />
      )}

      {/* Second-row door screens (§10.5 fallback ②): the freestanding
          slabs the double-bank doors hang on — same boxes, same cap rail,
          same opaque language as the perimeter, drawn at the host wall's
          height so a cutaway side keeps its screen low. */}
      {screenRuns.map(({ runs, source }, si) => {
        const h = sourceWallHeights.get(source) ?? wallHeight;
        return runs.map(({ wall }, ri) => (
          <group key={`screen${si}-${ri}`}>
            <mesh
              position={[wall.x, h / 2, wall.z]}
              castShadow
              receiveShadow
              material={screenMaterials[si][ri]}
            >
              <boxGeometry args={[wall.sizeX, h, wall.sizeZ]} />
            </mesh>
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
        ));
      })}

      {/* Module seam partitions (§8): the walls BETWEEN a composition's
          modules — real thickness, broken around a walkable opening with a
          header above (human door height, never scaled). Same opaque wall
          language and cap rail as the perimeter; full height even on the
          cutaway side (they are interior architecture, not the room's
          silhouette). */}
      {seamPartitions.map((sp, si) => {
        const mats = seamMaterials[si];
        const headerH = Math.max(0.05, wallHeight - DOOR_HEIGHT);
        return (
          <group key={`seam${si}`}>
            {sp.flanks.map((seg, fi) => (
              <group key={`seam${si}-f${fi}`}>
                <mesh
                  position={[seg.x, wallHeight / 2, seg.z]}
                  castShadow
                  receiveShadow
                  material={mats[fi]}
                >
                  <boxGeometry args={[seg.sizeX, wallHeight, seg.sizeZ]} />
                </mesh>
                <mesh
                  position={[seg.x, wallHeight - 0.05, seg.z]}
                  castShadow
                  receiveShadow
                >
                  <boxGeometry
                    args={[seg.sizeX + 0.06, 0.1, seg.sizeZ + 0.06]}
                  />
                  <meshStandardMaterial color={capColor} roughness={1} flatShading />
                </mesh>
              </group>
            ))}
            <mesh
              position={[sp.header.x, DOOR_HEIGHT + headerH / 2, sp.header.z]}
              castShadow
              receiveShadow
              material={mats[sp.flanks.length]}
            >
              <boxGeometry
                args={[sp.header.sizeX, headerH, sp.header.sizeZ]}
              />
            </mesh>
          </group>
        );
      })}

      {/* Strand doors (B.8): one per strand through the slice, composed
          like the doors of a home — clustered, framed, with thresholds
          and name plaques. Unlit doors are the strand's unwritten
          continuation: present, closed, dark — never missing, never
          glowing. Second-row doors hang on their screen (screen
          thickness), not on the perimeter wall. */}
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
              thick={
                placement.row === 1
                  ? ROOM_DOOR_SCREEN_THICK
                  : Math.min(
                      walls[placement.wall].sizeX,
                      walls[placement.wall].sizeZ,
                    )
              }
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
        .filter((c) => !inDoorApproach(c.x, c.z, clearanceDoors))
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
          surface — a lamp with a real point light, a window onto a
          layered outside whose spot is the interior rooms' shadow-casting
          KEY, and (outdoor-class sets + pool hall) the clerestory band
          that justifies the overall key. */}
      <RoomLamp
        x={fixtures.lamp.x}
        z={fixtures.lamp.z}
        y={terrainHeight(scaledRecipe, fixtures.lamp.x, fixtures.lamp.z)}
        scale={propScale}
        boost={night ? LAMP_NIGHT_BOOST : 1}
      />
      {/* Module register sconces (§8.2): one per composed-room module, the
          register's findable source — wall plate, lit dome, real point
          light, additive pool. Non-composed rooms grow none. */}
      {moduleSconces.map((anchor, i) => (
        <ModuleSconce key={`sconce${i}`} anchor={anchor} wallScale={wallHeight / WALL_HEIGHT} />
      ))}
      <RoomWindow
        fixture={fixtures.window}
        wallScale={wallHeight / WALL_HEIGHT}
        paneColor={windowPaneColor}
        view={windowView}
        viewColor={windowViewColor}
        isKey={recipe.worldClass === "interior"}
        night={night}
      />
      {fixtures.clerestory && (
        <RoomClerestory
          fixture={fixtures.clerestory}
          wallScale={wallHeight / WALL_HEIGHT}
          paneColor={windowPaneColor}
          view={clerestoryView}
          viewColor={windowViewColor}
          night={night}
        />
      )}

      {/* The anchor terminal (§13.1): the room's machine, breathing by the
          door. Walk up, interact, and the view dissolves to the 2.5D
          catalog focused on this slice — the game → catalog half of the
          shared ?slice= address. */}
      <group
        position={[terminalAnchor.x, GROUND_Y, terminalAnchor.z]}
        rotation={[0, terminalAnchor.rotY, 0]}
        scale={terminalAnchor.scale}
      >
        <AnchorTerminal accent={recipe.palette.accent} />
      </group>

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
