/**
 * Shallow-water surface material — the poolroom worked example (design doc
 * §2) as one factory. Built on MeshStandardMaterial so the scene's IBL
 * environment and key light produce the specular streak; three of the
 * library's seamless ripple normal layers scroll at different scales,
 * speeds, and directions, and a FOURTH normal layer comes from the live
 * wave-equation height field (wave-sim.ts / wave-driver.ts) so the surface
 * answers the wading player with physically-propagating ripples.
 *
 * WHY NOT MeshReflectorMaterial. The design doc budgets one reflector per
 * room, but drei's reflector (drei/materials/MeshReflectorMaterial.js)
 * hardcodes its normal-based reflection distortion as
 * `texture2D( normalMap, vUv * normalScale )` with a `* 2.0 - 1.0` unpack —
 * incompatible with this library's raw [-1,1] float maps and with
 * independently scrolling layers — and its onBeforeCompile is a prototype
 * method, so chaining this patch is fragile against its key-driven material
 * recreation. The env-mapped standard material below is the design doc's
 * sanctioned alternative; it also saves a full second scene render per
 * frame in a scene that is still gaining post-processing from another lane.
 *
 * DEPTH BY BEER–LAMBERT, NOT BY RIM LERP. The old rim-distance tint eased
 * a flat alpha from 0.3 to 0.65 — "a texture layer with a tint". What
 * reads as half a meter of blue-green water is wavelength-dependent
 * absorption: transmittance T = exp(−σ·d) per channel with red dying
 * fastest. The depth d(x,z) is ANALYTIC — the pool basin is the closed-
 * form ellipse bowl terrain.ts already displaces (BOWL_DEPTH feathered by
 * BOWL_FEATHER, flattened by the doorway entranceMask), so the fragment
 * shader rebuilds the exact floor height under each pixel and no depth
 * pass is needed. Alpha becomes 1 − mean(T): ankle-clear in the rect's
 * shallow corners (the bowl feathers OUTSIDE rho = 1, so inside the
 * rectangle only the corners are shallow), deep turquoise across the
 * full-depth bowl, and the tile floor ALWAYS reads through (at the 1.93 m
 * center α ≈ 0.63 < 1 — a flat opaque disc remains the forbidden
 * anti-pattern).
 *
 * RAW NORMALS, no texture clones: same patching discipline as surface.ts —
 * shared ripple textures stay at repeat 1, scrolling lives in uniforms, and
 * the normal_fragment_maps chunk is rewritten to sample all three layers
 * raw ([-1,1], no unpack), blend them, and add the wave field's central-
 * difference slope.
 *
 * Determinism: ripple offsets are a pure function of the elapsed clock
 * (visual motion may read the clock); all texture content derives from
 * WORLD_SEED; the wave field is a pure function of its impulse history.
 */

import {
  Color,
  DataTexture,
  HalfFloatType,
  MeshStandardMaterial,
  RedFormat,
  ShaderChunk,
  Vector2,
  Vector3,
  Vector4,
  type ColorRepresentation,
  type WebGLProgramParametersWithUniforms,
} from "three";
import {
  DOOR_GAP_HALF,
  ENTRANCE_DEPTH,
  WATER_NORMAL_SCALE,
  WATER_RIPPLE_LAYERS,
  WATER_ROUGHNESS,
  WATER_Y,
} from "../tuning/room";
import { sharedWaterNormalTextures } from "./shared";

/**
 * Effective absorption coefficients σ (m⁻¹), red/green/blue. These fold
 * the light's down-and-back path through the water column into one
 * exponent (standard practice for top-down water), so d is the plain
 * water depth. The RATIO is physical — clear water transmits blue ≈ 4×
 * and green ≈ 2.5× better than red; the SCALE is tuned so the rect's
 * shallow corners (d ≈ 0.33 m) read ankle-clear (α ≈ 0.18) and the
 * full-depth bowl (d ≈ 1.93 m across the inscribed ellipse) reads
 * genuinely deep (α ≈ 0.63, green transmittance 0.42).
 */
export const WATER_ABSORPTION_SIGMA = new Vector3(1.1, 0.45, 0.28);

/**
 * Mirror of terrain.ts's private basin constants (BOWL_DEPTH, BOWL_FEATHER)
 * and GROUND_Y. terrain.ts owns the heightfield math but does not export
 * these; the shader needs them to rebuild the floor height analytically.
 * MUST stay in sync with terrain.ts — if the basin is re-tuned there,
 * update these (a terrain.ts export is the proper fix; see handoff).
 */
