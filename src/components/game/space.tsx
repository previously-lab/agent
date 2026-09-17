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
 * corridor) run along all four edges, and a 2.4m doorway gap centered on
 * the entrance (local x = 0, z = 0) is the only opening. Walls are fully
 * opaque; the interior stays visible from the fixed top-down camera via a
 * dollhouse cutaway — the walls whose outward face looks toward the camera
 * are drawn at WALL_SILL_HEIGHT (see wallFacesCamera below). A clear strip
 * at the doorway (terrain flattened, no props near the door axis) means the
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
 *   - scale:  normal / colossal (×8–20) / miniature (×0.05–0.2), applied
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
 * Everything rendered here is a pure function of the resolved recipe plus
 * the door position — rebuilding a space from the same recipe yields the
 * identical scene. Layout (positions, counts, waypoints, phases) is seed-
 * deterministic; only visual motion (bobbing, sway, snowfall, wandering)
 * reads the clock. Scene fog, background, and lights are owned by the
 * integrator's canvas and are deliberately NOT rendered here.
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
  type JSX,
  type MutableRefObject,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { WALL_HEIGHT, type DoorRef } from "@/lib/game/hotel";
import { GAME_DEBUG } from "./debug";
import { smoothstep } from "@/lib/game/math";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
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
  wallSegmentsFor,
  type Composition,
  type RoomPlan,
  type WallSegment,
} from "@/lib/game/room-plan";
import {
  createSurfaceMaterial,
  createWaterSurfaceMaterial,
} from "@/lib/game/materials";
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
  LONE_PROB,
  PARQUET_CELL,
  PET_COUNT,
  PET_NEAR_RADIUS_MAX,
  PORTAL_HEIGHT,
  PROP_COUNT,
  PROP_DOOR_DEPTH,
  PROP_DOOR_HALF,
  PROP_SCALE_EXP,
  ROCK_DIVISOR,
  ROCK_MIN,
  ROOM_WALL_THICKNESS,
  SKIRT_OVERHANG,
  SKIRT_OVERHANG_MIN,
  SKIRT_Y,
  SNOW_COUNT_MAX,
  SPACE_FADE_S,
  STRUCTURE_MIN_EXTENT,
  TILE_NORMAL_SCALE,
  TREE_DIVISOR,
  TREE_MIN,
  WALL_CLEARANCE,
  WALL_SILL_HEIGHT,
  WATER_Y,
} from "@/lib/game/tuning/room";
import { CAM_OFFSET } from "@/lib/game/tuning/render";

/** Horizontal direction from any point toward the fixed camera (world XZ,
 *  unit length): CAM_OFFSET is a constant world vector and the camera never
 *  rotates, so this never changes — which walls are "near" is decidable
 *  once per room, in world space. */
const CAM_DIR_XZ = (() => {
  const len = Math.hypot(CAM_OFFSET.x, CAM_OFFSET.z);
  return { x: CAM_OFFSET.x / len, z: CAM_OFFSET.z / len };
})();

/**
 * Dollhouse cutaway test: does this wall segment's OUTWARD face look toward
 * the camera? The outward normal is found by probing planContains just off
 * both faces (the side with no walkable plan is the outside), then rotated
 * to world space (a south door's room is rotated π about Y, so both axes
 * flip — room-local axes alone would pick the wrong walls). Segments whose
 * outward normal points within ~45° of the camera direction stand between
 * the camera and the interior, so they are drawn at WALL_SILL_HEIGHT:
 * opaque, but low enough to see over. Walls are axis-aligned, so the dot
 * is exactly ±1/√2 or 0 and the 0.5 threshold splits cleanly.
 */
