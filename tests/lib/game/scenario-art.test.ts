import { describe, expect, it } from "vitest";
import { cameraModeFor, moveBasisFor, TOPDOWN_YAW } from "@/lib/game/chase-camera";
import { rtsRoomZoom, scenarioPalette, scenarioSkin, shouldInteractWithScene } from "@/lib/game/scenario-art";
import { SKINS, skinForSlice } from "@/lib/game/skins";
import { PALETTES } from "@/lib/game/space-types";
import { skinFloorHex, skinFogHex, skinWallHex, skinWindowBake } from "@/lib/game/tuning/render";
import { CAM_OFFSET } from "@/lib/game/tuning/room";

describe("scenario material colors", () => {
  const sourcePalette = PALETTES[0];

  it("recolors ordinary record skins and skinless debug rooms through the same material family", () => {
    // Synthetic ids exercise the real-record draw without touching stored data.
    const ids = Array.from({ length: 64 }, (_, i) => `2099-01-01T00-00-00-art-${i}`);
    for (const id of [...ids, "dbg-m:living", "dbg-skin:temperate+dbg-m:living"]) {
      const catalogueSkin = skinForSlice(id);
      if (!id.startsWith("dbg-")) expect(catalogueSkin).not.toBeNull();
      const skin = scenarioSkin(catalogueSkin, sourcePalette);
      for (const night of [false, true]) {
        const palette = scenarioPalette(sourcePalette, night);
        const materials = [palette.ground, palette.wood, palette.fabric, palette.wall];
        expect(materials).toContain(skinFloorHex(skin, night) ?? palette.ground);
        expect(materials).toContain(skinWallHex(skin, night) ?? palette.wall);
        expect(skinFogHex(skin, night) ?? palette.fog).toBe(palette.fog);
      }
    }
    expect(scenarioSkin(skinForSlice("dbg-m:living"), sourcePalette)).toBeNull();
  });

  it("keeps temperate timber warm and plaster light instead of restoring the catalogue's dark brown", () => {
    const catalogueSkin = skinForSlice("dbg-skin:temperate+dbg-m:living");
    const skin = scenarioSkin(catalogueSkin, sourcePalette);
    expect(skin?.floor.colors).toEqual({ day: "#c8b28d", night: "#a89676" });
    expect(skin?.wall.colors).toEqual({ day: "#dedfca", night: "#b1bda4" });
    expect(catalogueSkin?.floor.colors).toEqual({ day: "#9a7a58", night: "#5e4b38" });
  });

  it.each(SKINS.map((skin) => [skin.id, skin] as const))("preserves %s identity and physical behavior without mutating the catalogue", (_, source) => {
    const before = structuredClone(source);
    const skin = scenarioSkin(source, sourcePalette)!;
    expect(source).toEqual(before);
    expect(skin).toMatchObject({
      id: source.id,
      label: source.label,
      floor: { kind: source.floor.kind, walk: source.floor.walk, speed: source.floor.speed },
      wall: { kind: source.wall.kind },
      light: { register: source.light.register },
      window: { silhouette: source.window.silhouette },
      fog: { density: source.fog.density, horizon: source.fog.horizon },
    });
    expect(skin.wall.opacity).toBe(source.wall.opacity);
    expect(skin.light.intensity).toBe(source.light.intensity);
    expect(skin.light.pool).toBe(source.light.pool);
    expect(skin.furnishing).toBe(source.furnishing);
    expect(skin.slotOverrides).toBe(source.slotOverrides);
    // The exterior's old blue/brown haze cannot re-enter through the apron
    // or the baked window view while the stage itself uses the new fog.
    expect(skin.fog.day).toBe("#becbb2");
    expect(skin.fog.night).toBe("#7d8d77");
    expect(skinWindowBake(skin)?.fog).toBe(skin.fog.day);
    expect(skin.window.night.fog).toBe(skin.fog.night);
  });

  it("preserves visible material distinctions across room skins", () => {
    const colors = SKINS.map((skin) => scenarioSkin(skin, sourcePalette)!.floor.colors.day);
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it("keeps the room-polish interior fill soft: lifted ambient, unchanged key hierarchy, distinct roles", () => {
    const day = scenarioPalette(sourcePalette, false);
    const night = scenarioPalette(sourcePalette, true);
    // Soft bright diffuse (visual study 02): the ambient floor is lifted
    // day and night, the key stays dominant, and the material-kind roles
    // remain distinct hues — no flattened single-tint room.
    expect(day.ambient).toBeGreaterThan(0.5);
    expect(night.ambient).toBeGreaterThan(0.4);
    expect(night.ambient).toBeLessThan(day.ambient);
    expect(day.sunIntensity).toBeGreaterThan(day.ambient);
    expect(day.wood).not.toBe(day.fabric);
    expect(day.fabric).not.toBe(day.wall);
    // The prop roles derive from these — the accent must not BE any role.
    expect(day.accent).not.toBe(day.wood);
    expect(day.accent).not.toBe(day.fabric);
    // Night keeps the same family, only dimmed.
    expect(night.wood).not.toBe(day.wood);
    expect(night.fabric).not.toBe(day.fabric);
  });
});

describe("fixed RTS camera", () => {
  it("defaults to the fixed view and keeps the chase view behind an explicit debug parameter", () => {
    for (const value of [null, "", "top", "invalid"]) {
      expect(cameraModeFor(value)).toBe("top");
    }
    expect(cameraModeFor("chase")).toBe("chase");
  });

  it("looks northwest from the southeast at 40–45 degrees, with screen-relative movement", () => {
    const horizontal = Math.hypot(CAM_OFFSET.x, CAM_OFFSET.z);
    const pitch = Math.atan2(CAM_OFFSET.y, horizontal) * 180 / Math.PI;
    expect(CAM_OFFSET.x).toBeGreaterThan(0);
    expect(CAM_OFFSET.z).toBeLessThan(0);
    expect(pitch).toBeGreaterThanOrEqual(40);
    expect(pitch).toBeLessThanOrEqual(45);
    const forward = moveBasisFor(TOPDOWN_YAW);
    expect(forward.fx).toBeCloseTo(-CAM_OFFSET.x / horizontal);
    expect(forward.fz).toBeCloseTo(-CAM_OFFSET.z / horizontal);
  });

  it("fits the room silhouette on desktop and portrait screens", () => {
    const pitch = Math.atan2(CAM_OFFSET.y, Math.hypot(CAM_OFFSET.x, CAM_OFFSET.z));
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 600 }]) {
      for (const room of [
        { width: 8, depth: 8, wallHeight: 3 },
        { width: 16, depth: 10, wallHeight: 3 },
        { width: 32, depth: 24, wallHeight: 3 },
      ]) {
        const zoom = rtsRoomZoom(viewport, room);
        const width = (room.width + room.depth) * Math.SQRT1_2;
        const height = width * Math.sin(pitch) + room.wallHeight * Math.cos(pitch);
        expect(width * zoom).toBeLessThanOrEqual(viewport.width * 0.85);
        expect(height * zoom).toBeLessThanOrEqual(viewport.height * 0.73);
      }
    }
    expect(rtsRoomZoom({ width: 390, height: 600 }, null)).toBeLessThan(
      rtsRoomZoom({ width: 1440, height: 900 }, null),
    );
  });
});

describe("scene keyboard interaction", () => {
  const paperOnly = { key: "Enter", blocked: false, targetOwnsKeys: false, hasPaper: true, hasAnchor: false };

  it("picks up a nearby paper with Enter or E without requiring a terminal", () => {
    for (const key of ["Enter", "e", "E"]) {
      expect(shouldInteractWithScene({ ...paperOnly, key })).toBe(true);
    }
    expect(shouldInteractWithScene({ ...paperOnly, hasPaper: false, hasAnchor: true })).toBe(true);
  });

  it("does not interact while reading, transitioning or using a DOM control", () => {
    expect(shouldInteractWithScene({ ...paperOnly, blocked: true })).toBe(false);
    expect(shouldInteractWithScene({ ...paperOnly, targetOwnsKeys: true })).toBe(false);
    expect(shouldInteractWithScene({ ...paperOnly, hasPaper: false })).toBe(false);
    expect(shouldInteractWithScene({ ...paperOnly, key: "w" })).toBe(false);
  });
});
