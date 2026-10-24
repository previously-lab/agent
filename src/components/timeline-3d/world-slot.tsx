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
 *
 * THE FRAME-REQUEST CHANNEL. The canvas's frame cadence is no longer
 * unconditionally "always" (canvasPolicy in world-contract.ts): a
 * fullscreen pause stops the loop entirely, the document pause runs it on
 * demand. React commits still reach the canvas (fiber invalidates on store
 * changes), but a DOM owner's gesture handlers that write ONLY refs — the
 * archive field's wheel/touch/keyboard, whose easing lives in a useFrame —
 * never produce a commit, so under "demand" they could never start the
 * loop. `useWorldScene` therefore returns a stable `requestFrame` the
 * owner calls after mutating its refs; it reaches the R3F `invalidate`
 * the canvas's bridge registered here, and is a no-op while the canvas
 * has not registered (owners outside the canvas) or has unregistered.
 * Requesting a frame is always safe: "never" drops it, "demand" schedules
 * one, "always" needs none.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

/**
 * The frame-request channel between the DOM owners and the canvas. Both
 * functions are stable for the provider's lifetime; the registered
 * callback itself lives in a ref, so registering/unregistering never
 * re-renders anyone.
 */
export interface WorldFrameChannel {
  /**
   * Ask the canvas for one frame. A no-op until the canvas's bridge
   * registers, and again after it unregisters — the owner must never
   * assume the canvas is listening.
   */
  requestFrame: () => void;
  /**
   * Canvas-side only: install (or, with null, clear) the callback
   * `requestFrame` forwards to — the R3F `invalidate`.
   */
  registerFrameRequest: (frameRequest: (() => void) | null) => void;
}

const NOOP_FRAME_CHANNEL: WorldFrameChannel = {
  requestFrame: () => undefined,
  registerFrameRequest: () => undefined,
};

const WorldFrameChannelContext =
  createContext<WorldFrameChannel>(NOOP_FRAME_CHANNEL);

export function WorldSceneProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [nodes, setNodes] = useState<WorldSceneNodes>(EMPTY_NODES);
  const setWorldScene = useCallback<SetWorldScene>((world, node) => {
    setNodes((prev) => ({ ...prev, [world]: node }));
  }, []);
  const frameRequestRef = useRef<(() => void) | null>(null);
  const frameChannel = useMemo<WorldFrameChannel>(() => {
    return {
      requestFrame: () => {
        frameRequestRef.current?.();
      },
      registerFrameRequest: (frameRequest) => {
        frameRequestRef.current = frameRequest;
      },
    };
  }, []);
  return (
    <WorldSceneSetContext.Provider value={setWorldScene}>
      <WorldSceneNodesContext.Provider value={nodes}>
        <WorldFrameChannelContext.Provider value={frameChannel}>
          {children}
        </WorldFrameChannelContext.Provider>
      </WorldSceneNodesContext.Provider>
    </WorldSceneSetContext.Provider>
  );
}

/**
 * Canvas-side bridge: install `frameRequest` (typically R3F's `invalidate`)
 * as the channel's target for the component's lifetime. Unmounting clears
 * the registration so stale invalidates can never reach a dead store.
 */
export function useWorldFrameRegistration(
  frameRequest: (() => void) | null,
): void {
  const { registerFrameRequest } = useContext(WorldFrameChannelContext);
  useEffect(() => {
    registerFrameRequest(frameRequest);
    return () => registerFrameRequest(null);
  }, [registerFrameRequest, frameRequest]);
}

/**
 * The channel's stable `requestFrame` — for DOM owners that must ask for
 * frames before (or without) registering their scene through
 * `useWorldScene` (e.g. gesture effects that run earlier in the component
 * body). Returns the same function `useWorldScene` returns.
 */
export function useWorldFrameRequest(): () => void {
  const { requestFrame } = useContext(WorldFrameChannelContext);
  return requestFrame;
}

/**
 * Register the caller's R3F subtree as one world's scene. Called by the
 * DOM-side owner of a world (CardField → "field", GameCanvas → "game") on
 * every render; the cleanup clears that world's slot on unmount so a
 * leaving world never paints one extra frame. Returns the channel's
 * stable `requestFrame` — call it after ref-only mutations (scroll
 * gestures) so the canvas's loop advances under "demand"; owners that
 * never need it may ignore the return value.
 */
export function useWorldScene(world: WorldKind, node: ReactNode): () => void {
  const setWorldScene = useContext(WorldSceneSetContext);
  const requestFrame = useWorldFrameRequest();
  useEffect(() => {
    setWorldScene(world, node);
    return () => setWorldScene(world, null);
  });
  return requestFrame;
}
