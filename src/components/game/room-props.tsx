"use client";

/**
 * Room props — the polished furniture/material vocabulary for interior
 * rooms (visual study 02: soft layered wood/cloth/paper, low-poly but
 * crafted, contact shadows, no hot spots).
 *
 * One SpaceScene mount calls useRoomPropMaterials ONCE and passes the set
 * through MotifProp/MotifGeometry and ShelfWallRun: every sofa/bookshelf/
 * desk of the room shares ONE material per role (wood top/base/dark, fabric
 * light/base/dark, paper, ceramic, metal, leaf, rug, contact). Material
 * sharing is a texture/GC discipline — it does not reduce draw calls — and
 * it composes with the room fade: the fade captures materials through the
 * AUTHORED_MATERIAL_STATE WeakMap, so one shared instance is captured and
 * crossfaded exactly once no matter how many meshes reference it. Role
 * materials are disposed on unmount; the textures they sample (wood grain,
 * grunge roughness, radial glow) are app-lifetime shared singletons and are
 * NEVER disposed here.
 *
 * All colors derive from the scenario palette (scenario-art.ts) — no hard
 * coded dark browns, vivid spines, terracotta pots or cyan TV screens.
 *
 * Books and plant leaves are STATIC InstancedMesh fills (the Ducks matrix
 * discipline): matrices/colors are written once in a mount/layout effect,
 * never per frame. Only the TV tint uses the pause-aware game clock.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type JSX } from "react";
import * as THREE from "three";
import { useGameFrame } from "./use-game-frame";
import {
  sharedGrungeRoughnessMap,
  sharedRadialGlowTexture,
  sharedWoodTextures,
  WOOD_ALBEDO_MEAN,
} from "@/lib/game/materials";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  BOOKSHELF_DIMENSIONS, ACTIVITY_SHEETS, ACTIVITY_CUPS,
  ACTIVITY_CUP_RADIUS, ACTIVITY_DIARY_SIZE,
} from "@/lib/game/prop-dimensions";
import type { ActivityTraceItem } from "@/lib/game/activity-traces";

/** The palette roles the prop materials derive from — the scenarioPalette
 *  output (day or night) satisfies this structurally. */
export interface RoomPropPalette {
  wall: string;
  fabric: string;
  wood: string;
  accent: string;
  ground: string;
}

/** One shared material per surface role, plus the derived tint tables the
 *  instanced props consume. */
export interface RoomPropMaterials {
  /** Light timber — shelf boards, desk tops. */
  woodTop: THREE.MeshStandardMaterial;
  /** Mid timber — frames, seats, legs. */
  woodBase: THREE.MeshStandardMaterial;
  /** Dark stained timber — plinths, backs, trim. */
  woodDark: THREE.MeshStandardMaterial;
  /** Pale cloth — cushions, chair pads. */
  fabricLight: THREE.MeshStandardMaterial;
  /** Mid cloth — upholstery bodies. */
  fabricBase: THREE.MeshStandardMaterial;
  /** Deep cloth — aprons, rug fields, pillow tones. */
  fabricDark: THREE.MeshStandardMaterial;
  /** Warm paper — lampshades, book pages. */
  paper: THREE.MeshStandardMaterial;
  /** Muted clay — pots, cups, vases (accent quieted toward plaster). */
  ceramic: THREE.MeshStandardMaterial;
  /** Dark metal — lamp stems, hardware. */
  metal: THREE.MeshStandardMaterial;
  /** Foliage — the canopy color, leaves tint themselves per instance. */
  leaf: THREE.MeshStandardMaterial;
  /** Potting soil. */
  soil: THREE.MeshStandardMaterial;
  /** Rug field + border, from the fabric role (never the raw accent). */
  rug: THREE.MeshStandardMaterial;
  rugEdge: THREE.MeshStandardMaterial;
  /** Lamp shade — paper with a QUIET emissive (the fixture's point light
   *  owns the actual glow; the shade must not bloom). */
  shade: THREE.MeshStandardMaterial;
  /** Throw-pillow tie — accent muted into the cloth family. */
  pillow: THREE.MeshStandardMaterial;
  /** Muted book spines — low-saturation, luminance-varied, palette-derived. */
  book: THREE.MeshStandardMaterial;
  bookColors: readonly THREE.Color[];
  /** TV screen — low brightness, low saturation, never cyan. */
  screen: THREE.MeshStandardMaterial;
  /** Shared ground-hugging contact shadow (radial alpha, dark, matte). */
  contact: THREE.MeshBasicMaterial;
}

/** Peak opacity of the furniture contact shadow — a grounding shade, not a
 *  glow (papers use 0.5 tight at the sheet's edge; furniture sits wider
 *  and softer). */
export const CONTACT_SHADOW_OPACITY = 0.3;
/** The contact plane's lift above the placement's terrain point: above the
 *  parquet (+0.006), below the accent rug's top (+0.04) — the same floor
 *  stack discipline as room-papers' SHEET_LIFT. */
export const CONTACT_SHADOW_LIFT = 0.009;
/** One wood-grain period in meters on UV-scaled parts. */
const WOOD_GRAIN_METERS = 0.4;

/* ------------------------------------------------------------------ */
/* Material factory                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the room's shared role materials from the (already theme-resolved)
 * scenario palette. Called once per SpaceScene mount; the result is disposed
 * on unmount — textures are shared app-lifetime singletons and survive.
 */
