"use client";

/**
 * WorldCanvas (v0.11 §13.2/§14) — THE one `<Canvas>` of the app. It carries
 * two worlds, of which ONE is mounted while the reader is settled and BOTH
 * are mounted while a world transition (world-transition.ts) moves between
 * them:
 *
 *   - "field"  the 2.5D catalog — the card field's scene (delivered through
 *              the world slot, see below) plus the left band's threadline
 *              braid. Both render here: the braid lives in a separate
 *              THREE.Scene reached by `createPortal` (with its own camera
 *              and a band-sized `size` override, so the rig reads the
 *              strip's dimensions exactly as it did when it owned a
 *              canvas), and a priority-1 frame subscriber renders the two
 *              passes — the main scene full-width, then the braid
 *              scissored into the band strip.
 *   - "game"   the hotel — its subtree arrives through the same slot and
 *              brings its own EffectComposer (which renders it to the
 *              screen whenever it is mounted, same as it did on its own
 *              canvas).
 *
 * THE WORLD SLOT. The scenes are built by components that live OUTSIDE this
 * canvas in the DOM tree (CardField owns the card field's state, GameCanvas
 * the game's), so they cannot be Canvas children. `useWorldScene(world,
 * node)` (world-slot.tsx) hands each world's scene subtree to the canvas
 * under its own kind; one world is a plain hand-off, a transition keeps
 * both registered.
 *
 * EACH WORLD GETS ITS OWN SCENE — ALWAYS. Both subtrees render through
 * `createPortal` into per-world THREE.Scene objects (fieldScene/gameScene),
 * never into the canvas's default scene. That is what makes a transition
 * honest: the two worlds are genuinely separated in the GL, the hotel's
 * composer can never draw the card field into its frame (and vice versa),
 * and each world's `attach`/scene lookups land on its own scene. It also
 * removes the makeDefault tug-of-war the single-scene merge had (the
 * game's orthographic rig and the field's perspective camera no longer
 * fight over the default camera — the game makeDefaults inside its portal,
 * the field keeps the canvas's perspective camera).
 *
 * THE TRANSITION COMPOSITOR. While a transition runs, the field world
 * NEVER renders directly to the screen — even when it is the leaving
 * world. The TransitionCompositor (priority 2, above the game's composer
 * at priority 1) renders the field into an offscreen target and draws a
 * full-viewport quad over the game's output with the transition's alpha:
 * a screen-layer dissolve, no scene material ever carries an alpha. The
 * compositor also pins the renderer's contract values (tone mapping, the
 * shadow flag) to the leaving world's settings through the dissolve and
 * switches to the entering world's at the settle beat, so neither the
 * descent nor the reveal ever renders a visible frame under a foreign
 * mapping (world-contract.ts stays the source of truth for settled
 * worlds; see world-transition.ts for the schedule).
 *
 * THE CONTRACT (§14.2) — `world-contract.ts`: tone mapping, shadow map,
 * scene background/fog are renderer-level now. WorldContract applies the
 * settled world's values in a LAYOUT effect (before that world's first
 * frame paints) and applies nothing mid-transition (the compositor owns
 * the renderer for those frames). The worlds' scene backgrounds live on
 * their own scenes now — the game's `<color attach="background">` reaches
 * gameScene through its portal, the field scene stays transparent.
 *
 * What deliberately does NOT live here: the DOM around the worlds (the
 * band's scrub lens, the card field's gesture surface, the HUD) and the
 * world-switch UI. This file owns the canvas and nothing else.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { Canvas, createPortal, useFrame, useThree } from "@react-three/fiber";
import { useTheme } from "@teispace/next-themes";
import { FIELD_FOV, camZFor } from "@/lib/timeline3d/camera";
import { canvasPolicy, canvasPolicyWorld } from "@/components/timeline-3d/world-contract";
import {
  WORLD_TRANSITION,
  contractPinAt,
  fieldLayerAlpha,
} from "@/lib/timeline3d/world-transition";
import { applyWorldContract, type WorldKind } from "./world-contract";
import { WorldSceneNodesContext, useWorldFrameRegistration } from "./world-slot";
import {
  THREADLINE_BASE_Z,
  THREADLINE_FOV,
  ThreadlineRig,
  type ThreadlineSceneProps,
} from "./threadline-scene";

/* ------------------------------------------------------------------------ */
/* The contract (renderer-level world state, §14.2)                          */
/* ------------------------------------------------------------------------ */