function wallFacesCamera(
  plan: RoomPlan,
  wall: WallSegment,
  dir: number,
): boolean {
  const probe = 0.5;
  let nx = 0;
  let nz = 0;
  if (wall.sizeZ <= wall.sizeX) {
    nz = planContains(plan, wall.x, wall.z + probe, 0) ? -1 : 1;
  } else {
    nx = planContains(plan, wall.x + probe, wall.z, 0) ? -1 : 1;
  }
  const wx = dir > 0 ? nx : -nx;
  const wz = dir > 0 ? nz : -nz;
  return wx * CAM_DIR_XZ.x + wz * CAM_DIR_XZ.z > 0.5;
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
 *  doorway strip, off the cleared path, and clear of the hero's clearing. */
function candidateOk(
  plan: RoomPlan,
  comp: Composition,
  x: number,
  z: number,
  edge: number,
  heroClear: number,
): boolean {
  if (!planContains(plan, x, z, edge)) return false;
  if (Math.abs(x) < ENTRANCE_CLEAR_RADIUS && z < ENTRANCE_DEPTH) return false;
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
 * the entrance strip, or in the water are rejected and redrawn (bounded
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
    if (!candidateOk(plan, comp, lx, lz, edge, heroClear)) continue;
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

/** Low-contrast checkerboard parquet for interior/wonder floors: a
 *  code-generated 2×2 canvas texture (no asset files), repeated at
 *  PARQUET_CELL meters. Only flat-floor interior/wonder rooms get it —
 *  nature ground stays untouched. Sits a hair above the ground plane. */
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
      .lerp(new THREE.Color("#ffffff"), 0.13)
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
 * (|x| < 1.8, z < 3m), the walk path, the hero's clearing, the plan
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
    if (!candidateOk(plan, comp, lx, lz, isPoolside(kind) ? 0 : edge, heroClear)) {
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
 *  outside the kept leg are dropped). */
type Structure =
  | { kind: "none" }
  | { kind: "partition"; z: number; gapX: number }
  | { kind: "columns"; points: { x: number; z: number }[] };

function buildStructure(
  rng: () => number,
  scaled: SpaceRecipe,
  plan: RoomPlan,
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
    return {
      kind: "partition",
      z,
      gapX: (rng() * 2 - 1) * (width / 2 - 2.4),
    };
  }
  const n = rng() < 0.5 ? 2 : 3;
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -width / 4 + (i * width) / (2 * (n - 1) || 1);
      const z = extent * 0.3 + (j * extent * 0.5) / (n - 1 || 1);
      if (planContains(plan, x, z, 1)) {
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
      ducks.push({
        x: water.cx + (rng() * 2 - 1) * Math.max(0.3, water.halfX - 0.8),
        z: water.cz + (rng() * 2 - 1) * Math.max(0.3, water.halfZ - 0.8),
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
        if (rng() < 0.7) {
          const a = rng() * Math.PI * 2;
          const r = Math.sqrt(rng()) * nearR;
          waypoints.push([
            Math.cos(a) * r,
            Math.min(Math.max(extent * 0.12 + Math.sin(a) * r, 1.8), extent - 1.8),
          ]);
        } else {
          waypoints.push([
            (rng() * 2 - 1) * Math.max(8, (width / 2 - 1.8) * 0.75),
            2 + rng() * (extent - 4),
          ]);
        }
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
      // Spread bunches across the whole room; the door corridor, the plan
      // footprint, and the wall margin stay clear (the gift-box anchor sits
      // on the floor).
      let bx = 0;
      let bz = extent * 0.4;
      for (let tries = 0; tries < 24; tries++) {
        bx = (rng() * 2 - 1) * (width / 2 - 2);
        bz = extent * (0.12 + rng() * 0.78);
        if (Math.abs(bx) < PROP_DOOR_HALF && bz < PROP_DOOR_DEPTH) continue;
        if (!planContains(plan, bx, bz, 1)) continue;
        break;
      }
      if (
        (Math.abs(bx) < PROP_DOOR_HALF && bz < PROP_DOOR_DEPTH) ||
        !planContains(plan, bx, bz, 1)
      ) {
        bz = PROP_DOOR_DEPTH + 1 + rng() * 2;
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
export function SpaceScene({
  recipe,
  door,
  playerRef,
  corridorGone,
  fade,
  onFadedOut,
}: {
  recipe: SpaceRecipe;
  door: DoorRef;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  corridorGone: boolean;
  fade: "in" | "out";
  onFadedOut: () => void;
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
  const plan = useMemo(
    () =>
      roomPlanFor(
        recipe.sliceId,
        width,
        extent,
        COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35)),
      ),
    [recipe, width, extent, scaleFactor],
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
      ),
    [recipe, scaledRecipe, spec, waterRect, plan, comp, scatterEdge, propScale],
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
      ),
    [recipe, scaledRecipe, spec, waterRect, plan, comp, scatterEdge, propScale],
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
      ),
    };
  }, [recipe, scaledRecipe, waterRect, plan, comp, scatterEdge, propScale]);

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
        heightAt: (x: number, z: number) => terrainHeight(scaledRecipe, x, z),
      };
      if (recipe.archetype === "pool-hall") {
        const legacy = furnishInterior(rng, scaledRecipe, waterRect, plan, propScale);
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
    return furnishInterior(rng, scaledRecipe, waterRect, plan, propScale);
  }, [recipe, scaledRecipe, waterRect, plan, comp, propScale, scaleFactor, wallThick]);

  // Internal structure (L/XL only, on the scaled tier): partition or
  // column grid.
  const structure = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "structure"),
    );
    return buildStructure(rng, scaledRecipe, plan);
  }, [recipe, scaledRecipe, plan]);

  // Wonder-room animals: ducks / cats+dogs / balloons from one stream.
  const animals = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "animals"),
    );
    return buildAnimals(rng, recipe, scaledRecipe, waterRect, plan, creatureScale);
  }, [recipe, scaledRecipe, waterRect, plan, creatureScale]);

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

  // Perimeter walls from the room plan: rect rooms get the legacy
  // five-segment enclosure; l-shape rooms narrow past a seeded step (two
  // near sides, a step wall, and the kept leg's own three sides); colonnade
  // rooms open both sides into column bays. Every plan keeps the entrance
  // edge as two segments around the 2.4m doorway gap at human thickness —
  // the door handoff is structurally untouchable. Heights ride the wall
  // scale (S^0.5, clamped) so colossal rooms stay readable from the fixed
  // camera. Segments overlap the corners so no seam shows between them.
  const walls = useMemo(
    () => wallSegmentsFor(plan, wallThick),
    [plan, wallThick],
  );

  // Dollhouse cutaway: entrance segments always keep full height (the door
  // handoff depends on them); of the rest, the segments whose outward face
  // looks toward the fixed camera are drawn at sill height — opaque, but
  // low enough that the interior reads over them.
  const wallHeights = useMemo(
    () =>
      walls.map((wall) =>
        wall.entrance || !wallFacesCamera(plan, wall, dir)
          ? wallHeight
          : Math.min(wallHeight, WALL_SILL_HEIGHT),
      ),
    [walls, plan, dir, wallHeight],
  );

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
      walls.map((wall, i) =>
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
    [walls, wallHeights, wallColor, surfaceKind, wallNormalScale],
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
          always human-thickness around the 2.4m doorway gap. Fully opaque;
          the camera-facing segments are cut to sill height (wallHeights)
          so the interior reads over them — the dollhouse cutaway. */}
      {walls.map((wall, i) => {
        const h = wallHeights[i];
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
          parts that fit under their drawn top). */}
      {walls.map((wall, i) => (
        <DadoBand
          key={`dado${i}`}
          wall={wall}
          height={wallHeights[i]}
          plan={plan}
          wallScale={wallHeight / WALL_HEIGHT}
          trimColor={capColor}
          panelColor={dadoPanelColor}
        />
      ))}

      {/* Colonnade bays: open column rows where the side walls would be —
          the room spills onto the mist skirt between the columns. Column
          height matches the walls (wall scale, not prop scale). */}
      {plan.columns.map((c, i) => (
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