export const WATER_BOWL_DEPTH = 1.6;
export const WATER_BOWL_FEATHER = 0.3;
export const WATER_GROUND_Y = 0.02;

/**
 * Pure mirror of the shader's Beer–Lambert term, so tests can lock the
 * absorption contract without compiling GLSL: per-channel transmittance
 * T = exp(−σ·d) and the surface alpha 1 − mean(T). The DEPTH_ABSORPTION
 * chunk below MUST implement exactly this math.
 */
export function waterTransmittance(depthMeters: number): {
  r: number;
  g: number;
  b: number;
  alpha: number;
} {
  const s = WATER_ABSORPTION_SIGMA;
  const r = Math.exp(-s.x * depthMeters);
  const g = Math.exp(-s.y * depthMeters);
  const b = Math.exp(-s.z * depthMeters);
  return { r, g, b, alpha: 1 - (r + g + b) / 3 };
}

/**
 * Wave-sim slope gain: multiplies the height field's dh/dx before it is
 * summed into the surface normal. A footstep ring (≈ 8 cm over ≈ 4 texels
 * ≈ 0.3 m → slope ≈ 0.27) lands at ≈ 0.09 against the noise layers' raw
 * sum (each layer's xy spans [-1,1], normalScale 0.75) — clearly visible
 * large waves under the micro-ripple detail, never spiking. If waves ever
 * shade INVERTED (concave where they should be convex) the tangent frame
 * of the rotated plane is the suspect — flip this sign, not the sim's.
 */
export const WATER_WAVE_NORMAL_GAIN = 0.35;

export interface WaterSurfaceMaterial {
  material: MeshStandardMaterial;
  /** Advance the ripple scroll; `elapsed` is the frame clock in seconds. */
  update: (elapsed: number) => void;
  /** Dispose the material. Shared textures must NOT be disposed; the wave
   *  texture is disposed only if this factory created the fallback. */
  dispose: () => void;
}

export interface WaterSurfaceOptions {
  /** Deep-water tint (the palette-derived water color). */
  color: ColorRepresentation;
  /** Shallow tint at the rim — clear, near-white. */
  shallowColor: ColorRepresentation;
  /** Water plane size in meters (x and z spans). */
  spanX: number;
  spanY: number;
  /**
   * Space-local z of the water rectangle's center — needed for the doorway
   * entranceMask term of the analytic depth (the basin flattens near the
   * door). Omit only when the pool is far from the doorway; the depth then
   * assumes the full bowl everywhere.
   */
  centerZ?: number;
  /**
   * Live wave height field (wave-driver.ts). When omitted, a flat 1×1
   * fallback keeps the program identical and the wave term vanishes.
   */
  waveTexture?: DataTexture;
  /** Meters per sim texel on each axis (the driver's texelMeters). */
  waveTexelMeters?: { x: number; y: number };
}

/** The [0,1]-encoded normal sample inside normal_fragment_maps (r185). */
const NORMAL_SAMPLE_PACKED =
  "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;";

/** Three raw [-1,1] noise layers scrolled by their own uniforms, plus the
 *  wave field's central-difference slope scaled by uWaveGain. The chunk's
 *  own `mapN.xy *= normalScale; normal = normalize( tbn * mapN );` lines
 *  still run after this replacement. uWaveTexel = (texelUv.x, texelUv.y,
 *  texelMeters.x, texelMeters.y). */
const NORMAL_SAMPLE_LAYERED = `
	vec3 waterNA = texture2D( normalMap, vNormalMapUv * uWaterScrollA.xy + uWaterScrollA.zw ).xyz;
	vec3 waterNB = texture2D( uWaterNormalB, vNormalMapUv * uWaterScrollB.xy + uWaterScrollB.zw ).xyz;
	vec3 waterNC = texture2D( uWaterNormalC, vNormalMapUv * uWaterScrollC.xy + uWaterScrollC.zw ).xyz;
	float waveL = texture2D( uWaveHeight, vNormalMapUv - vec2( uWaveTexel.x, 0.0 ) ).r;
	float waveR = texture2D( uWaveHeight, vNormalMapUv + vec2( uWaveTexel.x, 0.0 ) ).r;
	float waveD = texture2D( uWaveHeight, vNormalMapUv - vec2( 0.0, uWaveTexel.y ) ).r;
	float waveU = texture2D( uWaveHeight, vNormalMapUv + vec2( 0.0, uWaveTexel.y ) ).r;
	vec2 waveSlope = vec2( waveR - waveL, waveU - waveD ) / ( 2.0 * uWaveTexel.zw );
	vec3 mapN = normalize( vec3( waterNA.xy + waterNB.xy + waterNC.xy - waveSlope * uWaveGain, waterNA.z * waterNB.z * waterNC.z ) );`;

