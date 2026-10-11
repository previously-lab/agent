"use client";

/**
 * AnchorHologram — the §13.1 anchor's mount. Since v0.29 it has exactly
 * ONE mount point: the lobby's east-wall terminal (game-canvas.tsx). The
 * per-room mounts are retired — rooms grow no machine.
 *
 * HISTORY (v0.11-streams): the holographic braid is gone. What the reader
 * photographed — the bright vertical beam with the white helix wound
 * around it and the ring — was the STRAND visualisation (one thread per
 * strand 线索, the retired model; strands.json lives on for graceful
 * degradation only), and the owner retired it: "the spiral timeline we
 * made before — it is not needed now." The whole light object went with
 * it: the core line, the strand/neighbour threads and their halo shells,
 * the crossed fog quads, the floor pool and the through-wall ghost. The
 * pure geometry module behind them (`anchor-hologram-geometry.ts`) is
 * deleted with its test file.
 *
 * WHAT REMAINS, AND WHY. The interaction is pure data — game-canvas's
 * GameLoop measures proximity to `anchor.ts`'s lobby anchor (world XZ,
 * TERMINAL_REACH) and fires the catalog jump; nothing in the retired
 * geometry was load-bearing for it. But the reader still needs to SEE
 * where the machine stands, so two things stay:
 *
 *  - THE EMITTER DISC — the one solid of the old object, in the hotel's
 *    dark-trim register. It sits at the anchor origin and is the
 *    footprint's visible marker; without it the lobby would offer a
 *    proximity prompt at an empty patch of floor.
 *  - THE POINT LIGHT — it lights the lobby where the machine stands (the
 *    glow cues went with the braid). Removing it would dim the machine's
 *    corner and change the scene's light configuration — a visual
 *    regression outside the braid removal's scope. It keeps the lamp's
 *    ×propScale² convention (compensated from the caller's group scale
 *    each frame).
 *
 * THE DEPART CLOCK. The frame loop still breathes and still writes
 * TERMINAL_DEPART.intensity (the §13.2 flare clock's live value, read by
 * the debug probes) — the stamp and the catalog jump live in game-canvas,
 * untouched, and probes keep reading the same record.
 *
 * DETERMINISM (A6). No seeded anything remains: the disc is a constant
 * cylinder, the light follows the caller's group scale, the breath is a
 * pure function of the clock (frozen to its base under
 * prefers-reduced-motion — luminance breathing is still motion).
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  TERMINAL_BREATH_PERIOD_S,
  TERMINAL_DEPART,
  TERMINAL_FLARE_GAIN,
  TERMINAL_FLARE_MS,
  TERMINAL_PLINTH,
} from "./anchor";

/** The light's ink — the brand blue the old core wore. */
const CORE_INK = "#0066ff";
/** The point light: HALF the lamp's reach — a halo, not a work light.
 *  Intensity scales with the caller's group scale squared (the lamp's
 *  ×propScale² convention), distance linearly, so the glow stays
 *  proportional from miniature to colossal rooms. */
const LIGHT_INTENSITY = 3;
const LIGHT_DISTANCE = 6;
/** The depart clock's gain range — the breath the old core wore, kept so
 *  TERMINAL_DEPART.intensity keeps meaning what the probes expect. */
const GAIN_BASE = 0.85;
const GAIN_BREATH = 0.12;
/** How far the lobby's dissolve pulls the light down (the corridor's
 *  rate, matching the old dim contract). */
const DIM_FADE = 0.88;

/**
 * prefers-reduced-motion, read straight off the media query: the breath
 * settles to its base gain (luminance breathing is still motion). */
const REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function AnchorHologram({
  dimmed = false,
}: {
  /** Lobby-only: lerp down with the corridor's dissolve (light
   *  included). */
  dimmed?: boolean;
  /** RETIRED with the braid — accepted (and ignored) so the two mounts in
   *  game-canvas.tsx / space.tsx keep compiling untouched. */
  strands?: readonly string[];
  /** RETIRED with the braid — accepted and ignored, as above. */
  neighborSlots?: number;
}): JSX.Element {
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
  useEffect(() => () => baseMaterial.dispose(), [baseMaterial]);

  const groupRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const dimKRef = useRef(0);
  // Scratch — the frame loop reuses these, never allocates.
  const worldScale = useRef(new THREE.Vector3());

  useFrame(({ clock }, delta) => {
    // The breath + the departure flare (the §13.2 屏幕亮起 beat's clock):
    // gain only, written for the probes — nothing visual consumes it now.
    const t = clock.elapsedTime;
    const k = REDUCED_MOTION
      ? 0.5
      : 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / TERMINAL_BREATH_PERIOD_S);
    let gain = GAIN_BASE + GAIN_BREATH * k;
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

    // The point light rides the caller's group scale (the lamp's
    // ×propScale² convention): miniature rooms get a dollhouse glow,
    // colossal rooms a flood.
    const light = lightRef.current;
    if (light) {
      const s = groupRef.current
        ? groupRef.current.getWorldScale(worldScale.current).x
        : 1;
      light.intensity = LIGHT_INTENSITY * s * s * dim;
      light.distance = LIGHT_DISTANCE * s;
    }
  });

  return (
    <group ref={groupRef}>
      {/* The emitter disc — the anchor's footprint marker: the one solid,
          in the hotel's dark-trim register, where the cable used to rise
          from. The interaction measures to the anchor XZ beside it. */}
      <mesh
        position={[0, 0.022, 0]}
        castShadow
        receiveShadow
        material={baseMaterial}
      >
        <cylinderGeometry args={[0.16, 0.18, 0.044, 24]} />
      </mesh>

      {/* The point light — brand blue, restrained, hard cutoff. It lights
          the room where the machine stands; the glow cues retired with
          the braid. */}
      <pointLight
        ref={lightRef}
        color={CORE_INK}
        position={[0, 1.4, 0]}
        decay={2}
      />
    </group>
  );
}