export function createRoomPropMaterials(
  palette: RoomPropPalette,
  canopyColor: THREE.Color,
): RoomPropMaterials {
  const wood = new THREE.Color(palette.wood);
  const fabric = new THREE.Color(palette.fabric);
  const wall = new THREE.Color(palette.wall);
  const accent = new THREE.Color(palette.accent);
  const ground = new THREE.Color(palette.ground);

  const woodMaps = sharedWoodTextures();
  const grunge = sharedGrungeRoughnessMap();

  const standard = (
    color: THREE.Color,
    roughness: number,
    extra: Partial<THREE.MeshStandardMaterialParameters> = {},
  ): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: 0,
      flatShading: true,
      ...extra,
    });

  // Wood roles sample the shared grain; the palette stays the average
  // (surface.ts's ALBEDO COMPENSATION discipline).
  const woodMaterial = (color: THREE.Color, roughness: number): THREE.MeshStandardMaterial =>
    standard(color.clone().multiplyScalar(1 / WOOD_ALBEDO_MEAN), roughness, {
      map: woodMaps.albedo,
      roughnessMap: woodMaps.roughness,
    });
  // Cloth/paper/clay roles wear the shared mottled roughness so matte
  // surfaces do not read as flat vector color.
  const matte = (
    color: THREE.Color,
    roughness: number,
    extra: Partial<THREE.MeshStandardMaterialParameters> = {},
  ): THREE.MeshStandardMaterial =>
    standard(color, roughness, { roughnessMap: grunge, ...extra });

  const paperColor = wall.clone().lerp(new THREE.Color("#ffffff"), 0.55);
  const ceramicColor = accent.clone().lerp(wall, 0.62);
  const metalColor = wood.clone().multiplyScalar(0.42).lerp(wall, 0.18);
  const soilColor = wood.clone().multiplyScalar(0.4);
  const rugColor = fabric.clone().multiplyScalar(0.86).lerp(accent, 0.12);
  const pillowColor = accent.clone().lerp(fabric, 0.5).offsetHSL(0, -0.12, 0.02);
  const shadeColor = paperColor.clone().offsetHSL(0.02, 0.04, -0.03);
  // The TV screen: the wall's own hue dropped to a dim slate — low
  // brightness AND low saturation, the anti-cyan rule.
  const screenColor = wall.clone().multiplyScalar(0.3).lerp(new THREE.Color("#46545a"), 0.4);

  // Muted spine palette: every entry derived from a palette role, then
  // desaturated/lightness-jittered so a shelf reads as paper/wood/cloth
  // rhythm, never as color bands.
  const bookColors: readonly THREE.Color[] = [
    fabric.clone().multiplyScalar(0.72),
    wood.clone().multiplyScalar(0.82).offsetHSL(0.01, -0.04, -0.03),
    wood.clone().multiplyScalar(0.58),
    paperColor.clone().multiplyScalar(0.86),
    ceramicColor.clone().offsetHSL(0, -0.08, -0.02),
    accent.clone().lerp(fabric, 0.55).offsetHSL(0, -0.18, -0.04),
    wall.clone().multiplyScalar(0.7),
    ground.clone().multiplyScalar(0.82),
  ];

  return {
    woodTop: woodMaterial(wood.clone().multiplyScalar(1.07), 0.68),
    woodBase: woodMaterial(wood, 0.74),
    woodDark: woodMaterial(wood.clone().multiplyScalar(0.6), 0.8),
    fabricLight: matte(fabric.clone().multiplyScalar(1.09), 0.95),
    fabricBase: matte(fabric, 0.95),
    fabricDark: matte(fabric.clone().multiplyScalar(0.76), 0.98),
    paper: matte(paperColor, 0.92),
    ceramic: matte(ceramicColor, 0.82),
    metal: standard(metalColor, 0.5, { metalness: 0.55 }),
    leaf: standard(canopyColor.clone(), 0.9),
    soil: matte(soilColor, 1),
    rug: matte(rugColor, 0.99),
    rugEdge: matte(rugColor.clone().multiplyScalar(0.82), 0.99),
    shade: matte(shadeColor, 0.9, {
      emissive: shadeColor,
      emissiveIntensity: 0.3,
    }),
    pillow: matte(pillowColor, 0.95),
    // Books: the material stays WHITE — the instanced spines carry their
    // palette-derived color through instanceColor, and any material tint
    // would multiply (double-darken) it.
    book: standard(new THREE.Color("#ffffff"), 0.9, { roughnessMap: grunge }),
    bookColors,
    screen: standard(screenColor, 0.55, {
      emissive: screenColor,
      emissiveIntensity: 0.22,
    }),
    contact: new THREE.MeshBasicMaterial({
      map: sharedRadialGlowTexture(),
      color: new THREE.Color("#0b0906"),
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      depthWrite: false,
    }),
  };
}

function disposeRoomPropMaterials(mats: RoomPropMaterials): void {
  for (const value of Object.values(mats)) {
    if (value instanceof THREE.Material) value.dispose();
    // bookColors are THREE.Color — nothing to dispose.
  }
}

/**
 * One shared role-material set per SpaceScene mount: created with useMemo,
 * disposed on unmount. The shared TEXTURES are app-lifetime and untouched.
 */
