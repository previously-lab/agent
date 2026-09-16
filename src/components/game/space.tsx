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
 * the entrance (local x = 0, z = 0) is the only opening. Walls are slightly
 * translucent so the camera can hint through the far wall when the player
 * stands near an edge. A clear strip at the doorway (terrain flattened, no
 * props near the door axis) means the player can always walk in.
 *
 * v2 taxonomy — the recipe's worldClass picks the content family:
 *   - nature:   biomes (meadow/plains/pool/forest + ocean/lake/beach/
 *               snowfield) with trees, rocks, water, and biome motif props
 *   - interior: hotel-room / pool-hall / library / ballroom — flat floor,
 *               seeded furniture layouts, no vegetation
 *   - hybrid:   a nature biome dressed with hotel furniture that does not
 *               belong (a bed on the grass, a TV in the forest)
 *   - wonder:   ducks (a pool full of bobbing rubber ducks), cats, dogs,
 *               balloons — cute low-poly animals with seeded wander paths
 * Large (L/XL) plans of any class may grow an internal structure: a
 * partition wall with a door gap, or a column grid.
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
} from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { DoorRef } from "@/lib/game/hotel";
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
  VIVID_PALETTES,
  type ArchetypeId,
  type SpaceRecipe,
} from "@/lib/game/space-types";

const GROUND_SEGMENTS = 48;
/** Perimeter wall height — unified with the corridor wall (4.0m). Every
 *  space is an enclosed room; the doorway gap is the only opening. */
const WALL_HEIGHT = 4.0;
const WALL_THICKNESS = 0.3;
/** Half of the 2.4m doorway gap in the entrance-edge wall. */
const DOOR_GAP_HALF = 1.2;
/** Space-side doorway mirrors the corridor door (1.4 × 3.0 slab, trim
 *  frame, accent glow) — the door is hotel property and reads identically
 *  from both sides. The entrance gets a 3.2m portal surround (filler
 *  panels + lintel) since the wall is 4.0m tall. */
const DOOR_WIDTH = 1.4;
const DOOR_HEIGHT = 3.0;
const PORTAL_HEIGHT = 3.2;
const DOOR_TRIM_COLOR = "#463f36";
const DOOR_GLOW_INTENSITY = 1.6;
const DOOR_HALO_OPACITY = 0.14;
/** Jamb/head light-leak seams around the closed slab (the exit landmark
 *  from deep inside a space). */
const DOOR_SEAM_INTENSITY = 2.8;
/** Slab swing, mirroring the corridor face: open within this distance of
 *  the door center, ~100°, always rotating away from the player. */
const DOOR_OPEN_DIST = 2.2;
const DOOR_OPEN_ANGLE = 1.75;
const DOOR_SWING_RATE = 5;
/** Scatter keeps this clearance from the wall boxes. */
const WALL_CLEARANCE = 1;
/** Wall transparency: at the unified 4m height the walls would hide the
 *  room interior from the 45° camera, so they read as translucent veils —
 *  solid enough to own the space, clear enough to show what is inside. */
const WALL_OPACITY = 0.5;
/** No props within this distance of the door axis near the doorway. */
const ENTRANCE_CLEAR_RADIUS = 1.5;
/** Depth outward from the wall that counts as "the doorway". */
const ENTRANCE_DEPTH = 2.5;
/** Mount/unmount crossfade: the room condenses out of (and dissolves back
 *  into) its own shadow in 150 ms — fast, but never a pop. */
const SPACE_FADE_S = 0.15;
const WATER_Y = 0.35;
/** Water reads too much like empty floor from above: keep it nearly solid,
 *  and tint it blue-green (waterColor below) rather than the raw accent. */
const WATER_OPACITY = 0.9;
/** Grounding skirt: dark apron extending this far beyond the walls, so the
 *  space reads as grounded terrain in the mist instead of a floating
 *  board. 40m — the unfoggable background shows past the apron's side
 *  edges at the fixed CAM_OFFSET when the player stands near the door, so
 *  the apron is deliberately oversized (only one space is mounted at a
 *  time, making it free). Sits just below the corridor floor (y = 0). */
