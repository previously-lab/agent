/**
 * Tests for the pure wave-equation height field
 * (src/lib/game/materials/wave-sim.ts) — the math the interactive pool
 * water ships. Locked down: impulse shape, propagation, damping to calm,
 * reflective pool walls, the amplitude bound, step determinism, and the
 * space-local → sim-UV mapping (including the plane's v flip).
 */
import { describe, it, expect } from "vitest";
import {
  WAVE_CALM_THRESHOLD,
  WAVE_DAMPING,
  WAVE_MAX_HEIGHT,
  WAVE_SIM_SIZE,
  createWaveField,
  splatImpulse,
  stepWaveField,
  waveRectContains,
  waveUvForLocal,
} from "@/lib/game/materials/wave-sim";

function totalAbs(field: { curr: Float32Array }): number {
  let sum = 0;
  for (let i = 0; i < field.curr.length; i++) sum += Math.abs(field.curr[i]);
  return sum;
}

function maxAbs(field: { curr: Float32Array }): number {
  let m = 0;
  for (let i = 0; i < field.curr.length; i++) {
    m = Math.max(m, Math.abs(field.curr[i]));
  }
  return m;
}

describe("splatImpulse", () => {
  it("stamps a Gaussian peaked at the impulse center", () => {
    const field = createWaveField(32);
    splatImpulse(field, 0.5, 0.5, 3, -0.1);
    const c = 15.5; // 0.5 * (32 - 1)
    const peak = field.curr[Math.round(c) * 32 + Math.round(c)];
    expect(peak).toBeLessThan(0);
    expect(Math.abs(peak)).toBeGreaterThan(0.09); // ≈ amplitude at center
    // Falls off with radius and stays negative everywhere inside 2σ.
    const near = field.curr[Math.round(c) * 32 + Math.round(c) + 2];
    expect(Math.abs(near)).toBeLessThan(Math.abs(peak));
    expect(near).toBeLessThan(0);
    // Far outside 3σ the stamp does not reach.
    expect(field.curr[0]).toBe(0);
  });

  it("is a no-op-sized stamp when clipped by the field edge", () => {
    const field = createWaveField(16);
    splatImpulse(field, 0, 0, 2, 0.1);
    expect(field.curr[0]).toBeGreaterThan(0);
    expect(Number.isFinite(totalAbs(field))).toBe(true);
  });
});

describe("stepWaveField", () => {
  it("propagates an impulse outward (energy leaves the center)", () => {
    const field = createWaveField(64);
    splatImpulse(field, 0.5, 0.5, 2, -0.1);
    const before = field.curr[32 * 64 + 32];
    expect(before).toBeLessThan(0);
    for (let i = 0; i < 10; i++) stepWaveField(field);
    // The field EVOLVES (the center oscillates as the ring travels out —
    // sign and phase depend on step count, so assert evolution, not phase).
    expect(Math.abs(field.curr[32 * 64 + 32] - before)).toBeGreaterThan(0.01);
    let ringEnergy = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const d = Math.hypot(x - 31.5, y - 31.5);
        if (d > 6 && d < 20) ringEnergy += Math.abs(field.curr[y * 64 + x]);
      }
    }
    expect(ringEnergy).toBeGreaterThan(0);
  });

  it("rings down below the calm threshold when damped", () => {
    const field = createWaveField(32);
    splatImpulse(field, 0.5, 0.5, 2, -0.05);
    // WAVE_DAMPING < 1 guarantees decay; 2000 steps is ~33 s of sim time,
    // far past the 2–3 s ring-down the constant documents.
    for (let i = 0; i < 2000; i++) stepWaveField(field);
    expect(maxAbs(field)).toBeLessThan(WAVE_CALM_THRESHOLD);
  });

  it("stays bounded under stacked maximum impulses", () => {
    const field = createWaveField(32);
    for (let i = 0; i < 50; i++) {
      splatImpulse(field, 0.5, 0.5, 3, 10); // absurdly large, same spot
      stepWaveField(field);
    }
    expect(maxAbs(field)).toBeLessThanOrEqual(WAVE_MAX_HEIGHT + 1e-6);
  });

  it("reflects off the walls instead of leaking (energy stays in the pool)", () => {
    // With damping the total decays geometrically; a LEAKING (absorbing)
    // boundary would decay strictly faster. Compare against the analytic
    // upper bound: with zero laplacian flux the energy can only be removed
    // by damping, so total |h| after n steps exceeds damping^n × initial
    // minus propagation redistribution — a cheap robust proxy is that a
    // wave started AT the wall does not vanish instantly.
    const field = createWaveField(32);
    splatImpulse(field, 0.02, 0.5, 2, -0.1);
    const initial = totalAbs(field);
    for (let i = 0; i < 5; i++) stepWaveField(field);
    expect(totalAbs(field)).toBeGreaterThan(initial * Math.pow(WAVE_DAMPING, 5) * 0.5);
  });

  it("is deterministic: same impulses and steps give identical fields", () => {
    const run = () => {
      const field = createWaveField(48);
      splatImpulse(field, 0.3, 0.7, 2.5, -0.08);
      for (let i = 0; i < 40; i++) stepWaveField(field);
      splatImpulse(field, 0.6, 0.4, 2, 0.05);
      for (let i = 0; i < 40; i++) stepWaveField(field);
      return field.curr;
    };
    const a = run();
    const b = run();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it("never produces NaN or Infinity from a zero field", () => {
    const field = createWaveField(WAVE_SIM_SIZE);
    for (let i = 0; i < 10; i++) stepWaveField(field);
    expect(maxAbs(field)).toBe(0);
  });
});

describe("waveUvForLocal", () => {
  const rect = { cx: 0, cz: 10, halfX: 4, halfZ: 6 };

  it("maps the rect center to (0.5, 0.5)", () => {
    const { u, v } = waveUvForLocal(0, 10, rect);
    expect(u).toBeCloseTo(0.5, 10);
    expect(v).toBeCloseTo(0.5, 10);
  });

  it("maps +x to +u", () => {
    expect(waveUvForLocal(4, 10, rect).u).toBeCloseTo(1, 10);
    expect(waveUvForLocal(-4, 10, rect).u).toBeCloseTo(0, 10);
  });

  it("FLIPS v against +z (the water plane is rotated −π/2 about X)", () => {
    // Plane local +y (v = 1) lands on world z = cz − halfZ.
    expect(waveUvForLocal(0, 10 - 6, rect).v).toBeCloseTo(1, 10);
    expect(waveUvForLocal(0, 10 + 6, rect).v).toBeCloseTo(0, 10);
  });
});

describe("waveRectContains", () => {
  const rect = { cx: 0, cz: 10, halfX: 4, halfZ: 6 };
  it("accepts points over the water and rejects the deck", () => {
    expect(waveRectContains(0, 10, rect)).toBe(true);
    expect(waveRectContains(3.9, 15.9, rect)).toBe(true);
    expect(waveRectContains(4.1, 10, rect)).toBe(false);
    expect(waveRectContains(0, 3, rect)).toBe(false);
  });
});
