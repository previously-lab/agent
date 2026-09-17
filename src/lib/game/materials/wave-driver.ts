/**
 * three-coupled driver for the wave-equation height field (pure math in
 * wave-sim.ts): owns the HalfFloat DataTexture the water material
 * samples, steps the sim on a fixed 60 Hz accumulator, uploads on change,
 * and sleeps when the pool is calm.
 *
 * TEXTURE. R-channel half float, linear-filtered, NO mipmaps — the one
 * deliberate deviation from the library's applyTextureSampling policy:
 * that policy regenerates the full mip chain on every upload, which is
 * pure waste for a texture rewritten every stepped frame (and mip 0 is
 * the only level the water shader's central differences ever want, at
 * 1:1 sim resolution). Half float because linear filtering of 32-bit
 * float textures needs OES_texture_float_linear, while half-float
 * filtering is core WebGL2.
 *
 * SLEEP. With no impulses for WAVE_SLEEP_STEPS consecutive steps and the
 * field under WAVE_CALM_THRESHOLD everywhere, stepping and uploading stop
 * entirely — a calm pool costs zero per frame. Any impulse wakes it.
 */

import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from "three";
import {
  WAVE_CALM_THRESHOLD,
  WAVE_SIM_SIZE,
  createWaveField,
  splatImpulse,
  stepWaveField,
  waveRectContains,
  waveUvForLocal,
  type WaveField,
  type WaveSimRect,
} from "./wave-sim";

/** Fixed sim rate: wave speed (WAVE_C2) is tuned per-step, so the step
 *  rate must be fixed for the physics to read identically at any display
 *  refresh. 60 Hz matches the tuning in wave-sim.ts. */
export const WAVE_STEP_HZ = 60;

/** Steps without impulses before a calm field may sleep (~2 s at 60 Hz). */
export const WAVE_SLEEP_STEPS = 120;

/** Default footstep impulse: a wading step presses the surface down
 *  ~8 cm across a ~20 cm radius — exaggerated past the physical few mm
 *  so the ring reads at the fixed camera, bounded by WAVE_MAX_HEIGHT. */
export const WAVE_STEP_AMPLITUDE = -0.08;
export const WAVE_STEP_RADIUS_METERS = 0.2;

export interface WaveDriver {
  /** The height texture; assign to the water material's uWaveHeight. */
  readonly texture: DataTexture;
  /**
   * Inject an impulse at a space-local position. `amplitude` in meters
   * (negative presses down), `radiusMeters` the Gaussian sigma. No-op
   * outside the water rectangle.
   */
  addImpulse: (x: number, z: number, amplitude: number, radiusMeters?: number) => void;
  /**
   * Advance by `dt` frame seconds (fixed-step accumulator; dt is clamped
   * so a hitch never fast-forwards the pool). Returns whether the sim is
   * awake.
   */
  step: (dt: number) => boolean;
  /** Meters per sim texel on each axis (for shader uniforms). */
  readonly texelMeters: { x: number; y: number };
  /** True while the sim is stepping (false = calm and asleep). */
  readonly awake: boolean;
  dispose: () => void;
}

export function createWaveDriver(
  rect: WaveSimRect,
  size: number = WAVE_SIM_SIZE,
): WaveDriver {
  const field: WaveField = createWaveField(size);
  const texelMeters = { x: (2 * rect.halfX) / size, y: (2 * rect.halfZ) / size };

  const data = new Uint16Array(size * size);
  const texture = new DataTexture(data, size, size, RedFormat, HalfFloatType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  let acc = 0;
  let awake = false;
  let idleSteps = 0;
  let dirty = false;

  const driver: WaveDriver = {
    texture,
    texelMeters,
    get awake() {
      return awake;
    },
    addImpulse(x, z, amplitude, radiusMeters = WAVE_STEP_RADIUS_METERS) {
      if (!waveRectContains(x, z, rect)) return;
      const { u, v } = waveUvForLocal(x, z, rect);
      const radiusTexels = radiusMeters / Math.max(texelMeters.x, texelMeters.y);
      splatImpulse(field, u, v, radiusTexels, amplitude);
      awake = true;
      idleSteps = 0;
    },
    step(dt) {
      if (!awake) return false;
      acc += Math.min(dt, 0.1);
      const stepSeconds = 1 / WAVE_STEP_HZ;
      while (acc >= stepSeconds) {
        acc -= stepSeconds;
        const maxAbs = stepWaveField(field);
        dirty = true;
        idleSteps += 1;
        if (maxAbs < WAVE_CALM_THRESHOLD && idleSteps > WAVE_SLEEP_STEPS) {
          awake = false;
          acc = 0;
          break;
        }
      }
      if (dirty) {
        dirty = false;
        const { curr } = field;
        for (let i = 0; i < curr.length; i++) {
          data[i] = DataUtils.toHalfFloat(curr[i]);
        }
        texture.needsUpdate = true;
      }
      return awake;
    },
    dispose() {
      texture.dispose();
    },
  };
  return driver;
}
