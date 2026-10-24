/**
 * Pool-floor caustics — the additive light web that sells "swimming pool"
 * (research pass: caustics is the single biggest cue; design doc §2 lists
 * drei's Caustics as the pool's signature, but that costs two extra scene
 * renders plus two fullscreen passes per frame — this is the zero-pass fake).
 *
 * HOW IT WORKS. This module PATCHES the existing ground material (the
 * matte basin floor from surface.ts) with an additive emissive term: the
 * two seamless caustics layers (caustics.ts) sampled at counter-scrolling
 * UV offsets and multiplied — where both webs' filaments cross, the
 * product flares, which reads as the slow boiling drift of real refracted
 * light. The web is masked to the water rectangle with a soft edge, so
 * the deck stays dark and the pattern fades at the waterline instead of
 * clipping.
 *
 * UV COORDINATES. The matte floor carries no map, so three defines no
 * map varying for it — the patch sets the material's `USE_UV` define
 * (the same convention as water-surface.ts) and reads the ordinary vUv.
 * space.tsx's ground mesh maps uv → local meters as
 *   lx = (uv.x - 0.5) · spanX,  lz = (1 - uv.y) · spanY
 * (plane rotated -π/2 about X, spanning z ∈ [0, extent]), so vUv IS the
 * ground plane's local coordinate system and the mask and the web
 * sampling work in METERS — isotropic on non-square pools.
 *
 * PATCHING DISCIPLINE (same as water-surface.ts): the shared textures
 * stay at repeat 1 (scrolling lives in uniforms), onBeforeCompile and
 * customProgramCacheKey are CHAINED onto whatever the material already
 * has, and the shader text is validated so a three upgrade that drops
 * the expected include fails loud. The target material does NOT need a
 * map — the matte floor has none.
 *
 * IDEMPOTENT. The patch is recorded in a WeakMap: applying it twice to the
 * SAME material returns the original driver without chaining another
 * onBeforeCompile layer (a re-run of the caller's useMemo — e.g. a new
 * waterRect identity with an unchanged groundMaterial — must not re-inject:
 * prepending FRAGMENT_DECLS a second time redeclares the uniforms and the
 * program fails to compile). The injection itself also checks whether the
 * declarations are already present in the shader text, so a patch layered
 * by any other path is skipped rather than duplicated.
 *
 * LIGHT-SOURCE DISCIPLINE (design axiom B.13 — this world has no outdoors,
 * every light needs a findable source): caustics are refracted KEY light,
 * so pass the skylight/window color as `color`; default is white.
 *
 * Determinism: texture content derives from WORLD_SEED; the scroll offsets
 * are a pure function of the elapsed clock (visual motion may read the
 * clock). Nothing here allocates per frame.
 *
 * WAVE-DRIVEN WOBBLE (optional `wave` option). True Snell refraction of
 * the pool floor would need a scene grab pass (render the world minus
 * water to a target, distort its UVs by the surface normal) — a full
 * extra render per frame, rejected in water-surface.ts's documented
 * budget. The stylized approximation instead offsets the caustics web's
 * own UVs by the live wave field's slope, which costs one 128² texture
 * sample in the floor shader and no pass at all:
 *   - the caustics web's UV is displaced ∝ slope (× a wobble factor) —
 *     refracted light dances with the surface, which is how real pools
 *     behave;
 *   - the matte floor has no albedo pattern to bend (the old textured
 *     tile map is gone), so the offset drives ONLY the light web.
 * A calm pool has slope 0 everywhere, so the offset vanishes and the floor
 * is pixel-identical to an unpatched one; dynamics keep their single
 * source (the wave field) and a sleeping driver costs nothing here.
 */

