/** Visual direction for the RTS scene. These values never alter a room's
 * identity, geometry, links or stored record. No browser or renderer imports. */
import type { Palette } from "./space-types";
import type { BiomeSkin, SkinFloorKind, SkinWallKind } from "./skins";
import { CAM_OFFSET, MODULE_LIGHT_FIXTURES } from "./tuning/room";

type ScenarioPalette = Palette & Required<Pick<Palette, "wall" | "fabric" | "wood">>;

/** The same calm material family in every room; the existing palette id keeps
 * its daylight/night distinction and remains available to authored fixtures. */
export function scenarioPalette(source: Palette, night: boolean): ScenarioPalette {
  return {
    ...source,
    sky: night ? "#b7c1a9" : "#d9ddc7",
    fog: night ? "#c3cbb4" : "#dce1cd",
    ground: night ? "#b7bfa6" : "#c0c5ad",
    wall: night ? "#cbd1b8" : "#d1d6bf",
    fabric: night ? "#9dab8e" : "#a0af91",
    wood: night ? "#c5b797" : "#d0c1a2",
    accent: "#b78b60",
    sunColor: night ? "#e2ddbb" : "#fff3d5",
    sunIntensity: night ? 0.62 : 0.92,
    // Matte broad-surface pass (v0.11-streams art overhaul): interiors read
    // soft and diffuse — the lifted sun fill + ambient do the shaping —
    // while the contact shadows under furniture carry the grounding
    // instead of hard pools.
    ambient: night ? 0.44 : 0.56,
  };
}

type MaterialSlot = "ground" | "wall" | "fabric" | "wood";
const FLOOR_SLOT: Record<SkinFloorKind, MaterialSlot> = {
  timber: "wood", deck: "wood", sand: "wood",
  carpet: "fabric", moss: "fabric",
  tile: "wall", gravel: "wall", snow: "wall",
  grass: "ground", stone: "ground", "shallow-water": "ground",
};
const WALL_SLOT: Record<SkinWallKind, MaterialSlot> = {
  plaster: "wall", tile: "wall", stone: "wall", glass: "wall",
  panelling: "wood", rock: "wood",
  shelf: "fabric", hedge: "fabric", "water-wall": "ground",
};

/** Adapt catalogue colors AND light levels at the render boundary. Real
 * records always draw a skin, including temperate; its authored colors and
 * catalogue light intensity/pool overrides must not override the scene's
 * art direction — the matte pass runs every fixture at the quiet
 * MODULE_LIGHT_FIXTURES levels regardless of how hot the catalogue entry
 * was authored. Material kinds, movement, silhouettes, light register,
 * furnishing and staging stay intact; only the render copy's tint, level
 * and pool join the shared art direction. A skinless debug room keeps
 * using scenarioPalette directly. */
export function scenarioSkin(source: BiomeSkin | null, palette: Palette): BiomeSkin | null {
  if (source === null) return null;
  const day = scenarioPalette(palette, false);
  const night = scenarioPalette(palette, true);
  const colors = (slot: MaterialSlot) => ({ day: day[slot], night: night[slot] });
  const windowColors = (p: ScenarioPalette) => ({
    sky: p.sky, fog: p.fog, ground: p.ground, sun: p.sunColor,
  });
  // The render copy answers to the CURRENT fixture table (fallback quiet):
  // the catalogue's intensity/pool overrides are render-boundary values,
  // not identity — real-record rooms get the same quiet levels as the
  // skinless debug rooms.
  const fixture =
    MODULE_LIGHT_FIXTURES[source.light.register] ?? MODULE_LIGHT_FIXTURES.quiet;
  return {
    ...source,
    floor: { ...source.floor, colors: colors(FLOOR_SLOT[source.floor.kind]) },
    wall: { ...source.wall, colors: colors(WALL_SLOT[source.wall.kind]) },
    light: {
      ...source.light,
      tint: day.sunColor,
      intensity: fixture.intensity,
      pool: fixture.pool,
    },
    window: { ...source.window, day: windowColors(day), night: windowColors(night) },
    fog: { ...source.fog, day: day.fog, night: night.fog },
  };
}

/** Fit the cutaway on all viewport sizes. This uses the projected room, not
 * a scale tier: a wide room and a square room must not get the same zoom. */
export function rtsRoomZoom(
  viewport: { width: number; height: number },
  room: { width: number; depth: number; wallHeight: number } | null,
): number {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  if (room === null) return Math.max(18, Math.min(44, width / 17, height / 12));
  const horizontal = Math.hypot(CAM_OFFSET.x, CAM_OFFSET.z);
  const pitch = Math.atan2(CAM_OFFSET.y, horizontal);
  const projectedWidth = (room.width + room.depth) * Math.SQRT1_2;
  const projectedHeight = projectedWidth * Math.sin(pitch) + room.wallHeight * Math.cos(pitch);
  return Math.max(1, Math.min(
    66,
    width * 0.84 / Math.max(1, projectedWidth),
    height * 0.72 / Math.max(1, projectedHeight),
  ));
}

/** Paper and terminal use one keyboard gate. A focused DOM control owns its
 * own Enter/Space; typing E into a field must never pick up a sheet. */
export function shouldInteractWithScene(input: {
  key: string;
  blocked: boolean;
  targetOwnsKeys: boolean;
  hasPaper: boolean;
  hasAnchor: boolean;
}): boolean {
  return !input.blocked && !input.targetOwnsKeys &&
    (input.key.toLowerCase() === "enter" || input.key.toLowerCase() === "e") &&
    (input.hasPaper || input.hasAnchor);
}
