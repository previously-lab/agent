"use client";

/**
 * AnchorHologram — the §13.1 anchor in holographic form, shared by both
 * mount points (every room's doorway wall, the lobby's east wall).
 *
 * WHAT IT IS. The room's anchor is a MINIATURE OF THE LEFT BAND'S BRAID:
 * one bright blue core line (the room's own slice of the timeline) with a
 * few quiet grey threads wound around it — one per strand passing through
 * the slice, one per newer slice of the corridor window — braided through
 * a single knot at eye height while the core climbs on above the walls.
 * The geometry is `anchor-hologram-geometry.ts`, which is `winding.ts`'s
 * coaxial model standing up in the room; this file only bakes it into
 * instanced tubes and keeps it alive.
 *
 * COLOUR IS THE BAND'S COLOUR, NOT THE ROOM'S (reader decision): the
 * core wears the brand blue #0066ff — the same ink the band's core wears
 * while it is the answer, and the card view's theme colour — and every
 * outer thread wears a neutral grey, like the band's resting strands.
 * Nothing here follows `recipe.palette.accent`, so the hologram reads
 * identically under every world skin.
 *
 * DETERMINISM (A6). The baked bytes are a pure function of (strands,
 * neighborSlots) — slice and door data, never the clock, never a seed.
 * The live motions are the rigid self-spin (`rotation.y = t ·
 * HOLO_SPIN_SPEED`, frozen under prefers-reduced-motion), the breath on
 * the core's gain, and the scanline drift — all pure functions of the
 * clock, none feeding back into the geometry. On a cylinder the rigid
 * spin only re-deals which seat faces the viewer, and the per-instance
 * brightness was baked in the cable's own frame, so the bundle turns as
 * one physical object (threadline-scene's group-spin discipline).
 *
 * LIGHT, REALLY (reader decision). A hologram that glows but lights
 * nothing reads as a decal, so a POINT LIGHT rides the cable — brand
 * blue, restrained, hard cutoff (the lamp's ×propScale² convention,
 * compensated from the caller's group scale each frame so miniature and
 * colossal rooms keep a proportional glow). An additive light COLUMN
 * climbs the cable and an additive floor POOL spreads at its foot (both
 * the door-halo pattern: black-based texture + AdditiveBlending, so no
 * alpha ever gates coverage), and a very faint GHOST of the core draws
 * with depth testing off — through-wall presence at 5% strength, an
 * ambiance cue, never a quest marker.
 *
 * EVERYTHING ELSE IS THE OLD TERMINAL'S CONTRACT. Position and rotation
 * still come from `anchor.ts`'s resolver through the caller's group (the
 * footprint is smaller than the terminal's, so every cleared spot still
 * clears). Interaction is still the integrator's walk-up-and-Enter: the
 * proximity measure, `TERMINAL_DEPART.t0` stamp and the catalog jump all
 * live in game-canvas.tsx, untouched — this component only READS the
 * depart clock and swells, and keeps writing `TERMINAL_DEPART.intensity`
 * for the debug probes. Materials are owned here (created, animated,
 * disposed in this module); in rooms they mount under the room root, so
 * space.tsx's material capture carries them through the crossfade.
 *
 * THE LOBBY VARIANT rides the same component one size bigger (the
 * caller's group scale, LOBBY_TERMINAL_ANCHOR.scale): its strands are the
 * union of every strand threading the window, its neighbor count is the
 * window's slice count, `dimmed` follows the corridor's dissolve (light
 * included), and `overlay` floats the whole-window index as DOM beside
 * the column (§13: 文字走 DOM — the register board was never scene
 * geometry).
 */
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import {
  TERMINAL_BREATH_PERIOD_S,
  TERMINAL_DEPART,
  TERMINAL_FLARE_GAIN,
  TERMINAL_FLARE_MS,
  TERMINAL_PLINTH,
  TERMINAL_SCAN_DRIFT,
} from "./anchor";
import { RADIAL_SEGMENTS } from "@/lib/timeline3d/tube";
import {
  HOLO_BOTTOM,
  HOLO_BUNDLE_GLOW,
  HOLO_CORE_RADIUS,
  HOLO_NEIGHBOR_RADIUS,
  HOLO_SEGMENTS,
  HOLO_SPIN_SPEED,
  HOLO_STRAND_RADIUS,
  HOLO_TOP,
  holoCoreBake,
  holoThreadsFor,
  holoThreadBake,
  type HoloLineBake,
} from "./anchor-hologram-geometry";

/** The core's ink — the band's core blue (its `CORE_INK`), the card
 *  view's theme colour; the reader pinned it: core = #0066FF. */