const FRAGMENT_DECLS = `
uniform sampler2D uWaterNormalB;
uniform sampler2D uWaterNormalC;
uniform sampler2D uWaveHeight;
uniform vec4 uWaterScrollA;
uniform vec4 uWaterScrollB;
uniform vec4 uWaterScrollC;
uniform vec4 uWaveTexel;
uniform float uWaveGain;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uWaterSigma;
uniform vec2 uWaterPlaneSize;
uniform vec2 uWaterBowl;
uniform vec2 uWaterLevels;
uniform vec2 uWaterDoor;
uniform float uWaterCenterZ;
`;

/**
 * Beer–Lambert depth absorption, appended after diffuseColor is
 * established. Rebuilds the terrain.ts bowl under the pixel: rho is the
 * ellipse-normalized radius (the plane maps the water rect 1:1, so
 * vUv·2−1 IS the ellipse coordinate), the entrance funnel flattens the
 * bowl near the door exactly as entranceMask does, and the water depth is
 * what is left between the surface plane and that floor. The plane's v
 * axis runs AGAINST +z (rotated −π/2 about X), hence the minus in
 * localZ — the same flip waveUvForLocal documents.
 */
const DEPTH_ABSORPTION = `
	{
		vec2 waterCentered = vUv * 2.0 - 1.0;
		float waterRho = length( waterCentered );
		float waterBowlT = 1.0 - smoothstep( 1.0, 1.0 + uWaterBowl.y, waterRho );
		float waterLocalX = waterCentered.x * ( 0.5 * uWaterPlaneSize.x );
		float waterLocalZ = uWaterCenterZ - waterCentered.y * ( 0.5 * uWaterPlaneSize.y );
		float waterEntrance = max(
			smoothstep( uWaterDoor.x, uWaterDoor.x + 1.0, abs( waterLocalX ) ),
			smoothstep( uWaterDoor.y, uWaterDoor.y + 2.5, waterLocalZ ) );
		float waterFloorY = uWaterLevels.y - uWaterBowl.x * waterBowlT * waterEntrance;
		float waterDepthM = max( uWaterLevels.x - waterFloorY, 0.0 );
		vec3 waterT = exp( -uWaterSigma * waterDepthM );
		diffuseColor.rgb = mix( uWaterShallow, uWaterDeep, 1.0 - waterT.g );
		diffuseColor.a = 1.0 - dot( waterT, vec3( 1.0 / 3.0 ) );
	}
`;

function buildWaterNormalFragmentMaps(): string {
  const chunk = ShaderChunk.normal_fragment_maps;
  if (!chunk.includes(NORMAL_SAMPLE_PACKED)) {
    throw new Error(
      "materials/water-surface: three's normal_fragment_maps no longer contains the packed normal sample — the water patch needs updating for this three version",
    );
  }
  return chunk.replace(NORMAL_SAMPLE_PACKED, NORMAL_SAMPLE_LAYERED);
}

// One shared cache key: every water material compiles the SAME program;
// per-material values live in uniforms only. v2: Beer–Lambert depth +
// wave-field normal layer (the v1 rim-lerp program is gone).
const WATER_PROGRAM_CACHE_KEY = "previously-water-v2";

/** Flat 1×1 half-float height field: the wave term degenerates to zero. */
function createFlatWaveTexture(): DataTexture {
  const texture = new DataTexture(
    new Uint16Array(1),
    1,
    1,
    RedFormat,
    HalfFloatType,
  );
  texture.needsUpdate = true;
  return texture;
}