const SKIRT_OVERHANG = 40;
const SKIRT_Y = -0.005;
/** Trees / rocks per instance: count = max(min, round(density · extent² / N)). */
const TREE_DIVISOR = 22;
const ROCK_DIVISOR = 45;
const TREE_MIN = 3;
const ROCK_MIN = 2;
/** Motif props per size tier — S stays restrained; big plans scale up so
 *  an L/XL room never reads as an empty hangar. */
const PROP_COUNT: Record<number, number> = {
  16: 3,
  32: 5,
  64: 8,
  96: 12,
};
/** Motif props keep the doorway corridor clear: |x| < 1.8 out to z = 3m. */
const PROP_DOOR_HALF = 1.8;
const PROP_DOOR_DEPTH = 3;
/** Internal structures only on big plans. */
const STRUCTURE_MIN_EXTENT = 64;
/** Wonder-animal counts per size tier. */
const DUCK_COUNT: Record<number, number> = {
  16: 20,
  32: 30,
  64: 45,
  96: 60,
};
const PET_COUNT: Record<number, number> = { 16: 4, 32: 5, 64: 6, 96: 8 };
/** Balloon bunches per size tier — a big ballroom of a room needs many. */
const BALLOON_BUNCHES: Record<number, number> = {
  16: 4,
  32: 6,
  64: 10,
  96: 15,
};
/** Parquet checkerboard cell size in meters. */
const PARQUET_CELL = 4;
/** Balloon colors come from the vivid palette set. */
const BALLOON_COLORS = VIVID_PALETTES.map((p) => p.accent);

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
 * Deterministic tree/rock scatter: count = max(minCount, round(density ·
 * extent² / divisor)) whenever density > 0, positions drawn from
 * createRng(recipe.layoutSeed), snapped to the shared terrainHeight.
 * Candidates inside the entrance clear zone or the water rectangle are
 * rejected and redrawn, so the placed count is exact (bounded attempts
 * guard the pathological case).
 */