const CORE_INK = "#0066ff";
/** The outer threads' ink — a neutral cool grey, the band's resting
 *  strand colour, light enough to read as a LINE in a dark room yet
 *  always dimmer than the core (which owns the only bloom). */
const BUNDLE_GREY = "#a8b3c4";
/** The core's gain range: base × breath just kisses the bloom threshold
 *  — a tight halo around the spine, never the fat ball that ate the
 *  braid; the real illumination is the point light's job. */
const CORE_GAIN_BASE = 0.85;
const CORE_GAIN_BREATH = 0.12;
/** The point light: brand blue, HALF the lamp's reach — a halo, not a
 *  work light. Intensity scales with the caller's group scale squared
 *  (the lamp's ×propScale² convention), distance linearly, so the glow
 *  stays proportional from miniature to colossal rooms. */
const LIGHT_INTENSITY = 3;
const LIGHT_DISTANCE = 6;
/** The ghost column's strength — 5% of the core's blue, visible only
 *  where geometry occludes the real line. */
const GHOST_GAIN = 0.05;
/** The scanline ripple count along the core's full height. */
const SCAN_LINES = 26;
/** The index plate's height beside the column (world meters at scale 1;
 *  the lobby's 1.5× group lands it at ~3.1 m). */
const OVERLAY_Y = 2.05;
/** How far the lobby's dissolve pulls the inks down (the corridor's
 *  rate, matching the old terminal's dim contract). */
const DIM_FADE = 0.88;

/**
 * prefers-reduced-motion, read straight off the media query: the spin
 * freezes (the shape stays), the breath and the light keep breathing —
 * luminance, not motion.
 */
const REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The core's scanline texture, generated in code (no assets): a
 * brightness ripple along the cylinder's height — pixels, not material
 * alpha — that the frame loop drifts slowly upward. Opaque RGB.
 */
