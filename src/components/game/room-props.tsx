"use client";

/**
 * Room props — the polished furniture/material vocabulary for interior
 * rooms (2026-10-25 art overhaul: matte palette-derived standard materials,
 * soft low-poly upholstery in quiet proportions, grouped book clusters,
 * contact shadows, no hot spots — selective meaningful details, not
 * high-frequency realism).
 *
 * One SpaceScene mount calls useRoomPropMaterials ONCE and passes the set
 * through MotifProp/MotifGeometry and ShelfWallRun: every sofa/bookshelf/
 * desk of the room shares ONE material per role (wood top/base/dark, fabric
 * light/base/dark, paper, ceramic, metal, leaf, rug, contact). Material
 * sharing is a GC discipline — it does not reduce draw calls — and
 * it composes with the room fade: the fade captures materials through the
 * AUTHORED_MATERIAL_STATE WeakMap, so one shared instance is captured and
 * crossfaded exactly once no matter how many meshes reference it. Role
 * materials are disposed on unmount; the one texture they still sample
 * (the radial contact-shadow glow) is an app-lifetime shared singleton
 * and is NEVER disposed here.
 *
 * All colors derive from the scenario palette (scenario-art.ts) — no hard
 * coded dark browns, vivid spines, terracotta pots or cyan TV screens.
 * The materials are deliberately PLAIN: matte MeshStandardMaterial, metalness
 * 0, roughness ~0.9–1, no albedo/roughness maps — the long quiet grain of
 * the reference study comes from geometry and light, not texture noise.
 *
 * Books and plant leaves are STATIC InstancedMesh fills (the Ducks matrix
 * discipline): matrices/colors are written once in a mount/layout effect,
 * never per frame. Only the TV tint uses the pause-aware game clock.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type JSX } from "react";
import * as THREE from "three";
import { useGameFrame } from "./use-game-frame";
import { sharedRadialGlowTexture } from "@/lib/game/materials";
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
  /** Warm paper — lampshades, book pages, draft sheets. */
  paper: THREE.MeshStandardMaterial;
  /** Muted clay — pots, cups, vases (accent quieted toward plaster). */
  ceramic: THREE.MeshStandardMaterial;
  /** Quiet patinated hardware — lamp stems, knobs; lightened toward the
   *  wall family and fully matte (metalness 0), never polished metal. */
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
 *  and softer). 0.18 since the 2026-10-25 art overhaul (was 0.3): a
 *  grounding shade, never a dirty smudge. */
export const CONTACT_SHADOW_OPACITY = 0.18;
/** The contact plane's lift above the placement's terrain point: above the
 *  parquet (+0.006), below the accent rug's top (+0.04) — the same floor
 *  stack discipline as room-papers' SHEET_LIFT. */
export const CONTACT_SHADOW_LIFT = 0.009;

