"use client";

/**
 * WorldCanvas (v0.11 §13.2/§14) — THE one `<Canvas>` of the app. It carries
 * two worlds, of which exactly ONE is mounted at a time:
 *
 *   - "field"  the 2.5D catalog — the card field's scene (delivered through
 *              the world slot, see below) plus the left band's threadline
 *              braid, which used to be its OWN canvas
 *              (`threadline-scene.tsx`). Both now render here: the braid
 *              lives in a separate THREE.Scene reached by `createPortal`
 *              (with its own camera and a band-sized `size` override, so the
 *              rig reads the strip's dimensions exactly as it did when it
 *              owned a canvas), and a priority-1 frame subscriber renders
 *              the two passes — the main scene full-width, then the braid
 *              scissored into the band strip.
 *   - "game"   the hotel — its subtree arrives through the same slot and
 *              brings its own EffectComposer (which takes over rendering
 *              while it is mounted, same as it did on its own canvas).
 *
 * THE WORLD SLOT. The scenes are built by components that live OUTSIDE this
 * canvas in the DOM tree (CardField owns the card field's state, GameCanvas
 * the game's), so they cannot be Canvas children. `useWorldScene(node)`
 * (world-slot.tsx) hands the current world's scene subtree to the canvas;
 * re-registering on every render is cheap (an element is a description, and
 * the producer only re-renders when its own state changes).
 *
 * THE CONTRACT (§14.2) — `world-contract.ts`: tone mapping, shadow map,
 * scene background/fog are renderer-level now. WorldContract applies the
 * world's values in a LAYOUT effect (before the world's first frame paints)
 * and restores on exit.
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
import { applyWorldContract, type WorldKind } from "./world-contract";
import { WorldSceneNodeContext } from "./world-slot";
import {
  THREADLINE_BASE_Z,
  THREADLINE_FOV,
  ThreadlineRig,
  type ThreadlineSceneProps,
} from "./threadline-scene";

/* ------------------------------------------------------------------------ */
/* The world slot — contexts and the provider live in `world-slot.tsx` (the  */
/* shell statically imports them; this module is the dynamic chunk).         */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* The contract (renderer-level world state, §14.2)                          */
/* ------------------------------------------------------------------------ */

function WorldContract({ world }: { world: WorldKind }): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  // Layout effect: the renderer values are in place before the entering
  // world's first frame can paint with the other world's atmosphere.
  useLayoutEffect(() => applyWorldContract({ gl, scene }, world), [
    world,
    gl,
    scene,
  ]);
  return null;
}

/* ------------------------------------------------------------------------ */
/* The field world's renderer: main scene + the band's braid, two passes     */
/* ------------------------------------------------------------------------ */

export interface WorldBand extends ThreadlineSceneProps {
  /** The band strip's left edge, px from the canvas's left (the rail's
   *  margin) — the braid renders scissored to `[x, x + width]`. */
  x: number;
  /** The strip's width in CSS px (the tier's `railW`). */
  width: number;
}

function FieldWorldRenderer({
  band,
  dark,
}: {
  band: WorldBand;
  dark: boolean;
}): ReactNode {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  // The braid's own scene and camera — the same camera the standalone canvas
  // created (fov 30 parked at z=9), now one object instead of one canvas.
  const [bandScene] = useState(() => new THREE.Scene());
  const [bandCamera] = useState(() => {
    const camera = new THREE.PerspectiveCamera(THREADLINE_FOV, 1, 0.1, 100);
    camera.position.z = THREADLINE_BASE_Z;
    return camera;
  });

  // The two passes. Priority 1, which switches R3F's automatic render off —
  // this subscriber IS the field world's render. The main pass paints the
  // card field full-width; the band pass then clears and paints only the
  // strip (scissor bounds the clear as well as the draw), so the braid sits
  // over whatever the main pass left there — exactly the stacking the two
  // canvases had.
  useFrame(({ gl, scene, camera }) => {
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    gl.render(scene, camera);
    gl.setViewport(band.x, 0, band.width, size.height);
    gl.setScissor(band.x, 0, band.width, size.height);
    gl.setScissorTest(true);
    gl.render(bandScene, bandCamera);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
  }, 1);

  // Leave the renderer the way the automatic path expects it: no scissor.
  // Without this the NEXT world (or a remount) inherits a clipped frame.
  useEffect(() => {
    return () => {
      gl.setScissorTest(false);
    };
  }, [gl]);

  // The braid renders through a portal with its own camera and a size
  // override the strip's width, so ThreadlineRig's `useThree` reads exactly
  // the dimensions its standalone canvas used to report.
  return createPortal(
    <ThreadlineRig
      strands={band.strands}
      selected={band.selected}
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

/* ------------------------------------------------------------------------ */
/* WorldCanvas                                                               */
/* ------------------------------------------------------------------------ */

export interface WorldCanvasProps {
  /** Which world's subtree is mounted — the contract follows this. */
  world: WorldKind;
  /** Freeze the frame loop while the conversation layer is fullscreen
   *  (§14.1 rule 2): pause, never unmount. */
  paused: boolean;
  /** The left band's braid, mounted in the field world only (null in the
   *  game world — the hotel owns the whole viewport). */
  band: WorldBand | null;
}

export function WorldCanvas({
  world,
  paused,
  band,
}: WorldCanvasProps): ReactNode {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  // The slot's current scene subtree — registered by the mounted world's
  // DOM-side owner through `useWorldScene` (the provider lives ABOVE both of
  // us in the shell, see WorldSceneProvider).
  const worldScene = useContext(WorldSceneNodeContext);

  return (
      <div
        data-world-canvas
        // The canvas is the shell's bottom layer: the band's DOM (scrub
        // lens, fades) and the pane's overlays stack above it by DOM order,
        // and pointer events behave exactly as they did when each world had
        // its own canvas (the card field's gestures bind its own wrapper;
        // neither world raycasts).
        className="absolute inset-0 z-0"
      >
        <Canvas
          dpr={[1, 2]}
          frameloop={paused ? "never" : "always"}
          // The field world's camera — the game's rig `makeDefault`s its own
          // orthographic camera while that world is up, and drei restores
          // this one on the way back. The field's frame loop rewrites
          // position every frame; this only covers the frame before it
          // starts.
          camera={{ position: [0, 0, camZFor(800)], fov: FIELD_FOV }}
          gl={{ antialias: true, alpha: true }}
          onCreated={(state) => state.gl.setClearColor(0x000000, 0)}
        >
          <WorldContract world={world} />
          {world === "field" && band !== null && (
            <FieldWorldRenderer band={band} dark={dark} />
          )}
          {worldScene}
        </Canvas>
      </div>
  );
}