import {
  Color,
  Vector2,
  Vector4,
  type ColorRepresentation,
  type DataTexture,
  type MeshStandardMaterial,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";
import { TILE_SPAN_METERS } from "../tuning/room";
import { sharedCausticsTextures } from "./shared";

export interface PoolCausticsOptions {
  /** Water rectangle in space-local meters (terrain.ts WaterRect). */
  rect: { cx: number; cz: number; halfX: number; halfZ: number };
  /** Ground plane span in meters (x = width, y = extent). */
  spanX: number;
  spanY: number;
  /**
   * Live wave height field (wave-driver.ts). When given, the caustics web
   * WOBBLES: its UV is displaced by the wave field's slope, masked to the
   * water rectangle (see module doc). The matte floor itself has no
   * pattern to refract — only the light web rides the slope. When omitted
   * the patch behaves exactly as before.
   */
  wave?: {
    /** The driver's half-float height texture (R channel, meters). */
    texture: DataTexture;
    /** Meters per sim texel on each axis (the driver's texelMeters). */
    texelMeters: { x: number; y: number };
  };
  /**
   * Web tint — refracted KEY light, so tint toward the skylight/window
   * (B.13: every light has a findable source). Default white.
   */
  color?: ColorRepresentation;
  /**
   * Emissive multiplier on the web product (default 1), before the
   * module's CAUSTICS_OUTPUT_GAIN — the product's mean is ≈0.04 with
   * sub-1% pixels above 0.5 (see caustics.ts), and the gain scales the
   * result down to "light dappling through water" (see its doc); the
   * floor's own lighting supplies the base.
   */
  intensity?: number;
  /**
   * Meters per texture repeat (default CAUSTICS_CELL_METERS). Web filaments
   * sit ~cellMeters/5 apart (the builder's base period is 5 cells/repeat).
   */
  cellMeters?: number;
}

export interface PoolCaustics {
  /** Advance the counter-scroll; `elapsed` is the frame clock in seconds. */
  update: (elapsed: number) => void;
}

/**
 * Meters per texture repeat (default): 4.5m / 5 cells puts the bright
 * filaments ~0.9m apart — three tile widths at the basin's 0.3m tile
 * scale. Was 3m (filaments ~0.6m): at pool scale that density tiled the
 * whole floor into a continuous net that read as a pattern ON the water
 * surface (v0.11 user review). The sparser web keeps the "refracted
 * light" read at room scale without wallpapering the pool.
 */
export const CAUSTICS_CELL_METERS = 4.5;

/**
 * Output gain applied on top of the caller's intensity. The web product's
 * bright filaments peak near 0.5–1.0, so at intensity 1 unscaled the
 * emissive web hit ~0.5–1.0 white across the whole floor — through the
 * water's α ≈ 0.55 that still out-shone the water body itself and read
 * as a net printed on the surface (v0.11 user review). 0.4 lands the
 * filaments at ~0.2–0.4 emissive: clearly visible dappling through the
 * water, always subordinate to the water's own color.
 */
const CAUSTICS_OUTPUT_GAIN = 0.4;

/**
 * Counter-scroll velocities in texture-repeats/sec, in the same slow band
 * the water surface's wave field moves at, so the floor light and the
 * surface above it drift together. Opposite x signs and mutually
 * incommensurate components mean the two webs take minutes to re-align.
 */
const CAUSTICS_SCROLL_A = { vx: 0.021, vy: 0.013 } as const;
const CAUSTICS_SCROLL_B = { vx: -0.016, vy: 0.024 } as const;

/**
 * Layer B is sampled at 1.37× the base scale: an incommensurate zoom so
 * filament crossings (the flares) drift instead of standing still. Shared
 * by the GLSL below and nothing else — keep them in sync by construction
 * (the value is interpolated into the chunk text).
 */
const LAYER_B_SCALE = 1.37;

/**
 * The mask fades across the last 8% of the rect's half-extents: the web
 * dissolves at the waterline instead of a hard clip, which would read as a
 * projected slide rather than refracted light.
 */
const MASK_FEATHER_START = 0.92;

/**
 * Wave-slope → caustics-web wobble gain: meters of apparent light shift
 * per unit of wave slope. A wading footstep peaks at slope ≈ 0.27
 * (water-surface.ts's gain doc), so the web under a ring sweeps ≈ 3 cm —
 * clearly alive, never swimming. A calm field has slope 0, so the offset
 * is exactly 0 and the floor is pixel-identical to an unpatched one.
 */
export const WATER_REFRACT_GAIN = 0.12;

/**
 * The caustics web is displaced by refrOffset × this factor: refracted
 * LIGHT dances several times further than the apparent floor shift (the
 * focused web sweeps with the surface, which is how real pools behave).
 */
const CAUSTICS_WOBBLE_FACTOR = 2.5;

/**
 * Pure mirror of the OLD shader's meters → tile-map-UV conversion, kept
 * exported for API/test compatibility even though the matte floor no
 * longer consumes it: the current GLSL reads vUv directly (the ground
 * plane maps local meters to vUv 1:1 over its span). The conversion is
 * still the exact inverse of the plane's local↔uv mapping, with the v
 * axis running AGAINST +z (rotated −π/2 about X — the same flip the
 * caustics doc documents).
 */
export function refractUvDeltaFromMeters(
  offsetX: number,
  offsetZ: number,
): { x: number; y: number } {
  return {
    x: offsetX / TILE_SPAN_METERS,
    y: -offsetZ / TILE_SPAN_METERS,
  };
}

const FRAGMENT_DECLS = `
uniform sampler2D uCausticsA;
uniform sampler2D uCausticsB;
uniform vec4 uCausticsScroll;
uniform vec4 uCausticsRect;
uniform vec2 uCausticsPlane;
uniform vec2 uCausticsCell;
uniform vec3 uCausticsColor;
uniform float uCausticsIntensity;
`;

/** Wave-field uniforms, prepended only when the wave option is present. */
const WAVE_FRAGMENT_DECLS = `
uniform sampler2D uWaveHeight;
uniform vec4 uWaveTexel;
`;

/**
 * Wave-slope sample + water-rect mask, injected ahead of map_fragment as
 * the early main-scope computation whose only product is refrOffset: the
 * caustics web's UV (later, in the emissive chunk) displaces by it. The
 * u/v mapping mirrors waveUvForLocal (v flipped against +z); the slope is
 * the same central-difference quotient the water surface's normal uses.
 * Declared at main() scope WITHOUT a wrapping block: refrOffset must stay
 * visible to the emissive chunk below. Coordinates come from vUv — the
 * patch sets USE_UV on the material (the matte floor has no map to define
 * it); the refr* names are unique to this patch. map_fragment stays in
 * place purely as the injection anchor — nothing displaces its sample.
 */
const WAVE_REFRACT_BLOCK = `
vec2 refr01 = vUv;
vec2 refrLocal = vec2(
	( refr01.x - 0.5 ) * uCausticsPlane.x,
	( 1.0 - refr01.y ) * uCausticsPlane.y );
vec2 refrUv = vec2(
	0.5 + ( refrLocal.x - uCausticsRect.x ) / ( 2.0 * uCausticsRect.z ),
	0.5 - ( refrLocal.y - uCausticsRect.y ) / ( 2.0 * uCausticsRect.w ) );
float refrL = texture2D( uWaveHeight, refrUv - vec2( uWaveTexel.x, 0.0 ) ).r;
float refrR = texture2D( uWaveHeight, refrUv + vec2( uWaveTexel.x, 0.0 ) ).r;
float refrD = texture2D( uWaveHeight, refrUv - vec2( 0.0, uWaveTexel.y ) ).r;
float refrU = texture2D( uWaveHeight, refrUv + vec2( 0.0, uWaveTexel.y ) ).r;
vec2 refrSlope = vec2( refrR - refrL, refrU - refrD ) / ( 2.0 * uWaveTexel.zw );
vec2 refrEdge = abs( refrLocal - uCausticsRect.xy ) / uCausticsRect.zw;
float refrMask = 1.0 - smoothstep( ${MASK_FEATHER_START}, 1.0, max( refrEdge.x, refrEdge.y ) );
vec2 refrOffset = refrSlope * ( refrMask * ${WATER_REFRACT_GAIN} );
`;

const EMISSIVE_INCLUDE = "#include <emissivemap_fragment>";
const MAP_INCLUDE = "#include <map_fragment>";

function buildCausticsEmissive(hasWave: boolean): string {
  // With the wave option the web's UV rides the wave slope, amplified —
  // refracted light sweeps further than the apparent floor shift beneath
  // it. refrOffset is declared by WAVE_REFRACT_BLOCK, which is injected
  // ahead of map_fragment (earlier in main()). vUv is the ground plane's
  // local coordinate system (USE_UV is set on the material).
  const webUv = hasWave
    ? `( causticsLocal + refrOffset * ${CAUSTICS_WOBBLE_FACTOR} ) / uCausticsCell`
    : "causticsLocal / uCausticsCell";
  return `${EMISSIVE_INCLUDE}
	{
		vec2 caustics01 = vUv;
		vec2 causticsLocal = vec2(
			( caustics01.x - 0.5 ) * uCausticsPlane.x,
			( 1.0 - caustics01.y ) * uCausticsPlane.y );
		vec2 causticsEdge = abs( causticsLocal - uCausticsRect.xy ) / uCausticsRect.zw;
		float causticsMask = 1.0 - smoothstep( ${MASK_FEATHER_START}, 1.0, max( causticsEdge.x, causticsEdge.y ) );
		vec2 causticsUv = ${webUv};
		float causticsWeb =
				texture2D( uCausticsA, causticsUv + uCausticsScroll.xy ).r
			* texture2D( uCausticsB, causticsUv * ${LAYER_B_SCALE} + uCausticsScroll.zw ).r;
		totalEmissiveRadiance += uCausticsColor * ( causticsWeb * causticsMask * uCausticsIntensity );
	}`;
}

const CAUSTICS_PROGRAM_CACHE_TAG = ":caustics-v1";
/** Appended when the wave option is present: the program differs (extra
 *  uniforms + the refract block), so the key must too. */
const CAUSTICS_WAVE_CACHE_TAG = ":wave";

/** The declarations the patch prepends — the idempotency probe below keys
 *  on this exact line. */
const CAUSTICS_DECLS_PROBE = "uniform sampler2D uCausticsA;";

/**
 * Materials already patched, mapped to their driver. The patch chains
 * onBeforeCompile and prepends the uniform declarations, neither of which
 * is safe to apply twice: a second chain would prepend FRAGMENT_DECLS
 * again and the redeclared uniforms fail program validation
 * (`'uCausticsA' : redefinition`).
 */
const patchedMaterials = new WeakMap<MeshStandardMaterial, PoolCaustics>();

/**
 * Patch `material` (the matte basin floor) with the additive caustics
 * web. Chains onto the material's existing onBeforeCompile / cache key.
 * The matte floor has no map, so the patch sets the `USE_UV` define
 * itself (three only emits vUv when a map/uv-consuming feature asks for
 * it — same convention as water-surface.ts). Idempotent: calling it
 * again on the SAME material returns the original driver untouched — no
 * second onBeforeCompile layer, no re-injection. Returns the per-frame
 * driver; call `update(elapsed)` from the room's useFrame. The shared
 * caustics textures must NOT be disposed; the material stays owned by
 * its creator.
 */
export function applyPoolCaustics(
  material: MeshStandardMaterial,
  opts: PoolCausticsOptions,
): PoolCaustics {
  const existing = patchedMaterials.get(material);
  if (existing) return existing;
  const layers = sharedCausticsTextures();
  if (layers.length !== 2) {
    throw new Error(
      `materials/caustics-surface: ${layers.length} caustics layers for 2 scroll slots`,
    );
  }

  // The caustics math reads vUv; the matte floor has no map slot to
  // define USE_UV on its own. Preserve any existing defines.
  material.defines = { ...material.defines, USE_UV: "" };

  const scroll = new Vector4(0, 0, 0, 0);
  const cell = opts.cellMeters ?? CAUSTICS_CELL_METERS;
  const hasWave = opts.wave != null;

  const previousOnBeforeCompile = material.onBeforeCompile;
  material.onBeforeCompile = (
    shader: WebGLProgramParametersWithUniforms,
    renderer: WebGLRenderer,
  ) => {
    previousOnBeforeCompile(shader, renderer);
    Object.assign(shader.uniforms, {
      uCausticsA: { value: layers[0] },
      uCausticsB: { value: layers[1] },
      uCausticsScroll: { value: scroll },
      uCausticsRect: {
        value: new Vector4(
          opts.rect.cx,
          opts.rect.cz,
          opts.rect.halfX,
          opts.rect.halfZ,
        ),
      },
      uCausticsPlane: { value: new Vector2(opts.spanX, opts.spanY) },
      uCausticsCell: { value: new Vector2(cell, cell) },
      uCausticsColor: { value: new Color(opts.color ?? 0xffffff) },
      uCausticsIntensity: {
        value: (opts.intensity ?? 1) * CAUSTICS_OUTPUT_GAIN,
      },
      ...(opts.wave
        ? {
            uWaveHeight: { value: opts.wave.texture },
            uWaveTexel: {
              value: new Vector4(
                1 / opts.wave.texture.image.width,
                1 / opts.wave.texture.image.height,
                opts.wave.texelMeters.x,
                opts.wave.texelMeters.y,
              ),
            },
          }
        : {}),
    });
    if (!shader.fragmentShader.includes(CAUSTICS_DECLS_PROBE)) {
      if (!shader.fragmentShader.includes(EMISSIVE_INCLUDE)) {
        throw new Error(
          "materials/caustics-surface: fragment shader has no emissivemap_fragment include",
        );
      }
      let next = shader.fragmentShader.replace(
        EMISSIVE_INCLUDE,
        buildCausticsEmissive(hasWave),
      );
      if (hasWave) {
        if (!next.includes(MAP_INCLUDE)) {
          throw new Error(
            "materials/caustics-surface: fragment shader has no map_fragment include for the wave slope block's injection anchor",
          );
        }
        next = WAVE_FRAGMENT_DECLS + next;
        next = next.replace(MAP_INCLUDE, `${WAVE_REFRACT_BLOCK}\n${MAP_INCLUDE}`);
      }
      shader.fragmentShader = FRAGMENT_DECLS + next;
    }
  };

  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () =>
    previousCacheKey() +
    CAUSTICS_PROGRAM_CACHE_TAG +
    (hasWave ? CAUSTICS_WAVE_CACHE_TAG : "");

  material.needsUpdate = true;

  const driver: PoolCaustics = {
    update(elapsed: number) {
      scroll.x = (elapsed * CAUSTICS_SCROLL_A.vx) % 1;
      scroll.y = (elapsed * CAUSTICS_SCROLL_A.vy) % 1;
      scroll.z = (elapsed * CAUSTICS_SCROLL_B.vx) % 1;
      scroll.w = (elapsed * CAUSTICS_SCROLL_B.vy) % 1;
    },
  };
  patchedMaterials.set(material, driver);
  return driver;
}
