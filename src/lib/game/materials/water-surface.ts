/**
 * Pool water surface material — plain, pattern-free water whose color
 * comes from depth alone. Built on MeshStandardMaterial so the scene's
 * IBL environment and key light produce the specular streak. The surface
 * carries NO albedo/normal texture pattern: user review (v0.11) read the
 * old scrolling ripple normal layers as "a white net printed on the
 * water", so they are gone. The ONLY normal perturbation left is the
 * live wave-equation height field (wave-sim.ts / wave-driver.ts), so the
 * surface stays mirror-clean until the wading player physically disturbs
 * it — dynamics have exactly one source.
 *
 * WHY NOT MeshReflectorMaterial. The design doc budgets one reflector per
 * room, but drei's reflector (drei/materials/MeshReflectorMaterial.js)
 * hardcodes its normal-based reflection distortion as
 * `texture2D( normalMap, vUv * normalScale )` with a `* 2.0 - 1.0` unpack —
 * incompatible with this library's raw [-1,1] float maps — and its
 * onBeforeCompile is a prototype method, so chaining this patch is fragile
 * against its key-driven material recreation. The env-mapped standard
 * material below is the design doc's sanctioned alternative; it also saves
 * a full second scene render per frame in a scene that is still gaining
 * post-processing from another lane.
 *
 * DEPTH BY BEER–LAMBERT. What reads as a body of light-blue water is
 * wavelength-dependent absorption: transmittance T = exp(−σ·d) per
 * channel with red dying fastest. The depth d(x,z) is ANALYTIC — the
 * basin is the straight-walled, flat-bottomed rectangle terrain.ts
 * displaces (POOL_DEPTH below the deck, softened only by the doorway
 * entranceMask), so the fragment shader rebuilds the exact floor height
 * under each pixel and no depth pass is needed. Alpha becomes
 * 1 − mean(T): constant across the flat bottom (a real pool reads
 * uniform), lighter only where the doorway funnel ramps the floor up —
 * while the tile floor ALWAYS reads through (at the 1.93 m bottom
 * α ≈ 0.55 < 1 — a flat opaque disc remains the forbidden anti-pattern).
 *
 * normalMap STAYS BOUND (to the shared ripple layer 0) but is NEVER
 * SAMPLED: three's normal_fragment_maps chunk only compiles its tangent-
 * frame math when a normalMap slot exists, and that frame is what orients
 * the wave-field slope correctly on the rotated plane. The packed texture
 * sample is replaced with a synthesized mapN built purely from the wave
 * field's central-difference slope.
 *
 * Determinism: all motion derives from the wave field, a pure function of
 * its impulse history; no texture content reaches the surface.
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
  WATER_ROUGHNESS,
  WATER_Y,
} from "../tuning/room";
import { GROUND_Y, POOL_DEPTH } from "../terrain";
import { sharedWaterNormalTextures } from "./shared";

/**
 * Effective absorption coefficients σ (m⁻¹), red/green/blue. These fold
 * the light's down-and-back path through the water column into one
 * exponent (standard practice for top-down water), so d is the plain
 * water depth. The RATIO is physical — clear water transmits blue ≈ 5×
 * and green ≈ 3× better than red; the SCALE is tuned for the read the
 * user asked for (v0.11 review: "有深度的浅蓝色水" — light blue with
 * depth, not a saturated lagoon). With the straight-walled basin every
 * pixel away from the doorway sits at the same 1.93 m, so the old σ
 * (1.4, 0.55, 0.32) would have painted the whole pool a uniform deep
 * turquoise (α ≈ 0.68). This scale lands the flat bottom at α ≈ 0.55 —
 * unmistakably a body of water, with the tile floor and its caustics
 * still reading through everywhere — and the doorway ramp at α ≈ 0.19
 * (d ≈ 0.33 m), ankle-clear over the tiles.
 */
export const WATER_ABSORPTION_SIGMA = new Vector3(1.0, 0.36, 0.19);

/**
 * The basin shape is NOT mirrored here: terrain.ts exports POOL_DEPTH and
 * GROUND_Y (imported above) and owns waterRectFor, so the shader's
 * analytic floor and the displaced ground mesh share one definition by
 * construction. (History: this module used to carry WATER_BOWL_* copies
 * of terrain.ts's private ellipse-bowl constants; the straight-walled
 * rectangular basin made the copy unnecessary and the export landed.)
 */

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
 * Wave-sim slope gain: multiplies the height field's dh/dx before it
 * becomes the surface normal's xy. The wave field is now the ONLY normal
 * source (the scrolling ripple layers were removed — see the module
 * doc), so the gain rose from 0.35 to 0.6: a footstep ring (≈ 8 cm over
 * ≈ 4 texels ≈ 0.3 m → slope ≈ 0.27) lands at ≈ 0.16 of normal tilt —
 * clearly readable against a mirror-clean surface, never spiking under
 * the WAVE_MAX_HEIGHT clamp (slope ≤ 0.5 m / texel-meter → tilt ≤ 0.7,
 * well inside normalize()). If waves ever shade INVERTED (concave where
 * they should be convex) the tangent frame of the rotated plane is the
 * suspect — flip this sign, not the sim's.
 */
export const WATER_WAVE_NORMAL_GAIN = 0.6;

export interface WaterSurfaceMaterial {
  material: MeshStandardMaterial;
  /**
   * No-op kept for the frame loop's call site (space.tsx): the surface
   * has no scrolling texture left, so the only per-frame advance is the
   * wave driver's, which the component steps separately.
   */
  update: (elapsed: number) => void;
  /** Dispose the material. Shared textures must NOT be disposed; the wave
   *  texture is disposed only if this factory created the fallback. */
  dispose: () => void;
}