function WorldContract({
  world,
}: {
  /** The settled (single mounted) world, or null mid-transition — the
   *  TransitionCompositor pins the renderer for those frames. */
  world: WorldKind | null;
}): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  // Layout effect: the renderer values are in place before the entering
  // world's first frame can paint with the other world's atmosphere.
  useLayoutEffect(() => {
    if (world === null) return;
    applyWorldContract({ gl, scene }, world);
  }, [world, gl, scene]);
  return null;
}

/* ------------------------------------------------------------------------ */
/* The frame-request bridge — the world-slot channel → R3F invalidate        */
/* ------------------------------------------------------------------------ */

/**
 * Hands the world-slot channel's `requestFrame` to this canvas's R3F
 * `invalidate`. The canvas bridges the outer context into fiber itself,
 * so this component only reads the store hook and registers. Under the
 * policy (world-contract.ts): "always" needs no requests, "demand" runs
 * exactly the requested frames, "never" drops them — the bridge never
 * has to know which mode is live.
 */
function FrameRequestBridge(): null {
  const invalidate = useThree((s) => s.invalidate);
  useWorldFrameRegistration(invalidate);
  return null;
}

/* ------------------------------------------------------------------------ */
/* The field world's two passes — main scene + the band's braid              */
/* ------------------------------------------------------------------------ */

export interface WorldBand
  extends Omit<ThreadlineSceneProps, "strands" | "selected"> {
  /** The band strip's left edge, px from the canvas's left (the rail's
   *  margin) — the braid renders scissored to `[x, x + width]`. */
  x: number;
  /** The strip's width in CSS px (the tier's `railW`). */
  width: number;
}

/**
 * The field world's render, as a pair of passes: the main scene
 * full-width, then the braid scissored into the band strip — over
 * whatever the main pass left there, exactly the stacking the two
 * canvases had. With `target` null this hits the screen (the settled
 * field); with a target it renders the identical pair into it (the
 * transition's offscreen field layer), where the target's own
 * viewport/scissor (device px, applied at bind time) take the place of
 * the renderer's screen viewport.
 */
function renderFieldWorld(
  gl: THREE.WebGLRenderer,
  size: { width: number; height: number },
  scene: THREE.Scene,
  camera: THREE.Camera,
  band: { x: number; width: number } | null,
  bandScene: THREE.Scene,
  bandCamera: THREE.Camera,
  target: THREE.WebGLRenderTarget | null,
  dpr: number,
): void {
  if (target) {
    const w = target.width;
    const h = target.height;
    target.scissorTest = false;
    target.viewport.set(0, 0, w, h);
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    if (band) {
      const bx = Math.round(band.x * dpr);
      const bw = Math.round(band.width * dpr);
      target.viewport.set(bx, 0, bw, h);
      target.scissor.set(bx, 0, bw, h);
      target.scissorTest = true;
      // Re-bind so the new viewport/scissor apply.
      gl.setRenderTarget(target);
      // The braid draws OVER the main pass (the two canvases' old stacking —
      // see the screen path below): keep the strip's colour, clear only the
      // depth the field's scene left in it.
      gl.autoClear = false;
      gl.clearDepth();
      gl.render(bandScene, bandCamera);
      gl.autoClear = true;
      target.scissorTest = false;
      target.viewport.set(0, 0, w, h);
    }
    gl.setRenderTarget(null);
    return;
  }
  gl.setScissorTest(false);
  gl.setViewport(0, 0, size.width, size.height);
  gl.render(scene, camera);
  if (band) {
    gl.setViewport(band.x, 0, band.width, size.height);
    gl.setScissor(band.x, 0, band.width, size.height);
    gl.setScissorTest(true);
    // OVER, not INSTEAD: autoClear would clear the strip to the transparent
    // clear colour first, erasing the main pass's surface inside the band
    // rect and letting the DOM backdrop show through as a pale column (the
    // v0.28 left-edge seam). Depth still clears — the braid's scene must not
    // test against the field's depth — so the threads draw exactly as they
    // did on their own canvas, over whatever the main pass left there.
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(bandScene, bandCamera);
    gl.autoClear = true;
    gl.setScissorTest(false);
  }
  gl.setViewport(0, 0, size.width, size.height);
}

