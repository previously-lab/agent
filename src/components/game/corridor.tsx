"use client";

/**
 * Corridor — the hotel diorama: lobby + ONE window of corridor (HD2).
 *
 * WHAT IT IS. The render half of the hotel. All layout arithmetic lives in
 * `src/lib/game/hotel.ts` + `corridor-pitch.ts`; this file only draws what
 * those functions return. The treadmill is gone (v0.11-room-interiors
 * §9/§10): exactly ONE window — hotel.ts's chunk, CHUNK_DOORS bays × two
 * walls — is materialized at a time, in the ONE local frame every hotel
 * shares (lobby at x ∈ [0, LOBBY_LENGTH), corridor at negative x). Which
 * window is showing is the integrator's location state (`windowIndex`
 * prop); a window switch is a data swap, never a coordinate change. The
 * corridor's far end is either the PAGE DOOR into the next-older hotel's
 * lobby or — at the oldest window — a plain wall (§10: "直到尽头就什么都
 * 没有了"). The lobby carries the RETURN DOORS the trips in came through
 * (§10.5): one per wall (north junction wall / south leg wall) the nav
 * stack's trips entered from, hung whenever the integrator says that side
 * has a trip. The lobby's south wall also wears the REGISTER BOARD above
 * the front desk (§9.2/§10.3 — the window's slices and their gaps, the
 * hotel's identity, the older-hotel promise; R3F panel, DOM text per §13).
 *
 * ACCENT (§11.1). Every hotel has one accent color (the `accent` prop —
 * brand blue for the core timeline, another brand-family member for strand
 * timelines): the door plates' ink, the page door's glow, and the return
 * door's glow all take it, so a hotel reads as belonging to its timeline.
 *
 *
 * THE HALL. The camera looks at the player from (−x, +y, +z), so the north
 * wall (z > 0) is the near wall and the south wall (z < 0) is the far
 * backdrop. Both walls run full height — the corridor reads as one tall
 * hall volume. No ceilings anywhere — open dollhouse: nothing spans the
 * hall overhead, so the top-down camera reads straight down to the floor.
 * Every wall also carries a
 * cornice band at the top and a wainscot + chair-rail band at the bottom,
 * both broken around door gaps, so the wall face no longer reads as one
 * flat extrusion.
 *
 * WALLS WITH HOLES. A wall run is not one box: for each door the run is
 * split into solid segments plus a lintel box above the door gap, so the
 * wall face stays continuous and the top edge is one straight line.
 *
 * THE LOBBY IS THE SHORT LEG OF THE L (v0.11-room-interiors §10: 短边 =
 * 大厅, 长边 = 走廊). The corridor is the long leg; the lobby turns across
 * it. Its floor keeps the corridor's junction band (x ∈ [0, LOBBY_LENGTH])
 * and extends SOUTH to z = −LOBBY_SOUTH_REACH, so the room's own axis is
 * perpendicular to the hall: the junction's south side is open (the
 * corridor's south wall stops at the seam), the leg's west wall — the
 * camera side — is a low cutaway parapet, and the far walls run full
 * height with the front desk against the south one, facing the arriving
 * player. Chunk ownership is unchanged: chunk 0 owns the lobby along x
 * whatever its z extent, and no corridor geometry moves (see hotel.ts).
 *
 * DOOR GLOW. Each door's glow color comes from
 * `doorGlowColor(compileSpaceRecipe(door.sliceId).palette)` — the room's
 * own tone (ground→sky, lifted), deterministic per slice, so the glimpse
 * through the frame reads as THAT room's light. Glow is emissive material
 * only: a plane behind the recessed slab plus a strip above the lintel
 * and a faint additive halo. No per-door point lights (too many lights).
 *
 * DOOR PITCH. The corridor is the timeline, and a timeline is intervals
 * (v0.11-strand-field §1): the distance between two doors is a function of
 * the time gap between their slices (corridor-pitch.ts — log10 of the gap
 * in days, clamped between 5 and 24 m). A busy week walks dense; a silent
 * month walks long. The layout is built once from the doors' start
 * timestamps and threaded through every layout query; when every gap is
 * one day or less the grid collapses onto the legacy uniform 6 m spacing
 * bit for bit. The pitch lives purely in corridor space — it is
 * independent of room dimensions; a room merely mounts at its door's
 * position.
 *
 * CORRIDOR LAMPS (灯廊 — hotel-rooms §B.13). The corridor is not lit from
 * overhead; it is lit by its fixtures, and every real point light sits ON
 * one. Sconces hang on the corridor's FIXED architectural grid — one every
 * 6 m on the north (full-height) wall, anchored at the lobby, independent
 * of the bays: the house's rhythm stays periodic while the doors (content)
 * move with time, so a long silent stretch shows a longer bare wall with
 * its lamp rhythm intact and a dense cluster keeps the old look. A sconce
 * is a dark bracket box plus a warm emissive cone, a radial-gradient light
 * pool on the floor and a soft gradient wash on the wall behind it — both
 * textured additive quads (shared canvas textures), not the old bare
 * circles at 0.07/0.15 opacity that read as nothing — and, for up to
 * SCONCE_LIGHT_MAX_PER_CHUNK per chunk, a REAL short-range point light just
 * under the shade. Longer chunks thin the lit set to an even spread with a
 * proportionally longer reach, so the real-light budget stays bounded while
 * every sconce keeps its shade and decals. The south wall answers with the
 * LIGHT LINE: a continuous warm cove strip just above the baseboard (the
 * dollhouse has no ceiling, so the cove lives at ankle height), a soft wash
 * up the wall, a glow along the floor's edge, and a few low real point
 * lights spread along it. FLOOR LAMPS — the lobby's fixture — stand at
 * intervals along the hall on a 24 m grid, alternating walls, skipping
 * door swings, real light included. Everything is static: calm
 * incandescent pools, never flickering. Sconce glow is a constant warm
 * #ffd9a0 — it is architecture, not memory, so it deliberately does not
 * derive from any slice recipe.
 *
 * DIMMING & HIDING. While a door space is active (`dimmed` prop) the
 * hotel goes dark behind the player so the space owns the screen — and
 * once the fade completes, the hotel UNMOUNTS entirely: geometry, door
 * glow, sconces, every light source. Nothing residual may light the
 * space. Every real light and emissive/glow material eases between its
 * full and dimmed level with an exponential lerp; the descent runs at a
 * faster rate (6/s) so the corridor is ~95% dark within the 500 ms hide
 * window, while the recovery keeps the game canvas's atmosphere rate
 * (2.5/s, dt clamped at 0.05). The live values sit in three.js object
 * refs mutated from `useFrame` — no React state per frame, no
 * allocations. Full/dimmed pairs live in one LIGHT_LEVELS table so the
 * JSX initial values and the lerp targets can never drift apart. The
 * `dimmed` flag reaches the lerp callbacks through a ref (synced in an
 * effect), so toggling it never re-renders the tree; only the delayed
 * unmount is a state change. Corridor itself (and its chunk window state)
 * stays mounted while hidden — playerRef keeps the position, so the hotel
 * remounts exactly where the player left it when the space ends.
 *
 * THE VOID. The corridor stands in open void — a surrounding dark
 * building mass was tried and rejected (it read as a black shell), so
 * nothing here extends beyond the wall faces. The corridor's far end is
 * deliberate: the window's end wall carries either the page door into the
 * next-older hotel or — at the oldest window — a plain wall (see
 * CorridorEnd).
 *
 * MATERIALS. Every shared surface material carries a real physical finish
 * (MATERIAL_FINISH — waxed-wood floor sheen, satin wainscot, matte
 * plaster/fabric, darkened-metal trim) plus a seeded mottled roughnessMap
 * (GRUNGE_*) so reflections vary subtly instead of reading as one uniform
 * value. No per-material ambient hacks; the finishes are built to come
 * alive under the scene-wide environment map and shadows. The grunge map
 * and the sconce/end-glow gradient textures come from the shared procedural
 * material library (src/lib/game/materials — grunge.ts / glow.ts).
 *
 * CORRIDOR DRESSING. The hall is dressed per chunk, all seeded:
 * a carpet runner with dark binding stripes down the floor's spine,
 * framed abstract paintings on ~half the interior wall gaps (2–3 flat
 * color quads each — no textures), 0–2 wall-hugging floor props (potted
 * plants, bins) rejection-sampled clear of doors and art, and glowing
 * date plaques where the calendar day changes between bays. Paintings
 * and props derive from `corridor-chunk-<n>` sub-seeds, so they are
 * architecture: they never reshuffle as slices allocate. The carpet,
 * cornice, and wainscot are fixed geometry. The lobby prop
 * layout is likewise seeded; the lobby itself carries no corridor
 * dressing but wears the seam portal posts that
 * make it recognisable from far down the hall.
 *
 * SLICE SIGNAGE. Every door wears a plate with its slice's HHMM time
 * (`…-0746` → `0746`) just right of the frame, and each date boundary
 * wears a larger glowing plaque (`09·15`) high on both walls — the signs
 * are canvas-textured plaques whose text is parsed from the sliceId
 * itself (see SLICE_ID_RE). Textures are built once per sign and disposed
 * on unmount.
 *
 * WHAT THIS FILE OWNS vs THE INTEGRATOR. This component supplies the
 * indoor floor light (one hemisphere light — B.13: only the "we are
 * indoors" base; the fixtures carry the mood). It does NOT set the scene
 * fog; the fog color #1a1d24 belongs to the canvas owner (the hotel
 * floats in it). The camera is also the canvas
 * owner's job.
 *
 * DETERMINISM. The lobby prop layout and all corridor dressing derive
 * from `deriveSubSeed(WORLD_SEED, …)` streams — same world seed, same
 * hotel, on any machine. No Math.random anywhere (see seed.ts).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { AdditiveBlending, CanvasTexture, Color, DoubleSide, MeshStandardMaterial, SRGBColorSpace } from "three";
import type { JSX, MutableRefObject } from "react";
import type {
  Group,
  HemisphereLight,
  MeshBasicMaterial,
  PointLight,
} from "three";
import {
  createGrungeRoughnessMap,
  sharedRadialGlowTexture,
  sharedWallWashTexture,
} from "@/lib/game/materials";
import {
  CHUNK_DOORS,
  CORRIDOR_WIDTH,
  DOOR_SPACING,
  LOBBY_LENGTH,
  LOBBY_SOUTH_REACH,
  WALL_HEIGHT,
  WINDOW_SLICES,
  chunkBounds,
  doorsInChunk,
  type DoorRef,
  type Side,
} from "@/lib/game/hotel";
import {
  bayBoundaryX,
  bayCenterX,
  corridorLayoutFromDoors,
  windowCountForLayout,
  windowLayout,
  type CorridorLayout,
} from "@/lib/game/corridor-pitch";
import { sliceClock } from "@/lib/game/slice-clock";
import { sliceIdToMs } from "@/lib/game/strand-graph";
import { WORLD_SEED, createRng, deriveSubSeed, pick, rangeInt } from "@/lib/game/seed";
import { compileSpaceRecipe, doorGlowColor } from "@/lib/game/space-recipe";
import type { ArchetypeId } from "@/lib/game/space-types";
import {
  ART_PALETTE,
  CHAIR_RAIL_DEPTH,
  CHAIR_RAIL_HEIGHT,
  CORNICE_DEPTH,
  CORNICE_HEIGHT,
  CORRIDOR_WALL_THICKNESS,
  DIM_LERP_RATE,
  DIM_LERP_RATE_DESCEND,
  DIM_MAX_DT,
  FLOOR_LAMP_DOOR_CLEARANCE,
  FLOOR_LAMP_LIGHT_DISTANCE,
  FLOOR_LAMP_SPACING,
  FLOOR_LAMP_Z,
  GRUNGE_ROLES,
  HIDE_DELAY_MS,
  LAMP_COLOR,
  LIGHT_LEVELS,
  LOBBY_CUTAWAY_CAP,
  LOBBY_CUTAWAY_HEIGHT,
  MATERIAL_FINISH,
  PAINTING_H,
  PAINTING_W,
  PLATE_BG,
  PLATE_INK,
  PORTAL_POST_SIZE,
  REGISTER_BOARD_H,
  REGISTER_BOARD_W,
  REGISTER_BOARD_Y,
  RETURN_DOOR_SOUTH_X,
  RETURN_DOOR_X,
  SCONCE_COLOR,
  SCONCE_LIGHT_HEIGHT,
  SCONCE_LIGHT_INSET,
  SCONCE_LIGHT_MAX_PER_CHUNK,
  SCONCE_POOL_OFFSET,
  SCONCE_POOL_RADIUS,
  SCONCE_WASH_HEIGHT,
  SCONCE_WASH_WIDTH,
  STRIP_COLOR,
  STRIP_HEIGHT,
  STRIP_LIGHT_HEIGHT,
  STRIP_LIGHT_INSET,
  STRIP_LIGHT_MAX_PER_CHUNK,
  STRIP_LIGHT_TARGET_SPACING,
  STRIP_POOL_WIDTH,
  STRIP_WASH_HEIGHT,
  THEME_COLORS,
  THEME_LERP_RATE,
  WAINSCOT_DEPTH,
  WAINSCOT_HEIGHT,
  type LightLevels,
} from "@/lib/game/tuning/hotel";
import {
  DOOR_HEIGHT,
  DOOR_OPEN_ANGLE,
  DOOR_OPEN_DIST,
  DOOR_SWING_RATE,
  DOOR_WIDTH,
} from "@/lib/game/tuning/room";
import "./lobby-register.css";

/** A corridor door as the integrator supplies it. */
export type CorridorDoor = {
  sliceId: string;
  label: string;
  /** Slice start (ISO 8601). The corridor's door spacing is a function of
   *  the time gaps between slices, computed from these timestamps — no id
   *  parsing needed (v0.11-strand-field §1: the timeline is its intervals).
   *  When absent or invalid, the layout falls back to parsing the sliceId. */
  start?: string;
  archetype?: ArchetypeId; // v1 fixture override
};

/** Both corridor walls run full height — the hall reads as one tall volume
 *  and door lintels sit flush inside a continuous wall face. (A low cutaway
 *  wall once existed for a camera on the south side; the camera moved to
 *  the north, and the floating lintels it left read as a cracked wall.) */
const SOUTH_WALL_HEIGHT = WALL_HEIGHT;

type HotelRole = keyof typeof THEME_COLORS;

const HOTEL_ROLES = Object.keys(THEME_COLORS) as HotelRole[];

/** Preallocated lerp targets — the day/night Color pair per role. */
const THEME_TARGETS: Record<HotelRole, { day: Color; night: Color }> =
  Object.fromEntries(
    HOTEL_ROLES.map((role) => [
      role,
      { day: new Color(THEME_COLORS[role].day), night: new Color(THEME_COLORS[role].night) },
    ]),
  ) as Record<HotelRole, { day: Color; night: Color }>;