export function useRoomPropMaterials(
  palette: RoomPropPalette,
  canopyColor: THREE.Color,
): RoomPropMaterials {
  const mats = useMemo(
    () => createRoomPropMaterials(palette, canopyColor),
    // The palette object identity changes with theme/night; colors inside
    // are strings, so a changed reference always means changed colors.
    [palette, canopyColor],
  );
  useEffect(() => () => disposeRoomPropMaterials(mats), [mats]);
  return mats;
}

/* ------------------------------------------------------------------ */
/* UV-scaled grain geometry helpers                                    */
/* ------------------------------------------------------------------ */

/**
 * Scale a BoxGeometry's per-face UVs so one wood-grain period spans
 * WOOD_GRAIN_METERS of real size on every face (box UVs are laid out face
 * by face: +x, -x, +y, -y, +z, -z, four vertices each, spanning 0..1).
 * Without this the shared repeat-1 texture stretches one grain across a
 * whole bookshelf side and squeezes 34 stripes into a 5 cm shelf board.
 */
function scaleBoxUv(
  geometry: THREE.BoxGeometry,
  w: number,
  h: number,
  d: number,
  grain: number,
): void {
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const faceDims: readonly (readonly [number, number])[] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  faceDims.forEach(([du, dv], face) => {
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      uv.setXY(i, uv.getX(i) * (du / grain), uv.getY(i) * (dv / grain));
    }
  });
  uv.needsUpdate = true;
}

/** A wood-part box with physically scaled grain UVs, disposed on unmount. */
function GrainBox({
  size,
  material,
  position,
  rotation,
}: {
  size: readonly [number, number, number];
  material: THREE.MeshStandardMaterial;
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
}): JSX.Element {
  const [w, h, d] = size;
  const geometry = useMemo(() => {
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUv(g, w, h, d, WOOD_GRAIN_METERS);
    return g;
  }, [w, h, d]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} material={material} position={position} rotation={rotation} />
  );
}

/* ------------------------------------------------------------------ */
/* Static instancing — books & leaves (mount-time fills only)          */
/* ------------------------------------------------------------------ */

/** One box instance in an InstancedBoxes fill. */
export interface BoxInstance {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotY: number;
  rotZ: number;
  colorIndex: number;
}

/**
 * A static instancedMesh of unit boxes: matrices and per-instance colors
 * are written once in a layout effect and never touched again (the Ducks
 * discipline, minus the per-frame motion). Meshes are tagged
 * userData.noCastShadow — dozens of book/leaf casters would only thicken
 * the shadow map's noise on the shelf they sit in. An EMPTY spec list
 * renders nothing at all (no mesh is created); the hooks above the early
 * return still run unconditionally, so spec changes never reorder hook
 * calls.
 */
function InstancedBoxes({
  specs,
  colors,
  material,
}: {
  specs: readonly BoxInstance[];
  colors: readonly THREE.Color[];
  material: THREE.MeshStandardMaterial;
}): JSX.Element | null {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = specs.length;
  useLayoutEffect(() => {
    const mesh = ref.current;
    // Empty shelves are legal (an empty InstancedBoxes renders nothing);
    // there is simply no mesh to fill.
    if (!mesh || count === 0) return;
    specs.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rotY, s.rotZ);
      dummy.scale.set(s.sx, s.sy, s.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, colors[s.colorIndex % colors.length]);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [specs, colors, dummy, count]);
  // Hooks above ran unconditionally; an empty spec list produces NO mesh
  // (the old Math.max(1, …) guard rendered a stray unit box at the
  // shelf's origin).
  if (count === 0) return null;
  return (
    <instancedMesh
      key={count}
      ref={ref}
      args={[undefined, undefined, count]}
      material={material}
      frustumCulled={false}
      userData={{ noCastShadow: true }}
      receiveShadow
    >
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
}

/**
 * Deterministic per-book layout for one shelf row: variable widths and
 * heights, occasional gaps, an occasional leaning last book — the authored
 * shelf rhythm that replaced the three-color row bands. Books sit on the
 * baseline y = 0 and the run is centered on x = 0. Pure: same seed, same
 * row, on any machine.
 */
export function layoutBookRow(
  seedKey: string,
  width: number,
  height: number,
  depth: number,
): BoxInstance[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, seedKey, "props"));
  const specs: BoxInstance[] = [];
  const pad = Math.min(0.02, width * 0.03);
  let cursor = pad;
  const usable = width - pad * 2;
  let spent = 0;
  // First pass draws widths/gaps; the run is re-centered afterwards.
  const pending: { w: number; h: number; lean: number; gapAfter: number }[] = [];
  while (spent < usable - 0.024) {
    const w = 0.024 + rng() * 0.03;
    const h = height * (0.72 + rng() * 0.24);
    const lean = rng() < 0.08 ? -0.1 - rng() * 0.08 : 0;
    pending.push({ w, h, lean, gapAfter: rng() < 0.1 ? 0.008 + rng() * 0.02 : 0 });
    spent += w;
    if (spent >= usable - 0.024) break;
    spent += pending[pending.length - 1].gapAfter;
  }
  const total = pending.reduce((sum, b) => sum + b.w + b.gapAfter, 0);
  for (const b of pending) {
    specs.push({
      x: cursor + b.w / 2 - total / 2,
      y: b.h / 2,
      z: 0,
      sx: b.w,
      sy: b.h,
      sz: depth * (0.9 + rng() * 0.08),
      rotY: 0,
      rotZ: b.lean,
      colorIndex: Math.floor(rng() * 8),
    });
    cursor += b.w + b.gapAfter;
  }
  return specs;
}

