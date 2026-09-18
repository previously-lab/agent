"use client";

/**
 * The world slot (v0.11 §14) — the registration channel between the ONE
 * shared canvas (`world-canvas.tsx`) and the worlds' DOM-side owners
 * (CardField, GameCanvas). A separate module because the canvas is a
 * dynamic-imported chunk while the owners are statically imported by the
 * shell: if the contexts lived in the canvas module, the owners' static
 * `useWorldScene` import would pull the whole three/Canvas chunk into the
 * main bundle, defeating §13.2's split.
 *
 * THE PROVIDER MUST SIT ABOVE BOTH. The owners are SIBLINGS of the canvas
 * in the shell's DOM tree — a provider rendered inside WorldCanvas would
 * leave them reading the default no-op setter, and their scenes would
 * silently never reach the canvas (that was the v0.11 merge's first bug:
 * an empty field and a white hotel with zero console errors).
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type SetWorldScene = (node: ReactNode) => void;

const WorldSceneSetContext = createContext<SetWorldScene>(() => undefined);
/** Read by WorldCanvas only. */
export const WorldSceneNodeContext = createContext<ReactNode>(null);

export function WorldSceneProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [worldScene, setWorldScene] = useState<ReactNode>(null);
  return (
    <WorldSceneSetContext.Provider value={setWorldScene}>
      <WorldSceneNodeContext.Provider value={worldScene}>
        {children}
      </WorldSceneNodeContext.Provider>
    </WorldSceneSetContext.Provider>
  );
}

/**
 * Register the caller's R3F subtree as THE mounted world's scene. Called by
 * the DOM-side owner of a world (CardField, GameCanvas) on every render;
 * the cleanup clears the slot on unmount so a leaving world never paints
 * one extra frame.
 */
export function useWorldScene(node: ReactNode): void {
  const setWorldScene = useContext(WorldSceneSetContext);
  useEffect(() => {
    setWorldScene(node);
    return () => setWorldScene(null);
  });
}
