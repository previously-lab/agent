"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { camZFor } from "@/lib/timeline3d/camera";

/**
 * The -scene recipe variant's frame — the minimal real R3F setup the app's
 * papers actually live in (desk-field / row-group): one Canvas, fov 30,
 * camera distance `camZFor(H)` so one world unit is one CSS px, dpr [1,2],
 * and ONE `<Html transform center distanceFactor={400}>` billboard. A pure
 * DOM stage can lie about AA, scaling and stacking — this frame cannot.
 *
 * The board behind the canvas is a DOM sheet (bg-paper) because the board is
 * paper; only the sheet stack is projected, as in the desk.
 */
export function SceneFrame({
  worldHeight,
  contentWidth,
  contentHeight,
  children,
}: {
  worldHeight: number;
  contentWidth: number;
  contentHeight: number;
  children: ReactNode;
}) {
  const camZ = camZFor(worldHeight);
  return (
    <div className="lab-scene" style={{ height: worldHeight }}>
      <Canvas
        dpr={[1, 2]}
        // "always", not "demand": drei <Html> positions its portal each
        // frame and a demand loop can leave a portal unpositioned (hidden) —
        // the app itself runs an always loop (world-canvas).
        frameloop="always"
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, 0, camZ], fov: 30 }}
      >
        <Html
          transform
          center
          distanceFactor={400}
          zIndexRange={[30, 21]}
          pointerEvents="none"
        >
          <div
            className="lab-scene-content"
            style={{ width: contentWidth, height: contentHeight }}
          >
            {children}
          </div>
        </Html>
      </Canvas>
    </div>
  );
}

/** Reads the <html> theme class so scene-only values (e.g. the desk table
 *  plane's GL colour, which CSS tokens cannot reach) follow the theme. */
export function useLabDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = (): void => setDark(root.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}
