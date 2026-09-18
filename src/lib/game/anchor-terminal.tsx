"use client";

/**
 * AnchorTerminal — the §13.1 machine, shared by both mount points.
 *
 * A floor-standing terminal in the hotel's dark-trim register: plinth,
 * pedestal, body, and a recessed screen whose emissive surface breathes
 * on a slow sine while a code-generated scanline texture drifts barely
 * perceptibly upward. It reads as a device on standby — no flicker, no
 * glitch, no stripes (this is a dream, not a horror game). On interact
 * the integrator stamps TERMINAL_DEPART and every mounted terminal's
 * screen swells toward the bloom threshold — §13.2's "屏幕亮起" beat,
 * the game-world half of the transition.
 *
 * The component's origin is the FLOOR CENTER of the machine; local +z is
 * the front (screen) side. Callers position it (room entrance wall /
 * lobby east wall) and pass the accent that tints the standby glow (the
 * room's palette accent, the hotel's timeline accent in the lobby).
 *
 * `screenOverlay` renders through drei Html INSIDE the bezel — the lobby
 * terminal passes the window index (buildLobbyRegister's data) so the
 * glyphs are DOM per §13's 文字走 DOM rule; room terminals pass none and
 * keep the abstract standby screen.
 *
 * Materials are owned here (created, animated, disposed in this module)
 * EXCEPT the fade participation in rooms: space.tsx captures every
 * material under the room root once on mount, so these ride the room's
 * crossfade for free. No lights are added — the glow is emissive + the
 * scene's bloom, so mounting a terminal never re-keys the light
 * configuration (the compile-storm discipline, game-canvas.tsx).
 */
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import {
  TERMINAL_BEZEL,
  TERMINAL_BODY,
  TERMINAL_BREATH_AMP,
  TERMINAL_BREATH_BASE,
  TERMINAL_BREATH_PERIOD_S,
  TERMINAL_DEPART,
  TERMINAL_FLARE_GAIN,
  TERMINAL_FLARE_MS,
  TERMINAL_PLINTH,
  TERMINAL_SCAN_DRIFT,
  TERMINAL_SCREEN_BASE,
  TERMINAL_SCREEN_H,
  TERMINAL_SCREEN_W,
} from "./anchor";

/** Local Y of the screen center (bezel middle). */
const SCREEN_Y = 1.06;
/** Local Z of the screen plane (proud of the bezel face). */
const SCREEN_Z = 0.326;
/** Up-tilt of the screen toward the 45° camera (top leans into the room). */
const SCREEN_TILT = 0.14;
/** px per world meter for the Html overlay at distanceFactor 2. */
const HTML_PX_PER_M = 200;