/** One row of instanced book spines (baseline origin, centered). */
export function BookSpines({
  seedKey,
  width,
  height,
  depth,
  materials,
}: {
  seedKey: string;
  width: number;
  height: number;
  depth: number;
  materials: RoomPropMaterials;
}): JSX.Element {
  const specs = useMemo(
    () => layoutBookRow(seedKey, width, height, depth),
    [seedKey, width, height, depth],
  );
  return (
    <InstancedBoxes specs={specs} colors={materials.bookColors} material={materials.book} />
  );
}

/* ------------------------------------------------------------------ */
/* Contact shadow                                                      */
/* ------------------------------------------------------------------ */

/**
 * The furniture contact shadow: the shared radial-alpha texture drawn dark
 * and matte, hugging the floor under the piece — room-papers' grounding
 * idiom (tight, dark, a shade not a glow), widened for a sofa's footprint.
 * Never a light source: meshBasic, depthWrite off, no emissive.
 */
export function ContactShadowPlane({
  materials,
  width,
  depth,
}: {
  materials: RoomPropMaterials;
  width: number;
  depth: number;
}): JSX.Element {
  return (
    <mesh
      position={[0, CONTACT_SHADOW_LIFT, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      material={materials.contact}
      userData={{ noCastShadow: true }}
    >
      <planeGeometry args={[width, depth]} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */
/* Furniture — the polished high-frequency props                       */
/* ------------------------------------------------------------------ */

/**
 * Stable identity → seed-key fragment for one prop instance. The scene
 * passes the recipe's skin-stripped room id plus the kit piece index, so two
 * bookshelves in the same room (or two plants) lay out different books/
 * leaves, and revisiting a room rebuilds the identical prop. The defaults
 * keep the old no-identity debug-gallery calls stable.
 */
export function propDetailKey(
  kind: string,
  roomId: string,
  instanceId: string | number,
): string {
  // JSON-array encoding: roomId/instanceId may themselves contain ":" (the
  // kit path builds instanceId as kitId:kitIndex:index), so a colon-joined
  // string could collide two distinct identities; an array cannot.
  return JSON.stringify([kind, roomId, String(instanceId)]);
}

/**
 * Sofa: plinth + two seat cushions, a raked backrest, wrap arms, two throw
 * pillows, short wood legs — soft low-poly upholstery in the cloth roles,
 * no single accent slab.
 */
export function SofaProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <ContactShadowPlane materials={mats} width={2.15} depth={1.05} />
      {([
        [-0.8, -0.3],
        [0.8, -0.3],
        [-0.8, 0.3],
        [0.8, 0.3],
      ] as const).map(([x, z]) => (
        <mesh
          key={`${x}${z}`}
          position={[x, 0.06, z]}
          material={mats.woodDark}
          userData={{ noCastShadow: true }}
        >
          <boxGeometry args={[0.07, 0.12, 0.07]} />
        </mesh>
      ))}
      <mesh position={[0, 0.22, 0]} material={mats.fabricDark}>
        <boxGeometry args={[1.9, 0.24, 0.85]} />
      </mesh>
      {[-0.46, 0.46].map((x) => (
        <mesh key={x} position={[x, 0.4, 0.05]} material={mats.fabricLight}>
          <boxGeometry args={[0.86, 0.16, 0.72]} />
        </mesh>
      ))}
      <mesh position={[0, 0.66, -0.32]} rotation={[-0.1, 0, 0]} material={mats.fabricBase}>
        <boxGeometry args={[1.9, 0.58, 0.2]} />
      </mesh>
      {[-0.86, 0.86].map((x) => (
        <mesh key={x} position={[x, 0.42, 0]} material={mats.fabricBase}>
          <boxGeometry args={[0.18, 0.44, 0.8]} />
        </mesh>
      ))}
      {([
        [-0.5, 0.52, -0.16, 0.14],
        [0.48, 0.5, -0.18, -0.12],
      ] as const).map(([x, y, z, lean], i) => (
        <mesh
          key={i}
          position={[x, y, z]}
          rotation={[0.12, i === 0 ? 0.2 : -0.24, lean]}
          material={mats.pillow}
          userData={{ noCastShadow: true }}
        >
          <boxGeometry args={[0.34, 0.32, 0.12]} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Bookshelf: plinth, sides, back, top and shelf boards in the wood roles,
 * and PER-BOOK instanced rows — variable width/height, muted palette-
 * derived spines — replacing the old three-color row bands. Overall
 * dimensions come from the shared BOOKSHELF_DIMENSIONS (kits.ts's
 * bookshelf-run kit spaces its three cases by BOOKSHELF_RUN_SPACING, and
 * the shelf wall bays these same numbers); each row's seedKey carries the
 * instance identity so two shelves never share one book layout.
 */
export function BookshelfProp({
  mats,
  roomId = "room-props",
  instanceId = 0,
}: {
  mats: RoomPropMaterials;
  roomId?: string;
  instanceId?: string | number;
}): JSX.Element {
  const { width, depth, height } = BOOKSHELF_DIMENSIONS;
  const shelves = [0.5, 1.1, 1.7] as const;
  return (
    <group>
      <ContactShadowPlane materials={mats} width={width + 0.16} depth={depth + 0.16} />
      <GrainBox size={[width, 0.1, depth]} position={[0, 0.05, 0]} material={mats.woodDark} />
      {[-0.85, 0.85].map((x) => (
        <GrainBox key={x} size={[0.07, height, 0.42]} position={[x, height / 2, 0]} material={mats.woodBase} />
      ))}
      <GrainBox size={[width - 0.07, height, 0.05]} position={[0, height / 2, -depth / 2 + 0.035]} material={mats.woodDark} />
      <GrainBox size={[width, 0.06, depth]} position={[0, height - 0.03, 0]} material={mats.woodBase} />
      {shelves.map((y, i) => (
        <group key={y}>
          <GrainBox size={[1.7, 0.05, 0.4]} position={[0, y, 0]} material={mats.woodTop} />
          <group position={[0, y + 0.025, 0.02]}>
            <BookSpines
              seedKey={`${propDetailKey("bookshelf", roomId, instanceId)}:row:${i}`}
              width={1.58}
              height={Math.max(0.1, 0.31 - 0.04 * ((i + 1) % 2))}
              depth={0.3}
              materials={mats}
            />
          </group>
        </group>
      ))}
    </group>
  );
}

/**
 * Reading chair: four wood legs, a deep apron, a cushion seat, a raked
 * wrap back and two low arms — distinct from the plain side chair.
 */
export function ReadingChairProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <ContactShadowPlane materials={mats} width={0.95} depth={0.95} />
      {([
        [-0.26, -0.26],
        [0.26, -0.26],
        [-0.26, 0.26],
        [0.26, 0.26],
      ] as const).map(([x, z]) => (
        <mesh
          key={`${x}${z}`}
          position={[x, 0.11, z]}
          material={mats.woodDark}
          userData={{ noCastShadow: true }}
        >
          <boxGeometry args={[0.06, 0.22, 0.06]} />
        </mesh>
      ))}
      <mesh position={[0, 0.28, 0]} material={mats.fabricDark}>
        <boxGeometry args={[0.62, 0.14, 0.62]} />
      </mesh>
      <mesh position={[0, 0.42, 0]} material={mats.fabricLight}>
        <boxGeometry args={[0.68, 0.14, 0.68]} />
      </mesh>
      <mesh position={[0, 0.74, -0.29]} rotation={[-0.16, 0, 0]} material={mats.fabricBase}>
        <boxGeometry args={[0.68, 0.6, 0.13]} />
      </mesh>
      {[-0.33, 0.33].map((x) => (
        <mesh key={x} position={[x, 0.52, 0.02]} material={mats.fabricBase}>
          <boxGeometry args={[0.1, 0.26, 0.56]} />
        </mesh>
      ))}
    </group>
  );
}

/** Plain side chair — wood legs/seat/back, one thin cushion; deliberately
 *  sparer than the reading chair so the two never read as the same piece. */
export function ChairProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <ContactShadowPlane materials={mats} width={0.62} depth={0.62} />
      {([-0.18, 0.18] as const).flatMap((x) =>
        [-0.18, 0.18].map((z) => (
          <mesh
            key={`${x}${z}`}
            position={[x, 0.225, z]}
            material={mats.woodDark}
            userData={{ noCastShadow: true }}
          >
            <boxGeometry args={[0.05, 0.45, 0.05]} />
          </mesh>
        )),
      )}
      <GrainBox size={[0.44, 0.06, 0.44]} position={[0, 0.48, 0]} material={mats.woodBase} />
      <mesh position={[0, 0.53, 0]} material={mats.fabricLight} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.4, 0.05, 0.4]} />
      </mesh>
      <GrainBox size={[0.44, 0.54, 0.06]} position={[0, 0.78, -0.19]} material={mats.woodBase} />
    </group>
  );
}

/** Writing desk: grained top, four tapered-dark legs, a two-drawer block
 *  with small knobs — clear proportions, nothing floating. */
export function DeskProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <ContactShadowPlane materials={mats} width={1.7} depth={0.95} />
      {([
        [-0.66, -0.28],
        [0.66, -0.28],
        [-0.66, 0.28],
        [0.66, 0.28],
      ] as const).map(([x, z]) => (
        <mesh
          key={`${x}${z}`}
          position={[x, 0.37, z]}
          material={mats.woodDark}
          userData={{ noCastShadow: true }}
        >
          <boxGeometry args={[0.08, 0.74, 0.08]} />
        </mesh>
      ))}
      <GrainBox size={[1.5, 0.08, 0.75]} position={[0, 0.76, 0]} material={mats.woodTop} />
      <group position={[-0.42, 0, 0]}>
        <GrainBox size={[0.5, 0.5, 0.62]} position={[0, 0.49, 0]} material={mats.woodBase} />
        {[0.38, 0.6].map((y) => (
          <group key={y}>
            <mesh position={[0, y, 0.315]} material={mats.woodTop}>
              <boxGeometry args={[0.44, 0.16, 0.02]} />
            </mesh>
            <mesh position={[0, y, 0.33]} material={mats.ceramic} userData={{ noCastShadow: true }}>
              <sphereGeometry args={[0.02, 6, 5]} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

/** Round area rug: a border ring + a quieter field, cloth roles only. */
export function RugProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <mesh position={[0, 0.022, 0]} material={mats.rugEdge} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[1.5, 1.5, 0.04, 28]} />
      </mesh>
      <mesh position={[0, 0.03, 0]} material={mats.rug} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[1.28, 1.28, 0.035, 28]} />
      </mesh>
    </group>
  );
}

