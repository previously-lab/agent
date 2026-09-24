"use client";

/**
 * AnchorHologram — the §13.1 anchor in holographic form, shared by both
 * mount points (every room's doorway wall, the lobby's east wall).
 *
 * WHAT IT IS. The room's anchor is no longer a floor-standing machine but
 * a human-height MINIATURE OF THE LEFT BAND'S BRAID: a glowing core line
 * (the room's own timeline) with the slice's bundle wound around it — one
 * thread per strand passing through the slice, one per newer slice of the
 * corridor window — braided through a single knot at this room's moment.
 * The geometry is `anchor-hologram-geometry.ts`, which is `winding.ts`'s
 * coaxial model standing up in the room; this file only bakes it into
 * instanced tubes and keeps it alive.
 *
 * DETERMINISM (A6). The baked bytes are a pure function of (strands,
 * neighborSlots) — slice and door data, never the clock, never a seed.
 * The ONE live motion is the rigid self-spin: `rotation.y = t ·
 * HOLO_SPIN_SPEED` on the cable group. On a cylinder a rigid spin only
 * re-deals which seat faces the viewer — it cannot deform the
 * cross-section or move a thread off the cylinder — and the per-instance
 * brightness was baked in the cable's own frame, so the spin turns the
 * bundle as one physical object instead of dragging a light around
 * (threadline-scene's group-spin discipline). The breath and the depart
 * flare touch material colour only; geometry never re-bakes after mount.
 *
 * HOLOGRAM WITHOUT ALPHA (the transparency budget). Every material here
 * is OPAQUE — only water and glass may spend alpha in this world, and a
 * hologram is a light emitter, not a filter. The glow is carried by
 * UNLIT colours pushed over the bloom threshold (the scene's bloom does
 * the halo), and the scanline feel by a code-generated emissive-map
 * ripple — texture pixels, not material alpha, the same trick the old
 * terminal's screen used. The tubes are the band's real cylinders
 * (`RADIAL_SEGMENTS` from timeline3d/tube.ts), so threads occlude each
 * other and the braid reads as volume, not decal.
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
 * space.tsx's material capture carries them through the crossfade. No
 * lights are added — emissive + the scene's bloom only.
 *
 * THE LOBBY VARIANT rides the same component one size bigger (the
 * caller's group scale, LOBBY_TERMINAL_ANCHOR.scale): its strands are the
 * union of every strand threading the window, its neighbor count is the
 * window's slice count (the whole index, not one slice's newer slots),
 * `dimmed` follows the corridor's dissolve, and `overlay` floats the
 * whole-window index as DOM above the cable (§13: 文字走 DOM — the
 * register board was never scene geometry).
 */
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import {
  TERMINAL_BEZEL,
  TERMINAL_BREATH_PERIOD_S,
  TERMINAL_DEPART,
  TERMINAL_FLARE_GAIN,
  TERMINAL_FLARE_MS,
  TERMINAL_PLINTH,
  TERMINAL_SCAN_DRIFT,
} from "./anchor";
import { RADIAL_SEGMENTS } from "@/lib/timeline3d/tube";
import {
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

/** The core's gain range: base × breath peaks just over the bloom
 *  threshold so the spine swells; the depart flare multiplies on top. */
const CORE_GAIN_BASE = 1.0;
const CORE_GAIN_BREATH = 0.28;
/** The bundle's material gain: instance brightness (≤ ~0.95) times this
 *  puts a turning thread's near flank just over the bloom threshold for
 *  a moment — threads glint as the cable spins, the core keeps the
 *  landmark. */
const BUNDLE_GAIN = 1.15;
/** The scanline ripple count along the cable's full height. */
const SCAN_LINES = 26;
/** How far the lobby's dissolve pulls the inks down (the corridor's
 *  rate, matching the old terminal's dim contract). */
const DIM_FADE = 0.88;

/** Deterministic per-mount breath phase from the accent — data-derived,
 *  like the old terminal, so two accents never breathe in lockstep. */
function phaseFor(accent: string): number {
  let h = 0;
  for (let i = 0; i < accent.length; i++) h = (h * 31 + accent.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1000) * Math.PI * 2;
}

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
    // colours multiplied into the shared accent material.
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
  accent,
  dimmed = false,
  strands = [],
  neighborSlots = 0,
  overlay,
}: {
  /** The room palette accent / the hotel's timeline accent — the ONE hue
   *  the hologram glows in, so it reads under every world skin. */
  accent: string;
  /** Lobby-only: lerp down with the corridor's dissolve. */
  dimmed?: boolean;
  /** The strands passing through this slice (the room-door data lane) —
   *  one braid thread each. */
  strands?: readonly string[];
  /** How many newer slices this room's window provably holds — one
   *  context thread each. */
  neighborSlots?: number;
  /** DOM content floating above the cable (the lobby's window index);
   *  null = the abstract hologram. */
  overlay?: ReactNode;
}): JSX.Element {
  const accentColor = useMemo(() => new THREE.Color(accent), [accent]);
  const phase = useMemo(() => phaseFor(accent), [accent]);

  const unitCylinder = useMemo(
    () => new THREE.CylinderGeometry(1, 1, 1, RADIAL_SEGMENTS, 1, true),
    [],
  );
  const scanTexture = useMemo(() => createScanTexture(), []);
  const coreMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: accent,
        map: scanTexture,
      }),
    [accent, scanTexture],
  );
  const bundleMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: "#ffffff" }),
    [],
  );
  const puckMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: TERMINAL_PLINTH,
        roughness: 0.9,
        metalness: 0,
        flatShading: true,
      }),
    [],
  );
  const bezelMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: TERMINAL_BEZEL,
        roughness: 0.55,
        metalness: 0.1,
        flatShading: true,
      }),
    [],
  );

  // The braid, baked once for this room's data. The thread set is a pure
  // function of (strands, neighborSlots); either changing re-bakes, but
  // the integrator freezes the door data per mount, so in practice this
  // is mount-only.
  const threadKey = strands.join("") + "" + neighborSlots;
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
      coreMaterial.dispose();
      bundleMaterial.dispose();
      puckMaterial.dispose();
      bezelMaterial.dispose();
    },
    [unitCylinder, scanTexture, coreMaterial, bundleMaterial, puckMaterial, bezelMaterial],
  );

  const spinRef = useRef<THREE.Group>(null);
  const dimKRef = useRef(0);
  // Scratch colours — the frame loop reuses these, never allocates.
  const coreInk = useRef(new THREE.Color());
  const bundleInk = useRef(new THREE.Color());

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    // The one live motion: a rigid spin of the whole cable.
    if (spinRef.current) spinRef.current.rotation.y = t * HOLO_SPIN_SPEED;

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

    coreInk.current.copy(accentColor).multiplyScalar(gain * (1 - DIM_FADE * dimK));
    coreMaterial.color.copy(coreInk.current);
    bundleInk.current
      .copy(accentColor)
      .multiplyScalar(BUNDLE_GAIN * (1 - DIM_FADE * dimK));
    bundleMaterial.color.copy(bundleInk.current);
    // The scanlines drift barely perceptibly upward.
    scanTexture.offset.y = (t * TERMINAL_SCAN_DRIFT) % 1;
  });

  return (
    <group>
      {/* The emitter: a dark puck + accent rim where the cable is
          "projected" from — the one solid left in place of the machine,
          in the hotel's dark-trim register. The rim shares the bundle
          material, so it breathes and dissolves with the threads. */}
      <mesh position={[0, 0.032, 0]} castShadow receiveShadow material={puckMaterial}>
        <cylinderGeometry args={[0.19, 0.215, 0.064, 24]} />
      </mesh>
      <mesh position={[0, 0.064, 0]} material={bezelMaterial}>
        <cylinderGeometry args={[0.148, 0.148, 0.012, 24]} />
      </mesh>
      <mesh position={[0, 0.072, 0]} rotation={[-Math.PI / 2, 0, 0]} material={bundleMaterial}>
        <torusGeometry args={[0.132, 0.0075, 8, 36]} />
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
          position={[0, HOLO_TOP + 0.28, 0]}
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