export function createWaterSurfaceMaterial(
  opts: WaterSurfaceOptions,
): WaterSurfaceMaterial {
  const layers = sharedWaterNormalTextures();
  if (layers.length !== WATER_RIPPLE_LAYERS.length) {
    throw new Error(
      `materials/water-surface: ${layers.length} ripple layers for ${WATER_RIPPLE_LAYERS.length} scroll slots`,
    );
  }

  const material = new MeshStandardMaterial({
    color: new Color(opts.color),
    roughness: WATER_ROUGHNESS,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });
  material.normalMap = layers[0];
  material.normalScale.set(WATER_NORMAL_SCALE, WATER_NORMAL_SCALE);
  // The depth model reads vUv; no map slot defines USE_UV on its own.
  material.defines = { USE_UV: "" };

  const fallbackWave = opts.waveTexture ? null : createFlatWaveTexture();
  const waveTexture = opts.waveTexture ?? fallbackWave!;
  const waveTexelMeters = opts.waveTexelMeters ?? { x: 1, y: 1 };
  const waveTexelUv = {
    x: 1 / (opts.waveTexture ? opts.waveTexture.image.width : 1),
    y: 1 / (opts.waveTexture ? opts.waveTexture.image.height : 1),
  };

  // Per-layer repeat: span / wavelength meters per axis, so ripples stay
  // isotropic on non-square pools. Offsets are driven by update().
  const scrollA = new Vector4(
    opts.spanX / WATER_RIPPLE_LAYERS[0].meters,
    opts.spanY / WATER_RIPPLE_LAYERS[0].meters,
    0,
    0,
  );
  const scrollB = new Vector4(
    opts.spanX / WATER_RIPPLE_LAYERS[1].meters,
    opts.spanY / WATER_RIPPLE_LAYERS[1].meters,
    0,
    0,
  );
  const scrollC = new Vector4(
    opts.spanX / WATER_RIPPLE_LAYERS[2].meters,
    opts.spanY / WATER_RIPPLE_LAYERS[2].meters,
    0,
    0,
  );

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, {
      uWaterNormalB: { value: layers[1] },
      uWaterNormalC: { value: layers[2] },
      uWaterScrollA: { value: scrollA },
      uWaterScrollB: { value: scrollB },
      uWaterScrollC: { value: scrollC },
      uWaveHeight: { value: waveTexture },
      uWaveTexel: {
        value: new Vector4(
          waveTexelUv.x,
          waveTexelUv.y,
          waveTexelMeters.x,
          waveTexelMeters.y,
        ),
      },
      uWaveGain: { value: WATER_WAVE_NORMAL_GAIN },
      uWaterShallow: { value: new Color(opts.shallowColor) },
      uWaterDeep: { value: new Color(opts.color) },
      uWaterSigma: { value: WATER_ABSORPTION_SIGMA },
      uWaterPlaneSize: { value: new Vector2(opts.spanX, opts.spanY) },
      uWaterBowl: { value: new Vector2(WATER_BOWL_DEPTH, WATER_BOWL_FEATHER) },
      uWaterLevels: { value: new Vector2(WATER_Y, WATER_GROUND_Y) },
      uWaterDoor: { value: new Vector2(DOOR_GAP_HALF, ENTRANCE_DEPTH) },
      // No centerZ ⇒ the pool is far from the doorway: push z so far out
      // that the entrance funnel term saturates to 1 (full bowl).
      uWaterCenterZ: { value: opts.centerZ ?? 1e6 },
    });
    if (!shader.fragmentShader.includes("#include <normal_fragment_maps>")) {
      throw new Error(
        "materials/water-surface: fragment shader has no normal_fragment_maps include",
      );
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_maps>",
      buildWaterNormalFragmentMaps(),
    );
    if (!shader.fragmentShader.includes("#include <color_fragment>")) {
      throw new Error(
        "materials/water-surface: fragment shader has no color_fragment include",
      );
    }
    shader.fragmentShader =
      FRAGMENT_DECLS +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n" + DEPTH_ABSORPTION,
      );
  };
  material.customProgramCacheKey = () => WATER_PROGRAM_CACHE_KEY;

  return {
    material,
    update(elapsed: number) {
      scrollA.z = (elapsed * WATER_RIPPLE_LAYERS[0].vx) % 1;
      scrollA.w = (elapsed * WATER_RIPPLE_LAYERS[0].vy) % 1;
      scrollB.z = (elapsed * WATER_RIPPLE_LAYERS[1].vx) % 1;
      scrollB.w = (elapsed * WATER_RIPPLE_LAYERS[1].vy) % 1;
      scrollC.z = (elapsed * WATER_RIPPLE_LAYERS[2].vx) % 1;
      scrollC.w = (elapsed * WATER_RIPPLE_LAYERS[2].vy) % 1;
    },
    dispose() {
      material.dispose();
      fallbackWave?.dispose();
    },
  };
}