function scatter(
  recipe: SpaceRecipe,
  density: number,
  divisor: number,
  minCount: number,
  water: WaterRect | null,
): Placement[] {
  if (density <= 0) return [];
  const { extent, width } = dims(recipe);
  // Keep WALL_CLEARANCE meters clear of the wall boxes: the walls hug the
  // plan edges, so the draw range starts WALL_THICKNESS + WALL_CLEARANCE
  // inside them.
  const edge = WALL_THICKNESS + WALL_CLEARANCE;
  const usableX = width / 2 - edge;
  const count = Math.max(
    minCount,
    Math.round((density * extent * extent) / divisor),
  );
  const rng = createRng(recipe.layoutSeed);
  const out: Placement[] = [];
  const maxAttempts = count * 50 + 200;
  let attempts = 0;
  while (out.length < count && attempts < maxAttempts) {
    attempts += 1;
    const lx = (rng() * 2 - 1) * usableX;
    const lz = edge + rng() * (extent - edge * 2);
    if (Math.abs(lx) < ENTRANCE_CLEAR_RADIUS && lz < ENTRANCE_DEPTH) {
      continue;
    }
    if (water && insideRect(lx, lz, water, 0.5)) {
      continue;
    }
    out.push({
      x: lx,
      y: terrainHeight(recipe, lx, lz),
      z: lz,
      scale: 0.8 + rng() * 0.5,
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

/** Water surface: a translucent blue-green plane that breathes (opacity)
 *  and bobs gently (y ±0.02) — cheap transform/material animation only. */
function WaterSurface({
  halfX,
  halfZ,
  cz,
  color,
}: {
  halfX: number;
  halfZ: number;
  cz: number;
  color: string | THREE.Color;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const mat = material.current;
    if (mat) mat.opacity = WATER_OPACITY + Math.sin(t * 1.3) * 0.03;
    const mesh = meshRef.current;
    if (mesh) mesh.position.y = WATER_Y + Math.sin(t * 0.6) * 0.02;
  });
  return (
    <mesh
      ref={meshRef}
      position={[0, WATER_Y, cz]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={1}
    >
      <planeGeometry args={[halfX * 2, halfZ * 2]} />
      <meshStandardMaterial
        ref={material}
        color={color}
        transparent
        opacity={WATER_OPACITY}
        roughness={0.15}
      />
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

/** Deterministic ripple patches scattered inside the water rectangle. */
function scatterRipples(rng: () => number, water: WaterRect): RipplePatch[] {
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
      radius: 1.2 + rng() * 1.4,
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
 *  Pure visual motion; layouts stay deterministic. */
function Snowfall({
  width,
  extent,
  seed,
}: {
  width: number;
  extent: number;
  seed: number;
}) {
  const count = Math.min(400, Math.max(140, Math.round((width * extent) / 10)));
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
        size={0.16}
        transparent
        opacity={0.9}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

/** Fireflies for dusk/night forests and lakes: warm points wandering slow
 *  circles around seeded centers. */
function Fireflies({
  width,
  extent,
  seed,
}: {
  width: number;
  extent: number;
  seed: number;
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
        size={0.15}
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
      >
        <cylinderGeometry args={[0.14, 0.2, 1.4, 6]} />
        <meshStandardMaterial color="#6b4f3a" roughness={1} flatShading />
      </instancedMesh>
      <instancedMesh
        ref={canopyRef}
        args={[undefined, undefined, placements.length]}
        frustumCulled={false}
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
    >
      <dodecahedronGeometry args={[0.5, 0]} />
      <meshStandardMaterial color="#8a8d90" roughness={1} flatShading />
    </instancedMesh>
  );
}

/** Motif prop kinds — every archetype has at least three (interiors are
 *  furnished by layout instead; see furnishInterior). */
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
 * Deterministic motif scatter: PROP_COUNT[extent] props, kind picked from
 * the given list, positions from the caller's rng stream (the dedicated
 * "props" seed stream — see SpaceScene). Obstacle rules: the doorway
 * corridor (|x| < 1.8, z < 3m) and the wall boxes (1m clearance) are
 * always off-limits; so is the water rectangle, except poolside fixtures,
 * which are placed ON its rim facing the water instead. Snapped to the
 * shared terrainHeight.
 */
function scatterMotifs(
  rng: () => number,
  recipe: SpaceRecipe,
  kinds: readonly MotifKind[],
  water: WaterRect | null,
): PropPlacement[] {
  if (kinds.length === 0) return [];
  const { extent, width } = dims(recipe);
  const edge = WALL_THICKNESS + WALL_CLEARANCE;
  const usableX = width / 2 - edge;
  const count = PROP_COUNT[extent] ?? Math.max(3, Math.round(extent / 12));
  const out: PropPlacement[] = [];
  const maxAttempts = count * 60 + 240;
  let attempts = 0;
  while (out.length < count && attempts < maxAttempts) {
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
      const clampX = width / 2 - WALL_THICKNESS - 0.25;
      const clampZ = extent - WALL_THICKNESS - 0.25;
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
      lx = (rng() * 2 - 1) * usableX;
      lz = edge + rng() * (extent - edge * 2);
    }
    if (Math.abs(lx) < PROP_DOOR_HALF && lz < PROP_DOOR_DEPTH) {
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
      y: terrainHeight(recipe, lx, lz),
      z: lz,
      rotY,
      scale: 0.9 + rng() * 0.25,
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
 * Seeded interior furnishing (hotel-room / pool-hall / library / ballroom):
 * fixed per-room checklists wall-anchored with seeded jitter — beds against
 * the far wall, shelf rows facing each other, chandeliers in a grid. Counts
 * scale with the plan; positions come from the "furniture" seed stream.
 */
function furnishInterior(
  rng: () => number,
  recipe: SpaceRecipe,
  water: WaterRect | null,
): PropPlacement[] {
  const { extent, width } = dims(recipe);
  const out: PropPlacement[] = [];
  const jitter = (amount: number) => (rng() * 2 - 1) * amount;
  const put = (
    kind: MotifKind,
    x: number,
    z: number,
    rotY: number,
    scale = 1,
  ) => {
    out.push({
      kind,
      x: Math.min(Math.max(x, -width / 2 + 1), width / 2 - 1),
      y: terrainHeight(recipe, x, z),
      z: Math.min(Math.max(z, 1.2), extent - 1.2),
      rotY,
      scale,
    });
  };

  switch (recipe.archetype) {
    case "hotel-room": {
      const side = rng() < 0.5 ? 1 : -1;
      const bedX = -width / 4 + jitter(0.5);
      put("rug", jitter(0.4), extent * 0.55, 0);
      put("bed", bedX, extent - 1.6, Math.PI);
      put("nightstand", bedX - 1.5, extent - 0.8, 0);
      put("nightstand", bedX + 1.5, extent - 0.8, 0);
      put("tv", side * (width / 2 - 0.7), extent * 0.55, -side * (Math.PI / 2));
      put("sofa", -side * (width / 2 - 1.0), extent * 0.5, side * (Math.PI / 2));
      if (extent >= 64) {
        put("floorlamp", -side * (width / 2 - 1.0), extent * 0.5 - 2.2, 0);
        put("desk", width / 4, 2.4, Math.PI);
      }
      break;
    }
    case "library": {
      const shelfStep = 2.6;
      for (const rowSide of [-1, 1]) {
        const x = rowSide * (width / 2 - 1.1);
        for (let z = 2.8; z <= extent - 2.8; z += shelfStep) {
          put("bookshelf", x, z + jitter(0.2), -rowSide * (Math.PI / 2));
        }
      }
      for (let z = 4.5; z <= extent - 3; z += 5.2) {
        // Chairs spread across the room's width (not just the center
        // column) so wide plans read furnished from the doorway too.
        const cx = (width / 2 - 4) * (rng() * 2 - 1);
        put("readingchair", cx + jitter(0.5), z + jitter(0.4), Math.PI + jitter(0.4));
        put("desklamp", cx + 1.1, z + jitter(0.3), 0);
      }
      put("rug", 0, extent / 2, 0, extent >= 64 ? 1.6 : 1.2);
      if (extent >= 64) {
        put("rug", 0, extent * 0.25, 0, 1.2);
        put("rug", 0, extent * 0.75, 0, 1.2);
      }
      break;
    }
    case "ballroom": {
      put("rug", 0, extent / 2, 0, 1.6);
      if (extent >= 64) {
        put("rug", -width / 4, extent * 0.28, 0, 1.2);
        put("rug", width / 4, extent * 0.72, 0, 1.2);
      }
      const n = extent >= 64 ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const gx = n === 4 ? (i % 2 === 0 ? -1 : 1) * (width / 4) : 0;
        const gz = n === 4 ? (i < 2 ? 0.35 : 0.65) * extent : (i === 0 ? 0.35 : 0.65) * extent;
        put("chandelier", gx, gz, 0);
      }
      for (const colSide of [-1, 1]) {
        for (let z = 3; z <= extent - 3; z += 4.5) {
          put("column", colSide * (width / 2 - 1.0), z + jitter(0.3), 0);
        }
      }
      break;
    }
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
 *  a column grid — seeded, never blocking the entrance corridor. */
type Structure =
  | { kind: "none" }
  | { kind: "partition"; z: number; gapX: number }
  | { kind: "columns"; points: { x: number; z: number }[] };

function buildStructure(rng: () => number, recipe: SpaceRecipe): Structure {
  const { extent, width } = dims(recipe);
  if (extent < STRUCTURE_MIN_EXTENT) return { kind: "none" };
  const roll = rng();
  if (roll < 0.45) return { kind: "none" };
  if (roll < 0.75) {
    return {
      kind: "partition",
      z: extent * (0.42 + rng() * 0.16),
      gapX: (rng() * 2 - 1) * (width / 2 - 2.4),
    };
  }
  const n = rng() < 0.5 ? 2 : 3;
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      points.push({
        x: -width / 4 + (i * width) / (2 * (n - 1) || 1),
        z: extent * 0.3 + (j * extent * 0.5) / (n - 1 || 1),
      });
    }
  }
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
      >
        <sphereGeometry args={[0.26, 9, 7]} />
        <meshStandardMaterial color="#ffd23f" roughness={0.9} flatShading />
      </instancedMesh>
      <instancedMesh
        ref={headRef}
        args={[undefined, undefined, count]}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.15, 8, 6]} />
        <meshStandardMaterial color="#ffd23f" roughness={0.9} flatShading />
      </instancedMesh>
      <instancedMesh
        ref={beakRef}
        args={[undefined, undefined, count]}
        frustumCulled={false}
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
          <PetGeometry kind={kind} color={pet.color} />
        </group>
      ))}
    </>
  );
}

/** One balloon bunch: balloons on strings anchored to a gift box — floats
 *  gently (intentionally airborne; everything else in the room stays put). */
interface BalloonData {
  x: number;
  z: number;
  phase: number;
  balloons: { dx: number; dz: number; y: number; r: number; color: string }[];
}

function BalloonBunch({ data }: { data: BalloonData }) {
  const floatRef = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = floatRef.current;
    if (!g) return;
    const t = clock.elapsedTime;
    g.position.y = Math.sin(t * 0.35 + data.phase) * 0.25;
    g.rotation.y = Math.sin(t * 0.12 + data.phase) * 0.2;
  });
  return (
    <group position={[data.x, GROUND_Y, data.z]}>
      <group ref={floatRef}>
        {data.balloons.map((b, i) => (
          <group key={i}>
            <mesh position={[b.dx, b.y, b.dz]}>
              <sphereGeometry args={[b.r, 10, 8]} />
              <meshStandardMaterial color={b.color} roughness={0.6} flatShading />
            </mesh>
            <mesh position={[b.dx * 0.5, b.y / 2, b.dz * 0.5]}>
              <cylinderGeometry args={[0.008, 0.008, b.y, 4]} />
              <meshStandardMaterial color="#d8d4cc" roughness={1} flatShading />
            </mesh>
          </group>
        ))}
      </group>
      {/* The anchor: a gift box the strings are tied to. */}
      <mesh position={[0, 0.28, 0]}>
        <boxGeometry args={[0.55, 0.55, 0.55]} />
        <meshStandardMaterial color="#f2ede2" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.58, 0]}>
        <boxGeometry args={[0.6, 0.1, 0.6]} />
        <meshStandardMaterial color="#e0643c" roughness={1} flatShading />
      </mesh>
    </group>
  );
}

