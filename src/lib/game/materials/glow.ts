/**
 * Radial glow gradient textures — white falloff gradients painted once into
 * a canvas (the consuming material's color does the tinting). Used by the
 * corridor for sconce floor pools, sconce wall washes, and the
 * end-of-world haze. Absorbed from src/components/game/corridor.tsx, which
 * kept them as private canvas code the design doc assigned to this library.
 *
 * The shared* accessors cache one texture per kind at module scope: every
 * instance of each kind shares it, so they are never disposed — one 256²
 * canvas per kind lives for the app's lifetime. Browser-coupled (canvas).
 */

import { CanvasTexture, SRGBColorSpace } from "three";

export const GLOW_TEXTURE_SIZE = 256;

/** Radial falloff centered in the texture: bright core dissolving to zero. */
export function createRadialGlowTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_TEXTURE_SIZE;
  canvas.height = GLOW_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const c = GLOW_TEXTURE_SIZE / 2;
    const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gradient.addColorStop(0.7, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Falloff anchored at the top-edge center: brightest just under the shade,
 *  dissolving downward and sideways into the wall. */
export function createWallWashTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_TEXTURE_SIZE;
  canvas.height = GLOW_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const c = GLOW_TEXTURE_SIZE / 2;
    const gradient = ctx.createRadialGradient(c, 0, 0, c, 0, GLOW_TEXTURE_SIZE);
    gradient.addColorStop(0, "rgba(255,255,255,0.9)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.4)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

let radialGlowTexture: CanvasTexture | null = null;
export function sharedRadialGlowTexture(): CanvasTexture {
  if (!radialGlowTexture) radialGlowTexture = createRadialGlowTexture();
  return radialGlowTexture;
}

let wallWashTexture: CanvasTexture | null = null;
export function sharedWallWashTexture(): CanvasTexture {
  if (!wallWashTexture) wallWashTexture = createWallWashTexture();
  return wallWashTexture;
}