/** One plant leaf's placement: direction from the stem, height, size. */
export interface LeafSpec {
  dir: THREE.Vector3;
  h: number;
  dist: number;
  len: number;
  jitter: number;
}

/** Twelve leaves on four stems, generated once from a sub-seed keyed by
 *  `seedKey` — the default keeps the original single-plant layout; passing
 *  a prop instance identity (propDetailKey) gives every plant its own leaf
 *  directions/lengths/placements while staying reproducible on revisit.
 *  Pure: same seedKey, same specs, on any machine. */
export function layoutPlantLeaves(seedKey = "room-props:plant-leaves"): LeafSpec[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, seedKey, "props"));
  const specs: LeafSpec[] = [];
  for (let i = 0; i < 12; i++) {
    const yaw = i * 2.39996 + rng() * 0.5;
    const droop = 0.35 + rng() * 0.45;
    specs.push({
      dir: new THREE.Vector3(Math.cos(yaw), droop, Math.sin(yaw)).normalize(),
      h: 0.58 + (i % 4) * 0.11 + rng() * 0.06,
      dist: 0.1 + rng() * 0.16,
      len: 0.3 + rng() * 0.16,
      jitter: 0.9 + rng() * 0.2,
    });
  }
  return specs;
}

/**
 * Potted floor plant: a tapered ceramic pot (the accent quieted toward
 * plaster — never raw terracotta), a soil disc, thin wood stems, and
 * INSTANCED leaves — flattened ellipsoids pointing every direction, tinted
 * per instance around the canopy color. No ball-of-spheres crown.
 */
