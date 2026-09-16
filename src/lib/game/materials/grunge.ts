/**
 * Seeded mottled-grayscale canvas used as a shared roughnessMap: low-res
 * noise blurred up to GRUNGE_MAP_SIZE so the variation reads as soft
 * blotches, centered on GRUNGE_MAP_BASE so each role's nominal roughness
 * survives the multiply. Deterministic (seeded rng, no Math.random).
 *
 * Absorbed from the corridor renderer (src/components/game/corridor.tsx),
 * where it lived as a local placeholder pending this library. Canvas-based
 * and therefore browser-coupled, like three.ts — the pure builders stay
 * DOM-free.
 */

import { CanvasTexture, RepeatWrapping } from "three";
import { createRng, deriveSubSeed, WORLD_SEED } from "../seed";

export const GRUNGE_MAP_SIZE = 128; // px, square canvas
export const GRUNGE_MAP_BASE = 0.96; // mean multiplier × material.roughness
export const GRUNGE_MAP_VARIANCE = 0.18; // ± mottling amplitude

export function createGrungeRoughnessMap(): CanvasTexture {
  const rng = createRng(deriveSubSeed(WORLD_SEED, "materials", "style"));
  const small = document.createElement("canvas");
  small.width = 32;
  small.height = 32;
  const smallCtx = small.getContext("2d");
  const canvas = document.createElement("canvas");
  canvas.width = GRUNGE_MAP_SIZE;
  canvas.height = GRUNGE_MAP_SIZE;
  const ctx = canvas.getContext("2d");
  if (smallCtx && ctx) {
    const image = smallCtx.createImageData(small.width, small.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const v = Math.max(
        0,
        Math.min(
          255,
          255 * (GRUNGE_MAP_BASE + (rng() * 2 - 1) * GRUNGE_MAP_VARIANCE),
        ),
      );
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    smallCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}
