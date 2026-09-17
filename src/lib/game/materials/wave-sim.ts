/**
 * Interactive water dynamics — the discrete 2D wave equation on a height
 * field, PURE (no three imports) so the exact math that ships is unit-
 * testable. The three-coupled half (texture upload, fixed-step driver)
 * lives in wave-driver.ts; the shading consumer is water-surface.ts.
 *
 * WHY CPU, NOT GPU PING-PONG. The research brief recommends the classic
 * two-FBO ping-pong (GPUComputationRenderer lineage). At 128² = 16 384
 * texels the update is ~80k FLOPs — under 0.1 ms on any CPU — while a GPU
 * version would need the WebGLRenderer handle at construction, half-float
 * render-target + filtering support checks, and shader code the test suite
 * cannot reach. The grid is far too small to justify any of that; the one
 * honest cost is a 32 KB half-float upload per stepped frame, noise next
 * to the scene's N8AO pass. Determinism is a bonus: motion may read the
 * clock, and this sim is a pure function of its impulse history.
 *
 * THE SCHEME (Evan Wallace's WebGL Water / the GPUComputationRenderer
 * waves example): h' = 2h − h_prev + c²·∇²h over the 4-neighbour
 * laplacian, then damping, then a height clamp. Boundaries are REFLECTIVE
 * (Neumann: missing neighbours read the cell itself), which is the correct
 * model for pool walls — waves bounce off the basin edges instead of
 * leaking out. Stability for this explicit scheme in 2D needs c² ≤ 0.5;
 * WAVE_C2 = 0.24 keeps a wide margin so impulses of any legal amplitude
 * can never blow the field up.
 */

/** Sim grid edge in texels. A few-meter pool puts a texel at 3–5 cm —
 *  fine enough for wading ripples, cheap enough to step every frame. */
export const WAVE_SIM_SIZE = 128;

/**
 * c² in h' = 2h − h_prev + c²·∇²h. 0.24 ⇒ a wavefront advances ≈ 0.49
 * texel per step (the CFL ceiling for this scheme is c² = 0.5). At the
 * driver's 60 Hz step that is ≈ 29 texels/s ≈ 1.5 m/s on a 7 m pool —
 * the right ballpark for shallow-water capillary-gravity waves at game
 * scale.
 */
export const WAVE_C2 = 0.24;

/**
 * Per-step amplitude retention. 0.992 rings a footstep down in ~2–3 s
 * (0.992^180 ≈ 0.24) while staying lossless enough for waves to cross the
 * pool and reflect off the far wall — a pool, not a puddle.
 */
export const WAVE_DAMPING = 0.992;

/**
 * Absolute height clamp in meters. Bounds the sim against stacked
 * impulses (a jumping player plus a prop splash) so normals never turn
 * into spikes; physical wading amplitudes stay well under it.
 */
export const WAVE_MAX_HEIGHT = 0.5;

/**
 * Amplitude below which the whole field counts as calm — the driver
 * sleeps (stops stepping and uploading) once every texel is under this
 * and no impulses arrive. 1 mm is far below visible shading.
 */
export const WAVE_CALM_THRESHOLD = 0.001;

/** One height field: current and previous heights, plus a scratch buffer
 *  the step writes into before rotation. Heights are in meters. */
export interface WaveField {
  readonly size: number;
  curr: Float32Array;
  prev: Float32Array;
  next: Float32Array;
}

export function createWaveField(size: number = WAVE_SIM_SIZE): WaveField {
  return {
    size,
    curr: new Float32Array(size * size),
    prev: new Float32Array(size * size),
    next: new Float32Array(size * size),
  };
}

/**
 * Advance the field one step. Returns the largest |h| in the new field so
 * the driver can sleep when the pool has rung down (WAVE_CALM_THRESHOLD).
 */
export function stepWaveField(field: WaveField): number {
  const { size, curr, prev, next } = field;
  let maxAbs = 0;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const rowUp = y > 0 ? row - size : row;
    const rowDown = y < size - 1 ? row + size : row;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      // Reflective boundaries: out-of-range neighbours read the cell
      // itself, so the laplacian's edge flux is zero and waves bounce.
      const left = curr[x > 0 ? i - 1 : i];
      const right = curr[x < size - 1 ? i + 1 : i];
      const up = curr[rowUp + x];
      const down = curr[rowDown + x];
      let h =
        (2 * curr[i] - prev[i] + WAVE_C2 * (left + right + up + down - 4 * curr[i])) *
        WAVE_DAMPING;
      if (h > WAVE_MAX_HEIGHT) h = WAVE_MAX_HEIGHT;
      else if (h < -WAVE_MAX_HEIGHT) h = -WAVE_MAX_HEIGHT;
      next[i] = h;
      const a = h < 0 ? -h : h;
      if (a > maxAbs) maxAbs = a;
    }
  }
  // Rotate: next becomes current, current becomes the new previous, and
  // the old previous is reused as the next scratch (no allocation).
  field.prev = curr;
  field.curr = next;
  field.next = prev;
  return maxAbs;
}

/**
 * Add one radial-Gaussian impulse to the current field (a footstep, a
 * prop splash). `u`/`v` are sim UV in [0,1], `radiusTexels` the Gaussian
 * sigma in texels, `amplitude` the peak height in meters (negative = a
 * foot pressing water down, positive = a splash-back). Adding to `curr`
 * only is the Evan Wallace convention: the displacement then propagates
 * on the following steps.
 */
export function splatImpulse(
  field: WaveField,
  u: number,
  v: number,
  radiusTexels: number,
  amplitude: number,
): void {
  const { size, curr } = field;
  const cx = u * (size - 1);
  const cy = v * (size - 1);
  const sigma = Math.max(radiusTexels, 0.5);
  // 3σ carries >98% of the Gaussian's energy; skip the rest of the grid.
  const reach = Math.ceil(sigma * 3);
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(size - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(size - 1, Math.ceil(cy + reach));
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      curr[y * size + x] += amplitude * Math.exp(-(dx * dx + dy * dy) * inv2s2);
    }
  }
}

/** The water rectangle the sim is stretched over (space-local meters). */
export interface WaveSimRect {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

/**
 * Space-local (x, z) → sim UV, matching the renderer's water plane
 * (planeGeometry rotated −π/2 about X at position z = cz): the plane's
 * local +y (uv v = 1) lands on world z = cz − halfZ, so v is FLIPPED
 * against +z. Both the impulse injection and the shader's height sample
 * use this same uv, so the mapping stays self-consistent; callers must
 * use this helper rather than a naive (x−cx)/2halfX + 0.5 on both axes.
 */
export function waveUvForLocal(
  x: number,
  z: number,
  rect: WaveSimRect,
): { u: number; v: number } {
  return {
    u: 0.5 + (x - rect.cx) / (2 * rect.halfX),
    v: 0.5 - (z - rect.cz) / (2 * rect.halfZ),
  };
}

/** True when (x, z) lies over the water rectangle (inside = worth an
 *  impulse; a splash exactly on the deck edge is clamped by splatImpulse's
 *  window anyway). */
export function waveRectContains(
  x: number,
  z: number,
  rect: WaveSimRect,
): boolean {
  return (
    Math.abs(x - rect.cx) <= rect.halfX && Math.abs(z - rect.cz) <= rect.halfZ
  );
}