export function PlantProp({
  mats,
  roomId = "room-props",
  instanceId = 0,
}: {
  mats: RoomPropMaterials;
  roomId?: string;
  instanceId?: string | number;
}): JSX.Element {
  const leaves = useMemo(
    () => layoutPlantLeaves(propDetailKey("plant", roomId, instanceId)),
    [roomId, instanceId],
  );
  const leafRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const xAxis = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const count = leaves.length;
  useLayoutEffect(() => {
    const mesh = leafRef.current;
    if (!mesh) return;
    leaves.forEach((leaf, i) => {
      dummy.position
        .set(leaf.dir.x, 0, leaf.dir.z)
        .normalize()
        .multiplyScalar(leaf.dist)
        .setY(leaf.h);
      dummy.quaternion.setFromUnitVectors(xAxis, leaf.dir);
      dummy.scale.set(leaf.len, leaf.len * 0.28, leaf.len * 0.5);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // Per-instance tint around white: instanceColor multiplies the leaf
      // material's canopy color, so this only warms/cools each leaf.
      mesh.setColorAt(
        i,
        new THREE.Color(1, 1, 1).offsetHSL(0.015 * ((i % 3) - 1), -0.04, 0.05 * (leaf.jitter - 1)),
      );
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [leaves, dummy, xAxis]);
  return (
    <group>
      <ContactShadowPlane materials={mats} width={0.55} depth={0.55} />
      <mesh position={[0, 0.18, 0]} material={mats.ceramic}>
        <cylinderGeometry args={[0.17, 0.22, 0.36, 10]} />
      </mesh>
      <mesh position={[0, 0.37, 0]} material={mats.ceramic}>
        <cylinderGeometry args={[0.185, 0.17, 0.05, 10]} />
      </mesh>
      <mesh position={[0, 0.375, 0]} material={mats.soil} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[0.155, 0.155, 0.03, 10]} />
      </mesh>
      {(
        [
          [0, 0.72, 0, 0.06, 0],
          [0.1, 0.6, 0.08, -0.12, 0.4],
          [-0.11, 0.58, -0.06, 0.14, 2.1],
          [0.02, 0.64, -0.1, 0.1, 4.2],
        ] as const
      ).map(([x, y, z, tilt, yaw], i) => (
        <mesh
          key={i}
          position={[x / 2, y / 2 + 0.18, z / 2]}
          rotation={[tilt, yaw, tilt]}
          material={mats.woodDark}
          userData={{ noCastShadow: true }}
        >
          <cylinderGeometry args={[0.014, 0.02, y - 0.36, 5]} />
        </mesh>
      ))}
      <instancedMesh
        key={count}
        ref={leafRef}
        args={[undefined, undefined, count]}
        material={mats.leaf}
        frustumCulled={false}
        userData={{ noCastShadow: true }}
      >
        <sphereGeometry args={[0.5, 7, 5]} />
      </instancedMesh>
    </group>
  );
}

/** Desk lamp: weighted base, slim stem, paper shade with a quiet emissive
 *  (0.3 — the room's fixture lights own the pools, not the prop). */
export function DeskLampProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <mesh position={[0, 0.03, 0]} material={mats.metal}>
        <cylinderGeometry args={[0.15, 0.18, 0.06, 10]} />
      </mesh>
      <mesh position={[0, 0.3, 0]} material={mats.metal} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[0.022, 0.022, 0.55, 6]} />
      </mesh>
      <mesh position={[0, 0.6, 0]} rotation={[Math.PI, 0, 0]} material={mats.shade}>
        <coneGeometry args={[0.16, 0.22, 10]} />
      </mesh>
    </group>
  );
}