const WALL_Z = CORRIDOR_WIDTH / 2;
const FLOOR_THICKNESS = 0.2;

/* ------------------------------------------------------------------ */
/* Shared themed materials — one instance per role, owned by Corridor  */
/* ------------------------------------------------------------------ */

/**
 * One MeshStandardMaterial per surface role, shared by every mesh of that
 * role across chunks and the lobby. JSX-created materials would multiply
 * per segment (dozens of identical instances) and each would need its own
 * theme lerp; sharing makes the day/night transition a single lerp loop
 * over the role table. Ownership: Corridor creates and disposes them —
 * R3F auto-disposal only touches materials it created itself, and these
 * are passed in by reference, so the dispose lives in Corridor's unmount
 * effect. Initial colors match the theme at mount.
 */
type HotelMaterials = Record<HotelRole, MeshStandardMaterial>;

function createHotelMaterials(night: boolean): {
  materials: HotelMaterials;
  grungeMap: CanvasTexture;
} {
  const grungeMap = createGrungeRoughnessMap();
  const make = (role: HotelRole) => {
    const material = new MeshStandardMaterial({
      color: THEME_COLORS[role][night ? "night" : "day"],
      roughness: MATERIAL_FINISH[role].roughness,
      metalness: MATERIAL_FINISH[role].metalness,
    });
    if ((GRUNGE_ROLES as readonly string[]).includes(role)) {
      material.roughnessMap = grungeMap;
    }
    return material;
  };
  const materials: HotelMaterials = {
    floor: make("floor"),
    wall: make("wall"),
    trim: make("trim"),
    slab: make("slab"),
    desk: make("desk"),
    cushion: make("cushion"),
    pot: make("pot"),
    carpet: make("carpet"),
    carpetEdge: make("carpetEdge"),
    wainscot: make("wainscot"),
    // Icosahedron foliage keeps its faceted low-poly read.
    foliage: new MeshStandardMaterial({
      color: THEME_COLORS.foliage[night ? "night" : "day"],
      roughness: MATERIAL_FINISH.foliage.roughness,
      metalness: MATERIAL_FINISH.foliage.metalness,
      flatShading: true,
    }),
  };
  return { materials, grungeMap };
}

/* ------------------------------------------------------------------ */
/* Dimming — one LIGHT_LEVELS table + the useDimLerp hook              */
/* ------------------------------------------------------------------ */

/**
 * Smoothly drive one live three.js value between its `levels`, following
 * the `dimRef` flag. Every frame the current value (read through `read`)
 * eases toward the target with an exponential lerp and is written back
 * through `write`. The descent uses the faster DIM_LERP_RATE_DESCEND (it
 * ends in an unmount; see HIDE_DELAY_MS), the recovery uses the
 * atmosphere-matched DIM_LERP_RATE. With `dayRef` given, a lit-mode
 * (`dayRef.current` true) undimmed value lerps toward `levels.day` when
 * present instead of `levels.full` — so theme changes ease through the
 * same path as dimming. Refs only — no React state, no per-frame
 * allocations — and the flags are read live from the refs, so toggling
 * them never re-renders the tree. On mount the value starts at the dimmed
 * level and the recovery lerp eases it toward the live target — remounts
 * (the corridor returning after a room) fade in instead of popping.
 */
