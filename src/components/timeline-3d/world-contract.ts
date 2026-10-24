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
 *                          game enables PCFShadowMap while it is mounted
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
 *  shared canvas now declares the same through fiber's object form
 *  (`shadows={{ type: PCFShadowMap, enabled: false }}`, world-canvas.tsx) —
 *  a boolean/omitted prop would map to the deprecated PCFSoftShadowMap on
 *  every re-configure. This contract still owns the live values while a
 *  world is mounted. The background is NOT set here: the game's Atmosphere
 *  attaches its own
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

/* ------------------------------------------------------------------------ */
/* Canvas render policy — the canvas-level props (dpr, frameloop)            */
/* ------------------------------------------------------------------------ */

/** The frame loop modes R3F's `frameloop` accepts that this app uses. */
export type FrameLoopMode = "always" | "demand" | "never";

/** The canvas props the shared `<Canvas>` should wear for a given state.
 *  Pure — WorldCanvas derives these every render and hands them to fiber. */
export interface CanvasRenderPolicy {
  dpr: [number, number];
  frameloop: FrameLoopMode;
}

/** The game world's whole-room RTS view pays the heaviest per-frame cost
 *  (full room on screen, the hotel's EffectComposer on top), so its DPR cap
 *  is lower than the field's. The field keeps the canvas's historical
 *  [1, 2]. */
const GAME_DPR: [number, number] = [1, 1.5];
const FIELD_DPR: [number, number] = [1, 2];

/**
 * Resolve which world's DPR cap the canvas wears (the input to
 * `canvasPolicy`). The rule follows whose pixels the canvas is actually
 * keeping, not where the reader is heading:
 *
 *   - dissolve    — the ENTERING world (worlds[1]): the compositor is
 *                   cross-fading the two worlds and settles on the
 *                   entering one, so its DPR applies from the first frame.
 *   - pause       — the LEAVING/FROZEN world (worlds[0]): a pause move
 *                   (game ⇄ field with the documents rising/falling) keeps
 *                   the leaving world mounted and FROZEN on the canvas —
 *                   it is the reader's backdrop for the whole pause. Its
 *                   DPR must not change mid-pause: an R3F `dpr` change
 *                   re-runs setPixelRatio/setSize, and the size write
 *                   CLEARS the canvas, erasing the frozen frame (measured:
 *                   every pixel alpha=0 after a game→field pause flipped
 *                   DPR 1.5 → 2 → 1.5). (The erasure the policy still
 *                   allows — a user resizing the window mid-pause — is
 *                   repaired by the game owner's one-shot frozen-frame
 *                   repaint, frozen-frame.ts; this rule is about the
 *                   POLICY not flipping DPR by itself.)
 *   - otherwise   — the settled world (worlds[0]).
 *
 * Returns null for an empty list or a missing slot, matching the canvas's
 * existing null-world fallback.
 */
export function canvasPolicyWorld(
  worlds: readonly WorldKind[],
  transitionActive: boolean,
  pauseTransition: boolean,
): WorldKind | null {
  if (transitionActive && !pauseTransition) return worlds[1] ?? null;
  return worlds[0] ?? null;
}

/**
 * Resolve the canvas's `dpr`/`frameloop` for a state. Three flavours:
 *
 *   - active        — "always": the loop runs every frame as before.
 *   - fullscreen    — "never" (paused): the conversation layer owns the
 *                     screen; nothing below it may draw, not even on
 *                     demand. R3F keeps the last presented frame.
 *   - document      — "demand" (suspended only): the archive under the
 *                     document tier is DOM reached through drei `<Html>`
 *                     portals, and its virtual list derives its visible
 *                     range in a `useFrame` — with no frames at all a cold
 *                     mount starves (first range stays [0,-1], no rows).
 *                     Demand runs exactly the frames `invalidate()` asks
 *                     for, so portals mount and the range responds, then
 *                     the loop idles instead of redrawing the hidden world.
 *                     React commits are not the only frame source: the
 *                     archive's wheel/touch/keyboard handlers write only
 *                     refs, so they ask for their next frame explicitly
 *                     through the world-slot channel (`requestFrame` from
 *                     `useWorldScene`), and the scene's own useFrame
 *                     re-arms the loop while its easing is converging.
 *                     Suspended is thus finite frames by construction —
 *                     not a continuous RAF, and never a GL repaint through
 *                     the loop: the field renderer stays gated and the
 *                     game's composer is disabled, so a demand frame
 *                     touches no GL. The single exception is a mid-pause
 *                     canvas resize or DPR change, which CLEARS the
 *                     drawing buffer: the game owner repairs it with
 *                     one manual repaint of the game's OWN composer after
 *                     the frozen scene's static frame setup (frozen-frame.ts).
 *                     Cold suspended mounts get the same initial paint;
 *                     ordinary demand frames never invoke the composer.
 *
 * In every flavour the world stays MOUNTED through the pause; only the
 * loop's cadence changes. The game's own composer is separately disabled
 * while suspended (game-canvas), so an ordinary demand frame never
 * repaints the hotel — the only repaint is the game owner's single
 * repair of a suspended size/DPR change (frozen-frame.ts).
 */
export function canvasPolicy(
  world: WorldKind,
  paused: boolean,
  suspended: boolean,
): CanvasRenderPolicy {
  const frameloop: FrameLoopMode = paused
    ? "never"
    : suspended
      ? "demand"
      : "always";
  return {
    dpr: world === "game" ? GAME_DPR : FIELD_DPR,
    frameloop,
  };
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
