/**
 * Pool-floor caustics — the additive light web that sells "swimming pool"
 * (research pass: caustics is the single biggest cue; design doc §2 lists
 * drei's Caustics as the pool's signature, but that costs two extra scene
 * renders plus two fullscreen passes per frame — this is the zero-pass fake).
 *
 * HOW IT WORKS. This module PATCHES the existing ground material (the tile
 * basin floor from surface.ts) with an additive emissive term: the two
 * seamless caustics layers (caustics.ts) sampled at counter-scrolling UV
 * offsets and multiplied — where both webs' filaments cross, the product
 * flares, which reads as the slow boiling drift of real refracted light.
 * The web is masked to the water rectangle with a soft edge, so the deck
 * stays dark and the pattern fades at the waterline instead of clipping.
 *
 * UV RECOVERY. The ground plane's local coords are recoverable from the
 * tile map's varying: vMapUv = uv · (span / TILE_SPAN_METERS), and
 * space.tsx's ground mesh maps uv → local meters as
 *   lx = (uv.x - 0.5) · spanX,  lz = (1 - uv.y) · spanY
 * (plane rotated -π/2 about X, spanning z ∈ [0, extent]). The patch bakes
 * TILE_SPAN_METERS / span into uCausticsUvFromMap, so the mask and the
 * web sampling work in METERS — isotropic on non-square pools.
 *
 * PATCHING DISCIPLINE (same as surface.ts / water-surface.ts): the shared
 * textures stay at repeat 1 (scrolling lives in uniforms), onBeforeCompile
 * and customProgramCacheKey are CHAINED onto whatever the material already
 * has (surface.ts's tiling patch must keep working), and the shader text is
 * validated so a three upgrade that drops the expected include fails loud.
 * The material must carry a map (vMapUv is the coordinate carrier) — the
 * tile ground material always does.
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
 */

import {
  Color,
  Vector2,
  Vector4,
  type ColorRepresentation,
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

const FRAGMENT_DECLS = `
uniform sampler2D uCausticsA;
uniform sampler2D uCausticsB;
uniform vec4 uCausticsScroll;
uniform vec4 uCausticsRect;
uniform vec2 uCausticsPlane;
uniform vec2 uCausticsUvFromMap;
uniform vec2 uCausticsCell;
uniform vec3 uCausticsColor;
uniform float uCausticsIntensity;
`;

const EMISSIVE_INCLUDE = "#include <emissivemap_fragment>";

function buildCausticsEmissive(): string {
  return `${EMISSIVE_INCLUDE}
	{
		vec2 caustics01 = vMapUv * uCausticsUvFromMap;
		vec2 causticsLocal = vec2(
			( caustics01.x - 0.5 ) * uCausticsPlane.x,
			( 1.0 - caustics01.y ) * uCausticsPlane.y );
		vec2 causticsEdge = abs( causticsLocal - uCausticsRect.xy ) / uCausticsRect.zw;
		float causticsMask = 1.0 - smoothstep( ${MASK_FEATHER_START}, 1.0, max( causticsEdge.x, causticsEdge.y ) );
		vec2 causticsUv = causticsLocal / uCausticsCell;
		float causticsWeb =
				texture2D( uCausticsA, causticsUv + uCausticsScroll.xy ).r
			* texture2D( uCausticsB, causticsUv * ${LAYER_B_SCALE} + uCausticsScroll.zw ).r;
		totalEmissiveRadiance += uCausticsColor * ( causticsWeb * causticsMask * uCausticsIntensity );
	}`;
}

const CAUSTICS_PROGRAM_CACHE_TAG = ":caustics-v1";

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
 * Patch `material` (the tile basin floor) with the additive caustics web.
 * Chains onto the material's existing onBeforeCompile / cache key, so it
 * composes with surface.ts's tiling patch in either order. Idempotent:
 * calling it again on the SAME material returns the original driver
 * untouched — no second onBeforeCompile layer, no re-injection. Returns
 * the per-frame driver; call `update(elapsed)` from the room's useFrame.
 * The shared caustics textures must NOT be disposed; the material stays
 * owned by its creator.
 */
export function applyPoolCaustics(
  material: MeshStandardMaterial,
  opts: PoolCausticsOptions,
): PoolCaustics {
  if (!material.map) {
    throw new Error(
      "materials/caustics-surface: the caustics patch needs vMapUv — the target material must carry a map (the tile ground material does)",
    );
  }
  const existing = patchedMaterials.get(material);
  if (existing) return existing;
  const layers = sharedCausticsTextures();
  if (layers.length !== 2) {
    throw new Error(
      `materials/caustics-surface: ${layers.length} caustics layers for 2 scroll slots`,
    );
  }

  const scroll = new Vector4(0, 0, 0, 0);
  const cell = opts.cellMeters ?? CAUSTICS_CELL_METERS;

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
      uCausticsUvFromMap: {
        value: new Vector2(
          TILE_SPAN_METERS / opts.spanX,
          TILE_SPAN_METERS / opts.spanY,
        ),
      },
      uCausticsCell: { value: new Vector2(cell, cell) },
      uCausticsColor: { value: new Color(opts.color ?? 0xffffff) },
      uCausticsIntensity: {
        value: (opts.intensity ?? 1) * CAUSTICS_OUTPUT_GAIN,
      },
    });
    if (!shader.fragmentShader.includes(CAUSTICS_DECLS_PROBE)) {
      if (!shader.fragmentShader.includes(EMISSIVE_INCLUDE)) {
        throw new Error(
          "materials/caustics-surface: fragment shader has no emissivemap_fragment include",
        );
      }
      shader.fragmentShader =
        FRAGMENT_DECLS +
        shader.fragmentShader.replace(
          EMISSIVE_INCLUDE,
          buildCausticsEmissive(),
        );
    }
  };

  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () =>
    previousCacheKey() + CAUSTICS_PROGRAM_CACHE_TAG;

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