/* ------------------------------------------------------------------ */
/* Material factory                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the room's shared role materials from the (already theme-resolved)
 * scenario palette. Called once per SpaceScene mount; the result is disposed
 * on unmount — the shared contact-shadow texture is an app-lifetime
 * singleton and survives.
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

  // Every role is a plain matte standard material: metalness 0, roughness
  // ~0.9–1, no maps. The 2026-10-25 art overhaul dropped the wood-grain
  // and grunge texture maps — the long quiet read comes from the palette
  // and the lighting, not surface noise.
  const standard = (
    color: THREE.Color,
    roughness: number,
    extra: Partial<THREE.MeshStandardMaterialParameters> = {},
  ): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: 0,
      ...extra,
    });

  const paperColor = wall.clone().lerp(new THREE.Color("#ffffff"), 0.55);
  const ceramicColor = accent.clone().lerp(wall, 0.62);
  // Hardware keeps its recognizable silhouette but joins the pale wood /
  // plaster family instead of multiplying down into dark brown or gray.
  const metalColor = wood.clone().lerp(wall, 0.6);
  // Soil is the ground role dimmed only as far as a dry potting mix needs.
  const soilColor = ground.clone().multiplyScalar(0.72);
  const rugColor = fabric.clone().lerp(wall, 0.32);
  const pillowColor = accent.clone().lerp(fabric, 0.5).offsetHSL(0, -0.12, 0.02);
  const shadeColor = paperColor.clone().lerp(wood, 0.45);
  // The TV screen: the wall's own hue dropped to a dim slate — low
  // brightness AND low saturation, the anti-cyan rule.
  const screenColor = wall.clone().multiplyScalar(0.3).lerp(new THREE.Color("#46545a"), 0.4);

  // Muted spine palette: every entry derived from a palette role, then
  // desaturated/lightness-jittered so a shelf reads as paper/wood/cloth
  // rhythm, never as color bands. The multipliers stay shallow (the 2026-
  // 10-25 overhaul dropped the deep 0.58/0.72 darkening) — muted but
  // never muddy.
  const bookColors: readonly THREE.Color[] = [
    fabric.clone().multiplyScalar(0.85),
    wood.clone().multiplyScalar(0.9).offsetHSL(0.01, -0.04, -0.03),
    wood.clone().multiplyScalar(0.72),
    paperColor.clone().multiplyScalar(0.92),
    ceramicColor.clone().offsetHSL(0, -0.08, -0.02),
    accent.clone().lerp(fabric, 0.55).offsetHSL(0, -0.18, -0.04),
    wall.clone().multiplyScalar(0.8),
    ground.clone().multiplyScalar(0.88),
  ];

  return {
    // Close pale roles separate the timber and cloth faces without a dark
    // stained edge. The rug's border warms toward wood instead of forming
    // a conspicuous dark ring.
    woodTop: standard(wood.clone().lerp(new THREE.Color("#ffffff"), 0.08), 0.92),
    woodBase: standard(wood, 0.95),
    woodDark: standard(wood.clone().multiplyScalar(0.9).lerp(wall, 0.18), 0.96),
    fabricLight: standard(fabric.clone().multiplyScalar(1.09), 0.95),
    fabricBase: standard(fabric, 0.95),
    fabricDark: standard(fabric.clone().multiplyScalar(0.86), 0.98),
    paper: standard(paperColor, 0.92),
    ceramic: standard(ceramicColor, 0.88),
    metal: standard(metalColor, 0.9),
    leaf: standard(canopyColor.clone(), 0.9),
    soil: standard(soilColor, 1),
    rug: standard(rugColor, 0.99),
    rugEdge: standard(rugColor.clone().lerp(wood, 0.3), 0.99),
    shade: standard(shadeColor, 0.9, {
      emissive: shadeColor,
      emissiveIntensity: 0.06,
    }),
    pillow: standard(pillowColor, 0.95),
    // Books: the material stays WHITE — the instanced spines carry their
    // palette-derived color through instanceColor, and any material tint
    // would multiply (double-darken) it.
    book: standard(new THREE.Color("#ffffff"), 0.92),
    bookColors,
    screen: standard(screenColor, 0.55, {
      emissive: screenColor,
      emissiveIntensity: 0.22,
    }),
    contact: new THREE.MeshBasicMaterial({
      map: sharedRadialGlowTexture(),
      color: new THREE.Color("#3e4634"),
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
/* Wood-box geometry helper                                            */
/* ------------------------------------------------------------------ */

/** A plain wood-part box. The 2026-10-25 art overhaul dropped the UV-scaled
 *  wood-grain texture, so a wood part is simply a box mesh in one of the
 *  shared wood roles — the JSX boxGeometry is managed and disposed by the
 *  renderer, exactly like every other inline geometry in this module. */
