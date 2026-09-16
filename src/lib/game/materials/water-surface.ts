/**
 * Shallow-water surface material — the poolroom worked example (design doc
 * §2) as one factory. Built on MeshStandardMaterial so the scene's IBL
 * environment and key light produce the specular streak; three of the
 * library's seamless ripple normal layers scroll at different scales,
 * speeds, and directions and blend into the surface normal.
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
 * DEPTH TINT. The pool basin feathers from the rim to 1.6m deep at center
 * (terrain.ts BOWL_DEPTH). Real per-pixel water depth would need the
 * scene's depth buffer; instead the fragment shader measures the distance
 * from the water rectangle's rim in meters (uv × plane size) and eases from
 * the shallow look (nearly clear — the tile floor shows through) to the
 * deep tint across WATER_DEPTH_RAMP_METERS. The tile bottom is ALWAYS
 * partially visible (deep alpha < 1) — a flat opaque disc is the forbidden
 * anti-pattern.
 *
 * RAW NORMALS, no texture clones: same patching discipline as surface.ts —
 * shared ripple textures stay at repeat 1, scrolling lives in uniforms, and
 * the normal_fragment_maps chunk is rewritten to sample all three layers
 * raw ([-1,1], no unpack) and blend them.
 *
 * Determinism: ripple offsets are a pure function of the elapsed clock
 * (visual motion may read the clock); all texture content derives from
 * WORLD_SEED.
 */

import {
  Color,
  MeshStandardMaterial,
  ShaderChunk,
  Vector2,
  Vector4,
  type ColorRepresentation,
  type WebGLProgramParametersWithUniforms,
} from "three";
import {
  WATER_DEPTH_RAMP_METERS,
  WATER_DEEP_ALPHA,
  WATER_EDGE_ALPHA,
  WATER_NORMAL_SCALE,
  WATER_RIPPLE_LAYERS,
  WATER_ROUGHNESS,
} from "../tuning/room";
import { sharedWaterNormalTextures } from "./shared";

export interface WaterSurfaceMaterial {
  material: MeshStandardMaterial;
  /** Advance the ripple scroll; `elapsed` is the frame clock in seconds. */
  update: (elapsed: number) => void;
  /** Dispose the material. The shared ripple textures must NOT be disposed. */
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
}

/** The [0,1]-encoded normal sample inside normal_fragment_maps (r185). */
const NORMAL_SAMPLE_PACKED =
  "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;";

/** Three raw [-1,1] layers, each scrolled by its own uniform, blended. The
 *  chunk's own `mapN.xy *= normalScale; normal = normalize( tbn * mapN );`
 *  lines still run after this replacement. */
const NORMAL_SAMPLE_LAYERED = `
	vec3 waterNA = texture2D( normalMap, vNormalMapUv * uWaterScrollA.xy + uWaterScrollA.zw ).xyz;
	vec3 waterNB = texture2D( uWaterNormalB, vNormalMapUv * uWaterScrollB.xy + uWaterScrollB.zw ).xyz;
	vec3 waterNC = texture2D( uWaterNormalC, vNormalMapUv * uWaterScrollC.xy + uWaterScrollC.zw ).xyz;
	vec3 mapN = normalize( vec3( waterNA.xy + waterNB.xy + waterNC.xy, waterNA.z * waterNB.z * waterNC.z ) );`;

const FRAGMENT_DECLS = `
uniform sampler2D uWaterNormalB;
uniform sampler2D uWaterNormalC;
uniform vec4 uWaterScrollA;
uniform vec4 uWaterScrollB;
uniform vec4 uWaterScrollC;
uniform vec3 uWaterShallow;
uniform vec2 uWaterPlaneSize;
uniform vec2 uWaterAlpha;
uniform float uWaterDepthRamp;
`;

/** Rim-distance depth tint, appended after diffuseColor is established. */
const DEPTH_TINT = `
	{
		vec2 waterEdgeMeters = min( vUv, 1.0 - vUv ) * uWaterPlaneSize;
		float waterRim = min( waterEdgeMeters.x, waterEdgeMeters.y );
		float waterDepthT = smoothstep( 0.0, uWaterDepthRamp, waterRim );
		diffuseColor.rgb = mix( uWaterShallow, diffuseColor.rgb, waterDepthT );
		diffuseColor.a *= mix( uWaterAlpha.x, uWaterAlpha.y, waterDepthT );
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
// per-material values live in uniforms only.
const WATER_PROGRAM_CACHE_KEY = "previously-water-v1";

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
  // The depth tint reads vUv; no map slot defines USE_UV on its own.
  material.defines = { USE_UV: "" };

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
      uWaterShallow: { value: new Color(opts.shallowColor) },
      uWaterPlaneSize: { value: new Vector2(opts.spanX, opts.spanY) },
      uWaterAlpha: { value: new Vector2(WATER_EDGE_ALPHA, WATER_DEEP_ALPHA) },
      uWaterDepthRamp: { value: WATER_DEPTH_RAMP_METERS },
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
        "#include <color_fragment>\n" + DEPTH_TINT,
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
    },
  };
}