function createScanTexture(): THREE.CanvasTexture {
  const w = 2;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      const ripple = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * SCAN_LINES);
      const band = Math.round((0.82 + 0.18 * ripple) * 255);
      ctx.fillStyle = `rgb(${band},${band},${band})`;
      ctx.fillRect(0, y, w, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** The light column's falloff: bright at the base, fading to nearly
 *  nothing by the crown — an RGB gradient (black adds nothing), the
 *  door-halo pattern. */
function createColumnTexture(): THREE.CanvasTexture {
  const w = 2;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let y = 0; y < h; y++) {
      const v = y / h; // 0 = bottom of the column
      const band = Math.round(0.3 * Math.pow(1 - v, 1.6) * 255);
      ctx.fillStyle = `rgb(${band},${band},${band})`;
      ctx.fillRect(0, h - 1 - y, w, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** The floor pool's radial falloff — same black-based additive pattern. */
function createPoolTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - half + 0.5, y - half + 0.5) / half;
        const band = Math.round(0.55 * Math.pow(Math.max(0, 1 - r), 2) * 255);
        ctx.fillStyle = `rgb(${band},${band},${band})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The direction a unit `CylinderGeometry` stands along before any
 *  rotation — orienting one onto a segment is one `setFromUnitVectors`. */
const CYLINDER_AXIS = new THREE.Vector3(0, 1, 0);
/** A segment with no direction collapses to zero size instead of taking
 *  an arbitrary axis. Shared, never written. */
const ZERO_SCALE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Bake one line into an InstancedMesh of unit cylinders — one instance
 *  per segment, placed and grey-inked exactly as the band's frame loop
 *  does, but ONCE: the matrices never change after this call. */
function buildLineMesh(
  bake: HoloLineBake,
  radius: number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, HOLO_SEGMENTS);
  const dir = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mid = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const p = bake.points;
  for (let i = 0; i < HOLO_SEGMENTS; i++) {
    const ax = p[i * 3];
    const ay = p[i * 3 + 1];
    const az = p[i * 3 + 2];
    const bx = p[i * 3 + 3];
    const by = p[i * 3 + 4];
    const bz = p[i * 3 + 5];
    dir.set(bx - ax, by - ay, bz - az);
    const length = dir.length();
    if (length < 1e-6) {
      mesh.setMatrixAt(i, ZERO_SCALE_MATRIX);
      continue;
    }
    dir.divideScalar(length);
    quat.setFromUnitVectors(CYLINDER_AXIS, dir);
    mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    scale.set(radius, length, radius);
    mesh.setMatrixAt(i, matrix.compose(mid, quat, scale));
    // The core carries its ink on the material (the band's note: seeding
    // instanceColor would square the colour); threads get grey instance
    // colours multiplied into the shared grey material.
    if (bake.kind !== "core") {
      mesh.setColorAt(i, color.setScalar(bake.brightness[i]));
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Instance matrices place the unit cylinder nowhere near the origin;
  // the default frustum test would cull the whole line.
  mesh.frustumCulled = false;
  if (bake.kind === "core") {
    // The spine stays legible through the bundle, as in the band.
    mesh.renderOrder = 2;
  }
  return mesh;
}

export function AnchorHologram({
  dimmed = false,
  strands = [],
  neighborSlots = 0,
  overlay,
}: {
  /** Lobby-only: lerp down with the corridor's dissolve (light
   *  included). */
  dimmed?: boolean;
  /** The strands passing through this slice (the room-door data lane) —
   *  one braid thread each. */
  strands?: readonly string[];
  /** How many newer slices this room's window provably holds — one
   *  context thread each. */
  neighborSlots?: number;
  /** DOM content floating beside the column (the lobby's window index);
   *  null = the abstract hologram. */
  overlay?: ReactNode;
}): JSX.Element {
  const coreInk = useMemo(() => new THREE.Color(CORE_INK), []);
  const greyInk = useMemo(() => new THREE.Color(BUNDLE_GREY), []);

  const unitCylinder = useMemo(
    () => new THREE.CylinderGeometry(1, 1, 1, RADIAL_SEGMENTS, 1, true),
    [],
  );
  const scanTexture = useMemo(() => createScanTexture(), []);
  const columnTexture = useMemo(() => createColumnTexture(), []);
  const poolTexture = useMemo(() => createPoolTexture(), []);
  const coreMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        map: scanTexture,
      }),
    [scanTexture],
  );
  const bundleMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: BUNDLE_GREY }),
    [],
  );
  const baseMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: TERMINAL_PLINTH,
        roughness: 0.9,
        metalness: 0,
        flatShading: true,
      }),
    [],
  );
  // The light column, floor pool and ghost all use the door-halo glow
  // pattern: a black-based texture + AdditiveBlending, so coverage is
  // never gated by alpha (black adds nothing). The scene alpha budget
  // stays untouched.
  const columnMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        map: columnTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [columnTexture],
  );
  const poolMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        map: poolTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [poolTexture],
  );
  const ghostMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  // The braid, baked once for this room's data. The thread set is a pure
  // function of (strands, neighborSlots); either changing re-bakes, but
  // the integrator freezes the door data per mount, so in practice this
  // is mount-only.
  // Separator for the thread key — unit separator via fromCharCode so it is never an invisible source byte (a bare concat collides ["a","bc"] === ["ab","c"]).
  const SET_KEY_SEP = String.fromCharCode(1);
  const threadKey = strands.join(SET_KEY_SEP) + SET_KEY_SEP + neighborSlots;
  const phase = useMemo(() => phaseFor(threadKey), [threadKey]);
  const lines = useMemo(() => {
    const bakes: { bake: HoloLineBake; radius: number }[] = [
      { bake: holoCoreBake(), radius: HOLO_CORE_RADIUS },
      ...holoThreadsFor(strands, neighborSlots).map((thread) => ({
        bake: holoThreadBake(thread),
        radius:
          thread.kind === "strand"
            ? HOLO_STRAND_RADIUS
            : HOLO_NEIGHBOR_RADIUS,
      })),
    ];
    return bakes.map(({ bake, radius }) =>
      buildLineMesh(bake, radius, unitCylinder, bake.kind === "core" ? coreMaterial : bundleMaterial),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey, unitCylinder, coreMaterial, bundleMaterial]);
  useEffect(
    () => () => {
      for (const line of lines) line.dispose();
    },
    [lines],
  );
  useEffect(
    () => () => {
      unitCylinder.dispose();
      scanTexture.dispose();
      columnTexture.dispose();
      poolTexture.dispose();
      coreMaterial.dispose();
      bundleMaterial.dispose();
      baseMaterial.dispose();
      columnMaterial.dispose();
      poolMaterial.dispose();
      ghostMaterial.dispose();
    },
    [
      unitCylinder,
      scanTexture,
      columnTexture,
      poolTexture,
      coreMaterial,
      bundleMaterial,
      baseMaterial,
      columnMaterial,
      poolMaterial,
      ghostMaterial,
    ],
  );

  const spinRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const dimKRef = useRef(0);
  // Scratch — the frame loop reuses these, never allocates.
  const worldScale = useRef(new THREE.Vector3());
  const coreColor = useRef(new THREE.Color());

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    // The one live MOTION: a rigid spin of the whole cable. Frozen
    // under prefers-reduced-motion — the shape stays, the turning
    // doesn't.
    if (spinRef.current && !REDUCED_MOTION) {
      spinRef.current.rotation.y = t * HOLO_SPIN_SPEED;
    }

    // The breath + the departure flare (the §13.2 屏幕亮起 beat, kept in
    // the game world): gain only, geometry untouched.
    const k = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / TERMINAL_BREATH_PERIOD_S + phase);
    let gain = CORE_GAIN_BASE + CORE_GAIN_BREATH * k;
    const depart = TERMINAL_DEPART.t0;
    if (depart >= 0) {
      const f = Math.min(1, (performance.now() - depart) / TERMINAL_FLARE_MS);
      gain *= 1 + TERMINAL_FLARE_GAIN * f * f;
    }
    TERMINAL_DEPART.intensity = gain;

    // Dim (lobby): follow the corridor's dissolve rate (≈6/s lerp).
    const dimK = (dimKRef.current +=
      (1 - Math.exp(-6 * Math.min(delta, 0.05))) * ((dimmed ? 1 : 0) - dimKRef.current));
    const dim = 1 - DIM_FADE * dimK;

    coreColor.current.copy(coreInk).multiplyScalar(gain * dim);
    coreMaterial.color.copy(coreColor.current);
    columnMaterial.color.copy(coreInk).multiplyScalar(0.9 * dim);
    poolMaterial.color.copy(coreInk).multiplyScalar(0.9 * dim);
    ghostMaterial.color.copy(coreInk).multiplyScalar(GHOST_GAIN * dim);
    bundleMaterial.color.copy(greyInk).multiplyScalar(HOLO_BUNDLE_GLOW * dim);

    // The point light rides the caller's group scale (the lamp's
    // ×propScale² convention): miniature rooms get a dollhouse glow,
    // colossal rooms a flood.
    const light = lightRef.current;
    if (light) {
      const s = spinRef.current
        ? spinRef.current.getWorldScale(worldScale.current).x
        : 1;
      light.intensity = LIGHT_INTENSITY * s * s * dim;
      light.distance = LIGHT_DISTANCE * s;
    }

    // The scanlines drift barely perceptibly upward.
    scanTexture.offset.y = (t * TERMINAL_SCAN_DRIFT) % 1;
  });

  return (
    <group>
      {/* The emitter: a slim dark disc where the cable rises from — the
          one solid, in the hotel's dark-trim register; the floor pool
          doubles as its glow. */}
      <mesh position={[0, 0.022, 0]} castShadow receiveShadow material={baseMaterial}>
        <cylinderGeometry args={[0.16, 0.18, 0.044, 24]} />
      </mesh>

      {/* The floor pool — additive blue spreading from the base, the
          "you can find it in the dark" cue. */}
      <mesh
        position={[0, 0.032, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={poolMaterial}
        renderOrder={1}
      >
        <planeGeometry args={[1.1, 1.1]} />
      </mesh>

      {/* The point light — brand blue, restrained, hard cutoff. */}
      <pointLight
        ref={lightRef}
        color={CORE_INK}
        position={[0, 1.4, 0]}
        decay={2}
      />

      {/* The light column — the shaft the cable is projected from;
          occluded naturally by walls (the ghost below carries the
          blocked case). Rotationally symmetric, so it needs no spin. */}
      <mesh
        position={[0, (HOLO_BOTTOM + HOLO_TOP) / 2, 0]}
        material={columnMaterial}
        renderOrder={1}
      >
        <cylinderGeometry
          args={[0.26, 0.3, HOLO_TOP - HOLO_BOTTOM, 20, 1, true]}
        />
      </mesh>

      {/* The through-wall ghost of the core — 5% blue, depth testing
          off, an ambiance cue where masonry blocks the real line. */}
      <mesh
        position={[0, (HOLO_BOTTOM + HOLO_TOP) / 2, 0]}
        material={ghostMaterial}
        renderOrder={3}
      >
        <cylinderGeometry args={[0.02, 0.02, HOLO_TOP - HOLO_BOTTOM, 8, 1, true]} />
      </mesh>

      {/* The cable: core + bundle, baked and spun rigidly. */}
      <group ref={spinRef}>
        {lines.map((line, i) => (
          <primitive key={i} object={line} />
        ))}
      </group>

      {overlay && (
        <Html
          transform
          center
          distanceFactor={2}
          position={[0, OVERLAY_Y, 0]}
          zIndexRange={[5, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              width: 172,
              height: 118,
              overflow: "hidden",
              userSelect: "none",
              background: "rgba(10, 12, 11, 0.82)",
              border: "1px solid rgba(236, 226, 204, 0.28)",
              borderRadius: 6,
            }}
          >
            {overlay}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Deterministic per-data breath phase: two rooms' holograms never
 *  breathe in lockstep on the rare frames two are mounted at once. */
function phaseFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1000) * Math.PI * 2;
}
