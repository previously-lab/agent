/**
 * A suspended canvas normally preserves the game's last frame. A resize or
 * DPR write clears that buffer, so the game may repaint its frozen scene once.
 * Observing a size is not proof of painting it: only markPainted settles the
 * debt, after the composer has returned successfully.
 *
 * Cold suspended mounts also need one paint, after their static frame setup.
 * The adapter runs after game subscribers, then requests a finite follow-up
 * frame so the field's DOM portals can finish their independent React commit.
 */
export interface FrozenFrameGeometry {
  /** CSS pixels, matching the EffectComposer wrapper's setSize arguments. */
  width: number;
  height: number;
  dpr: number;
}

export function frozenFrameGeometryChanged(
  previous: FrozenFrameGeometry | null,
  next: FrozenFrameGeometry,
): boolean {
  return previous !== null && (
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.dpr !== next.dpr
  );
}

export interface FrozenFrameComposer {
  setSize(width: number, height: number): void;
  render(deltaTime: number): void;
}

export interface FrozenFrameRenderer {
  autoClear: boolean;
  getRenderTarget(): unknown;
  setRenderTarget(target: unknown): void;
  getScissorTest(): boolean;
  setScissorTest(enabled: boolean): void;
}

/** Paint through the original postprocessing chain without advancing it. */
export function renderFrozenComposerOnce(
  gl: FrozenFrameRenderer,
  composer: FrozenFrameComposer,
  size: Readonly<Pick<FrozenFrameGeometry, "width" | "height">>,
): void {
  const prevAutoClear = gl.autoClear;
  const prevTarget = gl.getRenderTarget();
  const prevScissorTest = gl.getScissorTest();
  try {
    gl.autoClear = true;
    gl.setScissorTest(false);
    composer.setSize(size.width, size.height);
    composer.render(0);
  } finally {
    gl.autoClear = prevAutoClear;
    gl.setRenderTarget(prevTarget);
    gl.setScissorTest(prevScissorTest);
  }
}

export type FrozenFrameRepaintDecision = "paint" | "defer" | "none";

export interface FrozenFrameRepaintPlanner {
  /** Observe active geometry without claiming that a frame has rendered. */
  syncActive(geometry: FrozenFrameGeometry): void;
  /** Call only AFTER a successful normal or manual composer paint. */
  markPainted(geometry: FrozenFrameGeometry): void;
  /**
   * Planning does not consume a repaint. Until markPainted, repeated checks
   * keep returning paint/defer, including across resume and another pause.
   * sceneReady may be false before the cold static initialization frame.
   */
  planSuspended(
    geometry: FrozenFrameGeometry,
    composerReady: boolean,
    sceneReady?: boolean,
  ): FrozenFrameRepaintDecision;
}

export function createFrozenFrameRepaintPlanner(): FrozenFrameRepaintPlanner {
  let observedGeometry: FrozenFrameGeometry | null = null;
  let lastPaintedGeometry: FrozenFrameGeometry | null = null;
  let bufferInvalidated = false;

  const observe = (geometry: FrozenFrameGeometry): void => {
    // A -> B -> A still clears the canvas, even though its final dimensions
    // match the last paint. Keep that debt until an actual render pays it.
    if (frozenFrameGeometryChanged(observedGeometry, geometry)) {
      bufferInvalidated = true;
    }
    observedGeometry = { ...geometry };
  };

  return {
    syncActive: observe,
    markPainted(geometry) {
      lastPaintedGeometry = { ...geometry };
      observedGeometry = { ...geometry };
      bufferInvalidated = false;
    },
    planSuspended(geometry, composerReady, sceneReady = true) {
      observe(geometry);
      const needsPaint = lastPaintedGeometry === null || bufferInvalidated ||
        frozenFrameGeometryChanged(lastPaintedGeometry, geometry);
      if (!needsPaint) return "none";
      if (!composerReady || !sceneReady || geometry.width <= 0 || geometry.height <= 0) {
        return "defer";
      }
      return "paint";
    },
  };
}

/**
 * Demand frames must straddle the DOM portal commit: one computes the
 * virtual range, the deferred one projects the resulting Html nodes. The
 * injected scheduler keeps this finite sequence testable without a browser.
 */
export function requestFrozenLayoutFrames(
  invalidate: () => void,
  schedule: (callback: () => void) => number,
  cancel: (handle: number) => void,
): () => void {
  let active = true;
  invalidate();
  const handle = schedule(() => {
    if (active) invalidate();
  });
  return () => {
    active = false;
    cancel(handle);
  };
}