/** Floor lamp: disc foot, slim pole, paper shade — quiet emissive. */
export function FloorLampProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <ContactShadowPlane materials={mats} width={0.5} depth={0.5} />
      <mesh position={[0, 0.03, 0]} material={mats.metal}>
        <cylinderGeometry args={[0.2, 0.23, 0.06, 12]} />
      </mesh>
      <mesh position={[0, 0.92, 0]} material={mats.metal} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[0.025, 0.035, 1.8, 6]} />
      </mesh>
      <mesh position={[0, 1.9, 0]} material={mats.shade}>
        <coneGeometry args={[0.36, 0.44, 12]} />
      </mesh>
    </group>
  );
}

/**
 * A loose stack of books — the bookshelf's muted spine language off the
 * shelf: four stacked with jitter, one leaning against the pile. The
 * optional seedKey defaults to the original single-pile layout; pass a
 * prop instance identity (propDetailKey) to give each pile its own stack.
 */
export function layoutBookPile(seedKey = "room-props:bookpile"): BoxInstance[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, seedKey, "props"));
  const specs: BoxInstance[] = [];
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const w = 0.26 + rng() * 0.08;
    const h = 0.04 + rng() * 0.015;
    const d = 0.19 + rng() * 0.06;
    y += h / 2;
    specs.push({
      x: (rng() - 0.5) * 0.04,
      y,
      z: (rng() - 0.5) * 0.04,
      sx: w,
      sy: h,
      sz: d,
      rotY: (rng() - 0.5) * 0.5,
      rotZ: 0,
      colorIndex: Math.floor(rng() * 8),
    });
    y += h / 2;
  }
  specs.push({
    x: 0.24,
    y: 0.1,
    z: 0.02,
    sx: 0.05,
    sy: 0.22,
    sz: 0.18,
    rotY: 0.12,
    rotZ: -0.28,
    colorIndex: Math.floor(rng() * 8),
  });
  return specs;
}

export function BookpileProp({
  mats,
  roomId = "room-props",
  instanceId = 0,
}: {
  mats: RoomPropMaterials;
  roomId?: string;
  instanceId?: string | number;
}): JSX.Element {
  const specs = useMemo(
    () => layoutBookPile(propDetailKey("bookpile", roomId, instanceId)),
    [roomId, instanceId],
  );
  return (
    <group>
      <InstancedBoxes specs={specs} colors={mats.bookColors} material={mats.book} />
    </group>
  );
}

/**
 * Animated TV (moved out of space.tsx): the screen keeps the old slow
 * flicker/tint drift but at LOW brightness and LOW saturation — a TV left
 * on in a warm room, never the cyan panel of the baseline. The screen
 * material is a per-mount CLONE of the shared role (the clone carries the
 * room fade like any material; the shared original stays untouched), and
 * the stand/frame wear the shared wood/metal roles.
 */
export function TvProp({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  const screen = useMemo(() => mats.screen.clone(), [mats]);
  useEffect(() => () => screen.dispose(), [screen]);
  useGameFrame((_, { elapsed: t }) => {
    const n =
      Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.7) * Math.sin(t * 0.9 + 0.4);
    screen.emissiveIntensity = 0.22 + 0.1 * (0.5 + 0.5 * n);
    // The drift stays inside the screen's own muted family: a tiny hue
    // wander and lightness breathing around the base slate — the
    // anti-cyan rule, animated.
    screen.emissive
      .copy(mats.screen.emissive)
      .offsetHSL(Math.sin(t * 0.15) * 0.03, 0, 0.03 * n);
  });
  return (
    <group>
      <ContactShadowPlane materials={mats} width={1.5} depth={0.5} />
      <GrainBox size={[0.5, 0.4, 0.3]} position={[0, 0.2, 0]} material={mats.woodDark} />
      <mesh position={[0, 0.95, 0]} material={mats.metal}>
        <boxGeometry args={[1.25, 0.75, 0.08]} />
      </mesh>
      <mesh position={[0, 0.95, 0.045]} material={screen}>
        <boxGeometry args={[1.13, 0.63, 0.012]} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Activity traces — "someone was just here" dressing                  */
/* ------------------------------------------------------------------ */

/**
 * One sheet of paper on a trace pile — a thin paper box whose BASE sits at
 * `yBase` (never floating above the surface or the sheet beneath it).
 */
function TraceSheet({
  mats,
  width,
  depth,
  yBase,
  x,
  z,
  rotY,
}: {
  mats: RoomPropMaterials;
  width: number;
  depth: number;
  yBase: number;
  x: number;
  z: number;
  rotY: number;
}): JSX.Element {
  const t = 0.004;
  return (
    <mesh
      position={[x, yBase + t / 2, z]}
      rotation={[0, rotY, 0]}
      material={mats.paper}
      userData={{ noCastShadow: true }}
    >
      <boxGeometry args={[width, t, depth]} />
    </mesh>
  );
}

/** Writing: a few staggered draft sheets and a pen resting on the top one. */
function WritingTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      {ACTIVITY_SHEETS.writing.map((sheet, i) => <TraceSheet key={i} mats={mats} {...sheet} />)}
      <group position={[0.02, 0.018, 0.01]} rotation={[0, 0.5, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]} material={mats.metal} userData={{ noCastShadow: true }}>
          <cylinderGeometry args={[0.006, 0.006, 0.15, 6]} />
        </mesh>
      </group>
    </group>
  );
}