function WoodBox({
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
  return (
    <mesh material={material} position={position} rotation={rotation}>
      <boxGeometry args={[w, h, d]} />
    </mesh>
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
 * Deterministic per-book layout for one shelf row: SEEDED GROUPED CLUSTERS
 * — a few upright books standing together (3–5 per group), a real empty
 * gap between the groups, wider spines than the old dense row, variable
 * heights, an occasional gently leaning last book. The 2026-10-25 art
 * overhaul replaced the old near-solid fill (24–34 thin spines) with this
 * authored rhythm: an ordinary 1.4–1.58 m row carries ≤ 10 books total, so
 * the shelf reads as paper, wood and air — selective meaningful details,
 * not high-frequency realism. Books sit on the baseline y = 0 and the run
 * is centered on x = 0 (first left edge ≈ −last right edge, exactly, by
 * construction: the run's total is book widths plus INTERNAL gaps only, and
 * the last group's trailing gap never enters the total). Pure: same seed,
 * same row, on any machine.
 */
export function layoutBookRow(
  seedKey: string,
  width: number,
  height: number,
  depth: number,
): BoxInstance[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, seedKey, "props"));
  if (width < 0.2) return [];
  const specs: BoxInstance[] = [];
  const pad = Math.min(0.03, width * 0.04);
  const usable = width - pad * 2;
  // The book budget shrinks with the shelf; an ordinary 1.4–1.58 m row
  // caps at 10, a narrow remnant segment still gets a small cluster.
  const maxBooks = Math.max(3, Math.min(10, Math.round(width / 0.14)));
  interface PendingBook {
    w: number;
    h: number;
    lean: number;
  }
  const groups: { books: PendingBook[]; gapAfter: number }[] = [];
  let spent = 0;
  let totalBooks = 0;
  // First pass draws the groups; the run is re-centered afterwards. The
  // gapAfter drawn after each group is the gap BEFORE the next group (an
  // internal gap); the last group's trailing draw is discarded so no
  // trailing empty span enters the centering total.
  for (let guard = 0; guard < 32 && totalBooks < maxBooks; guard++) {
    const count = Math.min(3 + Math.floor(rng() * 3), maxBooks - totalBooks);
    const books: PendingBook[] = [];
    let groupWidth = 0;
    for (let i = 0; i < count; i++) {
      const w = 0.035 + rng() * 0.03;
      const h = height * (0.72 + rng() * 0.24);
      // A gentle lean, only on a group's last spine, occasionally.
      const lean =
        i === count - 1 && rng() < 0.22 ? -0.05 - rng() * 0.05 : 0;
      books.push({ w, h, lean });
      groupWidth += w;
    }
    if (spent + groupWidth > usable - 0.02) break;
    spent += groupWidth;
    totalBooks += count;
    groups.push({ books, gapAfter: 0.08 + rng() * 0.1 });
    if (spent >= usable - 0.06) break;
    spent += groups[groups.length - 1].gapAfter;
  }
  if (groups.length === 0) return [];
  // The last group's gapAfter is trailing air, not an internal gap — zero
  // it so the run total (book widths + internal gaps only) centers exactly.
  groups[groups.length - 1].gapAfter = 0;
  const total = groups.reduce(
    (sum, g) => sum + g.books.reduce((s, b) => s + b.w, 0) + g.gapAfter,
    0,
  );
  let cursor = -total / 2;
  for (const g of groups) {
    for (const b of g.books) {
      specs.push({
        x: cursor + b.w / 2,
        y: b.h / 2,
        z: 0,
        sx: b.w,
        sy: b.h,
        sz: depth * (0.9 + rng() * 0.08),
        rotY: 0,
        rotZ: b.lean,
        colorIndex: Math.floor(rng() * 8),
      });
      cursor += b.w;
    }
    cursor += g.gapAfter;
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
      <mesh position={[0, 0.63, -0.32]} rotation={[-0.1, 0, 0]} material={mats.fabricBase}>
        <boxGeometry args={[1.9, 0.46, 0.2]} />
      </mesh>
      {[-0.88, 0.88].map((x) => (
        <mesh key={x} position={[x, 0.42, 0]} material={mats.fabricBase}>
          <boxGeometry args={[0.14, 0.44, 0.8]} />
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
 * bookshelf-run kit spaces its two cases by BOOKSHELF_RUN_SPACING, and
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
      <WoodBox size={[width, 0.1, depth]} position={[0, 0.05, 0]} material={mats.woodDark} />
      {[-0.85, 0.85].map((x) => (
        <WoodBox key={x} size={[0.07, height, 0.42]} position={[x, height / 2, 0]} material={mats.woodBase} />
      ))}
      <WoodBox size={[width - 0.07, height, 0.05]} position={[0, height / 2, -depth / 2 + 0.035]} material={mats.woodDark} />
      <WoodBox size={[width, 0.06, depth]} position={[0, height - 0.03, 0]} material={mats.woodBase} />
      {shelves.map((y, i) => (
        <group key={y}>
          <WoodBox size={[1.7, 0.05, 0.4]} position={[0, y, 0]} material={mats.woodTop} />
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
      <mesh position={[0, 0.7, -0.29]} rotation={[-0.16, 0, 0]} material={mats.fabricBase}>
        <boxGeometry args={[0.68, 0.48, 0.13]} />
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
      <WoodBox size={[0.44, 0.06, 0.44]} position={[0, 0.48, 0]} material={mats.woodBase} />
      <mesh position={[0, 0.53, 0]} material={mats.fabricLight} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.4, 0.05, 0.4]} />
      </mesh>
      <WoodBox size={[0.44, 0.54, 0.06]} position={[0, 0.78, -0.19]} material={mats.woodBase} />
    </group>
  );
}

/** Writing desk: wood top, four tapered-dark legs, ONE shallow under-top
 *  drawer with a small knob — clear proportions and a real working top (the
 *  2026-10-25 art overhaul replaced the old half-metre drawer block), nothing
 *  floating. */
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
      <WoodBox size={[1.5, 0.08, 0.75]} position={[0, 0.76, 0]} material={mats.woodTop} />
      <group position={[-0.42, 0, 0]}>
        <WoodBox size={[0.5, 0.12, 0.58]} position={[0, 0.65, 0]} material={mats.woodBase} />
        <mesh position={[0, 0.65, 0.3]} material={mats.woodTop} userData={{ noCastShadow: true }}>
          <boxGeometry args={[0.44, 0.1, 0.02]} />
        </mesh>
        <mesh position={[0, 0.65, 0.325]} material={mats.ceramic} userData={{ noCastShadow: true }}>
          <sphereGeometry args={[0.02, 6, 5]} />
        </mesh>
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
 * INSTANCED leaves — smooth ellipsoid leaves (12×8 sphere segments since
 * the 2026-10-25 art overhaul, no faceted read) pointing every direction,
 * tinted per instance around the canopy color with only a quiet hue/light
 * variation. No ball-of-spheres crown.
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
      // material's canopy color, so this only warms/cools each leaf — a
      // quiet variation, never a variegated crown.
      mesh.setColorAt(
        i,
        new THREE.Color(1, 1, 1).offsetHSL(0.012 * ((i % 3) - 1), -0.03, 0.03 * (leaf.jitter - 1)),
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
        <sphereGeometry args={[0.5, 12, 8]} />
      </instancedMesh>
    </group>
  );
}

/** Desk lamp: weighted base, slim stem, paper shade with a quiet emissive
 *  (0.12 — the room's fixture lights own the pools, not the prop). */
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
      <WoodBox size={[0.5, 0.4, 0.3]} position={[0, 0.2, 0]} material={mats.woodDark} />
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

/** Writing: a few staggered draft sheets, a few quiet ink lines on the top
 *  draft, and a pen resting beside them. The ink lines ride ON the top
 *  sheet, well inside its footprint. */
function WritingTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      {ACTIVITY_SHEETS.writing.map((sheet, i) => <TraceSheet key={i} mats={mats} {...sheet} />)}
      {/* Quiet ink lines on the top draft (the third sheet, rotY .28) —
          woodDark at a hair's thickness reads as dried ink, nothing more. */}
      <group position={[0, 0.0128, -0.05]} rotation={[0, 0.28, 0]}>
        {[-0.09, -0.05, -0.01, 0.04].map((z, i) => (
          <mesh key={i} position={[i === 3 ? -0.02 : 0, 0, z]} material={mats.woodDark} userData={{ noCastShadow: true }}>
            <boxGeometry args={[i === 3 ? 0.07 : 0.12, 0.0012, 0.005]} />
          </mesh>
        ))}
      </group>
      <group position={[0.02, 0.018, 0.01]} rotation={[0, 0.5, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]} material={mats.metal} userData={{ noCastShadow: true }}>
          <cylinderGeometry args={[0.006, 0.006, 0.15, 6]} />
        </mesh>
      </group>
    </group>
  );
}

/** Research: an open reference book — two muted cover boards (the spine
 *  book instanceColor idiom) with two page slabs above, opened flat, each
 *  page carrying a few sparse printed lines. */
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
      {/* Sparse page lines — three quiet rows per page, inside the page
          slab's own footprint. */}
      {([-0.078, 0.078] as const).map((x) => (
        <group key={x} position={[x, 0.0142, 0]}>
          {[-0.06, -0.02, 0.02].map((z, i) => (
            <mesh key={i} position={[0, 0, z]} material={mats.woodDark} userData={{ noCastShadow: true }}>
              <boxGeometry args={[0.11, 0.0012, 0.004]} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** Planning: a spread sheet of plans with two small cards laid on it and
 *  a few quiet note lines pencilled across the plan. */
function PlanningTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      {ACTIVITY_SHEETS.planning.map((sheet, i) => <TraceSheet key={i} mats={mats} {...sheet} />)}
      {/* Note lines on the big plan sheet (rotY −.06), inside its area. */}
      <group position={[0, 0.0048, 0]} rotation={[0, -0.06, 0]}>
        {[-0.14, -0.09, -0.04, 0.05].map((z, i) => (
          <mesh key={i} position={[i === 3 ? -0.03 : 0, 0, z]} material={mats.woodDark} userData={{ noCastShadow: true }}>
            <boxGeometry args={[i === 3 ? 0.16 : 0.22, 0.0012, 0.005]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Making: a sketch sheet on the bench with a simple drawn mark, a wooden
 *  ruler and two small tools. */
function MakingTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  return (
    <group>
      {ACTIVITY_SHEETS.making.map((sheet, i) => <TraceSheet key={i} mats={mats} {...sheet} />)}
      {/* The drawn mark: two quiet strokes angled across the sketch sheet
          (rotY .1), well inside its footprint. */}
      <group position={[0, 0.0048, 0.01]} rotation={[0, 0.1, 0]}>
        <mesh position={[0, 0, -0.02]} rotation={[0, 0.5, 0]} material={mats.woodDark} userData={{ noCastShadow: true }}>
          <boxGeometry args={[0.13, 0.0012, 0.005]} />
        </mesh>
        <mesh position={[0.01, 0, 0.03]} rotation={[0, -0.35, 0]} material={mats.woodDark} userData={{ noCastShadow: true }}>
          <boxGeometry args={[0.09, 0.0012, 0.005]} />
        </mesh>
      </group>
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
 *  each (the woodDark role reads as tea/coffee, never a glowing liquid),
 *  and a subtle handle hugging each cup's side — kept inside the cup's
 *  own footprint radius, so the trace claims no extra table space. */
function ConversationTrace({ mats }: { mats: RoomPropMaterials }): JSX.Element {
  const cup = (x: number, z: number, yaw: number): JSX.Element => (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.035, 0]} material={mats.ceramic} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[ACTIVITY_CUP_RADIUS, 0.027, 0.07, 10]} />
      </mesh>
      <mesh position={[0, 0.066, 0]} material={mats.woodDark} userData={{ noCastShadow: true }}>
        <cylinderGeometry args={[0.028, 0.028, 0.004, 10]} />
      </mesh>
      <mesh
        position={[0.018, 0.035, 0]}
        rotation={[0, Math.PI / 2, 0]}
        material={mats.ceramic}
        userData={{ noCastShadow: true }}
      >
        <torusGeometry args={[0.011, 0.004, 6, 10]} />
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
 *  muted spine palette around a paper page block, with a restrained band
 *  across the top cover near the spine (an elastic closure, quiet). */
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
      {/* The closure band: a thin cloth strip on the top cover's spine
          edge, inside the diary's own silhouette. */}
      <mesh position={[0, 0.0245, -0.082]} material={mats.fabricDark} userData={{ noCastShadow: true }}>
        <boxGeometry args={[0.132, 0.003, 0.016]} />
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
 * ceramic / metal / woodBase / woodDark / fabricDark) — no labels, no
 * lights, no new materials, no effect on the room fade or the instanced
 * books/leaves.
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