/** The band's braid, portaled into its own scene with the strip-sized
 *  override the rig was built against. Lives at the canvas level (not
 *  inside FieldWorldRenderer) because the transition compositor renders
 *  the same bandScene into the offscreen target — one braid, two
 *  consumers, identical content either way. */
function BraidPortal({
  band,
  bandScene,
  bandCamera,
  dark,
}: {
  band: WorldBand;
  bandScene: THREE.Scene;
  bandCamera: THREE.PerspectiveCamera;
  dark: boolean;
}): ReactNode {
  const size = useThree((s) => s.size);
  return createPortal(
    <ThreadlineRig
      // The strand field is retired (§A.2.4) — there is no strand list to
      // feed the braid any more, so it winds with no strand picks and no
      // focus. Anchoring the band to cases instead is a separate question.
      strands={[]}
      selected={[]}
      // …and with nothing for 「核心时间线 is the answer」 to mark, the blue
      // PRESENT spine is the retired timeline's leftover (v0.27): the
      // archive surface keeps the ambient threads, not the spine.
      spine={false}
      feed={band.feed}
      range={band.range}
      reducedMotion={band.reducedMotion}
      dark={dark}
    />,
    bandScene,
    {
      camera: bandCamera,
      size: { width: band.width, height: size.height, top: 0, left: 0 },
    },
  );
}

/** The settled field world's renderer: the two passes to the screen,
 *  priority 1 — this subscriber IS the field world's render. Gated while
 *  a transition runs (the compositor owns the field layer then, on or
 *  off screen), including when the field is the leaving world. */
function FieldWorldRenderer({
  band,
  fieldScene,
  bandScene,
  bandCamera,
  gated,
}: {
  band: WorldBand;
  fieldScene: THREE.Scene;
  bandScene: THREE.Scene;
  bandCamera: THREE.Camera;
  gated: boolean;
}): ReactNode {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  useFrame(({ camera }) => {
    if (gated) return;
    renderFieldWorld(gl, size, fieldScene, camera, band, bandScene, bandCamera, null, 1);
  }, 1);

  // Leave the renderer the way the automatic path expects it: no scissor.
  // Without this the NEXT world (or a remount) inherits a clipped frame.
  useEffect(() => {
    return () => {
      gl.setScissorTest(false);
    };
  }, [gl]);

  return null;
}

/* ------------------------------------------------------------------------ */
/* The transition compositor — the field layer over the game, on one quad    */
/* ------------------------------------------------------------------------ */

/**
 * The transition's screen-layer dissolve (priority 2 — above the game's
 * composer at 1, below nothing). Every frame of a transition:
 *
 *   1. pin the renderer's contract values to the schedule's (the leaving
 *      world's through the dissolve, the entering world's from the
 *      settle beat — world-transition.ts);
 *   2. render the field world into an offscreen target — the same two
 *      passes the settled renderer runs, including the braid band;
 *   3. draw a full-viewport quad of that target over the game's own
 *      output, at the transition's field alpha.
 *
 * The quad's shader encodes linear→sRGB because three renders into a
 * plain render target in the working (linear) color space — the encode
 * the default framebuffer would have applied has to happen here.
 */
