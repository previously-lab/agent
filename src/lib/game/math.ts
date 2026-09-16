/**
 * Shared scalar math for the game modules (terrain, corridor, space).
 * Pure, no dependencies. lerpAngle stays in game-canvas.tsx — it is not
 * shared.
 */

/** Scalar smoothstep: 0 below e0, 1 above e1, cubic fade between. */
export function smoothstep(e0: number, e1: number, t: number): number {
  const x = Math.min(1, Math.max(0, (t - e0) / (e1 - e0)));
  return x * x * (3 - 2 * x);
}