export interface WaterSurfaceOptions {
  /** Deep-water tint (the palette-derived water color). */
  color: ColorRepresentation;
  /** Shallow tint where the depth → 0 (the doorway ramp) — clear, near-white. */
  shallowColor: ColorRepresentation;
  /** Water plane size in meters (x and z spans). */
  spanX: number;
  spanY: number;
  /**
   * Space-local z of the water rectangle's center — needed for the doorway
   * entranceMask term of the analytic depth (the floor ramps up near the
   * door). Omit only when the pool is far from the doorway; the depth then
   * assumes the full POOL_DEPTH everywhere.
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

/** Wave-field-only normal: the packed texture sample is replaced with a
 *  mapN synthesized from the height field's central-difference slope
 *  scaled by uWaveGain — no texture pattern ever reaches the surface.
 *  The chunk's own `mapN.xy *= normalScale; normal = normalize( tbn *
 *  mapN );` lines still run after this replacement (normalScale is 1).
 *  uWaveTexel = (texelUv.x, texelUv.y, texelMeters.x, texelMeters.y). */
const NORMAL_SAMPLE_LAYERED = `
	float waveL = texture2D( uWaveHeight, vNormalMapUv - vec2( uWaveTexel.x, 0.0 ) ).r;
	float waveR = texture2D( uWaveHeight, vNormalMapUv + vec2( uWaveTexel.x, 0.0 ) ).r;
	float waveD = texture2D( uWaveHeight, vNormalMapUv - vec2( 0.0, uWaveTexel.y ) ).r;
	float waveU = texture2D( uWaveHeight, vNormalMapUv + vec2( 0.0, uWaveTexel.y ) ).r;
	vec2 waveSlope = vec2( waveR - waveL, waveU - waveD ) / ( 2.0 * uWaveTexel.zw );
	vec3 mapN = normalize( vec3( - waveSlope * uWaveGain, 1.0 ) );`;

const FRAGMENT_DECLS = `
uniform sampler2D uWaveHeight;
uniform vec4 uWaveTexel;
uniform float uWaveGain;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uWaterSigma;
uniform vec2 uWaterPlaneSize;
uniform float uWaterDepth;
uniform vec2 uWaterLevels;
uniform vec2 uWaterDoor;
uniform float uWaterCenterZ;
`;

/**
 * Beer–Lambert depth absorption, appended after diffuseColor is
 * established. Rebuilds the terrain.ts basin under the pixel: the pool
 * is a straight-walled, flat-bottomed rectangle and the water plane maps
 * the water rect 1:1, so the floor is a constant POOL_DEPTH below the
 * deck everywhere on the plane; the only variation is the doorway
 * entrance funnel, which ramps the floor back up exactly as
 * terrain.ts's entranceMask does. The plane's v axis runs AGAINST +z
 * (rotated −π/2 about X), hence the minus in localZ — the same flip
 * waveUvForLocal documents.
 */
const DEPTH_ABSORPTION = `
	{
		vec2 waterCentered = vUv * 2.0 - 1.0;
		float waterLocalX = waterCentered.x * ( 0.5 * uWaterPlaneSize.x );
		float waterLocalZ = uWaterCenterZ - waterCentered.y * ( 0.5 * uWaterPlaneSize.y );
		float waterEntrance = max(
			smoothstep( uWaterDoor.x, uWaterDoor.x + 1.0, abs( waterLocalX ) ),
			smoothstep( uWaterDoor.y, uWaterDoor.y + 2.5, waterLocalZ ) );
		float waterFloorY = uWaterLevels.y - uWaterDepth * waterEntrance;
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
// per-material values live in uniforms only. v3: pattern-free surface —
// the scrolling ripple normal layers are gone, normals come from the
// wave field alone, and the depth model matches the straight-walled
// rectangular basin (v1 rim-lerp and v2 ellipse-bowl programs are gone).
const WATER_PROGRAM_CACHE_KEY = "previously-water-v3";

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
  // The shared ripple texture is bound to the normalMap slot but NEVER
  // sampled (see the module doc): the slot exists so three compiles the
  // normal_fragment_maps tangent-frame math the wave-field normal needs.
  const layers = sharedWaterNormalTextures();

  const material = new MeshStandardMaterial({
    color: new Color(opts.color),
    roughness: WATER_ROUGHNESS,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });
  material.normalMap = layers[0];
  // 1: the wave slope's strength is carried by uWaveGain alone.
  material.normalScale.set(1, 1);
  // The depth model reads vUv; no map slot defines USE_UV on its own.
  material.defines = { USE_UV: "" };

  const fallbackWave = opts.waveTexture ? null : createFlatWaveTexture();
  const waveTexture = opts.waveTexture ?? fallbackWave!;
  const waveTexelMeters = opts.waveTexelMeters ?? { x: 1, y: 1 };
  const waveTexelUv = {
    x: 1 / (opts.waveTexture ? opts.waveTexture.image.width : 1),
    y: 1 / (opts.waveTexture ? opts.waveTexture.image.height : 1),
  };

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, {
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
      uWaterDepth: { value: POOL_DEPTH },
      uWaterLevels: { value: new Vector2(WATER_Y, GROUND_Y) },
      uWaterDoor: { value: new Vector2(DOOR_GAP_HALF, ENTRANCE_DEPTH) },
      // No centerZ ⇒ the pool is far from the doorway: push z so far out
      // that the entrance funnel term saturates to 1 (full depth).
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
    // The surface has no scrolling texture left, so there is nothing to
    // advance per frame — the wave field is stepped by its driver, not
    // here. The method stays because the WaterSurface component's frame
    // loop calls it (space.tsx owns that call site).
    update(_elapsed: number) {},
    dispose() {
      material.dispose();
      fallbackWave?.dispose();
    },
  };
}