/** Research: an open reference book — two muted cover boards (the spine
 *  book instanceColor idiom) with two page slabs above, opened flat. */
const RESEARCH_COVERS: BoxInstance[] = [
  { x: -0.083, y: 0.004, z: 0, sx: 0.17, sy: 0.008, sz: 0.24, rotY: 0, rotZ: -0.03, colorIndex: 2 },
  { x: 0.083, y: 0.004, z: 0, sx: 0.17, sy: 0.008, sz: 0.24, rotY: 0, rotZ: 0.03, colorIndex: 5 },
];

function ResearchTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <InstancedBoxes specs={RESEARCH_COVERS} colors={mats.bookColors} material={mats.book} />
      <mesh position={[-0.078, 0.011, 0]} rotation={[0, 0, -0.02]} material={mats.paper} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.155, 0.006, 0.22]} />
      </mesh>
      <mesh position={[0.078, 0.011, 0]} rotation={[0, 0, 0.02]} material={mats.paper} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.155, 0.006, 0.22]} />
      </mesh>
    </group>
  );
}

/** Planning: a spread sheet of plans with two small cards laid on it. */
function PlanningTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      {ACTIVITY_SHEETS.planning.map((sheet, i) => <TraceSheet key={i} mats={mats} {...sheet} />)}
    </group>
  );
}

/** Making: a sketch sheet on the bench, a wooden ruler and two small tools. */
function MakingTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      {ACTIVITY_SHEETS.making.map((sheet, i) => <TraceSheet key={i} mats={mats} {...sheet} />)}
      <mesh position={[0, 0.002, 0.1]} rotation={[0, 0.04, 0]} material={mats.woodBase} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.2, 0.004, 0.022]} />
      </mesh>
      <mesh position={[0.04, 0.003, -0.1]} rotation={[0, -0.3, 0]} material={mats.metal} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.09, 0.006, 0.02]} />
      </mesh>
      <group position={[-0.04, 0.008, -0.1]} rotation={[0, 0.4, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]} material={mats.metal} userData={{ noCastShadow: true }}>
          <cylinderGeometry args={[0.008, 0.008, 0.05, 6]} />
        </mesh>
      </group>
    </group>
  );
}

/** Conversation: two cups set facing each other, a dark drink surface in
 *  each (the woodDark role reads as tea/coffee, never a glowing liquid). */
function ConversationTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  const cup = (x: number, z: number, yaw: number): JSX.Element => (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.035, 0]} material={mats.ceramic} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[ACTIVITY_CUP_RADIUS, 0.027, 0.07, 10]} />
      </mesh>
      <mesh position={[0, 0.066, 0]} material={mats.woodDark} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[0.028, 0.028, 0.004, 10]} />
      </mesh>
    </group>
  );
  return (
    <group>
      {ACTIVITY_CUPS.map((p, i) => <group key={i}>{cup(p.x, p.z, p.yaw)}</group>)}
    </group>
  );
}

/** Reflection: one closed diary beside the seat — cover boards in the
 *  muted spine palette around a paper page block. */
const REFLECTION_COVERS: BoxInstance[] = [
  { x: 0, y: 0.002, z: 0, sx: ACTIVITY_DIARY_SIZE.width, sy: 0.004, sz: ACTIVITY_DIARY_SIZE.depth, rotY: 0, rotZ: 0, colorIndex: 3 },
  { x: 0, y: 0.022, z: 0, sx: ACTIVITY_DIARY_SIZE.width, sy: 0.004, sz: ACTIVITY_DIARY_SIZE.depth, rotY: 0, rotZ: 0, colorIndex: 3 },
];

function ReflectionTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      <InstancedBoxes specs={REFLECTION_COVERS} colors={mats.bookColors} material={mats.book} />
      <mesh position={[0, 0.012, 0]} material={mats.paper} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.132, 0.016, 0.192]} />
      </mesh>
    </group>
  );
}

/**
 * Activity trace: the small dressing `activityTraceFor` (activity-traces.ts)
 * places ON a host furniture top — drafts on the desk, two cups on the
 * coffee table, a closed diary on the nightstand. The item's y is the
 * host's REAL working top (host.y + ACTIVITY_SURFACE_HEIGHTS·scale), so
 * this group's origin sits exactly on the support plane: every sheet,
 * cover and cup base is authored at y ≥ 0 inside the group and nothing
 * floats. Rendered with the shared role materials only (paper / book /
 * ceramic / metal / woodBase / woodDark) — no labels, no lights, no new
 * materials, no effect on the room fade or the instanced books/leaves.
 */
export function ActivityTraceProp({
  trace,
  mats,
}: {
  trace: ActivityTraceItem;
  mats: RoomPropMaterials;
}): JSX.Element {
  return (
    <group position={[trace.x, trace.y, trace.z]} rotation={[0, trace.rotY, 0]} scale={trace.scale}>
      {trace.kind === "writing" && <WritingTrace mats={mats} />}
      {trace.kind === "research" && <ResearchTrace mats={mats} />}
      {trace.kind === "planning" && <PlanningTrace mats={mats} />}
      {trace.kind === "making" && <MakingTrace mats={mats} />}
      {trace.kind === "conversation" && <ConversationTrace mats={mats} />}
      {trace.kind === "reflection" && <ReflectionTrace mats={mats} />}
    </group>
  );
}
