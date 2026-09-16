/**
 * PBR surface materials built on the library's shared tile/concrete texture
 * sets — the consumer half of the material wiring.
 *
 * PHYSICAL REPEAT WITHOUT TEXTURE CLONES. Three.js applies a map's repeat
 * through the texture's own uv transform, which is per-TEXTURE — but our
 * textures are shared singletons (shared.ts) while every wall/floor needs
 * its own physical tiling (one texture cell = one real 0.3m tile). Cloning
 * a DataTexture per repeat would re-upload ~1.5MB of GPU texture per clone
 * per room entry. Instead this module keeps the shared textures at repeat 1
 * and injects a per-material `uTiling` uniform into the vertex shader: the
 * patched uv_vertex chunk multiplies vMapUv / vRoughnessMapUv /
 * vNormalMapUv by uTiling, so each material gets exact physical tiling at
 * zero extra texture cost.
 *
 * RAW NORMAL MAPS. The library's normal textures store vectors RAW in
 * [-1, 1] (FloatType) — NOT the usual [0,1] encoding — so the patched
 * normal_fragment_maps chunk drops three's `* 2.0 - 1.0` unpack.
 *
 * Both patches rewrite ShaderChunk text imported from the installed three
 * and THROW if an expected line is missing — a three upgrade that changes
 * those chunks fails loud at material creation, never silently untiled.
 *
 * ALBEDO COMPENSATION. A map multiplies the material color; the tile and
 * concrete albedos average ~0.92 / ~0.60, which would darken the palette
 * colors the rooms are tuned around. The factory pre-divides by each
 * builder's documented mean (TILE_ALBEDO_MEAN / CONCRETE_ALBEDO_MEAN), so
 * the palette stays the average and the texture adds variation around it —
 * monochrome discipline (design axiom A5) is preserved.
 */

import {
  Color,
  MeshStandardMaterial,
  ShaderChunk,
  Vector2,
  type ColorRepresentation,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { CONCRETE_SPAN_METERS, TILE_SPAN_METERS } from "../tuning/room";
import { CONCRETE_ALBEDO_MEAN } from "./concrete";
import { sharedConcreteTextures, sharedTileTextures } from "./shared";
import { TILE_ALBEDO_MEAN } from "./tile";
import type { MaterialTextures } from "./three";

export type SurfaceKind = "tile" | "concrete";

export interface SurfaceMaterialOptions {
  kind: SurfaceKind;
  /** Palette color; the texture varies around it (see header). */
  color: ColorRepresentation;
  /** Physical span in meters the material covers along u and v. */
  spanX: number;
  spanY: number;
  transparent?: boolean;
  opacity?: number;
  flatShading?: boolean;
  normalScale?: number;
}

/** uv_vertex assignment expressions (three r185) that carry the maps we set. */
const UV_EXPRS = [
  "vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy",
  "vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy",
  "vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy",
] as const;

/** The [0,1]-encoded normal sample inside normal_fragment_maps (r185). */
const NORMAL_SAMPLE_PACKED =
  "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;";
const NORMAL_SAMPLE_RAW =
  "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz; // library maps store raw [-1,1] vectors — no unpack";

/** uv_vertex with every map's uv scaled by the per-material uTiling. */
function buildTiledUvVertex(): string {
  let chunk = ShaderChunk.uv_vertex;
  for (const expr of UV_EXPRS) {
    if (!chunk.includes(expr)) {
      throw new Error(
        `materials/surface: three's uv_vertex no longer contains "${expr}" — the tiling patch needs updating for this three version`,
      );
    }
    chunk = chunk.replace(expr, `${expr} * uTiling`);
  }
  return chunk;
}

/** normal_fragment_maps sampling the raw [-1,1] library maps as-is. */
function buildRawNormalFragmentMaps(): string {
  const chunk = ShaderChunk.normal_fragment_maps;
  if (!chunk.includes(NORMAL_SAMPLE_PACKED)) {
    throw new Error(
      "materials/surface: three's normal_fragment_maps no longer contains the packed normal sample — the raw-normal patch needs updating for this three version",
    );
  }
  return chunk.replace(NORMAL_SAMPLE_PACKED, NORMAL_SAMPLE_RAW);
}

function applySurfaceShaderPatch(
  shader: WebGLProgramParametersWithUniforms,
  tiling: { value: Vector2 },
): void {
  shader.uniforms.uTiling = tiling;
  if (!shader.vertexShader.includes("#include <uv_vertex>")) {
    throw new Error("materials/surface: vertex shader has no uv_vertex include");
  }
  shader.vertexShader =
    "uniform vec2 uTiling;\n" +
    shader.vertexShader.replace("#include <uv_vertex>", buildTiledUvVertex());
  if (!shader.fragmentShader.includes("#include <normal_fragment_maps>")) {
    throw new Error(
      "materials/surface: fragment shader has no normal_fragment_maps include",
    );
  }
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <normal_fragment_maps>",
    buildRawNormalFragmentMaps(),
  );
}

// One shared cache key: every surface material compiles the SAME program
// (identical patched chunks); per-material values live in uniforms only.
const SURFACE_PROGRAM_CACHE_KEY = "previously-surface-v1";

/**
 * One tile or concrete PBR material. albedo + roughness + normal maps come
 * from the shared texture sets; `spanX`/`spanY` are physical meters and the
 * repeat falls out of the kind's span constant (tile: TILE_SPAN_METERS =
 * 2.4m = 8 grout cells × 0.3m; concrete: CONCRETE_SPAN_METERS = 5m), so one
 * texture cell always maps to one real tile. roughness stays 1 so the maps
 * read as absolute values (glaze ≈ 0.05–0.15 / grout ≈ 0.8 / concrete matte
 * band 0.7–0.9). Dispose the material when its surface unmounts — the
 * shared textures must NOT be disposed.
 */
export function createSurfaceMaterial(
  opts: SurfaceMaterialOptions,
): MeshStandardMaterial {
  const textures: MaterialTextures =
    opts.kind === "tile" ? sharedTileTextures() : sharedConcreteTextures();
  const span = opts.kind === "tile" ? TILE_SPAN_METERS : CONCRETE_SPAN_METERS;
  const albedoMean =
    opts.kind === "tile" ? TILE_ALBEDO_MEAN : CONCRETE_ALBEDO_MEAN;

  const material = new MeshStandardMaterial({
    color: new Color(opts.color).multiplyScalar(1 / albedoMean),
    roughness: 1,
    metalness: 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    flatShading: opts.flatShading ?? false,
  });
  material.map = textures.albedo;
  material.roughnessMap = textures.roughness;
  material.normalMap = textures.normal;
  const strength = opts.normalScale ?? 1;
  material.normalScale.set(strength, strength);

  const tiling = {
    value: new Vector2(opts.spanX / span, opts.spanY / span),
  };
  material.onBeforeCompile = (shader) =>
    applySurfaceShaderPatch(shader, tiling);
  material.customProgramCacheKey = () => SURFACE_PROGRAM_CACHE_KEY;
  return material;
}
