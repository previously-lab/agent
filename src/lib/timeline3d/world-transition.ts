/**
 * The world transition (the camera-move primitive between the hotel and the
 * card field) — pure module.
 *
 * WHAT THIS IS. The app's one canvas carries both worlds, but until now the
 * swap between them was a subtree swap: the leaving world was gone the frame
 * the slot changed and the incoming world dissolved in over ~300 ms of CSS
 * opacity. The transition primitive replaces that with a three-beat move
 * owned by the shell (see app-shell.tsx):
 *
 *      camera   the LEAVING world plays its scripted move — the hotel's
 *               top-down follow camera descends along a curve to eye level
 *               in front of the anchor terminal (the "变成第一人称" beat);
 *               leaving the field holds its framing, the field camera's own
 *               focus landing is the entering beat on the other direction.
 *      dissolve the worlds cross on a SCREEN-LAYER blend: the field always
 *               renders into an offscreen target and a full-viewport quad
 *               composites it over the game (which renders through its own
 *               composer the whole time). No scene material ever gets an
 *               alpha — the dissolve lives entirely in the compositor.
 *      settle   the ENTERING world plays its move — the hotel camera rises
 *               back from eye level to the follow pose and hands the rig
 *               back.
 *
 * WHY THE CONTRACT HAS A PIN TABLE. Tone mapping and the shadow flag are
 * renderer-level, and the two worlds want different values (world-contract.ts
 * is the solo-mounted source of truth). While BOTH worlds are mounted they
 * still share the one renderer, so the transition PINS the leaving world's
 * values through the camera+dissolve beats and switches to the entering
 * world's values at the settle beat. Note the game pin says NoToneMapping,
 * not the contract's AgX: the game's EffectComposer forces NoToneMapping
 * while it is mounted (postprocessing renders the scene linear into its HDR
 * chain), so NoToneMapping IS the game's live operating value; the contract's
 * AgX only describes the renderer between mounts. Every switch in the
 * schedule below lands on the world that is INVISIBLE at that moment, so no
 * visible frame ever renders under a foreign mapping and no shader recompile
 * storm shows.
 *
 * THE LIVE SINGLETON. React state decides WHICH worlds are mounted (the
 * shell), but the per-frame progress and the imperative readers (the camera
 * rig, the game loop, the canvas orchestrator) must not re-render React at
 * 60 fps — they read WORLD_TRANSITION inside their frame loops. The shell
 * mutates it from one rAF clock; `id` bumps per transition so a rig that
 * captured a shot can tell a new transition from the last one.
 *
 * WORLD TRANSITIONS AND THE FEED. A transition freezes the band feed: both
 * fields stop publishing (the shell passes publishing=false), so the frozen
 * braid cannot be fought over by two writers while the field scene mounts
 * and unmounts around the swap (field-feed.ts's one-writer rule, extended).
 *
 * WHY A hook instead of a navigation. The room → catalog entrance used to be
 * an instant URL jump planned by anchor.ts's anchorNavPlan. The primitive
 * owns the swap now: the terminal interaction fires
 * WORLD_TRANSITION.hooks.enter and the shell starts the machine; the URL is
 * written at COMPLETION (destination reached), so a refresh or a share mid-
 * transition lands on the side the reader started from, and Back replays the
 * reverse move through the URL reconciliation in the shell.
 */
import * as THREE from "three";
import type { WorldKind } from "@/components/timeline-3d/world-contract";

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

/** Full transition length, ms (reduced motion gets a short fade only). */
export const WORLD_TRANSITION_MS = 1400;
/** Reduced-motion length: a plain dissolve, no camera scripting. */
export const WORLD_TRANSITION_REDUCED_MS = 260;

/** Progress (0..1) where the dissolve starts — the leaving world's scripted
 *  move occupies [0, DISSOLVE_START]. */
export const DISSOLVE_START = 0.45;
/** Progress where the dissolve ends and the settle beat begins. */
export const DISSOLVE_END = 0.72;

