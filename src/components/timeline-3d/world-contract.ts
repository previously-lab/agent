/**
 * The world-switch contract (v0.11 §14.2) — pure module, unit-tested.
 *
 * One `<Canvas>` now carries BOTH worlds (the 2.5D field and the game), so
 * the things that used to be per-canvas props have become RENDERER-LEVEL
 * state shared by whichever world is mounted:
 *
 *   - `gl.toneMapping`   — the field rides R3F's default (ACESFilmic), the
 *                          game needs AgX (saturated accents clip under ACES)
 *   - `gl.shadowMap`     — the field casts no shadows (enabled: false), the
 *                          game uses `shadows="percentage"` (PCFShadowMap)
 *   - `scene.background` / `scene.fog` — the field is a transparent canvas
 *                          over the page; the game attaches a `<color>` while
 *                          its subtree is up
 *   - the default camera — each world's rig `makeDefault`s its own (drei's
 *                          OrthographicCamera restores on unmount; the field
 *                          rewrites the perspective camera every frame), so
 *                          the camera needs no explicit handling here.
 *
 * `applyWorldContract` SETS the world's values on entry and returns the
 * restore (the previous values) for the exit. Any one of these left behind
 * means the other world renders with the previous world's atmosphere — that
 * is exactly the failure the tests lock against ("enter A → leave → enter B").
 *
 * Changing `toneMapping`/`shadowMap` re-keys every material's shader program
 * in three — the worlds' subtrees are unmounted across the switch (only one
 * world is mounted at a time), so every material that ever observes the new
 * values is a FRESH mount compiling against them; the leaving world's
 * programs stay in the renderer's cache, which is what makes switching BACK
 * cheap. No live-material `needsUpdate` pass is needed or wanted.
 */
import * as THREE from "three";

export type WorldKind = "field" | "game";

/** The renderer surface the contract writes (structural — the real
 *  `WebGLRenderer` satisfies it, and so does a plain object in tests). */
export interface RendererContractTarget {
  toneMapping: THREE.ToneMapping;
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
}

/** The scene surface the contract writes. */
export interface SceneContractTarget {
  background: THREE.Scene["background"];
  fog: THREE.Scene["fog"];
}

export interface WorldContractTarget {
  gl: RendererContractTarget;
  scene: SceneContractTarget;
}

interface ContractSnapshot {
  toneMapping: THREE.ToneMapping;
  shadowMapEnabled: boolean;
  shadowMapType: THREE.ShadowMapType;
  background: THREE.Scene["background"];
  fog: THREE.Scene["fog"];
}

/** The field world's renderer values — exactly what its two standalone
 *  canvases ran on before the merge: R3F's ACESFilmic default, no shadow
 *  map, transparent background, no fog. */
const FIELD_SETTINGS = {
  toneMapping: THREE.ACESFilmicToneMapping,
  shadowMapEnabled: false,
  shadowMapType: THREE.PCFShadowMap,
} as const;

/** The game world's renderer values — exactly what its standalone canvas
 *  declared: AgX via `gl={{ toneMapping }}`, `shadows="percentage"`. The
 *  background is NOT set here: the game's Atmosphere attaches its own
 *  `<color attach="background">` (it lerps between corridor and room
 *  moods), and the exit path clears whatever it left. */
const GAME_SETTINGS = {
  toneMapping: THREE.AgXToneMapping,
  shadowMapEnabled: true,
  shadowMapType: THREE.PCFShadowMap,
} as const;

function snapshot(target: WorldContractTarget): ContractSnapshot {
  return {
    toneMapping: target.gl.toneMapping,
    shadowMapEnabled: target.gl.shadowMap.enabled,
    shadowMapType: target.gl.shadowMap.type,
    background: target.scene.background,
    fog: target.scene.fog,
  };
}

function restore(target: WorldContractTarget, snap: ContractSnapshot): void {
  target.gl.toneMapping = snap.toneMapping;
  target.gl.shadowMap.enabled = snap.shadowMapEnabled;
  target.gl.shadowMap.type = snap.shadowMapType;
  target.scene.background = snap.background;
  target.scene.fog = snap.fog;
}

/**
 * Enter `world`: set its renderer-level values, and clear the scene
 * atmosphere the OTHER world may have left (a world's own subtree re-attaches
 * whatever it needs from here on). Returns the exit restore.
 */
export function applyWorldContract(
  target: WorldContractTarget,
  world: WorldKind,
): () => void {
  const prev = snapshot(target);
  const settings = world === "game" ? GAME_SETTINGS : FIELD_SETTINGS;
  target.gl.toneMapping = settings.toneMapping;
  target.gl.shadowMap.enabled = settings.shadowMapEnabled;
  target.gl.shadowMap.type = settings.shadowMapType;
  if (world === "field") {
    // The field world is the transparent one — a leftover game background
    // would make the page behind the cards vanish.
    target.scene.background = null;
    target.scene.fog = null;
  }
  return () => {
    restore(target, prev);
    // Never hand the next world a stale atmosphere: the game's `<color
    // attach="background">` is gone with its subtree by the time this runs,
    // but the restore above may have revived a pre-entry value — pin the
    // baseline instead.
    if (world === "game") {
      target.scene.background = null;
      target.scene.fog = null;
    }
  };
}
