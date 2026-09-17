/**
 * Tests for the pool-floor caustics patch
 * (src/lib/game/materials/caustics-surface.ts) and its shared texture cache
 * entry. No WebGL here: the patch is exercised against a fabricated shader
 * object (same style the water/surface patches are validated with — the
 * include markers are plain text), and the cache test only inspects the
 * DataTexture objects.
 */
import { describe, it, expect } from "vitest";
import {
  DataTexture,
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";
import {
  applyPoolCaustics,
  CAUSTICS_CELL_METERS,
} from "@/lib/game/materials/caustics-surface";
import { sharedCausticsTextures } from "@/lib/game/materials/shared";

const RECT = { cx: 0, cz: 8, halfX: 4, halfZ: 3 };
const SPAN = { spanX: 12, spanY: 16 };

/** A minimal stand-in for the linked program's pre-include shader text. */
function fakeShader() {
  return {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: "void main() { }",
    fragmentShader:
      "uniform vec3 totalEmissiveRadiance;\nvoid main() {\n#include <emissivemap_fragment>\n}",
  } as unknown as WebGLProgramParametersWithUniforms;
}

function mappedMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial();
  material.map = new DataTexture(new Uint8Array(4), 1, 1);
  return material;
}

describe("sharedCausticsTextures", () => {
  it("returns two seamless float layers with the library sampling policy", () => {
    const textures = sharedCausticsTextures();
    expect(textures.length).toBe(2);
    for (const texture of textures) {
      expect(texture.image.width).toBe(256);
      expect(texture.image.height).toBe(256);
      expect(texture.format).toBe(RGBAFormat);
      expect(texture.type).toBe(FloatType);
      expect(texture.wrapS).toBe(RepeatWrapping);
      expect(texture.wrapT).toBe(RepeatWrapping);
      expect(texture.magFilter).toBe(LinearFilter);
      expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
      expect(texture.generateMipmaps).toBe(true);
      expect(texture.anisotropy).toBeGreaterThanOrEqual(8);
    }
  });

  it("caches: the same instances come back on every call", () => {
    expect(sharedCausticsTextures()).toBe(sharedCausticsTextures());
  });
});

describe("applyPoolCaustics", () => {
  it("refuses a material without a map (vMapUv is the coordinate carrier)", () => {
    expect(() =>
      applyPoolCaustics(new MeshStandardMaterial(), { rect: RECT, ...SPAN }),
    ).toThrow(/vMapUv/);
  });

  it("injects the additive web after emissivemap_fragment, masked and tinted", () => {
    const material = mappedMaterial();
    applyPoolCaustics(material, { rect: RECT, ...SPAN, intensity: 1.5 });
    const shader = fakeShader();
    material.onBeforeCompile(shader, null as unknown as WebGLRenderer);

    expect(shader.fragmentShader).toContain("uCausticsA");
    expect(shader.fragmentShader).toContain("uCausticsB");
    expect(shader.fragmentShader).toContain("totalEmissiveRadiance +=");
    expect(shader.fragmentShader).toContain("smoothstep");
    // The include survives exactly once (the injection replaces it with
    // itself plus the web code).
    expect(
      shader.fragmentShader.split("#include <emissivemap_fragment>").length,
    ).toBe(2);

    const rect = shader.uniforms.uCausticsRect.value as {
      x: number;
      y: number;
      z: number;
      w: number;
    };
    expect([rect.x, rect.y, rect.z, rect.w]).toEqual([0, 8, 4, 3]);
    expect(shader.uniforms.uCausticsIntensity.value).toBe(1.5);
    const cell = shader.uniforms.uCausticsCell.value as Vector2;
    expect(cell.x).toBe(CAUSTICS_CELL_METERS);
    expect(shader.uniforms.uCausticsA.value).toBe(sharedCausticsTextures()[0]);
    expect(shader.uniforms.uCausticsB.value).toBe(sharedCausticsTextures()[1]);
  });

  it("throws loud when the fragment shader lacks the expected include", () => {
    const material = mappedMaterial();
    applyPoolCaustics(material, { rect: RECT, ...SPAN });
    const shader = fakeShader();
    shader.fragmentShader = "void main() { }";
    expect(() =>
      material.onBeforeCompile(shader, null as unknown as WebGLRenderer),
    ).toThrow(/emissivemap_fragment/);
  });

  it("chains onto an existing onBeforeCompile instead of replacing it", () => {
    const material = mappedMaterial();
    let previousRan = false;
    material.onBeforeCompile = () => {
      previousRan = true;
    };
    applyPoolCaustics(material, { rect: RECT, ...SPAN });
    material.onBeforeCompile(fakeShader(), null as unknown as WebGLRenderer);
    expect(previousRan).toBe(true);
  });

  it("forks the program cache key so patched and unpatched floors never share a program", () => {
    const base = mappedMaterial();
    const patched = mappedMaterial();
    applyPoolCaustics(patched, { rect: RECT, ...SPAN });
    expect(patched.customProgramCacheKey()).not.toBe(
      base.customProgramCacheKey(),
    );
    expect(patched.customProgramCacheKey()).toContain(":caustics-v1");
  });

  it("update(elapsed) counter-scrolls the two layers, deterministically", () => {
    const material = mappedMaterial();
    const caustics = applyPoolCaustics(material, { rect: RECT, ...SPAN });
    const shader = fakeShader();
    material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
    const scroll = shader.uniforms.uCausticsScroll.value as {
      x: number;
      y: number;
      z: number;
      w: number;
    };

    caustics.update(10);
    const first = { ...scroll };
    expect(first.x).toBeGreaterThan(0);
    // Counter-scroll: layer B moves against layer A on x.
    expect(Math.sign(first.z)).toBe(-Math.sign(first.x));
    expect(first.x).not.toBe(0);
    expect(first.w).not.toBe(0);

    caustics.update(10);
    expect({ ...scroll }).toEqual(first);

    caustics.update(20);
    expect(scroll.x).not.toBe(first.x);
  });
});