function TransitionCompositor({
  fieldScene,
  band,
  bandScene,
  bandCamera,
}: {
  fieldScene: THREE.Scene;
  band: WorldBand | null;
  bandScene: THREE.Scene;
  bandCamera: THREE.Camera;
}): null {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  // The field world's camera — the canvas's default perspective camera,
  // which no world's rig contests anymore (the game's ortho makeDefaults
  // inside its own portal).
  const camera = useThree((s) => s.camera);
  const [target] = useState(
    () => new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true }),
  );
  const [quad] = useState(() => {
    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uAlpha: { value: 0 } },
      vertexShader:
        "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: [
        "varying vec2 vUv;",
        "uniform sampler2D uMap;",
        "uniform float uAlpha;",
        // The target holds LINEAR working-space color (three only applies",
        // the output encode on the default framebuffer); this pass is the",
        // encode the screen would have done.",
        "vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }",
        "void main(){",
        "  vec4 t = texture2D(uMap, vUv);",
        "  gl_FragColor = vec4(toSrgb(t.rgb), t.a * uAlpha);",
        "}",
      ].join("\n"),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { scene, cam, material };
  });

  useEffect(() => {
    const w = Math.max(2, Math.round(size.width * dpr));
    const h = Math.max(2, Math.round(size.height * dpr));
    if (target.width !== w || target.height !== h) target.setSize(w, h);
    quad.material.uniforms.uMap.value = target.texture;
  }, [size, dpr, target, quad]);

  useFrame(() => {
    const wt = WORLD_TRANSITION;
    // Pause-mode moves run no dissolve: the world freezes under the shell's
    // DOM blur layer and the field's GL scene never paints (the desk's paper
    // is DOM) — there is nothing for the quad to composite.
    if (!wt.active || wt.mode === "pause") return;
    const pin = contractPinAt(wt.progress, wt.from, wt.to);
    if (gl.toneMapping !== pin.toneMapping) gl.toneMapping = pin.toneMapping;
    gl.shadowMap.enabled = pin.shadowMapEnabled;
    const alpha = fieldLayerAlpha(wt.progress, wt.from);
    if (alpha <= 0) return;
    renderFieldWorld(
      gl,
      size,
      fieldScene,
      camera,
      band,
      bandScene,
      bandCamera,
      target,
      dpr,
    );
    quad.material.uniforms.uAlpha.value = alpha;
    // Blend over the game's composer output — never clear it.
    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.render(quad.scene, quad.cam);
    gl.autoClear = prevAutoClear;
  }, 2);

  // Leave no bound target or scissor behind for the settled renderer.
  useEffect(() => {
    return () => {
      gl.setRenderTarget(null);
      gl.setScissorTest(false);
    };
  }, [gl]);

  return null;
}

/* ------------------------------------------------------------------------ */
/* WorldCanvas                                                               */
/* ------------------------------------------------------------------------ */

export interface WorldCanvasProps {
  /** Which worlds' subtrees are mounted — one while settled, two during a
   *  transition. The contract follows the settled world. */
  worlds: readonly WorldKind[];
  /** Freeze the frame loop while the conversation layer is fullscreen
   *  (§14.1 rule 2): frameloop "never" — pause, never unmount. This wins
   *  over `suspended`: a fullscreen pause over the suspended hotel is
   *  still fully never. */
  paused: boolean;
  /** THE DOCUMENT PAUSE (v0.28 step 1): the steady state after a pause-mode
   *  move — BOTH worlds stay mounted (the game frozen behind the field's
   *  document tier) but no transition is running. The field's GL scene
   *  never paints in this state: the desk/archive content is all DOM and
   *  sits above the shell's blur layer, so the canvas keeps showing exactly
   *  the game's frozen frame — PRESERVED, not redrawn (the field renderer
   *  stays gated and the game's composer is disabled, so no demand frame
   *  repaints it). The contract follows the game (worlds[0]) so the frozen
   *  frame's renderer values stay its own. The frame loop is "demand" here,
   *  not "never": the DOM archive reaches the canvas through drei `<Html>`
   *  portals and its virtual list sets its visible range in a `useFrame`,
   *  so a cold mount and the ref-only scroll gestures need the finite
   *  frames requested through the world-slot channel — while idle the loop
   *  stops and nothing repaints either world. */
  suspended: boolean;
  /** The left band's braid, mounted in the field world only (null in the
   *  game world — the hotel owns the whole viewport). */
  band: WorldBand | null;
}