export type WorldTransitionPhase = "camera" | "dissolve" | "settle";

export function transitionPhase(progress: number): WorldTransitionPhase {
  if (progress < DISSOLVE_START) return "camera";
  if (progress < DISSOLVE_END) return "dissolve";
  return "settle";
}

/** smoothstep, clamped — the dissolve ramp and the camera ease. */
export function smooth01(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** The field layer's coverage of the screen during a transition: 0→1 for
 *  game → field, 1→0 for field → game. Outside the dissolve window the
 *  value is pinned at whichever world owns the screen. */
export function fieldLayerAlpha(progress: number, from: WorldKind): number {
  const ramp = smooth01(
    (progress - DISSOLVE_START) / (DISSOLVE_END - DISSOLVE_START),
  );
  return from === "field" ? 1 - ramp : ramp;
}

/* ------------------------------------------------------------------ */
/* The contract pin                                                    */
/* ------------------------------------------------------------------ */

export interface ContractPin {
  toneMapping: THREE.ToneMapping;
  shadowMapEnabled: boolean;
}

/** The renderer values a world runs under WHILE BOTH WORLDS ARE MOUNTED.
 *  `game.toneMapping` is NoToneMapping on purpose — see the file note: the
 *  composer's guard pins it for as long as the game world is mounted, so
 *  that IS the game's live value. (The contract's GAME_SETTINGS still says
 *  AgX; that describes the between-mounts renderer and stays the solo
 *  path's truth — do not "fix" either side.) */
export const TRANSITION_PIN: Record<WorldKind, ContractPin> = {
  field: {
    toneMapping: THREE.ACESFilmicToneMapping,
    shadowMapEnabled: false,
  },
  game: {
    toneMapping: THREE.NoToneMapping,
    shadowMapEnabled: true,
  },
};

/** Which contract values the renderer wears at `progress`. The pin follows
 *  the LEAVING world through the camera and dissolve beats (it owns the
 *  screen) and switches to the ENTERING world's values at the settle beat —
 *  the exact moment the entering layer has won the screen. Both switches
 *  land on an invisible layer, so no live frame ever changes mapping
 *  visibly and the recompile they trigger happens under a hidden world. */
export function contractPinAt(
  progress: number,
  from: WorldKind,
  to: WorldKind,
): ContractPin {
  return progress < DISSOLVE_END ? TRANSITION_PIN[from] : TRANSITION_PIN[to];
}

/* ------------------------------------------------------------------ */
/* The scripted hotel shot (the camera-move half of the transition)     */
/* ------------------------------------------------------------------ */

/** Camera height at the terminal, in world units — a standing reader's
 *  eyes, just above the bezel top (TERMINAL_H 1.42). */
export const SHOT_EYE_HEIGHT = 1.5;
/** How far back from the interaction point the eye pose stands. */
export const SHOT_EYE_BACKOFF = 0.9;
/** The look target's height — the terminal's screen band. */
export const SHOT_LOOK_HEIGHT = 1.0;
/** The ortho zoom multiplier at the eye pose — the dolly-in. */
export const SHOT_ZOOM_CLOSE = 2.1;

/** The terminal's world pose as the game loop measures it every frame
 *  (game-canvas §4): the interaction point and the direction the terminal
 *  FACES (unit length, toward where the reader stands). */
export interface AnchorPose {
  x: number;
  z: number;
  faceX: number;
  faceZ: number;
  has: boolean;
}

export const NO_ANCHOR_POSE: AnchorPose = {
  x: 0,
  z: 0,
  faceX: 0,
  faceZ: 1,
  has: false,
};

/** The follow rig's pose in the same plain shape (world units + ortho
 *  zoom) — CameraRig feeds its live values in. */
export interface FollowPose {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  zoom: number;
}

/** The scripted pose: position, look target, ortho zoom. */
export interface ShotPose {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  zoom: number;
}

/** The eye-level end pose: standing SHOT_EYE_BACKOFF in front of the
 *  terminal's interaction point, facing the screen at close zoom. */
export function eyePoseFor(anchor: AnchorPose, baseZoom: number): ShotPose {
  return {
    x: anchor.x + anchor.faceX * SHOT_EYE_BACKOFF,
    y: SHOT_EYE_HEIGHT,
    z: anchor.z + anchor.faceZ * SHOT_EYE_BACKOFF,
    lookX: anchor.x,
    lookY: SHOT_LOOK_HEIGHT,
    lookZ: anchor.z,
    zoom: baseZoom * SHOT_ZOOM_CLOSE,
  };
}

/** The descent path between the follow pose and the eye pose, sampled at
 *  t ∈ [0,1] (eased inside). t=0 is the full follow pose, t=1 the eye pose;
 *  the rise plays the same path backwards, which is what makes the two
 *  directions read as one continuous move. */
export function shotPath(
  t: number,
  eye: ShotPose,
  follow: FollowPose,
): ShotPose {
  const k = smooth01(t);
  return {
    x: follow.x + (eye.x - follow.x) * k,
    y: follow.y + (eye.y - follow.y) * k,
    z: follow.z + (eye.z - follow.z) * k,
    lookX: follow.lookX + (eye.lookX - follow.lookX) * k,
    lookY: follow.lookY + (eye.lookY - follow.lookY) * k,
    lookZ: follow.lookZ + (eye.lookZ - follow.lookZ) * k,
    zoom: follow.zoom + (eye.zoom - follow.zoom) * k,
  };
}

/**
 * The hotel camera's pose for a live transition, or null when the rig
 * should keep following. The scripted move only runs when an anchor pose
 * is available and the reader allows motion; reduced-motion transitions
 * are a plain dissolve.
 *
 *  - leaving (from = "game"): the descent, sampled over [0, DISSOLVE_START]
 *    and held at the eye pose through the dissolve — the world dissolves
 *    away from the reader's eyes, not from the top-down rig.
 *  - entering (to = "game"): the eye pose held from the mount frame (the
 *    world is off screen until the dissolve, so the pose can snap) and the
 *    rise played over [DISSOLVE_END, 1], ending exactly ON the live follow
 *    pose so the hand back to the rig is seamless.
 */
export function hotelShotPose(
  progress: number,
  from: WorldKind,
  to: WorldKind,
  reducedMotion: boolean,
  anchor: AnchorPose,
  follow: FollowPose,
): ShotPose | null {
  if (reducedMotion || !anchor.has) return null;
  if (from === "game") {
    const eye = eyePoseFor(anchor, follow.zoom);
    const t = progress <= 0 ? 0 : progress / DISSOLVE_START;
    return shotPath(Math.min(1, t), eye, follow);
  }
  if (to === "game") {
    const eye = eyePoseFor(anchor, follow.zoom);
    if (progress < DISSOLVE_END) return eye;
    const rise = (progress - DISSOLVE_END) / (1 - DISSOLVE_END);
    // Rise = the descent sampled backwards: 1 → 0 as progress → 1.
    return shotPath(1 - Math.min(1, rise), eye, follow);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The live singleton (mutated by the shell's clock, read in frames)    */
/* ------------------------------------------------------------------ */

export interface WorldTransitionLive {
  active: boolean;
  /** Bumped per transition — readers key one-shot captures on it. */
  id: number;
  from: WorldKind;
  to: WorldKind;
  /** 0..1, written by the shell's rAF clock. */
  progress: number;
  reducedMotion: boolean;
  /** The terminal pose as the game loop last measured it (§4). */
  anchor: AnchorPose;
  /** The game → field entrance: fired by the terminal interaction after
   *  the depart flare, owned by the shell (starts the machine). */
  hooks: { enter: ((sliceId: string) => void) | null };
}

export const WORLD_TRANSITION: WorldTransitionLive = {
  active: false,
  id: 0,
  from: "field",
  to: "field",
  progress: 0,
  reducedMotion: false,
  anchor: NO_ANCHOR_POSE,
  hooks: { enter: null },
};