/** Deterministic per-mount phase so two terminals never breathe in lockstep. */
function phaseFor(accent: string): number {
  let h = 0;
  for (let i = 0; i < accent.length; i++) h = (h * 31 + accent.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 * Math.PI * 2;
}

/**
 * The standby screen texture, generated in code (no assets): the deep
 * base, a soft accent-phosphor radial glow, VERY faint scanlines (a ~4%
 * brightness ripple — texture pixels, not material alpha, so the
 * water/glass-only transparency budget is untouched), and one small
 * standby dot low on the glass. Opaque RGB throughout.
 */
function createScreenTexture(accent: string): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.CanvasTexture(canvas);
  ctx.fillStyle = TERMINAL_SCREEN_BASE;
  ctx.fillRect(0, 0, size, size);

  // Accent phosphor glow — radial, strongest at the center, fading well
  // before the bezel so the glass still reads as glass.
  const glow = ctx.createRadialGradient(
    size / 2,
    size * 0.42,
    size * 0.04,
    size / 2,
    size * 0.46,
    size * 0.62,
  );
  glow.addColorStop(0, accent);
  glow.addColorStop(0.55, accent);
  glow.addColorStop(1, TERMINAL_SCREEN_BASE);
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 1;

  // Scanlines: darken every third row by a hair, then drift the texture
  // slowly in the frame loop. Faint enough to read as surface, not signal.
  ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
  for (let y = 0; y < size; y += 3) {
    ctx.fillRect(0, y, size, 1);
  }

  // The standby dot: a small soft pool of light low on the glass.
  const dotX = size * 0.5;
  const dotY = size * 0.8;
  const dot = ctx.createRadialGradient(dotX, dotY, 1, dotX, dotY, 12);
  dot.addColorStop(0, "#ffffff");
  dot.addColorStop(0.35, accent);
  dot.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export function AnchorTerminal({
  accent,
  scale = 1,
  dimmed = false,
  screenOverlay,
}: {
  /** Tints the standby glow (room palette accent / hotel accent). */
  accent: string;
  /** Construction scale (room prop scale / lobby 1.5). */
  scale?: number;
  /** Lobby-only: lerp down with the corridor's dissolve. */
  dimmed?: boolean;
  /** DOM glyphs for the screen (lobby index); null = abstract standby. */
  screenOverlay?: ReactNode;
}): JSX.Element {
  const materials = useMemo(() => {
    const body = new THREE.MeshStandardMaterial({
      color: TERMINAL_BODY,
      roughness: 0.82,
      metalness: 0.04,
      flatShading: true,
    });
    const plinth = new THREE.MeshStandardMaterial({
      color: TERMINAL_PLINTH,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    });
    const bezel = new THREE.MeshStandardMaterial({
      color: TERMINAL_BEZEL,
      roughness: 0.55,
      metalness: 0.1,
      flatShading: true,
    });
    const stripe = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.6,
      metalness: 0,
      flatShading: true,
    });
    return { body, plinth, bezel, stripe };
  }, [accent]);
  const texture = useMemo(() => createScreenTexture(accent), [accent]);
  const screen = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#000000",
        map: texture,
        emissive: new THREE.Color("#ffffff"),
        emissiveMap: texture,
        emissiveIntensity: TERMINAL_BREATH_BASE,
        roughness: 0.35,
        metalness: 0,
      }),
    [texture],
  );
  useEffect(
    () => () => {
      texture.dispose();
      screen.dispose();
      materials.body.dispose();
      materials.plinth.dispose();
      materials.bezel.dispose();
      materials.stripe.dispose();
    },
    [texture, screen, materials],
  );

  const phase = useMemo(() => phaseFor(accent), [accent]);
  const dimKRef = useRef(0);
  const baseColors = useMemo(
    () => ({
      body: materials.body.color.clone(),
      plinth: materials.plinth.color.clone(),
      bezel: materials.bezel.color.clone(),
      stripe: materials.stripe.color.clone(),
    }),
    [materials],
  );

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    // The breath: one slow sine, base+amp chosen so the peak crosses the
    // bloom threshold and the glow swells — never a blink.
    const k = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / TERMINAL_BREATH_PERIOD_S + phase);
    let intensity = TERMINAL_BREATH_BASE + TERMINAL_BREATH_AMP * k;
    const depart = TERMINAL_DEPART.t0;
    if (depart >= 0) {
      const f = Math.min(1, (performance.now() - depart) / TERMINAL_FLARE_MS);
      intensity *= 1 + TERMINAL_FLARE_GAIN * f * f;
    }
    TERMINAL_DEPART.intensity = intensity;
    // Dim (lobby): follow the corridor's dissolve rate (≈6/s lerp).
    const dimK = (dimKRef.current += (1 - Math.exp(-6 * Math.min(delta, 0.05))) *
      ((dimmed ? 1 : 0) - dimKRef.current));
    materials.body.color.copy(baseColors.body).multiplyScalar(1 - 0.85 * dimK);
    materials.plinth.color.copy(baseColors.plinth).multiplyScalar(1 - 0.85 * dimK);
    materials.bezel.color.copy(baseColors.bezel).multiplyScalar(1 - 0.85 * dimK);
    materials.stripe.color.copy(baseColors.stripe).multiplyScalar(1 - 0.85 * dimK);
    screen.emissiveIntensity = intensity * (1 - 0.94 * dimK);
    // Scanline drift — one slow upward crawl, wrapped.
    texture.offset.y = (t * TERMINAL_SCAN_DRIFT) % 1;
  });

  return (
    <group scale={scale}>
      {/* Plinth + pedestal. */}
      <mesh position={[0, 0.04, 0]} castShadow receiveShadow material={materials.plinth}>
        <boxGeometry args={[0.56, 0.08, 0.46]} />
      </mesh>
      <mesh position={[0, 0.39, 0]} castShadow receiveShadow material={materials.body}>
        <boxGeometry args={[0.44, 0.62, 0.36]} />
      </mesh>
      <mesh position={[0, 0.725, 0]} castShadow receiveShadow material={materials.plinth}>
        <boxGeometry args={[0.5, 0.05, 0.42]} />
      </mesh>
      {/* Accent stripe on the pedestal — the family's palette tie. */}
      <mesh position={[0, 0.52, 0.181]} material={materials.stripe}>
        <boxGeometry args={[0.3, 0.02, 0.008]} />
      </mesh>
      {/* Body + top cap. */}
      <mesh position={[0, 1.065, 0]} castShadow receiveShadow material={materials.body}>
        <boxGeometry args={[0.78, 0.58, 0.52]} />
      </mesh>
      <mesh position={[0, 1.39, 0]} castShadow receiveShadow material={materials.plinth}>
        <boxGeometry args={[0.8, 0.06, 0.54]} />
      </mesh>
      {/* The screen: bezel box + emissive plane, tilted toward the camera. */}
      <group position={[0, SCREEN_Y, 0.285]} rotation={[SCREEN_TILT, 0, 0]}>
        <mesh castShadow material={materials.bezel}>
          <boxGeometry args={[0.64, 0.5, 0.07]} />
        </mesh>
        <mesh position={[0, 0, SCREEN_Z - 0.285]} material={screen}>
          <planeGeometry args={[TERMINAL_SCREEN_W, TERMINAL_SCREEN_H]} />
        </mesh>
        {screenOverlay && (
          <Html
            transform
            center
            distanceFactor={2}
            position={[0, 0, SCREEN_Z - 0.285 + 0.002]}
            zIndexRange={[5, 0]}
            style={{ pointerEvents: "none" }}
          >
            <div
              style={{
                width: TERMINAL_SCREEN_W * HTML_PX_PER_M,
                height: TERMINAL_SCREEN_H * HTML_PX_PER_M,
                overflow: "hidden",
                userSelect: "none",
              }}
            >
              {screenOverlay}
            </div>
          </Html>
        )}
      </group>
    </group>
  );
}
