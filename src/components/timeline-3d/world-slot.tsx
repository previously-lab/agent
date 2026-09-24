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
 *
 * ONE SLOT PER WORLD. The transition primitive (world-transition.ts) keeps
 * BOTH worlds mounted while the camera moves between them, so the slot is
 * a pair: each owner registers under its own kind and the canvas renders
 * whichever nodes are present — one when a world is settled, two mid-
 * transition. `useWorldScene` takes the kind explicitly (CardField is
 * always "field", GameCanvas always "game").
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { WorldKind } from "./world-contract";

export interface WorldSceneNodes {
  field: ReactNode;
  game: ReactNode;
}

const EMPTY_NODES: WorldSceneNodes = { field: null, game: null };

type SetWorldScene = (world: WorldKind, node: ReactNode) => void;

const WorldSceneSetContext = createContext<SetWorldScene>(() => undefined);
/** Read by WorldCanvas only. */
export const WorldSceneNodesContext = createContext<WorldSceneNodes>(EMPTY_NODES);

export function WorldSceneProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [nodes, setNodes] = useState<WorldSceneNodes>(EMPTY_NODES);
  const setWorldScene = useCallback<SetWorldScene>((world, node) => {
    setNodes((prev) => ({ ...prev, [world]: node }));
  }, []);
  return (
    <WorldSceneSetContext.Provider value={setWorldScene}>
      <WorldSceneNodesContext.Provider value={nodes}>
        {children}
      </WorldSceneNodesContext.Provider>
    </WorldSceneSetContext.Provider>
  );
}

/**
 * Register the caller's R3F subtree as one world's scene. Called by the
 * DOM-side owner of a world (CardField → "field", GameCanvas → "game") on
 * every render; the cleanup clears that world's slot on unmount so a
 * leaving world never paints one extra frame.
 */
export function useWorldScene(world: WorldKind, node: ReactNode): void {
  const setWorldScene = useContext(WorldSceneSetContext);
  useEffect(() => {
    setWorldScene(world, node);
    return () => setWorldScene(world, null);
  });
}