function useDimLerp(
  dimRef: MutableRefObject<boolean>,
  levels: LightLevels,
  read: () => number | null,
  write: (value: number) => void,
  dayRef?: MutableRefObject<boolean>,
) {
  const readRef = useRef(read);
  const writeRef = useRef(write);
  useEffect(() => {
    readRef.current = read;
    writeRef.current = write;
  });
  const targetFor = (dim: boolean, day: boolean): number => {
    if (dim) return levels.dimmed;
    if (day && levels.day !== undefined) return levels.day;
    return levels.full;
  };
  useEffect(() => {
    // Mount initialization: start at the DIMMED level and let the recovery
    // lerp ease the value up. Remounts happen on room exit — the corridor
    // returning — and a corridor that fades in reads; one that snaps to
    // full brightness in one frame pops (the whole hotel flashing on). The
    // first mount pays the same brief rise, which reads as the lights
    // coming on.
    writeRef.current(levels.dimmed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame((_, rawDt) => {
    const current = readRef.current();
    if (current === null) return;
    const dt = Math.min(rawDt, DIM_MAX_DT);
    const descending = dimRef.current;
    const target = targetFor(descending, dayRef?.current ?? false);
    const rate = descending ? DIM_LERP_RATE_DESCEND : DIM_LERP_RATE;
    const next = current + (target - current) * (1 - Math.exp(-rate * dt));
    if (next !== current) writeRef.current(next);
  });
}

/* ------------------------------------------------------------------ */
/* Pure helpers (no React)                                             */
/* ------------------------------------------------------------------ */

/**
 * Solid spans of a wall run between door gaps, in ascending x order.
 * Adjacent doors that would leave no solid span simply produce no segment;
 * gaps always win over wall.
 */
function wallSegments(
  xStart: number,
  xEnd: number,
  doorXs: readonly number[],
): { x0: number; x1: number }[] {
  const sorted = [...doorXs].sort((a, b) => a - b);
  const segments: { x0: number; x1: number }[] = [];
  let cursor = xStart;
  for (const doorX of sorted) {
    const gapStart = doorX - DOOR_WIDTH / 2;
    const gapEnd = doorX + DOOR_WIDTH / 2;
    if (gapStart > cursor) segments.push({ x0: cursor, x1: gapStart });
    cursor = Math.max(cursor, gapEnd);
  }
  if (cursor < xEnd) segments.push({ x0: cursor, x1: xEnd });
  return segments;
}

/** Chunk 0 owns the lobby too; the lobby draws its own floor/walls, so the
 *  corridor part of chunk 0 stops at x = 0 where the lobby begins. */
function corridorSpan(
  index: number,
  layout: CorridorLayout,
): { xStart: number; xEnd: number } {
  const { xStart, xEnd } = chunkBounds(index, layout);
  return index === 0 ? { xStart, xEnd: 0 } : { xStart, xEnd };
}

/**
 * X positions of the north-wall sconces for one chunk, on the corridor's
 * FIXED architectural grid: one sconce every DOOR_SPACING meters, anchored
 * at the lobby seam on the past side (x = -6, -12, …) and at the lobby's
 * far wall on the future side (LOBBY_LENGTH + 6, …). The grid deliberately
 * does NOT follow the bays — door spacing now varies with the time gaps
 * between slices, but the house's own grammar stays periodic: a long silent
 * stretch reads as a longer bare wall with its regular rhythm of lamps
 * intact, while a dense cluster (every bay 6 m) reproduces today's look
 * exactly. Content varies; architecture does not. Each sconce is owned by
 * the chunk whose (xStart, xEnd] span contains it, so adjacent chunks never
 * draw the same sconce and the rhythm continues seamlessly across chunk
 * boundaries however long the chunks are. Independent of door
 * materialization: an unallocated stretch still gets its lamps.
 */
function sconcePositions(xStart: number, xEnd: number): number[] {
  const base = xEnd <= 0 ? 0 : LOBBY_LENGTH;
  const xs: number[] = [];
  for (
    let k = Math.floor((xStart - base) / DOOR_SPACING) + 1;
    base + k * DOOR_SPACING <= xEnd + 1e-6;
    k++
  ) {
    xs.push(base + k * DOOR_SPACING);
  }
  return xs;
}

/**
 * Which of a chunk's sconces carry a REAL point light, and how far it
 * reaches. Every sconce is lit up to SCONCE_LIGHT_MAX_PER_CHUNK; past that
 * (a long silent stretch) the lit set thins to an even spread and the reach
 * grows to cover the gap, so the floor between fixtures stays readable
 * while the shader's light count stays bounded. The unlit sconces keep
 * their emissive shade and pool decals — the rhythm of lamps never breaks.
 * Pure function of the sconce count (the grid is uniform), so deterministic
 * per chunk (A6).
 */
function litSconceSelection(count: number): { lit: boolean[]; distance: number } {
  if (count <= SCONCE_LIGHT_MAX_PER_CHUNK) {
    return {
      lit: Array.from({ length: count }, () => true),
      distance: DOOR_SPACING + 3,
    };
  }
  const picks = SCONCE_LIGHT_MAX_PER_CHUNK;
  const lit = Array.from({ length: count }, () => false);
  for (let i = 0; i < picks; i++) {
    lit[Math.round((i * (count - 1)) / (picks - 1))] = true;
  }
  const spacing = ((count - 1) / (picks - 1)) * DOOR_SPACING;
  return { lit, distance: spacing + 3 };
}

interface FloorLampSpec {
  x: number;
  z: number;
}

/**
 * Corridor floor lamps on the FIXED architectural grid: one every
 * FLOOR_LAMP_SPACING meters, anchored at the lobby exactly like the
 * sconces, alternating walls by grid parity. A lamp whose position a bay
 * door would swing through is skipped — door positions come from the
 * corridor layout, not the materialized slices (same rule as the props),
 * so lamps never reshuffle as doors allocate. Pure; deterministic per
 * chunk (A6).
 */
function floorLampLayout(
  index: number,
  xStart: number,
  xEnd: number,
  layout: CorridorLayout,
): FloorLampSpec[] {
  const base = xEnd <= 0 ? 0 : LOBBY_LENGTH;
  const doorXs = Array.from({ length: CHUNK_DOORS }, (_, k) =>
    bayCenterX(layout, k - index * CHUNK_DOORS),
  );
  const lamps: FloorLampSpec[] = [];
  for (
    let k = Math.floor((xStart - base) / FLOOR_LAMP_SPACING) + 1;
    base + k * FLOOR_LAMP_SPACING <= xEnd + 1e-6;
    k++
  ) {
    const x = base + k * FLOOR_LAMP_SPACING;
    if (doorXs.some((dx) => Math.abs(x - dx) < FLOOR_LAMP_DOOR_CLEARANCE)) continue;
    lamps.push({ x, z: (k % 2 === 0 ? 1 : -1) * FLOOR_LAMP_Z });
  }
  return lamps;
}

/**
 * The light line's real lights, spread evenly over a corridor span: about
 * one per STRIP_LIGHT_TARGET_SPACING meters (never fewer than 2, never
 * more than STRIP_LIGHT_MAX_PER_CHUNK), each reaching just past its
 * neighbors so the south side of the floor never goes unreadable. Pure;
 * deterministic per chunk (A6).
 */
function stripLightLayout(length: number): { offsets: number[]; distance: number } {
  const count = Math.min(
    STRIP_LIGHT_MAX_PER_CHUNK,
    Math.max(2, Math.round(length / STRIP_LIGHT_TARGET_SPACING)),
  );
  const spacing = length / count;
  return {
    offsets: Array.from({ length: count }, (_, i) => (i + 0.5) * spacing),
    distance: spacing / 2 + 5,
  };
}

/**
 * Shared glow textures for the sconce floor pools, the sconce wall washes,
 * and the end-of-world haze live in the material library
 * (src/lib/game/materials/glow.ts): white falloff gradients painted once
 * (the material color does the tinting), cached at module scope so every
 * instance of each kind shares one texture and they are never disposed.
 */

/* ------------------------------------------------------------------ */
/* Deterministic lobby layout (module scope: pure, computed once)      */
/* ------------------------------------------------------------------ */

type Vec3 = [number, number, number];

interface LobbyLayout {
  desk: { position: Vec3; rotationY: number };
  armchairs: { position: Vec3; rotationY: number }[];
  plants: { position: Vec3; scale: number }[];
  lamps: { position: Vec3 }[];
}

function buildLobbyLayout(): LobbyLayout {
  const rng = createRng(deriveSubSeed(WORLD_SEED, "lobby", "layout"));
  // The desk stands against the leg's far (south) wall, counter facing
  // north — the thing the arriving player sees straight ahead after the
  // turn into the leg.
  const deskX = rangeInt(rng, 55, 85) / 10;
  const desk = {
    position: [
      deskX,
      0,
      -(LOBBY_SOUTH_REACH - 1.1 - rangeInt(rng, 0, 4) / 10),
    ] as Vec3,
    rotationY: 0, // long axis east-west; the counter face looks up the leg
  };
  // Two armchairs on the guest side, facing the desk (south), angled a
  // touch inward — the conversation pair across the counter.
  const chairAngle = pick(rng, [0.15, 0.25, 0.35] as const);
  const chairZ = -(LOBBY_SOUTH_REACH - rangeInt(rng, 42, 50) / 10);
  const chairGap = rangeInt(rng, 16, 20) / 10;
  const armchairs = [
    {
      position: [deskX - chairGap, 0, chairZ] as Vec3,
      rotationY: Math.PI / 2 - chairAngle, // faces south, toward the desk
    },
    {
      position: [deskX + chairGap, 0, chairZ + rangeInt(rng, -3, 3) / 10] as Vec3,
      rotationY: Math.PI / 2 + chairAngle,
    },
  ];
  // Plants hold the leg's far corners; one more greets at the portal.
  const cornerInset = rangeInt(rng, 12, 15) / 10;
  const plants = [
    {
      position: [
        cornerInset,
        0,
        -(LOBBY_SOUTH_REACH - rangeInt(rng, 8, 11) / 10),
      ] as Vec3,
      scale: rangeInt(rng, 9, 11) / 10,
    },
    {
      position: [
        LOBBY_LENGTH - cornerInset,
        0,
        -(LOBBY_SOUTH_REACH - rangeInt(rng, 8, 11) / 10),
      ] as Vec3,
      scale: rangeInt(rng, 8, 10) / 10,
    },
    {
      position: [rangeInt(rng, 11, 14) / 10, 0, rangeInt(rng, 34, 40) / 10] as Vec3,
      scale: rangeInt(rng, 8, 10) / 10,
    },
  ];
  // Floor lamps flank the desk; one more lights the vestibule.
  const lampGap = rangeInt(rng, 26, 30) / 10;
  const lamps = [
    { position: [deskX - lampGap, 0, -(LOBBY_SOUTH_REACH - 1.2)] as Vec3 },
    { position: [deskX + lampGap, 0, -(LOBBY_SOUTH_REACH - 1.2)] as Vec3 },
    {
      position: [
        LOBBY_LENGTH - rangeInt(rng, 13, 17) / 10,
        0,
        rangeInt(rng, 32, 40) / 10,
      ] as Vec3,
    },
  ];
  return { desk, armchairs, plants, lamps };
}

const LOBBY_LAYOUT = buildLobbyLayout();

/**
 * Walkable-space blockers for the lobby leg (the integrator's movement
 * clamp): the front desk and the armchair pair, inflated by a body radius.
 * The leg is walkable (the register board and the south return door must be
 * approachable), and these are the only pieces big enough to read as solid.
 * Small props (plants, lamps) stay clip-through, like every corridor prop.
 */
export interface LobbyBlocker {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const LOBBY_BLOCKER_PAD = 0.35;

function lobbyBlockerBox(cx: number, cz: number, halfW: number, halfD: number): LobbyBlocker {
  return {
    x0: cx - halfW - LOBBY_BLOCKER_PAD,
    x1: cx + halfW + LOBBY_BLOCKER_PAD,
    z0: cz - halfD - LOBBY_BLOCKER_PAD,
    z1: cz + halfD + LOBBY_BLOCKER_PAD,
  };
}

export const LOBBY_BLOCKERS: readonly LobbyBlocker[] = [
  lobbyBlockerBox(LOBBY_LAYOUT.desk.position[0], LOBBY_LAYOUT.desk.position[2], 1.1, 0.45),
  ...LOBBY_LAYOUT.armchairs.map((chair) =>
    lobbyBlockerBox(chair.position[0], chair.position[2], 0.36, 0.36),
  ),
];

/* ------------------------------------------------------------------ */
/* Small static building blocks                                        */
/* ------------------------------------------------------------------ */

/** One solid span of a wall run — shared wall material, JSX geometry. */
function WallBox({
  x0,
  x1,
  height,
  z,
  mats,
}: {
  x0: number;
  x1: number;
  height: number;
  z: number;
  mats: HotelMaterials;
}) {
  const length = x1 - x0;
  if (length <= 0) return null;
  return (
    <mesh position={[(x0 + x1) / 2, height / 2, z]} material={mats.wall} castShadow receiveShadow>
      <boxGeometry args={[length, height, CORRIDOR_WALL_THICKNESS]} />
    </mesh>
  );
}

/** A wall run (one side of one chunk) with 1.4 m gaps where doors sit. */
function WallRun({
  xStart,
  xEnd,
  height,
  z,
  doors,
  mats,
}: {
  xStart: number;
  xEnd: number;
  height: number;
  z: number;
  doors: readonly DoorRef[];
  mats: HotelMaterials;
}) {
  const segments = wallSegments(
    xStart,
    xEnd,
    doors.map((d) => d.x),
  );
  // Wainscot band + chair rail hug the inner wall face, broken around door
  // gaps exactly like the wall itself; lintels span the gaps above.
  const inward = -Math.sign(z); // toward the corridor interior
  const wainscotZ = z + inward * (CORRIDOR_WALL_THICKNESS / 2 + WAINSCOT_DEPTH / 2 - 0.01);
  const railZ = z + inward * (CORRIDOR_WALL_THICKNESS / 2 + CHAIR_RAIL_DEPTH / 2 - 0.01);
  return (
    <group>
      {segments.map((s) => {
        const length = s.x1 - s.x0;
        const cx = (s.x0 + s.x1) / 2;
        return (
          <group key={`${s.x0}:${s.x1}`}>
            <WallBox x0={s.x0} x1={s.x1} height={height} z={z} mats={mats} />
            <mesh
              position={[cx, WAINSCOT_HEIGHT / 2, wainscotZ]}
              material={mats.wainscot}
              receiveShadow
            >
              <boxGeometry args={[length, WAINSCOT_HEIGHT, WAINSCOT_DEPTH]} />
            </mesh>
            <mesh
              position={[cx, WAINSCOT_HEIGHT + CHAIR_RAIL_HEIGHT / 2, railZ]}
              material={mats.trim}
              receiveShadow
            >
              <boxGeometry args={[length, CHAIR_RAIL_HEIGHT, CHAIR_RAIL_DEPTH]} />
            </mesh>
          </group>
        );
      })}
      {doors.map((d) => (
        <mesh
          key={`lintel-${d.index}-${d.side}`}
          position={[d.x, (WALL_HEIGHT + DOOR_HEIGHT) / 2, z]}
          material={mats.wall}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[DOOR_WIDTH, WALL_HEIGHT - DOOR_HEIGHT, CORRIDOR_WALL_THICKNESS]} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Slice-id signage — door plates & date plaques                       */
/* ------------------------------------------------------------------ */

/**
 * Time-slice ids encode their own clock: `2026-09-15-0746` is Sep 15,
 * 07:46. The corridor signage reads those parts straight off the id — a
 * door plate wears the HHMM half, a date plaque the MM·DD half — so a
 * slice always hangs its own time on the wall, on any machine. The rule
 * lives in lib/game/slice-clock.ts (single source; the game-shell's strand
 * door numbers come from the same function). Ids that do not match the
 * format (fixtures, tests) simply get no signage.
 */

/** The calendar date of a door bay (north slice first, south fallback). */
function bayDate(sliceIds: readonly string[], i: number): string | null {
  if (i < 0) return null;
  const clock = sliceClock(sliceIds[2 * i] ?? "") ??
    sliceClock(sliceIds[2 * i + 1] ?? "");
  return clock ? clock.date : null;
}

/**
 * One small dark plaque with light monospace text — shared builder for
 * door plates and date plaques (`glow` bakes a soft halo for the latter).
 * 2:1 canvas at 384×192 so the digits survive the diorama camera's long
 * view down to a readable glyph. The ink defaults to the house cream; the
 * hotel's ACCENT (§11.1) replaces it on door plates so a hotel's signage
 * reads as its timeline's color.
 */
function createPlaqueTexture(text: string, glow: boolean, ink: string = PLATE_INK): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = PLATE_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(236,226,204,0.45)";
    ctx.lineWidth = 8;
    ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
    ctx.fillStyle = ink;
    ctx.font = "900 104px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (glow) {
      ctx.shadowColor = ink;
      ctx.shadowBlur = 22;
    }
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 6);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * The door plate: the slice's HHMM time (the `0746` of `…-15-0746`) on a
 * small dark plaque just right of the frame, at handle height ~2.2 m, on
 * the corridor face of the wall — both walls get one. The texture is
 * built once per slice and disposed with the door; the face fades with
 * the hotel-wide dimming so a space going dark takes the signage down
 * with it.
 */
function DoorPlate({
  door,
  dimRef,
  mats,
  ink,
  clock,
}: {
  door: DoorRef;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  /** Hotel accent ink (§11.1); defaults to the house cream. */
  ink?: string;
  /** Text override — the page door shows the NEXT window's newest slice's
   *  clock, which is not this door's own slice. Default: the door slice's
   *  own HHMM; an explicit null suppresses the plate (the return door
   *  carries no number — it leads back, not to a slice). */
  clock?: string | null;
}) {
  const texture = useMemo(() => {
    const text = clock !== undefined ? clock : (sliceClock(door.sliceId)?.time ?? null);
    return text ? createPlaqueTexture(text, false, ink) : null;
  }, [door.sliceId, clock, ink]);
  useEffect(() => () => texture?.dispose(), [texture]);
  const faceMatRef = useRef<MeshBasicMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.plaque,
    () => faceMatRef.current?.opacity ?? null,
    (v) => {
      const m = faceMatRef.current;
      if (m) m.opacity = v;
    },
  );
  if (!texture) return null;
  const inward = door.side === "north" ? -1 : 1;
  const faceZ = door.z + inward * (CORRIDOR_WALL_THICKNESS / 2);
  const facing = door.side === "north" ? Math.PI : 0;
  return (
    <group
      position={[door.x + DOOR_WIDTH / 2 + 0.5, 2.2, faceZ + inward * 0.03]}
      rotation={[0, facing, 0]}
    >
      <mesh material={mats.trim}>
        <boxGeometry args={[0.84, 0.46, 0.03]} />
      </mesh>
      <mesh position={[0, 0, 0.016]}>
        <planeGeometry args={[0.76, 0.38]} />
        <meshBasicMaterial ref={faceMatRef} map={texture} transparent />
      </mesh>
    </group>
  );
}

/**
 * One door: frame slightly proud of the wall, a REAL hinged slab that
 * swings open (away from the player) as they come within DOOR_OPEN_DIST,
 * an emissive glow plane on the space side of the gap — the room's light
 * spilling into the corridor once the slab swings aside — plus a faint
 * additive halo and an emissive strip above the lintel. All glow is
 * emissive material — no point lights here.
 */
function DoorAssembly({
  door,
  archetype,
  dimRef,
  mats,
  playerRef,
  glowOverride,
  plateInk,
  plateClock,
}: {
  door: DoorRef;
  archetype?: ArchetypeId;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  playerRef: MutableRefObject<{ x: number; z: number }>;
  /** Accent-colored glow for the hotel's own doors (page door, return
   *  door) — replaces the room-palette glow a slice door derives (§11.1). */
  glowOverride?: string;
  /** Door-plate ink (the hotel accent) and text override — see DoorPlate. */
  plateInk?: string;
  plateClock?: string | null;
}) {
  // The doorway light is the room's own tone (ground→sky, lifted), not a
  // decorative accent — the glimpse through the frame must read as THAT
  // room's light before the room itself ever renders. The hotel's OWN
  // doors (page/return) take the timeline accent instead.
  const glowColor = useMemo(() => {
    if (glowOverride !== undefined) return glowOverride;
    const recipe = compileSpaceRecipe(door.sliceId);
    return doorGlowColor(
      (archetype === undefined ? recipe : { ...recipe, archetype }).palette,
    );
  }, [door.sliceId, archetype, glowOverride]);

  const inward = door.side === "north" ? -1 : 1; // toward the corridor interior
  const frameZ = door.z + inward * 0.06;
  const glowZ = door.z - inward * 0.04; // space side of the wall plane
  const facing = door.side === "north" ? Math.PI : 0; // glow planes face the corridor

  // Hinged slab: the hinge group sits on the left jamb (seen from the
  // corridor) at the wall plane; the slab mesh hangs +x off it. Swing
  // target: open when the player is near, rotating AWAY from them (push,
  // never pull); the angle lerps so the door eases instead of snapping.
  const hingeRef = useRef<Group>(null);
  const angleRef = useRef(0);
  const snappedRef = useRef(false);
  useFrame((_, delta) => {
    const hinge = hingeRef.current;
    if (!hinge) return;
    const p = playerRef.current;
    const near =
      Math.hypot(p.x - door.x, p.z - door.z) < DOOR_OPEN_DIST;
    const away = Math.sign(p.z - door.z) || 1;
    const target = near ? away * DOOR_OPEN_ANGLE : 0;
    const dt = Math.min(delta, 0.05);
    if (!snappedRef.current) {
      angleRef.current = target;
      snappedRef.current = true;
    } else {
      angleRef.current += (target - angleRef.current) * (1 - Math.exp(-DOOR_SWING_RATE * dt));
    }
    hinge.rotation.y = angleRef.current;
  });

  // Glow materials follow the hotel-wide dimming.
  const glowMatRef = useRef<MeshStandardMaterial>(null);
  const haloMatRef = useRef<MeshBasicMaterial>(null);
  const stripMatRef = useRef<MeshStandardMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorGlow,
    () => glowMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = glowMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorHalo,
    () => haloMatRef.current?.opacity ?? null,
    (v) => {
      const m = haloMatRef.current;
      if (m) m.opacity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorStrip,
    () => stripMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = stripMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
  );

  return (
    <group>
      {/* Frame posts + header, proud of the wall face. */}
      <mesh
        position={[door.x - DOOR_WIDTH / 2 - 0.05, DOOR_HEIGHT / 2 + 0.05, frameZ]}
        material={mats.trim}
        castShadow
      >
        <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
      </mesh>
      <mesh
        position={[door.x + DOOR_WIDTH / 2 + 0.05, DOOR_HEIGHT / 2 + 0.05, frameZ]}
        material={mats.trim}
        castShadow
      >
        <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
      </mesh>
      <mesh position={[door.x, DOOR_HEIGHT + 0.11, frameZ]} material={mats.trim} castShadow>
        <boxGeometry args={[DOOR_WIDTH + 0.2, 0.12, 0.24]} />
      </mesh>
      {/* Hinged slab — a real door, opaque, swinging on its left jamb. */}
      <group ref={hingeRef} position={[door.x - DOOR_WIDTH / 2 + 0.02, 0, door.z]}>
        <mesh
          position={[DOOR_WIDTH / 2 - 0.02, DOOR_HEIGHT / 2, 0]}
          material={mats.slab}
          castShadow
        >
          <boxGeometry args={[DOOR_WIDTH - 0.04, DOOR_HEIGHT - 0.04, 0.05]} />
        </mesh>
        {/* Handle: a small dark knob on the corridor face, free-end side. */}
        <mesh
          position={[DOOR_WIDTH - 0.22, DOOR_HEIGHT / 2, inward * 0.05]}
          material={mats.trim}
          castShadow
        >
          <boxGeometry args={[0.05, 0.16, 0.05]} />
        </mesh>
      </group>
      {/* Room light behind the gap, revealed when the slab swings aside. */}
      <mesh position={[door.x, DOOR_HEIGHT / 2, glowZ]} rotation={[0, facing, 0]}>
        <planeGeometry args={[DOOR_WIDTH, DOOR_HEIGHT]} />
        <meshStandardMaterial
          ref={glowMatRef}
          color="#000000"
          emissive={glowColor}
          emissiveIntensity={LIGHT_LEVELS.doorGlow.full}
          roughness={1}
          metalness={0}
        />
      </mesh>
      {/* Faint additive halo around the opening. */}
      <mesh position={[door.x, DOOR_HEIGHT / 2, frameZ + inward * 0.03]} rotation={[0, facing, 0]}>
        <planeGeometry args={[DOOR_WIDTH + 0.5, DOOR_HEIGHT + 0.4]} />
        <meshBasicMaterial
          ref={haloMatRef}
          color={glowColor}
          transparent
          opacity={LIGHT_LEVELS.doorHalo.full}
          blending={AdditiveBlending}
          depthWrite={false}
          side={DoubleSide}
        />
      </mesh>
      {/* Emissive strip above the lintel — the fake fixture, just under
          the wall top. */}
      <mesh position={[door.x, WALL_HEIGHT - 0.14, door.z + inward * 0.12]}>
        <boxGeometry args={[DOOR_WIDTH, 0.06, 0.08]} />
        <meshStandardMaterial
          ref={stripMatRef}
          color="#000000"
          emissive={glowColor}
          emissiveIntensity={LIGHT_LEVELS.doorStrip.full}
          roughness={1}
          metalness={0}
        />
      </mesh>
      {/* Room number — the slice's HHMM time on a plaque by the frame. */}
      <DoorPlate door={door} dimRef={dimRef} mats={mats} ink={plateInk} clock={plateClock} />
    </group>
  );
}

/**
 * One wall sconce on the north wall: a dark bracket box, a warm emissive
 * cone shade at ~2.55 m (below the 4.0 m wall top, above the paintings),
 * a radial-gradient light pool on the floor below, and a soft gradient
 * wash on the wall face behind the shade. Both glows are shared-texture
 * additive quads — the painted gradient does the falloff, so the pool
 * actually reads (the old pair of bare circles at 0.07/0.15 opacity did
 * not). When `lit`, the sconce also carries a REAL point light just under
 * the shade (灯廊 — the fixture is the source; nothing floats mid-hall).
 * Everything is static: calm incandescent pools, never flickering.
 */
function WallSconce({
  x,
  lit,
  lightDistance,
  dimRef,
  darkRef,
  mats,
}: {
  x: number;
  lit: boolean;
  lightDistance: number;
  dimRef: MutableRefObject<boolean>;
  darkRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  const faceZ = WALL_Z - CORRIDOR_WALL_THICKNESS / 2; // inner face of the north wall

  // Shade emissive + glow opacities follow the hotel-wide dimming; the
  // glows additionally switch off in day mode (daylight needs no fake glow).
  const shadeMatRef = useRef<MeshStandardMaterial>(null);
  const poolMatRef = useRef<MeshBasicMaterial>(null);
  const washMatRef = useRef<MeshBasicMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.sconceShade,
    () => shadeMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = shadeMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.sconcePool,
    () => poolMatRef.current?.opacity ?? null,
    (v) => {
      const m = poolMatRef.current;
      if (m) m.opacity = v;
    },
    darkRef,
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.sconceWash,
    () => washMatRef.current?.opacity ?? null,
    (v) => {
      const m = washMatRef.current;
      if (m) m.opacity = v;
    },
    darkRef,
  );
  // The sconce's real light follows the dimming too. On unlit sconces the
  // ref never resolves and the lerp reads null — a no-op.
  const lightRef = useRef<PointLight>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.sconceLight,
    () => lightRef.current?.intensity ?? null,
    (v) => {
      const l = lightRef.current;
      if (l) l.intensity = v;
    },
  );

  return (
    <group>
      {/* Bracket, proud of the wall face. */}
      <mesh position={[x, 2.69, faceZ - 0.06]} material={mats.trim}>
        <boxGeometry args={[0.1, 0.16, 0.12]} />
      </mesh>
      {/* Shade — low-poly cone, apex up like an uplight bowl. */}
      <mesh position={[x, 2.55, faceZ - 0.12]}>
        <coneGeometry args={[0.15, 0.2, 8]} />
        <meshStandardMaterial
          ref={shadeMatRef}
          color="#000000"
          emissive={SCONCE_COLOR}
          emissiveIntensity={LIGHT_LEVELS.sconceShade.full}
          roughness={1}
          metalness={0}
          flatShading
        />
      </mesh>
      {/* The real light, hanging just under the shade it belongs to. */}
      {lit && (
        <pointLight
          ref={lightRef}
          position={[x, SCONCE_LIGHT_HEIGHT, faceZ - SCONCE_LIGHT_INSET]}
          color={SCONCE_COLOR}
          intensity={LIGHT_LEVELS.sconceLight.full}
          distance={lightDistance}
          decay={2}
        />
      )}
      {/* Light pool on the floor: one radial-gradient quad, soft edge. */}
      <mesh
        position={[x, 0.012, faceZ - SCONCE_POOL_OFFSET]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[SCONCE_POOL_RADIUS * 2, SCONCE_POOL_RADIUS * 2]} />
        <meshBasicMaterial
          ref={poolMatRef}
          map={sharedRadialGlowTexture()}
          color={SCONCE_COLOR}
          transparent
          opacity={LIGHT_LEVELS.sconcePool.full}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Wall wash behind the shade: a vertical gradient dissolving down. */}
      <mesh position={[x, SCONCE_WASH_HEIGHT / 2, faceZ - 0.02]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[SCONCE_WASH_WIDTH, SCONCE_WASH_HEIGHT]} />
        <meshBasicMaterial
          ref={washMatRef}
          map={sharedWallWashTexture()}
          color={SCONCE_COLOR}
          transparent
          opacity={LIGHT_LEVELS.sconceWash.full}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * One of the light line's real point lights — low and close to the south
 * wall, so its grazing pool reads as cast by the strip itself.
 */
function StripLight({
  x,
  distance,
  dimRef,
}: {
  x: number;
  distance: number;
  dimRef: MutableRefObject<boolean>;
}) {
  const lightRef = useRef<PointLight>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.stripLight,
    () => lightRef.current?.intensity ?? null,
    (v) => {
      const l = lightRef.current;
      if (l) l.intensity = v;
    },
  );
  return (
    <pointLight
      ref={lightRef}
      position={[x, STRIP_LIGHT_HEIGHT, -(WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - STRIP_LIGHT_INSET)]}
      color={STRIP_COLOR}
      intensity={LIGHT_LEVELS.stripLight.full}
      distance={distance}
      decay={2}
    />
  );
}

/**
 * The baseboard light line — the south wall's own lamp (灯廊: the sconces
 * belong to the north wall; the south wall answers with a low cove line).
 * A continuous warm emissive strip just above the baseboard — the
 * dollhouse cutaway has no ceiling, so the cove lives at ankle height —
 * a soft gradient wash up the wall (brightest at the strip, dissolving
 * upward), a glow along the floor's edge, and a few low real point lights
 * spread along it. Everything is static and follows the hotel-wide
 * dimming; the fake-glow decals switch off in day mode like the sconce
 * pools, while the strip itself merely tones down — a cove line burning
 * in a bright hotel.
 */
function LightLine({
  xStart,
  xEnd,
  dimRef,
  darkRef,
}: {
  xStart: number;
  xEnd: number;
  dimRef: MutableRefObject<boolean>;
  darkRef: MutableRefObject<boolean>;
}) {
  const length = xEnd - xStart;
  const centerX = (xStart + xEnd) / 2;
  const faceZ = -(WALL_Z - CORRIDOR_WALL_THICKNESS / 2); // inner face, south wall
  const { offsets, distance } = useMemo(() => stripLightLayout(length), [length]);

  // Strip emissive + wash/pool opacities follow the hotel-wide dimming.
  const stripMatRef = useRef<MeshStandardMaterial>(null);
  const washMatRef = useRef<MeshBasicMaterial>(null);
  const poolMatRef = useRef<MeshBasicMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.stripGlow,
    () => stripMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = stripMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
    darkRef,
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.stripWash,
    () => washMatRef.current?.opacity ?? null,
    (v) => {
      const m = washMatRef.current;
      if (m) m.opacity = v;
    },
    darkRef,
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.stripPool,
    () => poolMatRef.current?.opacity ?? null,
    (v) => {
      const m = poolMatRef.current;
      if (m) m.opacity = v;
    },
    darkRef,
  );

  return (
    <group>
      {/* The strip itself — the visible fixture, proud of the wainscot. */}
      <mesh position={[centerX, STRIP_HEIGHT, faceZ + 0.07]}>
        <boxGeometry args={[length, 0.05, 0.04]} />
        <meshStandardMaterial
          ref={stripMatRef}
          color="#000000"
          emissive={STRIP_COLOR}
          emissiveIntensity={LIGHT_LEVELS.stripGlow.full}
          roughness={1}
          metalness={0}
        />
      </mesh>
      {/* Wash up the wall: the sconce wash texture turned upside down, so
          it is brightest at the strip and dissolves upward. */}
      <mesh
        position={[centerX, STRIP_HEIGHT + STRIP_WASH_HEIGHT / 2, faceZ + 0.05]}
        rotation={[0, 0, Math.PI]}
      >
        <planeGeometry args={[length, STRIP_WASH_HEIGHT]} />
        <meshBasicMaterial
          ref={washMatRef}
          map={sharedWallWashTexture()}
          color={STRIP_COLOR}
          transparent
          opacity={LIGHT_LEVELS.stripWash.full}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Glow along the floor's edge, in front of the wainscot. */}
      <mesh
        position={[centerX, 0.011, faceZ + STRIP_POOL_WIDTH / 2 + 0.08]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[length, STRIP_POOL_WIDTH]} />
        <meshBasicMaterial
          ref={poolMatRef}
          map={sharedRadialGlowTexture()}
          color={STRIP_COLOR}
          transparent
          opacity={LIGHT_LEVELS.stripPool.full}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* The line's real lights — low, grazing, spread along it. */}
      {offsets.map((off) => (
        <StripLight key={off} x={xStart + off} distance={distance} dimRef={dimRef} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Seeded corridor dressing — art, plants, bins, date plaques          */
/* ------------------------------------------------------------------ */

interface PaintingSpec {
  side: Side;
  x: number;
  bg: string;
  accent: string;
  variant: number;
  r1: number;
  r2: number;
}

/**
 * Paintings for one chunk: each interior wall gap (the bay midpoints the
 * sconces hang at, minus the far seam) gets an independent ~50% chance per
 * wall, so hung and bare stretches alternate irregularly. Seeded by the
 * chunk index alone — the art is architecture and must not reshuffle when
 * slices allocate or unmount. Draw order is fixed (north gaps, then
 * south), keeping the rng stream stable.
 */
function paintingLayout(seedIndex: number, gapXs: readonly number[]): PaintingSpec[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, `corridor-chunk-${seedIndex}`, "style"));
  const paintings: PaintingSpec[] = [];
  for (const side of ["north", "south"] as const) {
    for (const x of gapXs) {
      if (rng() >= 0.5) continue;
      const bg = pick(rng, ART_PALETTE);
      let accent = pick(rng, ART_PALETTE);
      if (accent === bg) {
        accent = ART_PALETTE[(ART_PALETTE.indexOf(bg) + 1) % ART_PALETTE.length];
      }
      paintings.push({
        side,
        x,
        bg,
        accent,
        variant: rangeInt(rng, 0, 2),
        r1: rng(),
        r2: rng(),
      });
    }
  }
  return paintings;
}

/**
 * One framed abstract painting: a thin trim frame flush-mounted on the
 * wall, a muted seeded ground, and one or two seeded color blocks on top
 * — two to three flat quads total, no textures, standard materials so the
 * art dims naturally with the chunk light.
 */
function WallPainting({ spec, mats }: { spec: PaintingSpec; mats: HotelMaterials }) {
  const innerW = PAINTING_W - 0.14;
  const innerH = PAINTING_H - 0.16;
  const bandH = innerH * (0.25 + 0.2 * spec.r1);
  const colW = innerW * (0.2 + 0.2 * spec.r1);
  const blockW = innerW * (0.35 + 0.2 * spec.r1);
  const blockH = innerH * (0.22 + 0.15 * spec.r2);
  // Group sits on the wall face, local +z pointing into the corridor.
  return (
    <group
      position={[
        spec.x,
        2.2,
        (WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - 0.03) * (spec.side === "north" ? 1 : -1),
      ]}
      rotation={[0, spec.side === "north" ? Math.PI : 0, 0]}
    >
      <mesh material={mats.trim}>
        <boxGeometry args={[PAINTING_W, PAINTING_H, 0.06]} />
      </mesh>
      <mesh position={[0, 0, 0.033]}>
        <planeGeometry args={[innerW, innerH]} />
        <meshStandardMaterial color={spec.bg} roughness={1} metalness={0} />
      </mesh>
      {spec.variant === 0 && (
        <mesh position={[0, -innerH / 2 + bandH / 2, 0.039]}>
          <planeGeometry args={[innerW, bandH]} />
          <meshStandardMaterial color={spec.accent} roughness={1} metalness={0} />
        </mesh>
      )}
      {spec.variant === 1 && (
        <mesh position={[innerW / 2 - colW / 2, 0, 0.039]}>
          <planeGeometry args={[colW, innerH]} />
          <meshStandardMaterial color={spec.accent} roughness={1} metalness={0} />
        </mesh>
      )}
      {spec.variant === 2 && (
        <>
          <mesh
            position={[(spec.r1 - 0.5) * innerW * 0.4, (spec.r2 - 0.5) * innerH * 0.5, 0.039]}
          >
            <planeGeometry args={[blockW, blockH]} />
            <meshStandardMaterial color={spec.accent} roughness={1} metalness={0} />
          </mesh>
          <mesh
            position={[(0.5 - spec.r2) * innerW * 0.35, (0.5 - spec.r1) * innerH * 0.4, 0.045]}
          >
            <planeGeometry args={[blockW * 0.55, blockH * 0.6]} />
            <meshStandardMaterial color={spec.bg} roughness={1} metalness={0} />
          </mesh>
        </>
      )}
    </group>
  );
}

interface PropSpec {
  kind: "plant" | "bin";
  x: number;
  z: number;
  scale: number;
}

/**
 * Floor props for one chunk: 0–2 pieces hugging the walls — potted plants
 * and bins — never blocking a door, a painting, or each other. Candidates
 * are rejection-sampled from the chunk's own stream; the layout is
 * deterministic per chunk index regardless of slice allocation (bay door
 * positions come from the corridor layout, not the materialized doors).
 */
function propLayout(
  index: number,
  seedIndex: number,
  xStart: number,
  length: number,
  gapXs: readonly number[],
  layout: CorridorLayout,
): PropSpec[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, `corridor-chunk-${seedIndex}`, "layout"));
  const count = rangeInt(rng, 0, 2);
  const doorXs = Array.from({ length: CHUNK_DOORS }, (_, k) =>
    bayCenterX(layout, k - index * CHUNK_DOORS),
  );
  const props: PropSpec[] = [];
  for (let n = 0; n < count; n++) {
    let x: number | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = xStart + 1.4 + rng() * (length - 2.8);
      const clearDoor = doorXs.every((dx) => Math.abs(candidate - dx) >= 1.7);
      const clearGap = gapXs.every((gx) => Math.abs(candidate - gx) >= 1.1);
      const clearProp = props.every((p) => Math.abs(candidate - p.x) >= 1.4);
      if (clearDoor && clearGap && clearProp) {
        x = candidate;
        break;
      }
    }
    if (x === null) continue;
    const northSide = rng() < 0.5;
    const kind = rng() < 0.5 ? ("plant" as const) : ("bin" as const);
    props.push({
      kind,
      x,
      z: (northSide ? 1 : -1) * (kind === "plant" ? 4.42 : 4.6),
      scale: 0.8 + rng() * 0.3,
    });
  }
  return props;
}

/**
 * A glowing date plaque hung high on both walls at a bay boundary where
 * the calendar day changes — walking the corridor crosses days, not just
 * doors. The baked halo reads as backlight; each face fades with the
 * hotel-wide dimming.
 */
function DatePlaque({
  x,
  label,
  dimRef,
  mats,
}: {
  x: number;
  label: string;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  const texture = useMemo(() => createPlaqueTexture(label, true), [label]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <>
      {(["north", "south"] as const).map((side) => (
        <DatePlaqueSide key={side} x={x} side={side} texture={texture} dimRef={dimRef} mats={mats} />
      ))}
    </>
  );
}

function DatePlaqueSide({
  x,
  side,
  texture,
  dimRef,
  mats,
}: {
  x: number;
  side: Side;
  texture: CanvasTexture;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  const faceMatRef = useRef<MeshBasicMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.plaque,
    () => faceMatRef.current?.opacity ?? null,
    (v) => {
      const m = faceMatRef.current;
      if (m) m.opacity = v;
    },
  );
  return (
    <group
      position={[x, 3.2, (WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - 0.03) * (side === "north" ? 1 : -1)]}
      rotation={[0, side === "north" ? Math.PI : 0, 0]}
    >
      <mesh material={mats.trim}>
        <boxGeometry args={[1.24, 0.68, 0.03]} />
      </mesh>
      <mesh position={[0, 0, 0.016]}>
        <planeGeometry args={[1.14, 0.57]} />
        <meshBasicMaterial ref={faceMatRef} map={texture} transparent />
      </mesh>
    </group>
  );
}

/** One window's corridor: floor slab, carpet runner, both wall runs with
 *  wainscot, baseboards, cornice bands, doors,
 *  sconces (the lit subset carrying real light at the shade), the
 *  baseboard light line with its own low lights, floor lamps at grid
 *  intervals, and seeded dressing (paintings, props, date plaques).
 *  `index` is the GEOMETRY chunk (always 0 — the window renders in the
 *  local frame); `seedIndex` feeds the dressing seeds, so each window's
 *  hotel gets its own art and props ("整体相同、个别不同", §9.2). */
function CorridorChunk({
  index,
  seedIndex,
  sliceIds,
  layout,
  doorArchetypes,
  plateInk,
  dimRef,
  darkRef,
  mats,
  playerRef,
}: {
  index: number;
  seedIndex: number;
  sliceIds: readonly string[];
  layout: CorridorLayout;
  doorArchetypes: ReadonlyMap<string, ArchetypeId | undefined>;
  plateInk?: string;
  dimRef: MutableRefObject<boolean>;
  darkRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}) {
  const { xStart, xEnd } = corridorSpan(index, layout);
  const length = xEnd - xStart;
  const centerX = (xStart + xEnd) / 2;
  const doors = useMemo(
    () => doorsInChunk(index, sliceIds, layout),
    [index, sliceIds, layout],
  );
  const northDoors = doors.filter((d) => d.side === "north");
  const southDoors = doors.filter((d) => d.side === "south");
  const sconces = useMemo(() => sconcePositions(xStart, xEnd), [xStart, xEnd]);
  // Which sconces carry the chunk's real light, and how far it reaches.
  const sconceLights = useMemo(() => litSconceSelection(sconces.length), [sconces.length]);
  // Floor lamps on their own 24 m grid; props must keep clear of them.
  const lamps = useMemo(
    () => floorLampLayout(index, xStart, xEnd, layout),
    [index, xStart, xEnd, layout],
  );
  // Interior points of the fixed architectural grid (minus the far seam, so
  // a frame never straddles a chunk boundary) — where paintings hang. The
  // grid is independent of the bays: art keeps the house's rhythm while the
  // doors move with time.
  const gapXs = useMemo(
    () => sconces.filter((x) => x < xEnd - 1e-9),
    [sconces, xEnd],
  );
  const paintings = useMemo(() => paintingLayout(seedIndex, gapXs), [seedIndex, gapXs]);
  const props = useMemo(
    () =>
      propLayout(index, seedIndex, xStart, length, gapXs, layout).filter((p) =>
        lamps.every((l) => Math.sign(p.z) !== Math.sign(l.z) || Math.abs(p.x - l.x) >= 1.2),
      ),
    [index, seedIndex, xStart, length, gapXs, layout, lamps],
  );
  // A date plaque goes up at the BAY boundary (the seam between bay m − 1
  // and bay m, x = -cumulative[m]) wherever the calendar day changes across
  // it — signage follows the bays, not the sconce grid. Boundary m = base
  // sits at this chunk's xEnd; the boundary at xStart belongs to the deeper
  // chunk, so ownership stays total.
  const datePlaques = useMemo(() => {
    const base = -index * CHUNK_DOORS;
    const plaques: { x: number; label: string }[] = [];
    for (let m = base; m < base + CHUNK_DOORS; m++) {
      const prev = bayDate(sliceIds, m - 1);
      const cur = bayDate(sliceIds, m);
      if (prev && cur && prev !== cur) {
        plaques.push({ x: bayBoundaryX(layout, m), label: cur });
      }
    }
    return plaques;
  }, [index, sliceIds, layout]);

  return (
    <group>
      {/* Floor slab, top surface at y = 0. */}
      <mesh
        position={[centerX, -FLOOR_THICKNESS / 2, 0]}
        material={mats.floor}
        receiveShadow
      >
        <boxGeometry args={[length, FLOOR_THICKNESS, CORRIDOR_WIDTH]} />
      </mesh>
      {/* Carpet runner down the corridor's spine — one stretch per chunk,
          bound by two dark stripes, hovering a hair over the floor. */}
      <mesh
        position={[centerX, 0.005, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={mats.carpet}
        receiveShadow
      >
        <planeGeometry args={[length, 2.2]} />
      </mesh>
      <mesh
        position={[centerX, 0.009, 1.03]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={mats.carpetEdge}
        receiveShadow
      >
        <planeGeometry args={[length, 0.14]} />
      </mesh>
      <mesh
        position={[centerX, 0.009, -1.03]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={mats.carpetEdge}
        receiveShadow
      >
        <planeGeometry args={[length, 0.14]} />
      </mesh>
      <WallRun
        xStart={xStart}
        xEnd={xEnd}
        height={WALL_HEIGHT}
        z={WALL_Z}
        doors={northDoors}
        mats={mats}
      />
      <WallRun
        xStart={xStart}
        xEnd={xEnd}
        height={SOUTH_WALL_HEIGHT}
        z={-WALL_Z}
        doors={southDoors}
        mats={mats}
      />
      {/* Dark baseboards along the inner wall faces. */}
      <mesh
        position={[centerX, 0.06, WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - 0.02]}
        material={mats.trim}
      >
        <boxGeometry args={[length, 0.12, 0.04]} />
      </mesh>
      <mesh
        position={[centerX, 0.06, -WALL_Z + CORRIDOR_WALL_THICKNESS / 2 + 0.02]}
        material={mats.trim}
      >
        <boxGeometry args={[length, 0.12, 0.04]} />
      </mesh>
      {/* Cornice bands crowning both walls, slightly proud of the faces. */}
      <mesh
        position={[
          centerX,
          WALL_HEIGHT - CORNICE_HEIGHT / 2,
          WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - CORNICE_DEPTH / 2 + 0.02,
        ]}
        material={mats.trim}
        receiveShadow
      >
        <boxGeometry args={[length, CORNICE_HEIGHT, CORNICE_DEPTH]} />
      </mesh>
      <mesh
        position={[
          centerX,
          WALL_HEIGHT - CORNICE_HEIGHT / 2,
          -WALL_Z + CORRIDOR_WALL_THICKNESS / 2 + CORNICE_DEPTH / 2 - 0.02,
        ]}
        material={mats.trim}
        receiveShadow
      >
        <boxGeometry args={[length, CORNICE_HEIGHT, CORNICE_DEPTH]} />
      </mesh>
      {doors.map((door) => (
        <DoorAssembly
          key={`${door.index}-${door.side}`}
          door={door}
          archetype={doorArchetypes.get(door.sliceId)}
          dimRef={dimRef}
          mats={mats}
          playerRef={playerRef}
          plateInk={plateInk}
        />
      ))}
      {/* North-wall sconces — the lit subset carries the chunk's real
          light at the shade; the south wall answers with the light line. */}
      {sconces.map((x, i) => (
        <WallSconce
          key={x}
          x={x}
          lit={sconceLights.lit[i]}
          lightDistance={sconceLights.distance}
          dimRef={dimRef}
          darkRef={darkRef}
          mats={mats}
        />
      ))}
      <LightLine xStart={xStart} xEnd={xEnd} dimRef={dimRef} darkRef={darkRef} />
      {/* Floor lamps at grid intervals along the hall — the lobby fixture,
          real light included. */}
      {lamps.map((l) => (
        <FloorLamp
          key={l.x}
          position={[l.x, 0, l.z]}
          dimRef={dimRef}
          mats={mats}
          levels={LIGHT_LEVELS.corridorLamp}
          distance={FLOOR_LAMP_LIGHT_DISTANCE}
        />
      ))}
      {/* Seeded dressing: paintings, wall-hugging props, date plaques. */}
      {paintings.map((p) => (
        <WallPainting key={`${p.side}-${p.x}`} spec={p} mats={mats} />
      ))}
      {props.map((p, i) =>
        p.kind === "plant" ? (
          <PottedPlant key={i} position={[p.x, 0, p.z]} scale={p.scale} mats={mats} />
        ) : (
          <TrashBin key={i} position={[p.x, 0, p.z]} mats={mats} />
        ),
      )}
      {datePlaques.map((p) => (
        <DatePlaque key={p.x} x={p.x} label={p.label} dimRef={dimRef} mats={mats} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Lobby props                                                         */
/* ------------------------------------------------------------------ */

function FrontDesk({
  position,
  rotationY,
  mats,
}: {
  position: Vec3;
  rotationY: number;
  mats: HotelMaterials;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.525, 0]} material={mats.desk} castShadow>
        <boxGeometry args={[2.0, 1.05, 0.7]} />
      </mesh>
      <mesh position={[0, 1.1, 0]} material={mats.trim} castShadow receiveShadow>
        <boxGeometry args={[2.2, 0.08, 0.9]} />
      </mesh>
    </group>
  );
}

function Armchair({
  position,
  rotationY,
  mats,
}: {
  position: Vec3;
  rotationY: number;
  mats: HotelMaterials;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Base + cushion; backrest on local -x, so the chair faces +x. */}
      <mesh position={[0, 0.24, 0]} material={mats.desk} castShadow>
        <boxGeometry args={[0.72, 0.32, 0.72]} />
      </mesh>
      <mesh position={[0.03, 0.46, 0]} material={mats.cushion} castShadow receiveShadow>
        <boxGeometry args={[0.64, 0.14, 0.62]} />
      </mesh>
      <mesh position={[-0.29, 0.68, 0]} material={mats.desk} castShadow>
        <boxGeometry args={[0.14, 0.56, 0.72]} />
      </mesh>
    </group>
  );
}

function PottedPlant({
  position,
  scale,
  mats,
}: {
  position: Vec3;
  scale: number;
  mats: HotelMaterials;
}) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.18, 0]} material={mats.pot} castShadow>
        <cylinderGeometry args={[0.24, 0.19, 0.36, 10]} />
      </mesh>
      <mesh position={[0, 0.82, 0]} material={mats.foliage} castShadow>
        <icosahedronGeometry args={[0.4, 0]} />
      </mesh>
    </group>
  );
}

/** A small tapered corridor bin with a proud rim ring. */
function TrashBin({
  position,
  mats,
}: {
  position: Vec3;
  mats: HotelMaterials;
}) {
  return (
    <group position={position}>
      <mesh position={[0, 0.28, 0]} material={mats.trim} castShadow>
        <cylinderGeometry args={[0.2, 0.16, 0.56, 10]} />
      </mesh>
      <mesh position={[0, 0.59, 0]} material={mats.trim} castShadow>
        <cylinderGeometry args={[0.23, 0.2, 0.07, 10]} />
      </mesh>
    </group>
  );
}

/** A floor lamp with its real point light at the shade — the lobby pair
 *  and, at grid intervals, the corridor's own lamps (same fixture; the
 *  corridor's burn a touch softer and reach less far). */
function FloorLamp({
  position,
  dimRef,
  mats,
  levels = LIGHT_LEVELS.lobbyLamp,
  distance = 13,
}: {
  position: Vec3;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  levels?: LightLevels;
  distance?: number;
}) {
  // The lamp's real light and its glowing shade follow the dimming.
  const lightRef = useRef<PointLight>(null);
  const shadeMatRef = useRef<MeshStandardMaterial>(null);
  useDimLerp(
    dimRef,
    levels,
    () => lightRef.current?.intensity ?? null,
    (v) => {
      const l = lightRef.current;
      if (l) l.intensity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.lampShade,
    () => shadeMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = shadeMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
  );
  return (
    <group position={position}>
      <mesh position={[0, 0.02, 0]} material={mats.trim} castShadow>
        <cylinderGeometry args={[0.16, 0.18, 0.04, 10]} />
      </mesh>
      <mesh position={[0, 0.78, 0]} material={mats.trim} castShadow>
        <cylinderGeometry args={[0.03, 0.03, 1.52, 8]} />
      </mesh>
      {/* Shade glows — reads as the bulb. */}
      <mesh position={[0, 1.58, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.22, 0.3, 10]} />
        <meshStandardMaterial
          ref={shadeMatRef}
          color="#000000"
          emissive={LAMP_COLOR}
          emissiveIntensity={LIGHT_LEVELS.lampShade.full}
          roughness={1}
          metalness={0}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        position={[0, 1.5, 0]}
        color={LAMP_COLOR}
        intensity={levels.full}
        distance={distance}
        decay={2}
      />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Lobby register board (§9.2/§10.3 — 目录板)                          */
/* ------------------------------------------------------------------ */

const REGISTER_DAY_MS = 24 * 60 * 60 * 1000;

export interface LobbyRegisterEntry {
  sliceId: string;
  /** "09·15" / "0746" from the id's own clock; null for non-id fixtures. */
  date: string | null;
  time: string | null;
}

export interface LobbyRegister {
  /** The window's slices, newest first (the corridor's own order). */
  entries: LobbyRegisterEntry[];
  /** gaps[i] = whole days from entries[i] (newer) back to entries[i+1]
   *  (older); null when either timestamp is unknown. Length
   *  entries.length − 1. */
  gaps: readonly (number | null)[];
}

/**
 * The register's data: every slice in ONE window with the time gaps
 * between them — the corridor's pitch story re-homed to the lobby
 * (§10.3: "间隔"要在大堂安家). Gaps come from the same timestamps the
 * corridor's layout consumes (the ISO `start`, falling back to the slice
 * id through strand-graph's parser — corridor-pitch's exact rule), so the
 * board and the hall never disagree about an interval.
 */
export function buildLobbyRegister(
  doors: readonly CorridorDoor[],
  windowIndex: number,
): LobbyRegister {
  const windowDoors = doors.slice(
    windowIndex * WINDOW_SLICES,
    (windowIndex + 1) * WINDOW_SLICES,
  );
  const entries = windowDoors.map((door) => ({
    sliceId: door.sliceId,
    date: sliceClock(door.sliceId)?.date ?? null,
    time: sliceClock(door.sliceId)?.time ?? null,
  }));
  const starts = windowDoors.map((door) => {
    if (door.start !== undefined) {
      const ms = Date.parse(door.start);
      if (!Number.isNaN(ms)) return ms;
    }
    return sliceIdToMs(door.sliceId);
  });
  const gaps: (number | null)[] = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const newer = starts[i];
    const older = starts[i + 1];
    gaps.push(
      newer !== null && older !== null
        ? Math.max(0, Math.trunc((newer - older) / REGISTER_DAY_MS))
        : null,
    );
  }
  return { entries, gaps };
}

/**
 * The register board: a framed dark panel on the lobby's south wall above
 * the front desk — the classic rate-board spot, the one fixed place every
 * arrival faces (§10.2a) — and the future anchor for the 2.5D jump
 * (§13: 锚定物, so it hangs where the player can walk up to it). Panel
 * and frame are R3F; every glyph is DOM (§13: 文字永远 DOM, 空间永远
 * R3F). It reads as a hotel notice board, not a UI control: the hotel's
 * name and window number in the hotel's accent (§11.1 — brand blue for
 * the core timeline), then each slice's clock with the gap back to the
 * next-older one, and — while an older hotel exists — the page door's
 * promise at the foot.
 */
function LobbyRegisterBoard({
  register,
  hotelName,
  windowIndex,
  olderClock,
  accent,
  mats,
}: {
  register: LobbyRegister;
  hotelName: string;
  windowIndex: number;
  /** The page door's plate (the next-older hotel's first room clock) —
   *  null at the oldest window: nothing lies beyond. */
  olderClock: string | null;
  accent: string;
  mats: HotelMaterials;
}) {
  // 200 px per world unit (drei Html: 400 / distanceFactor) — the DOM is
  // sized to exactly cover the R3F panel behind it.
  const PX_PER_M = 200;
  return (
    <group
      position={[
        LOBBY_LAYOUT.desk.position[0],
        REGISTER_BOARD_Y,
        -LOBBY_SOUTH_REACH + CORRIDOR_WALL_THICKNESS / 2 + 0.03,
      ]}
    >
      <mesh material={mats.trim} castShadow>
        <boxGeometry args={[REGISTER_BOARD_W + 0.14, REGISTER_BOARD_H + 0.14, 0.07]} />
      </mesh>
      <mesh position={[0, 0, 0.04]}>
        <planeGeometry args={[REGISTER_BOARD_W, REGISTER_BOARD_H]} />
        <meshStandardMaterial color={PLATE_BG} roughness={0.9} metalness={0} />
      </mesh>
      <Html
        transform
        center
        distanceFactor={2}
        position={[0, 0, 0.08]}
        zIndexRange={[5, 0]}
        pointerEvents="none"
      >
        {/* Plate styling lives in lobby-register.css. Only three values stay
            in JS: the pixel size (derived from the 3D world constants so the
            DOM exactly covers the R3F panel), the ink (PLATE_INK — the lib
            palette constant the canvas plaque texture also draws with), and
            the accent (the per-hotel material colour, a prop). */}
        <div
          className="lobby-register"
          style={{
            width: REGISTER_BOARD_W * PX_PER_M - 24,
            height: REGISTER_BOARD_H * PX_PER_M - 24,
            color: PLATE_INK,
          }}
        >
          <div className="lobby-register-head" style={{ color: accent }}>
            <span>{hotelName}</span>
            <span>W{windowIndex}</span>
          </div>
          <div className="lobby-register-rows">
            {register.entries.map((entry, i) => (
              <div
                key={entry.sliceId}
                className="lobby-register-entry"
              >
                <span className="lobby-register-time">{entry.time ?? "····"}</span>
                <span className="lobby-register-dim lobby-register-date">{entry.date ?? ""}</span>
                <span className="lobby-register-spacer" />
                {i < register.gaps.length && (
                  <span className="lobby-register-dim lobby-register-gap">
                    {register.gaps[i] === null ? "·" : `${register.gaps[i]}d`}
                  </span>
                )}
              </div>
            ))}
          </div>
          {olderClock !== null && (
            <div className="lobby-register-foot" style={{ color: accent }}>
              ← {olderClock}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

/** The lobby — the L's short leg. The junction band (corridor width)
 *  keeps its north wall and the seam portal posts; its south side is
 *  OPEN — the corridor's south wall stops at the seam and the floor runs
 *  on south to the leg's far wall, so arriving from the hall reads as a
 *  turn into a separate room. The leg's far walls (south/east) run full
 *  height; its west wall faces the camera and stays a low cutaway
 *  parapet. The desk stands against the south wall, facing the turn.
 *  RETURN DOORS (§10.5 — 大堂南北墙各挂一扇): the lobby carries one return
 *  door per SIDE the trip in on the nav stack came from — a room entered
 *  from the corridor's north wall leaves its way back on the lobby's north
 *  wall (RETURN_DOOR_X, the junction band), a south-wall room on the leg's
 *  far south wall (RETURN_DOOR_SOUTH_X, west of the desk). Both walls carry
 *  a door when the stack holds trips from both sides; each leads back with
 *  the hotel's accent glow and carries no number (it leads back, not to a
 *  slice). The EAST wall carries the ARRIVAL DOOR (§10.5 西出东进) once an
 *  east-west trip (page door / travel) is on the stack: the corridor's
 *  west end is the way out, this east-wall door is the way back. No door
 *  without a trip: the newest hotel's lobby is the
 *  beginning of the world. The south wall also wears the REGISTER BOARD
 *  above the desk (§9.2/§10.3 — the one fixed place every arrival sees). */
function Lobby({
  dimRef,
  mats,
  returnDoors,
  register,
  hotelName,
  windowIndex,
  olderClock,
  accent,
  playerRef,
}: {
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  /** Which lobby walls carry a door back (§10.5) — the sides the nav
   *  stack's trips came in from; `east` is the arrival door (西出东进). */
  returnDoors: { north: boolean; south: boolean; east: boolean };
  register: LobbyRegister;
  hotelName: string;
  windowIndex: number;
  olderClock: string | null;
  accent: string;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}) {
  const { desk, armchairs, plants, lamps } = LOBBY_LAYOUT;
  const centerX = LOBBY_LENGTH / 2;
  // The floor spans the junction band plus the leg: z ∈ [−reach, +WALL_Z].
  const southZ = -LOBBY_SOUTH_REACH;
  const floorDepth = LOBBY_SOUTH_REACH + WALL_Z;
  const centerZ = (WALL_Z - LOBBY_SOUTH_REACH) / 2;
  // The leg proper (south of the corridor band) — the parapet's span.
  const legDepth = LOBBY_SOUTH_REACH - WALL_Z;
  const legCenterZ = (-WALL_Z + southZ) / 2;
  // The junction's north wall: one solid run, or split around the return
  // door's gap exactly like a corridor wall run (segments + lintel). The
  // leg's far south wall splits the same way around its own return door.
  const northWall = returnDoors.north
    ? wallSegments(0, LOBBY_LENGTH, [RETURN_DOOR_X])
    : [{ x0: 0, x1: LOBBY_LENGTH }];
  const southWall = returnDoors.south
    ? wallSegments(0, LOBBY_LENGTH, [RETURN_DOOR_SOUTH_X])
    : [{ x0: 0, x1: LOBBY_LENGTH }];
  // The leg's far EAST wall: one solid z-run, or split around the arrival
  // door's gap at z = 0 (two segments + a lintel) — the mirror of the
  // corridor's west-end page door (§10.5 西出东进). The wall spans a
  // half-thickness past both corner seams, like CorridorEnd's end wall.
  const eastWall = returnDoors.east
    ? [
        { z0: southZ - CORRIDOR_WALL_THICKNESS / 2, z1: -DOOR_WIDTH / 2 },
        { z0: DOOR_WIDTH / 2, z1: WALL_Z + CORRIDOR_WALL_THICKNESS / 2 },
      ]
    : [{ z0: southZ - CORRIDOR_WALL_THICKNESS / 2, z1: WALL_Z + CORRIDOR_WALL_THICKNESS / 2 }];
  // The east wall's interior-face trim (baseboard, wainscot, chair rail)
  // spans [southZ, WALL_Z] and breaks around the same gap.
  const eastTrim = returnDoors.east
    ? [
        { z0: southZ, z1: -DOOR_WIDTH / 2 },
        { z0: DOOR_WIDTH / 2, z1: WALL_Z },
      ]
    : [{ z0: southZ, z1: WALL_Z }];
  return (
    <group>
      <mesh
        position={[centerX, -FLOOR_THICKNESS / 2, centerZ]}
        material={mats.floor}
        receiveShadow
      >
        <boxGeometry args={[LOBBY_LENGTH, FLOOR_THICKNESS, floorDepth]} />
      </mesh>
      {/* Junction band: north wall full height (the corridor's north wall
          runs straight on), split around the return door when there is
          one; the south side is open — the turn. */}
      {northWall.map((s) => (
        <mesh
          key={`${s.x0}:${s.x1}`}
          position={[(s.x0 + s.x1) / 2, WALL_HEIGHT / 2, WALL_Z]}
          material={mats.wall}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[s.x1 - s.x0, WALL_HEIGHT, CORRIDOR_WALL_THICKNESS]} />
        </mesh>
      ))}
      {returnDoors.north && (
        <>
          <mesh
            position={[RETURN_DOOR_X, (WALL_HEIGHT + DOOR_HEIGHT) / 2, WALL_Z]}
            material={mats.wall}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[DOOR_WIDTH, WALL_HEIGHT - DOOR_HEIGHT, CORRIDOR_WALL_THICKNESS]} />
          </mesh>
          {/* The door you came through (§10.2a): accent glow, no number —
              it leads back, not to a slice. */}
          <DoorAssembly
            door={{
              index: 0,
              side: "north",
              sliceId: "",
              x: RETURN_DOOR_X,
              z: WALL_Z,
            }}
            dimRef={dimRef}
            mats={mats}
            playerRef={playerRef}
            glowOverride={accent}
            plateClock={null}
          />
        </>
      )}
      {/* Far walls: east and south, full height — the backdrop. The east
          wall splits around the ARRIVAL DOOR's gap at z = 0 when an
          east-west trip is on the stack (§10.5 西出东进); the south wall
          splits around its own return door exactly like the junction's
          north wall does. */}
      {eastWall.map((s) => (
        <mesh
          key={`east-${s.z0}:${s.z1}`}
          position={[LOBBY_LENGTH, WALL_HEIGHT / 2, (s.z0 + s.z1) / 2]}
          material={mats.wall}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[CORRIDOR_WALL_THICKNESS, WALL_HEIGHT, s.z1 - s.z0]} />
        </mesh>
      ))}
      {returnDoors.east && (
        <>
          {/* Lintel above the arrival door's gap, flush with the wall. */}
          <mesh
            position={[LOBBY_LENGTH, (WALL_HEIGHT + DOOR_HEIGHT) / 2, 0]}
            material={mats.wall}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[CORRIDOR_WALL_THICKNESS, WALL_HEIGHT - DOOR_HEIGHT, DOOR_WIDTH]} />
          </mesh>
          <ArrivalDoor
            accent={accent}
            dimRef={dimRef}
            mats={mats}
            playerRef={playerRef}
          />
        </>
      )}
      {southWall.map((s) => (
        <mesh
          key={`south-${s.x0}:${s.x1}`}
          position={[(s.x0 + s.x1) / 2, WALL_HEIGHT / 2, southZ]}
          material={mats.wall}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[s.x1 - s.x0, WALL_HEIGHT, CORRIDOR_WALL_THICKNESS]} />
        </mesh>
      ))}
      {returnDoors.south && (
        <>
          <mesh
            position={[RETURN_DOOR_SOUTH_X, (WALL_HEIGHT + DOOR_HEIGHT) / 2, southZ]}
            material={mats.wall}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[DOOR_WIDTH, WALL_HEIGHT - DOOR_HEIGHT, CORRIDOR_WALL_THICKNESS]} />
          </mesh>
          {/* The south-side way back (§10.5): a south-wall room's trip
              home. Accent glow, no number — it leads back, not to a slice. */}
          <DoorAssembly
            door={{
              index: 0,
              side: "south",
              sliceId: "",
              x: RETURN_DOOR_SOUTH_X,
              z: southZ,
            }}
            dimRef={dimRef}
            mats={mats}
            playerRef={playerRef}
            glowOverride={accent}
            plateClock={null}
          />
        </>
      )}
      {/* The leg's west wall faces the camera: a low parapet with a trim
          cap, so the 45° camera reads the leg's floor over it. */}
      <mesh
        position={[0, LOBBY_CUTAWAY_HEIGHT / 2, legCenterZ]}
        material={mats.wall}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[CORRIDOR_WALL_THICKNESS, LOBBY_CUTAWAY_HEIGHT, legDepth]} />
      </mesh>
      <mesh
        position={[0, LOBBY_CUTAWAY_HEIGHT + LOBBY_CUTAWAY_CAP / 2, legCenterZ]}
        material={mats.trim}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.1, LOBBY_CUTAWAY_CAP, legDepth + 0.1]} />
      </mesh>
      {/* Baseboards on the three full-height walls — the north and south
          ones break around their return door gaps like the walls do. */}
      {northWall.map((s) => (
        <mesh
          key={`baseboard-n-${s.x0}:${s.x1}`}
          position={[(s.x0 + s.x1) / 2, 0.06, WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - 0.02]}
          material={mats.trim}
        >
          <boxGeometry args={[s.x1 - s.x0, 0.12, 0.04]} />
        </mesh>
      ))}
      {southWall.map((s) => (
        <mesh
          key={`baseboard-s-${s.x0}:${s.x1}`}
          position={[(s.x0 + s.x1) / 2, 0.06, southZ + CORRIDOR_WALL_THICKNESS / 2 + 0.02]}
          material={mats.trim}
        >
          <boxGeometry args={[s.x1 - s.x0, 0.12, 0.04]} />
        </mesh>
      ))}
      {eastTrim.map((s) => (
        <mesh
          key={`baseboard-e-${s.z0}:${s.z1}`}
          position={[LOBBY_LENGTH - CORRIDOR_WALL_THICKNESS / 2 - 0.02, 0.06, (s.z0 + s.z1) / 2]}
          material={mats.trim}
        >
          <boxGeometry args={[0.04, 0.12, s.z1 - s.z0]} />
        </mesh>
      ))}
      {/* Wainscot + chair rail on the three full-height walls — the north
          and south walls' bands break around their return door gaps. */}
      {[1, -1].map((s) => {
        const wz = s > 0
          ? WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - WAINSCOT_DEPTH / 2 + 0.01
          : southZ + CORRIDOR_WALL_THICKNESS / 2 + WAINSCOT_DEPTH / 2 - 0.01;
        const rz = s > 0
          ? WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - CHAIR_RAIL_DEPTH / 2 + 0.01
          : southZ + CORRIDOR_WALL_THICKNESS / 2 + CHAIR_RAIL_DEPTH / 2 - 0.01;
        const spans = s > 0 ? northWall : southWall;
        return (
          <group key={`wainscot-${s}`}>
            {spans.map((span) => (
              <group key={`${span.x0}:${span.x1}`}>
                <mesh
                  position={[(span.x0 + span.x1) / 2, WAINSCOT_HEIGHT / 2, wz]}
                  material={mats.wainscot}
                  receiveShadow
                >
                  <boxGeometry args={[span.x1 - span.x0, WAINSCOT_HEIGHT, WAINSCOT_DEPTH]} />
                </mesh>
                <mesh
                  position={[(span.x0 + span.x1) / 2, WAINSCOT_HEIGHT + CHAIR_RAIL_HEIGHT / 2, rz]}
                  material={mats.trim}
                  receiveShadow
                >
                  <boxGeometry args={[span.x1 - span.x0, CHAIR_RAIL_HEIGHT, CHAIR_RAIL_DEPTH]} />
                </mesh>
              </group>
            ))}
          </group>
        );
      })}
      <group key="wainscot-east">
        {eastTrim.map((s) => (
          <group key={`we-${s.z0}:${s.z1}`}>
            <mesh
              position={[
                LOBBY_LENGTH - CORRIDOR_WALL_THICKNESS / 2 - WAINSCOT_DEPTH / 2 + 0.01,
                WAINSCOT_HEIGHT / 2,
                (s.z0 + s.z1) / 2,
              ]}
              material={mats.wainscot}
              receiveShadow
            >
              <boxGeometry args={[WAINSCOT_DEPTH, WAINSCOT_HEIGHT, s.z1 - s.z0]} />
            </mesh>
            <mesh
              position={[
                LOBBY_LENGTH - CORRIDOR_WALL_THICKNESS / 2 - CHAIR_RAIL_DEPTH / 2 + 0.01,
                WAINSCOT_HEIGHT + CHAIR_RAIL_HEIGHT / 2,
                (s.z0 + s.z1) / 2,
              ]}
              material={mats.trim}
              receiveShadow
            >
              <boxGeometry args={[CHAIR_RAIL_DEPTH, CHAIR_RAIL_HEIGHT, s.z1 - s.z0]} />
            </mesh>
          </group>
        ))}
      </group>
      {/* Cornices on the three full-height walls. */}
      {[1, -1].map((s) => (
        <mesh
          key={`cornice-${s}`}
          position={[
            centerX,
            WALL_HEIGHT - CORNICE_HEIGHT / 2,
            s > 0
              ? WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - CORNICE_DEPTH / 2 + 0.02
              : southZ + CORRIDOR_WALL_THICKNESS / 2 + CORNICE_DEPTH / 2 - 0.02,
          ]}
          material={mats.trim}
          receiveShadow
        >
          <boxGeometry args={[LOBBY_LENGTH, CORNICE_HEIGHT, CORNICE_DEPTH]} />
        </mesh>
      ))}
      <mesh
        position={[
          LOBBY_LENGTH - CORRIDOR_WALL_THICKNESS / 2 - CORNICE_DEPTH / 2 + 0.02,
          WALL_HEIGHT - CORNICE_HEIGHT / 2,
          centerZ,
        ]}
        material={mats.trim}
        receiveShadow
      >
        <boxGeometry args={[CORNICE_DEPTH, CORNICE_HEIGHT, floorDepth]} />
      </mesh>
      {/* Portal posts at the corridor seam (x = 0) — the threshold into the
          hall, visible as the lobby's marker from far down the corridor. */}
      {[1, -1].map((s) => (
        <mesh
          key={`portal-${s}`}
          position={[
            0,
            WALL_HEIGHT / 2,
            s * (WALL_Z - CORRIDOR_WALL_THICKNESS / 2 - PORTAL_POST_SIZE / 2 + 0.02),
          ]}
          material={mats.trim}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[PORTAL_POST_SIZE, WALL_HEIGHT, PORTAL_POST_SIZE]} />
        </mesh>
      ))}
      <FrontDesk position={desk.position} rotationY={desk.rotationY} mats={mats} />
      {/* The register board above the desk (§9.2/§10.3): the window's
          slices and their gaps, the hotel's identity, and the older-hotel
          promise — DOM text on an R3F panel (§13). */}
      <LobbyRegisterBoard
        register={register}
        hotelName={hotelName}
        windowIndex={windowIndex}
        olderClock={olderClock}
        accent={accent}
        mats={mats}
      />
      {armchairs.map((chair, i) => (
        <Armchair key={i} position={chair.position} rotationY={chair.rotationY} mats={mats} />
      ))}
      {plants.map((plant, i) => (
        <PottedPlant key={i} position={plant.position} scale={plant.scale} mats={mats} />
      ))}
      {lamps.map((lamp, i) => (
        <FloorLamp key={i} position={lamp.position} dimRef={dimRef} mats={mats} />
      ))}
    </group>
  );
}

/**
 * The lobby's EAST arrival door (§10.5 西出东进) — the mirror of the
 * corridor's west-end page door: every page-door/travel hop comes IN
 * through this door, and walking back out through it returns to the
 * departure hotel's west end. Same dressing as CorridorEnd's page door
 * (frame, hinged slab swinging away from the player — here toward +x,
 * into the void beyond the wall — an accent glow in the gap, halos and a
 * lintel strip on both faces), but NO plate: it leads back, not to a
 * slice. Hangs at z = 0 on the lobby's east wall (x = LOBBY_LENGTH).
 */
function ArrivalDoor({
  accent,
  dimRef,
  mats,
  playerRef,
}: {
  accent: string;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}) {
  // Hinged slab: the hinge group sits on the z < 0 jamb at the wall plane;
  // the slab hangs +z off it. The swing pushes AWAY from the player
  // (toward +x, back toward the hotel they came from), easing like the
  // room doors — the mirror of CorridorEnd's −x swing.
  const hingeRef = useRef<Group>(null);
  const angleRef = useRef(0);
  const snappedRef = useRef(false);
  useFrame((_, delta) => {
    const hinge = hingeRef.current;
    if (!hinge) return;
    const p = playerRef.current;
    const near = Math.hypot(p.x - LOBBY_LENGTH, p.z) < DOOR_OPEN_DIST;
    const target = near ? DOOR_OPEN_ANGLE : 0;
    const dt = Math.min(delta, 0.05);
    if (!snappedRef.current) {
      angleRef.current = target;
      snappedRef.current = true;
    } else {
      angleRef.current += (target - angleRef.current) * (1 - Math.exp(-DOOR_SWING_RATE * dt));
    }
    hinge.rotation.y = angleRef.current;
  });

  // Glow materials follow the hotel-wide dimming — one ref pair per face
  // (the door is dressed on BOTH faces; the camera only sees −x).
  const glowMatRef = useRef<MeshStandardMaterial>(null);
  const haloMatRef = useRef<MeshBasicMaterial>(null);
  const haloMatRef2 = useRef<MeshBasicMaterial>(null);
  const stripMatRef = useRef<MeshStandardMaterial>(null);
  const stripMatRef2 = useRef<MeshStandardMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorGlow,
    () => glowMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = glowMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorHalo,
    () => haloMatRef.current?.opacity ?? null,
    (v) => {
      const m = haloMatRef.current;
      if (m) m.opacity = v;
      const m2 = haloMatRef2.current;
      if (m2) m2.opacity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorStrip,
    () => stripMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = stripMatRef.current;
      if (m) m.emissiveIntensity = v;
      const m2 = stripMatRef2.current;
      if (m2) m2.emissiveIntensity = v;
    },
  );

  return (
    <group>
      {/* Frame posts + header, centered on the wall plane so they read
          proud of BOTH faces. */}
      <mesh
        position={[LOBBY_LENGTH, DOOR_HEIGHT / 2 + 0.05, -DOOR_WIDTH / 2 - 0.05]}
        material={mats.trim}
        castShadow
      >
        <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.14, DOOR_HEIGHT + 0.1, 0.1]} />
      </mesh>
      <mesh
        position={[LOBBY_LENGTH, DOOR_HEIGHT / 2 + 0.05, DOOR_WIDTH / 2 + 0.05]}
        material={mats.trim}
        castShadow
      >
        <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.14, DOOR_HEIGHT + 0.1, 0.1]} />
      </mesh>
      <mesh position={[LOBBY_LENGTH, DOOR_HEIGHT + 0.11, 0]} material={mats.trim} castShadow>
        <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.14, 0.12, DOOR_WIDTH + 0.2]} />
      </mesh>
      {/* Hinged slab — a real door, opaque, swinging on its z < 0 jamb,
          away from the arriving player (toward +x). */}
      <group ref={hingeRef} position={[LOBBY_LENGTH, 0, -DOOR_WIDTH / 2 + 0.02]}>
        <mesh
          position={[0, DOOR_HEIGHT / 2, DOOR_WIDTH / 2 - 0.02]}
          material={mats.slab}
          castShadow
        >
          <boxGeometry args={[0.05, DOOR_HEIGHT - 0.04, DOOR_WIDTH - 0.04]} />
        </mesh>
        {/* Handles: a small dark knob on each face, free-end side. */}
        {[1, -1].map((side) => (
          <mesh
            key={`handle-${side}`}
            position={[side * 0.05, DOOR_HEIGHT / 2, DOOR_WIDTH - 0.22]}
            material={mats.trim}
            castShadow
          >
            <boxGeometry args={[0.05, 0.16, 0.05]} />
          </mesh>
        ))}
      </group>
      {/* Accent glow inside the gap, revealed when the slab swings aside —
          the last hotel's light. Double-sided: it must read through the
          opening from both faces. */}
      <mesh position={[LOBBY_LENGTH, DOOR_HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[DOOR_WIDTH, DOOR_HEIGHT]} />
        <meshStandardMaterial
          ref={glowMatRef}
          color="#000000"
          emissive={accent}
          emissiveIntensity={LIGHT_LEVELS.doorGlow.full}
          roughness={1}
          metalness={0}
          side={DoubleSide}
        />
      </mesh>
      {/* Faint additive halo around the opening, both faces. */}
      {[1, -1].map((side) => (
        <mesh
          key={`halo-${side}`}
          position={[LOBBY_LENGTH + side * (CORRIDOR_WALL_THICKNESS / 2 + 0.03), DOOR_HEIGHT / 2, 0]}
          rotation={[0, Math.PI / 2, 0]}
        >
          <planeGeometry args={[DOOR_WIDTH + 0.5, DOOR_HEIGHT + 0.4]} />
          <meshBasicMaterial
            ref={side > 0 ? haloMatRef : haloMatRef2}
            color={accent}
            transparent
            opacity={LIGHT_LEVELS.doorHalo.full}
            blending={AdditiveBlending}
            depthWrite={false}
            side={DoubleSide}
          />
        </mesh>
      ))}
      {/* Emissive strip above the lintel — the fake fixture, both faces. */}
      {[1, -1].map((side) => (
        <mesh
          key={`strip-${side}`}
          position={[LOBBY_LENGTH + side * (CORRIDOR_WALL_THICKNESS / 2 + 0.06), WALL_HEIGHT - 0.14, 0]}
        >
          <boxGeometry args={[0.08, 0.06, DOOR_WIDTH]} />
          <meshStandardMaterial
            ref={side > 0 ? stripMatRef : stripMatRef2}
            color="#000000"
            emissive={accent}
            emissiveIntensity={LIGHT_LEVELS.doorStrip.full}
            roughness={1}
            metalness={0}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * The corridor's far end (HD2/HD3) — the wall across the window's xStart,
 * spanning z ∈ [−WALL_Z, +WALL_Z]. Two forms:
 *
 * - THE OLDEST WINDOW: a plain solid wall. The timeline simply ends here
 *   (§10: "直到尽头就什么都没有了") — no glow, no door, just the house's
 *   own trim so it reads as architecture, not an unfinished model.
 * - EVERY OTHER WINDOW: the PAGE DOOR. The wall splits around a door gap
 *   at z = 0 (two segments + a lintel, exactly like a corridor wall run),
 *   and the gap carries a real hinged slab that swings open away from the
 *   approaching player, an accent-colored glow plane on the far side, a
 *   halo, a lintel strip, and a plate showing the NEXT window's newest
 *   slice's HHMM — where this door leads. Walking through it (the
 *   integrator's clamp lets the player overtravel the wall plane inside
 *   the gap) pages to the next-older hotel.
 */
function CorridorEnd({
  endX,
  pageDoor,
  plate,
  accent,
  dimRef,
  mats,
  playerRef,
}: {
  endX: number;
  pageDoor: boolean;
  /** The page door's plate text — the next window's newest slice's HHMM.
   *  Ignored when `pageDoor` is false. */
  plate: string | null;
  accent: string;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}) {
  // Solid z-spans of the end wall: one full span, or two around the page
  // door's gap. A half-thickness overhang past ±WALL_Z closes the seam
  // with the corridor walls' end faces.
  const segments = pageDoor
    ? [
        { z0: -WALL_Z - CORRIDOR_WALL_THICKNESS / 2, z1: -DOOR_WIDTH / 2 },
        { z0: DOOR_WIDTH / 2, z1: WALL_Z + CORRIDOR_WALL_THICKNESS / 2 },
      ]
    : [{ z0: -WALL_Z - CORRIDOR_WALL_THICKNESS / 2, z1: WALL_Z + CORRIDOR_WALL_THICKNESS / 2 }];

  // Hinged slab: the hinge group sits on the z < 0 jamb at the wall plane;
  // the slab hangs +z off it. The swing pushes AWAY from the player
  // (toward −x, into the next hotel), easing like the room doors.
  const hingeRef = useRef<Group>(null);
  const angleRef = useRef(0);
  const snappedRef = useRef(false);
  useFrame((_, delta) => {
    const hinge = hingeRef.current;
    if (!hinge) return;
    const p = playerRef.current;
    const near = Math.hypot(p.x - endX, p.z) < DOOR_OPEN_DIST;
    const target = near ? -DOOR_OPEN_ANGLE : 0;
    const dt = Math.min(delta, 0.05);
    if (!snappedRef.current) {
      angleRef.current = target;
      snappedRef.current = true;
    } else {
      angleRef.current += (target - angleRef.current) * (1 - Math.exp(-DOOR_SWING_RATE * dt));
    }
    hinge.rotation.y = angleRef.current;
  });

  // Glow materials follow the hotel-wide dimming — one ref pair per face
  // (the door is dressed on BOTH faces; the camera only sees −x).
  const glowMatRef = useRef<MeshStandardMaterial>(null);
  const haloMatRef = useRef<MeshBasicMaterial>(null);
  const haloMatRef2 = useRef<MeshBasicMaterial>(null);
  const stripMatRef = useRef<MeshStandardMaterial>(null);
  const stripMatRef2 = useRef<MeshStandardMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorGlow,
    () => glowMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = glowMatRef.current;
      if (m) m.emissiveIntensity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorHalo,
    () => haloMatRef.current?.opacity ?? null,
    (v) => {
      const m = haloMatRef.current;
      if (m) m.opacity = v;
      const m2 = haloMatRef2.current;
      if (m2) m2.opacity = v;
    },
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.doorStrip,
    () => stripMatRef.current?.emissiveIntensity ?? null,
    (v) => {
      const m = stripMatRef.current;
      if (m) m.emissiveIntensity = v;
      const m2 = stripMatRef2.current;
      if (m2) m2.emissiveIntensity = v;
    },
  );

  // The page door's plate: the NEXT window's newest slice's HHMM in the
  // hotel's accent ink (§11.1), beside the frame at handle height.
  const plateTexture = useMemo(
    () => (pageDoor && plate ? createPlaqueTexture(plate, false, accent) : null),
    [pageDoor, plate, accent],
  );
  useEffect(() => () => plateTexture?.dispose(), [plateTexture]);
  const plateMatRef = useRef<MeshBasicMaterial>(null);
  const plateMatRef2 = useRef<MeshBasicMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.plaque,
    () => plateMatRef.current?.opacity ?? null,
    (v) => {
      const m = plateMatRef.current;
      if (m) m.opacity = v;
      const m2 = plateMatRef2.current;
      if (m2) m2.opacity = v;
    },
  );

  return (
    <group>
      {segments.map((s) => (
        <mesh
          key={`${s.z0}:${s.z1}`}
          position={[endX, WALL_HEIGHT / 2, (s.z0 + s.z1) / 2]}
          material={mats.wall}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[CORRIDOR_WALL_THICKNESS, WALL_HEIGHT, s.z1 - s.z0]} />
        </mesh>
      ))}
      {/* Baseboard + cornice on BOTH faces — the wall reads as the house's
          own architecture either way (the camera looks at the −x face; the
          player walks up the +x one). */}
      {[1, -1].map((side) =>
        segments.map((s) => (
          <mesh
            key={`bb-${side}-${s.z0}:${s.z1}`}
            position={[endX + side * (CORRIDOR_WALL_THICKNESS / 2 + 0.02), 0.06, (s.z0 + s.z1) / 2]}
            material={mats.trim}
          >
            <boxGeometry args={[0.04, 0.12, s.z1 - s.z0]} />
          </mesh>
        )),
      )}
      {[1, -1].map((side) => (
        <mesh
          key={`cornice-${side}`}
          position={[
            endX + side * (CORRIDOR_WALL_THICKNESS / 2 + CORNICE_DEPTH / 2 - 0.02),
            WALL_HEIGHT - CORNICE_HEIGHT / 2,
            0,
          ]}
          material={mats.trim}
          receiveShadow
        >
          <boxGeometry
            args={[CORNICE_DEPTH, CORNICE_HEIGHT, CORRIDOR_WIDTH + CORRIDOR_WALL_THICKNESS]}
          />
        </mesh>
      ))}
      {pageDoor && (
        <>
          {/* Lintel above the gap, flush with the wall faces. */}
          <mesh
            position={[endX, (WALL_HEIGHT + DOOR_HEIGHT) / 2, 0]}
            material={mats.wall}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[CORRIDOR_WALL_THICKNESS, WALL_HEIGHT - DOOR_HEIGHT, DOOR_WIDTH]} />
          </mesh>
          {/* Frame posts + header, centered on the wall plane so they read
              proud of BOTH faces — the fixed camera looks at the −x face,
              the approaching player at the +x one. */}
          <mesh
            position={[endX, DOOR_HEIGHT / 2 + 0.05, -DOOR_WIDTH / 2 - 0.05]}
            material={mats.trim}
            castShadow
          >
            <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.14, DOOR_HEIGHT + 0.1, 0.1]} />
          </mesh>
          <mesh
            position={[endX, DOOR_HEIGHT / 2 + 0.05, DOOR_WIDTH / 2 + 0.05]}
            material={mats.trim}
            castShadow
          >
            <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.14, DOOR_HEIGHT + 0.1, 0.1]} />
          </mesh>
          <mesh position={[endX, DOOR_HEIGHT + 0.11, 0]} material={mats.trim} castShadow>
            <boxGeometry args={[CORRIDOR_WALL_THICKNESS + 0.14, 0.12, DOOR_WIDTH + 0.2]} />
          </mesh>
          {/* Hinged slab — a real door, opaque, swinging on its z < 0
              jamb, away from the arriving player (toward the camera). */}
          <group ref={hingeRef} position={[endX, 0, -DOOR_WIDTH / 2 + 0.02]}>
            <mesh
              position={[0, DOOR_HEIGHT / 2, DOOR_WIDTH / 2 - 0.02]}
              material={mats.slab}
              castShadow
            >
              <boxGeometry args={[0.05, DOOR_HEIGHT - 0.04, DOOR_WIDTH - 0.04]} />
            </mesh>
            {/* Handles: a small dark knob on each face, free-end side. */}
            {[1, -1].map((side) => (
              <mesh
                key={`handle-${side}`}
                position={[side * 0.05, DOOR_HEIGHT / 2, DOOR_WIDTH - 0.22]}
                material={mats.trim}
                castShadow
              >
                <boxGeometry args={[0.05, 0.16, 0.05]} />
              </mesh>
            ))}
          </group>
          {/* Accent glow inside the gap, revealed when the slab swings
              aside — the next hotel's light. Double-sided: it must read
              through the opening from both faces. */}
          <mesh position={[endX, DOOR_HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[DOOR_WIDTH, DOOR_HEIGHT]} />
            <meshStandardMaterial
              ref={glowMatRef}
              color="#000000"
              emissive={accent}
              emissiveIntensity={LIGHT_LEVELS.doorGlow.full}
              roughness={1}
              metalness={0}
              side={DoubleSide}
            />
          </mesh>
          {/* Faint additive halo around the opening, both faces. */}
          {[1, -1].map((side) => (
            <mesh
              key={`halo-${side}`}
              position={[endX + side * (CORRIDOR_WALL_THICKNESS / 2 + 0.03), DOOR_HEIGHT / 2, 0]}
              rotation={[0, Math.PI / 2, 0]}
            >
              <planeGeometry args={[DOOR_WIDTH + 0.5, DOOR_HEIGHT + 0.4]} />
              <meshBasicMaterial
                ref={side > 0 ? haloMatRef : haloMatRef2}
                color={accent}
                transparent
                opacity={LIGHT_LEVELS.doorHalo.full}
                blending={AdditiveBlending}
                depthWrite={false}
                side={DoubleSide}
              />
            </mesh>
          ))}
          {/* Emissive strip above the lintel — the fake fixture, both faces. */}
          {[1, -1].map((side) => (
            <mesh
              key={`strip-${side}`}
              position={[endX + side * (CORRIDOR_WALL_THICKNESS / 2 + 0.06), WALL_HEIGHT - 0.14, 0]}
            >
              <boxGeometry args={[0.08, 0.06, DOOR_WIDTH]} />
              <meshStandardMaterial
                ref={side > 0 ? stripMatRef : stripMatRef2}
                color="#000000"
                emissive={accent}
                emissiveIntensity={LIGHT_LEVELS.doorStrip.full}
                roughness={1}
                metalness={0}
              />
            </mesh>
          ))}
          {/* Where this door leads: the next window's newest slice's HHMM,
              in accent ink beside the frame — both faces (the camera only
              ever sees the −x one). */}
          {plateTexture &&
            [1, -1].map((side) => (
              <group
                key={`plate-${side}`}
                position={[endX + side * (CORRIDOR_WALL_THICKNESS / 2 + 0.03), 2.2, DOOR_WIDTH / 2 + 0.5]}
                rotation={[0, (side * Math.PI) / 2, 0]}
              >
                <mesh material={mats.trim}>
                  <boxGeometry args={[0.84, 0.46, 0.03]} />
                </mesh>
                <mesh position={[0, 0, 0.016]}>
                  <planeGeometry args={[0.76, 0.38]} />
                  <meshBasicMaterial
                    ref={side > 0 ? plateMatRef : plateMatRef2}
                    map={plateTexture}
                    transparent
                  />
                </mesh>
              </group>
            ))}
        </>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Corridor                                                            */
/* ------------------------------------------------------------------ */

export function Corridor({
  playerRef,
  doors,
  windowIndex,
  accent,
  returnDoors,
  hotelName,
  dimmed = false,
  dark = true,
}: {
  playerRef: MutableRefObject<{ x: number; z: number }>;
  /** The hotel's FULL timeline (newest first) — all of it, not one
   *  window's worth. Which 8-slice window is materialized is the
   *  integrator's location state, passed as `windowIndex`. */
  doors: readonly CorridorDoor[];
  windowIndex: number;
  /** The hotel's accent (§11.1): door-plate ink, page-door glow, return-
   *  door glow, the register board's header. Brand blue for the core
   *  timeline. */
  accent: string;
  /** Which lobby walls carry a door back (§10.5): one per side the nav
   *  stack's trips came in from — north/south return doors, and the east
   *  wall's arrival door (西出东进). All false only for the hotel
   *  the run spawns in. */
  returnDoors: { north: boolean; south: boolean; east: boolean };
  /** The hotel's display name on the register board — "PREVIOUSLY" for the
   *  core timeline's hotel, the strand name otherwise. */
  hotelName: string;
  dimmed?: boolean; // true while a space is active
  dark?: boolean; // false = light mode (the app theme, read by the integrator)
}): JSX.Element {
  const sliceIds = useMemo(() => doors.map((d) => d.sliceId), [doors]);
  // The variable grid: time gaps between slices → bay pitches → door
  // positions (corridor-pitch.ts). All ≤ 1-day gaps reproduce the legacy
  // uniform grid bit for bit, so a dense timeline looks exactly as before.
  const layout = useMemo(() => corridorLayoutFromDoors(doors), [doors]);
  // ONE window materialized: the w-th CHUNK_DOORS-bay slice of the full
  // layout, re-based so its lobby sits at x ∈ [0, LOBBY_LENGTH) like every
  // hotel's (windowLayout in corridor-pitch.ts).
  const wLayout = useMemo(() => windowLayout(layout, windowIndex), [layout, windowIndex]);
  const windowIds = useMemo(
    () => sliceIds.slice(windowIndex * WINDOW_SLICES, (windowIndex + 1) * WINDOW_SLICES),
    [sliceIds, windowIndex],
  );
  const hasOlder = windowIndex + 1 < windowCountForLayout(layout);
  const endX = chunkBounds(0, wLayout).xStart;
  // The page door's plate shows where it leads: the NEXT (older) window's
  // newest slice's HHMM — the first door you'd meet there.
  const pagePlate = useMemo(() => {
    if (!hasOlder) return null;
    const nextNewest = sliceIds[(windowIndex + 1) * WINDOW_SLICES];
    return nextNewest ? (sliceClock(nextNewest)?.time ?? null) : null;
  }, [hasOlder, sliceIds, windowIndex]);
  // The register board's rows: this window's slices and the gaps between
  // them (§10.3 — the corridor's intervals, re-homed to the lobby).
  const register = useMemo(
    () => buildLobbyRegister(doors, windowIndex),
    [doors, windowIndex],
  );
  const doorArchetypes = useMemo(() => {
    const map = new Map<string, ArchetypeId | undefined>();
    for (const door of doors) map.set(door.sliceId, door.archetype);
    return map;
  }, [doors]);

  // Live flags read by the lerp callbacks — synced in effects so toggling
  // them never re-renders the tree.
  const dimRef = useRef(dimmed);
  useEffect(() => {
    dimRef.current = dimmed;
  }, [dimmed]);
  const darkRef = useRef(dark);
  useEffect(() => {
    darkRef.current = dark;
  }, [dark]);

  // Shared themed materials, created once with the theme at mount and
  // disposed with Corridor (R3F only auto-disposes JSX-created materials;
  // these are passed in by reference). One useFrame below eases all eight
  // toward the active theme's targets.
  const [{ materials: mats, grungeMap }] = useState(() => createHotelMaterials(dark));
  useEffect(() => {
    return () => {
      for (const m of Object.values(mats)) m.dispose();
      grungeMap.dispose();
    };
  }, [mats, grungeMap]);
  useFrame((_, rawDt) => {
    const k = 1 - Math.exp(-THEME_LERP_RATE * Math.min(rawDt, DIM_MAX_DT));
    const night = darkRef.current;
    for (const role of HOTEL_ROLES) {
      mats[role].color.lerp(night ? THEME_TARGETS[role].night : THEME_TARGETS[role].day, k);
    }
  });

  // Delayed unmount: the moment a space engages the player the lights ramp
  // down (useDimLerp at the descend rate) and only once that is ~complete
  // (HIDE_DELAY_MS) does the whole hotel — geometry, glow, every light
  // source — leave the scene, so nothing residual can light the space and
  // the cut itself is invisible. Corridor stays mounted throughout, and
  // its chunk-window state lives above this flag, so when the space ends
  // the hotel remounts exactly where the player left it — dark, easing up
  // through the same useDimLerp recovery lerp (no pop on exit).
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!dimmed) {
      setHidden(false);
      return;
    }
    const timer = setTimeout(() => setHidden(true), HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dimmed]);

  // The diorama fill light follows the hotel-wide dimming, and opens up
  // further in day mode.
  const hemisphereRef = useRef<HemisphereLight>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.hemisphere,
    () => hemisphereRef.current?.intensity ?? null,
    (v) => {
      const l = hemisphereRef.current;
      if (l) l.intensity = v;
    },
    darkRef,
  );

  // Fully faded out inside a space: render nothing, but keep this component
  // mounted so the hotel returns intact on exit.
  if (hidden) return <group />;

  return (
    <group>
      {/* The "we are indoors" floor — B.13: the fixtures carry the mood;
          this only keeps the hall from ever reading as outdoor dark.
          Follows the hotel-wide dimming. */}
      <hemisphereLight
        ref={hemisphereRef}
        args={["#cfc4b4", "#3a332b", LIGHT_LEVELS.hemisphere.full]}
      />
      <Lobby
        dimRef={dimRef}
        mats={mats}
        returnDoors={returnDoors}
        register={register}
        hotelName={hotelName}
        windowIndex={windowIndex}
        olderClock={pagePlate}
        accent={accent}
        playerRef={playerRef}
      />
      {/* The ONE materialized window: index 0 of the re-based window
          layout, seeded by the window index so each window's dressing is
          stable and distinct. */}
      <CorridorChunk
        index={0}
        seedIndex={-windowIndex}
        sliceIds={windowIds}
        layout={wLayout}
        doorArchetypes={doorArchetypes}
        plateInk={accent}
        dimRef={dimRef}
        darkRef={darkRef}
        mats={mats}
        playerRef={playerRef}
      />
      <CorridorEnd
        endX={endX}
        pageDoor={hasOlder}
        plate={pagePlate}
        accent={accent}
        dimRef={dimRef}
        mats={mats}
        playerRef={playerRef}
      />
    </group>
  );
}