export function WorldCanvas({
  worlds,
  paused,
  suspended,
  band,
}: WorldCanvasProps): ReactNode {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  // The slots' current scene subtrees — registered per world by the
  // mounted worlds' DOM-side owners through `useWorldScene` (the provider
  // lives ABOVE both of us in the shell, see WorldSceneProvider).
  const nodes = useContext(WorldSceneNodesContext);

  const transitionActive = worlds.length === 2 && !suspended;
  // The settled world's contract applies before its first paint; the
  // compositor owns the renderer for the frames in between. While SUSPENDED
  // no world paints at all — the field renderer is gated and the game's
  // composer is disabled — so the renderer simply keeps the game's contract
  // values (worlds[0]) and the frozen hotel frame is never re-rendered
  // under a foreign mapping.
  const contractWorld: WorldKind | null = transitionActive
    ? null
    : (worlds[0] ?? null);
  // The DPR cap follows the world whose pixels the canvas keeps: the
  // entering world during a DISSOLVE, the leaving/frozen world during a
  // PAUSE move (a DPR change mid-pause would clear the frozen frame — see
  // canvasPolicyWorld), the settled world otherwise.
  const policyWorld: WorldKind | null = canvasPolicyWorld(
    worlds,
    transitionActive,
    WORLD_TRANSITION.active && WORLD_TRANSITION.mode === "pause",
  );
  const { dpr, frameloop } = canvasPolicy(
    policyWorld ?? "field",
    paused,
    suspended,
  );
  const fieldMounted = worlds.includes("field");
  const gameMounted = worlds.includes("game");

  // Stable per-world scenes (see the file note) and the band's braid scene
  // + camera, created once and shared by the settled passes and the
  // transition compositor so both render the SAME objects.
  const [fieldScene] = useState(() => new THREE.Scene());
  const [gameScene] = useState(() => new THREE.Scene());
  const [bandScene] = useState(() => new THREE.Scene());
  const [bandCamera] = useState(() => {
    const c = new THREE.PerspectiveCamera(THREADLINE_FOV, 1, 0.1, 100);
    c.position.z = THREADLINE_BASE_Z;
    return c;
  });

  return (
      <div
        data-world-canvas
        // The canvas is the shell's bottom layer: the band's DOM (scrub
        // lens, fades) and the pane's overlays stack above it by DOM order,
        // and pointer events behave exactly as they did when each world had
        // its own canvas (the card field's gestures bind its own wrapper;
        // neither world raycasts). The world swap's fade is the transition
        // compositor's quad, not a DOM opacity — the canvas stays at full
        // opacity so the two worlds never blank the page behind them.
        className="absolute inset-0 z-0"
      >
        <Canvas
          dpr={dpr}
          frameloop={frameloop}
          // The object form (not a boolean) on purpose: fiber maps an omitted
          // /boolean `shadows` to the deprecated THREE.PCFSoftShadowMap, and
          // its Canvas layout effect re-runs configure() on container resizes
          // (no configured guard) — the world transition's compositor can then
          // re-enable shadow rendering while the deprecated type is set
          // (three 0.185 warns and rewrites it per render). This assigns
          // PCFShadowMap + disabled, the same effective values, with no
          // deprecated write. Live values stay the world contract's (§14.2).
          shadows={{ type: THREE.PCFShadowMap, enabled: false }}
          // The field world's camera — the game's rig `makeDefault`s its own
          // orthographic camera INSIDE the game portal, so the default stays
          // the field's perspective camera at every rung of the swap.
          camera={{ position: [0, 0, camZFor(800)], fov: FIELD_FOV }}
          gl={{ antialias: true, alpha: true }}
          onCreated={(state) => state.gl.setClearColor(0x000000, 0)}
        >
          <WorldContract world={contractWorld} />
          <FrameRequestBridge />
          {fieldMounted && band !== null && (
            <BraidPortal
              band={band}
              bandScene={bandScene}
              bandCamera={bandCamera}
              dark={dark}
            />
          )}
          {fieldMounted && band !== null && (
            <FieldWorldRenderer
              band={band}
              fieldScene={fieldScene}
              bandScene={bandScene}
              bandCamera={bandCamera}
              gated={transitionActive || suspended}
            />
          )}
          {transitionActive && (
            <TransitionCompositor
              fieldScene={fieldScene}
              band={band}
              bandScene={bandScene}
              bandCamera={bandCamera}
            />
          )}
          {/* The two world scenes — each in its own THREE.Scene, always
              portaled (see the file note). A world's subtree is whatever its
              owner last registered; null while that world is unmounted. */}
          {createPortal(nodes.field, fieldScene, { scene: fieldScene })}
          {createPortal(nodes.game, gameScene, { scene: gameScene })}
        </Canvas>
      </div>
  );
}