/** Wonder-room animal data, all from the "animals" seed stream. */
function buildAnimals(
  rng: () => number,
  recipe: SpaceRecipe,
  water: WaterRect | null,
): {
  ducks: DuckSeed[];
  pets: { kind: "cat" | "dog"; pets: Pet[] };
  balloons: BalloonData[];
} {
  const { extent, width } = dims(recipe);
  const ducks: DuckSeed[] = [];
  const pets: Pet[] = [];
  const balloons: BalloonData[] = [];
  const petCount = PET_COUNT[extent] ?? 4;

  if (recipe.archetype === "ducks" && water) {
    const count = DUCK_COUNT[extent] ?? 30;
    for (let i = 0; i < count; i++) {
      ducks.push({
        x: water.cx + (rng() * 2 - 1) * Math.max(0.3, water.halfX - 0.8),
        z: water.cz + (rng() * 2 - 1) * Math.max(0.3, water.halfZ - 0.8),
        phase: rng() * Math.PI * 2,
        scale: 0.8 + rng() * 0.45,
        spin: (rng() - 0.5) * 0.4,
        heading: rng() * Math.PI * 2,
      });
    }
  }

  if (recipe.archetype === "cats" || recipe.archetype === "dogs") {
    const colors =
      PET_COLORS[recipe.archetype === "cats" ? "cat" : "dog"];
    // Waypoints concentrate around the doorway circle (radius extent·0.3)
    // so an animal crosses the player's view soon after entering; a third
    // of them roam wider to keep the room alive.
    const nearR = extent * 0.3;
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
        scale: 0.85 + rng() * 0.3,
        color: colors[Math.floor(rng() * colors.length)],
        phase: rng() * Math.PI * 2,
      });
    }
  }

  if (recipe.archetype === "balloons") {
    const bunches = BALLOON_BUNCHES[extent] ?? 8;
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
      // Spread bunches across the whole room; the door corridor and the
      // wall margin stay clear (the gift-box anchor sits on the floor).
      let bx = 0;
      let bz = extent * 0.4;
      for (let tries = 0; tries < 24; tries++) {
        bx = (rng() * 2 - 1) * (width / 2 - 2);
        bz = extent * (0.12 + rng() * 0.78);
        if (!(Math.abs(bx) < PROP_DOOR_HALF && bz < PROP_DOOR_DEPTH)) break;
      }
      if (Math.abs(bx) < PROP_DOOR_HALF && bz < PROP_DOOR_DEPTH) {
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
      kind: recipe.archetype === "dogs" ? "dog" : "cat",
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
          position={[side * fillerCenter, PORTAL_HEIGHT / 2, WALL_THICKNESS / 2]}
        >
          <boxGeometry args={[fillerWidth, PORTAL_HEIGHT, WALL_THICKNESS]} />
          <meshStandardMaterial
            color={wallColor}
            roughness={1}
            flatShading
            transparent
            opacity={WALL_OPACITY}
          />
        </mesh>
      ))}
      {/* Lintel above the slab, up to portal height. */}
      <mesh
        position={[0, (PORTAL_HEIGHT + DOOR_HEIGHT) / 2, WALL_THICKNESS / 2]}
      >
        <boxGeometry
          args={[DOOR_WIDTH, PORTAL_HEIGHT - DOOR_HEIGHT, WALL_THICKNESS]}
        />
        <meshStandardMaterial
          color={wallColor}
          roughness={1}
          flatShading
          transparent
          opacity={WALL_OPACITY}
        />
      </mesh>
      {/* Trim frame, proud of the wall face into the space (+z local). */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (DOOR_WIDTH / 2 + 0.05), DOOR_HEIGHT / 2 + 0.05, WALL_THICKNESS + 0.06]}
        >
          <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
          <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
        </mesh>
      ))}
      <mesh position={[0, DOOR_HEIGHT + 0.11, WALL_THICKNESS + 0.06]}>
        <boxGeometry args={[DOOR_WIDTH + 0.2, 0.12, 0.24]} />
        <meshStandardMaterial color={DOOR_TRIM_COLOR} roughness={1} flatShading />
      </mesh>
      {doorVisible && (
        <>
          {/* The hinged slab — the way back out, swinging on its jamb. */}
          <group ref={hingeRef} position={[hingeX, 0, WALL_THICKNESS / 2]}>
            <mesh position={[-hingeX, DOOR_HEIGHT / 2, 0]}>
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
            <mesh position={[knobX, DOOR_HEIGHT / 2, 0.05]}>
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
              position={[side * (DOOR_WIDTH / 2 - 0.02), DOOR_HEIGHT / 2, WALL_THICKNESS + 0.05]}
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
          <mesh position={[0, DOOR_HEIGHT - 0.02, WALL_THICKNESS + 0.05]}>
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
          <mesh position={[0, DOOR_HEIGHT / 2, WALL_THICKNESS + 0.2]}>
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
 * Render the space described by a fully resolved recipe, extending outward
 * from the corridor wall at `door`. Pure function of (recipe, door) — no
 * fog, background, or lights (the integrator's canvas owns those).
 *
 * FADE. The room never pops: every material under the root is captured on
 * mount (base opacity + transparency) and crossfaded over SPACE_FADE_S —
 * `fade="in"` condenses the room out of its shadow on entry, `fade="out"`
 * dissolves it on exit and fires `onFadedOut` so the integrator can
 * unmount. Once the fade-in completes, materials are restored to their
 * authored transparency so steady-state rendering is untouched.
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
  const { extent } = recipe.size;
  const width = recipe.width;
  const dir = door.z > 0 ? 1 : -1;

  // Crossfade machinery: capture every material once (the tree is static
  // per recipe), then scale opacity each frame toward the fade target.
  const rootRef = useRef<THREE.Group>(null);
  const fadeMatsRef = useRef<{ mat: THREE.Material; base: number; transparent: boolean }[]>([]);
  const fadeTRef = useRef(fade === "in" ? 0 : 1);
  const fadeDoneRef = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mats: { mat: THREE.Material; base: number; transparent: boolean }[] = [];
    root.traverse((obj) => {
      const material = (obj as { material?: THREE.Material | THREE.Material[] }).material;
      if (material === undefined) return;
      for (const mat of Array.isArray(material) ? material : [material]) {
        mats.push({ mat, base: mat.opacity, transparent: mat.transparent });
      }
    });
    fadeMatsRef.current = mats;
    const k0 = fadeTRef.current;
    for (const { mat } of mats) {
      mat.transparent = true;
      mat.opacity = mat.opacity * k0;
    }
  }, []);
  useFrame((_, delta) => {
    const mats = fadeMatsRef.current;
    if (mats.length === 0) return;
    const dirSign = fade === "in" ? 1 : -1;
    const t = fadeTRef.current;
    if ((dirSign > 0 && t >= 1) || (dirSign < 0 && t <= 0)) return;
    const next = THREE.MathUtils.clamp(
      t + (dirSign * Math.min(delta, 0.05)) / SPACE_FADE_S,
      0,
      1,
    );
    fadeTRef.current = next;
    const k = next * next * (3 - 2 * next);
    for (const entry of mats) {
      entry.mat.transparent = true;
      entry.mat.opacity = entry.base * k;
    }
    if (dirSign > 0 && next >= 1) {
      // Fade-in done: hand materials back to their authored state.
      for (const entry of mats) {
        entry.mat.opacity = entry.base;
        entry.mat.transparent = entry.transparent;
      }
    }
    if (dirSign < 0 && next <= 0 && !fadeDoneRef.current) {
      fadeDoneRef.current = true;
      onFadedOut();
    }
  });

  const waterRect = useMemo(() => waterRectFor(recipe), [recipe]);

  const trees = useMemo(
    () => scatter(recipe, spec.treeDensity, TREE_DIVISOR, TREE_MIN, waterRect),
    [recipe, spec, waterRect],
  );
  const rocks = useMemo(
    () => scatter(recipe, spec.rockDensity, ROCK_DIVISOR, ROCK_MIN, waterRect),
    [recipe, spec, waterRect],
  );

  // Motif layer: one dedicated "props" seed stream. Ripples draw first,
  // then motif props, in a fixed order, so the whole layer is deterministic
  // per recipe. Hybrids mix their biome's props with hotel furniture.
  const motif = useMemo(() => {
    const rng = createRng(deriveSubSeed(WORLD_SEED, recipe.sliceId, "props"));
    const ripples = waterRect ? scatterRipples(rng, waterRect) : [];
    const base = MOTIF_KINDS[recipe.archetype];
    const kinds =
      recipe.worldClass === "hybrid"
        ? [...base, ...HYBRID_FURNITURE]
        : base;
    return { ripples, props: scatterMotifs(rng, recipe, kinds, waterRect) };
  }, [recipe, waterRect]);

  // Interiors AND wonder rooms are dressed by seeded layout (furniture for
  // interiors; oversized rugs for the animal/balloon dioramas).
  const furniture = useMemo(() => {
    if (
      recipe.worldClass !== "interior" &&
      recipe.worldClass !== "wonder"
    ) {
      return [];
    }
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "furniture"),
    );
    return furnishInterior(rng, recipe, waterRect);
  }, [recipe, waterRect]);

  // Internal structure (L/XL only): partition or column grid.
  const structure = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "structure"),
    );
    return buildStructure(rng, recipe);
  }, [recipe]);

  // Wonder-room animals: ducks / cats+dogs / balloons from one stream.
  const animals = useMemo(() => {
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "animals"),
    );
    return buildAnimals(rng, recipe, waterRect);
  }, [recipe, waterRect]);

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

  // Grounding skirt: a dark rectangular apron around the plan (hole cut for
  // the plan itself), darkened ~38% from the ground color.
  const skirtGeometry = useMemo(() => {
    const sizeX = width + SKIRT_OVERHANG * 2;
    const sizeZ = extent + SKIRT_OVERHANG * 2;
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
  }, [width, extent]);
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

  // Perimeter walls (universal — every space is an enclosed room): two side
  // walls spanning the z depth, the far wall, and the entrance-edge wall
  // split in two around a 2.4m doorway gap. Segments overlap the corners by
  // WALL_THICKNESS so no seam shows between them.
  const walls = useMemo(() => {
    const halfW = width / 2;
    const y = WALL_HEIGHT / 2;
    const entranceLength = halfW - DOOR_GAP_HALF + WALL_THICKNESS;
    const entranceCenter = DOOR_GAP_HALF + entranceLength / 2;
    const segments: {
      position: [number, number, number];
      size: [number, number, number];
    }[] = [
      {
        position: [-(halfW - WALL_THICKNESS / 2), y, extent / 2],
        size: [WALL_THICKNESS, WALL_HEIGHT, extent],
      },
      {
        position: [halfW - WALL_THICKNESS / 2, y, extent / 2],
        size: [WALL_THICKNESS, WALL_HEIGHT, extent],
      },
      {
        position: [-entranceCenter, y, WALL_THICKNESS / 2],
        size: [entranceLength, WALL_HEIGHT, WALL_THICKNESS],
      },
      {
        position: [entranceCenter, y, WALL_THICKNESS / 2],
        size: [entranceLength, WALL_HEIGHT, WALL_THICKNESS],
      },
      {
        position: [0, y, extent - WALL_THICKNESS / 2],
        size: [width + WALL_THICKNESS * 2, WALL_HEIGHT, WALL_THICKNESS],
      },
    ];
    return segments;
  }, [width, extent]);

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
      pos.setZ(i, terrainHeight(recipe, lx, lz) - GROUND_Y);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  }, [recipe, extent]);

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
      >
        <meshStandardMaterial color={skirtColor} roughness={1} />
      </mesh>

      {/* Ground: width × extent plane, 48×48 segments, displaced by the
          archetype heightfield. Spans local z ∈ [0, extent] with the
          doorway edge at z = 0, flush against the corridor wall, and is
          lifted GROUND_Y above the corridor floor so the seam can never
          z-fight. */}
      <mesh
        ref={groundRef}
        position={[0, GROUND_Y, extent / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry
          args={[width, extent, GROUND_SEGMENTS, GROUND_SEGMENTS]}
        />
        <meshStandardMaterial
          color={recipe.palette.ground}
          roughness={1}
          flatShading
        />
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
          <MotifProp
            kind={p.kind}
            accent={recipe.palette.accent}
            canopyColor={canopyColor}
          />
        </group>
      ))}

      {/* Interior furnishing (hotel-room / pool-hall / library / ballroom). */}
      {furniture.map((p, i) => (
        <group
          key={`f${i}`}
          position={[p.x, p.y, p.z]}
          rotation={[0, p.rotY, 0]}
          scale={p.scale}
        >
          <MotifProp
            kind={p.kind}
            accent={recipe.palette.accent}
            canopyColor={canopyColor}
          />
        </group>
      ))}

      {/* Internal structure (L/XL): partition wall with a door gap, or a
          column grid. Same translucent wall color. */}
      {structure.kind === "partition" && (
        <>
          {([-1, 1] as const).map((side) => {
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
                  position={[segCenter, WALL_HEIGHT / 2, structure.z]}
                >
                  <boxGeometry
                    args={[segLength, WALL_HEIGHT, WALL_THICKNESS]}
                  />
                  <meshStandardMaterial
                    color={wallColor}
                    roughness={1}
                    flatShading
                    transparent
                    opacity={WALL_OPACITY}
                  />
                </mesh>
                <mesh
                  position={[segCenter, WALL_HEIGHT - 0.05, structure.z]}
                >
                  <boxGeometry
                    args={[segLength + 0.06, 0.1, WALL_THICKNESS + 0.06]}
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
          <group key={i} position={[pt.x, GROUND_Y, pt.z]}>
            <MotifProp
              kind="column"
              accent={recipe.palette.accent}
              canopyColor={canopyColor}
            />
          </group>
        ))}

      {/* Dynamic atmosphere layers. */}
      {snowing && (
        <Snowfall
          key={`snow-${recipe.sliceId}`}
          width={width}
          extent={extent}
          seed={recipe.lightSeed}
        />
      )}
      {fireflies && (
        <Fireflies
          key={`ff-${recipe.sliceId}`}
          width={width}
          extent={extent}
          seed={recipe.lightSeed}
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
        <BalloonBunch key={`b${i}`} data={b} />
      ))}

      {/* Perimeter walls: every space is an enclosed room. 4m-high segments
          enclose the plan on all four edges — slight transparency lets the
          camera hint through the far wall. */}
      {walls.map((wall, i) => (
        <group key={i}>
          <mesh position={wall.position}>
            <boxGeometry args={wall.size} />
            <meshStandardMaterial
              color={wallColor}
              roughness={1}
              flatShading
              transparent
              opacity={WALL_OPACITY}
            />
          </mesh>
          {/* Dark cap rail along the wall top: keeps the room boundary
              readable from inside despite the translucency. */}
          <mesh position={[wall.position[0], WALL_HEIGHT - 0.05, wall.position[2]]}>
            <boxGeometry
              args={[wall.size[0] + 0.06, 0.1, wall.size[2] + 0.06]}
            />
            <meshStandardMaterial color={capColor} roughness={1} flatShading />
          </mesh>
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
