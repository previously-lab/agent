/**
 * Shared contract for the procedural material library.
 *
 * Every builder in this module produces a `MaterialMaps`: plain typed
 * arrays, no DOM, no canvas, no three.js — so the pure generation code runs
 * and is testable in node. `src/lib/game/materials/three.ts` is the only
 * browser-coupled file and converts these into three.js textures.
 *
 * All buffers are `size × size` RGBA. Determinism is part of the contract:
 * the same options always produce byte-identical buffers (all entropy comes
 * from the seeded streams in `src/lib/game/seed.ts`).
 */
export interface MaterialMaps {
  /** Texture is size × size. */
  size: number;
  /** RGBA, length size*size*4, sRGB-ish base colour. A = 255. */
  albedo: Uint8ClampedArray;
  /** RGBA, length size*size*4. R = roughness channel used; G/B mirror R, A = 255. */
  roughness: Uint8ClampedArray;
  /** RGBA, length size*size*4. Tangent-space normal, RGB in [-1, 1] (NOT the usual [0,1] encoding), A = 1. */
  normal: Float32Array;
}
