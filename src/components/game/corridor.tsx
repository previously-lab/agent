"use client";

/**
 * Corridor — the hotel diorama: lobby + infinite treadmill corridor.
 *
 * WHAT IT IS. The render half of the hotel. All layout arithmetic lives in
 * `src/lib/game/hotel.ts`; this file only draws what those functions return.
 * The world streams: `useFrame` reads the player's x from `playerRef`,
 * resolves it to a chunk via `chunkIndexForX`, and keeps the visible window
 * (`visibleChunkIndices(playerX, 1)` — current chunk plus one neighbor each
 * way) in React state. Chunks outside the window unmount, and because every
 * mesh here is built from JSX geometry/material, R3F disposes the GPU
 * resources for free. The state update is guarded (same center → same
 * array reference), so unchanged frames cost one `Math.ceil` and zero
 * allocations, no setState, no re-render.
 *
 * THE HALL. The camera looks at the player from (−x, +y, +z), so the north
 * wall (z > 0) is the near wall and the south wall (z < 0) is the far
 * backdrop. Both walls run full height — the corridor reads as one tall
 * hall volume. No ceilings anywhere — open dollhouse.
 *
 * WALLS WITH HOLES. A wall run is not one box: for each door the run is
 * split into solid segments plus a lintel box above the door gap, so the
 * wall face stays continuous and the top edge is one straight line.
 *
 * DOOR GLOW. Each door's glow color comes from
 * `doorGlowColor(compileSpaceRecipe(door.sliceId).palette)` — the room's
 * own tone (ground→sky, lifted), deterministic per slice, so the glimpse
 * through the frame reads as THAT room's light. Glow is emissive material
 * only: a plane behind the recessed slab plus a strip above the lintel
 * and a faint additive halo. No per-door point lights (too many lights).
 *
 * CORRIDOR SCONCES. Every corridor chunk carries CHUNK_DOORS wall sconces
 * on the north (full-height) wall — one per door bay, centered between
 * door centers, so the rhythm is a sconce every 3 m alternating with the
 * doors. A sconce is a dark bracket box plus a warm emissive cone and a
 * fake additive light pool on the floor; the sconce itself is NOT a
 * light. Each chunk also gets exactly one real point light at its center
 * so walking stays continuously lit; with the treadmill window that is at
 * most 3 corridor lights + 2 lobby lamps = 5 point lights in the scene.
 * Sconce glow is a constant warm #ffd9a0 — it is architecture, not memory,
 * so it deliberately does not derive from any slice recipe.
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
 * nothing here extends beyond the wall faces.
 *
 * CORRIDOR DRESSING. The hall is dressed per chunk, all seeded:
 * a carpet runner with dark binding stripes down the floor's spine,
 * framed abstract paintings on ~half the interior wall gaps (2–3 flat
 * color quads each — no textures), 0–2 wall-hugging floor props (potted
 * plants, bins) rejection-sampled clear of doors and art, and glowing
 * date plaques where the calendar day changes between bays. Paintings
 * and props derive from `corridor-chunk-<n>` sub-seeds, so they are
 * architecture: they never reshuffle as slices allocate. The carpet is
 * fixed geometry. The lobby prop layout is likewise seeded but the lobby
 * itself carries no corridor dressing.
 *
 * SLICE SIGNAGE. Every door wears a plate with its slice's HHMM time
 * (`…-0746` → `0746`) just right of the frame, and each date boundary
 * wears a larger glowing plaque (`09·15`) high on both walls — the signs
 * are canvas-textured plaques whose text is parsed from the sliceId
 * itself (see SLICE_ID_RE). Textures are built once per sign and disposed
 * on unmount.
 *
 * WHAT THIS FILE OWNS vs THE INTEGRATOR. This component supplies the
 * diorama fill light (one hemisphere light — without it the corridor is
 * pitch black between lamps). It does NOT set the scene fog; the fog
 * color #1a1d24 is referenced here (end-fade curtains) but the fog itself
 * is the canvas owner's job. The camera is also the canvas owner's job.
 *
 * DETERMINISM. The lobby prop layout and all corridor dressing derive
 * from `deriveSubSeed(WORLD_SEED, …)` streams — same world seed, same
 * hotel, on any machine. No Math.random anywhere (see seed.ts).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, CanvasTexture, Color, DoubleSide, MeshStandardMaterial, SRGBColorSpace } from "three";
import type { JSX, MutableRefObject } from "react";
import type {
  Group,
  HemisphereLight,
  MeshBasicMaterial,
  PointLight,
} from "three";
import {
  CHUNK_DOORS,
  CHUNK_LENGTH,
  CORRIDOR_WIDTH,
  DOOR_SPACING,
  LOBBY_LENGTH,
  WALL_HEIGHT,
  chunkBounds,
  chunkIndexForX,
  doorPosition,
  doorsInChunk,
  type DoorRef,
  type Side,
} from "@/lib/game/hotel";
import { WORLD_SEED, createRng, deriveSubSeed, pick, rangeInt } from "@/lib/game/seed";
import { compileSpaceRecipe, doorGlowColor } from "@/lib/game/space-recipe";
import type { ArchetypeId } from "@/lib/game/space-types";

/** A corridor door as the integrator supplies it. */
export type CorridorDoor = {
  sliceId: string;
  label: string;
  archetype?: ArchetypeId; // v1 fixture override
};

/** Door slab size — tall enough to hold its own on a 4.0 m hall wall. */
const DOOR_WIDTH = 1.4;
const DOOR_HEIGHT = 3.0;
/** The slab swings open when the player comes within this distance of the
 *  door center — a push, never a pull: it always rotates away from them. */
const DOOR_OPEN_DIST = 2.2;
/** ~100° — wide enough to read "open", not so far it clips the wall. */
const DOOR_OPEN_ANGLE = 1.75;
const DOOR_SWING_RATE = 5;

/** Both corridor walls run full height — the hall reads as one tall volume
 *  and door lintels sit flush inside a continuous wall face. (A low cutaway
 *  wall once existed for a camera on the south side; the camera moved to
 *  the north, and the floating lintels it left read as a cracked wall.) */
const SOUTH_WALL_HEIGHT = WALL_HEIGHT;

/** Wall thickness; walls are centered on z = ±CORRIDOR_WIDTH / 2. */
const WALL_THICKNESS = 0.2;

/**
 * Day/night — the corridor INTERIOR follows the app's Tailwind dark mode (the
 * integrator reads it via next-themes and passes `dark` down; the R3F
 * reconciler never sees that React context, so it arrives as a plain
 * prop). The void behind the hotel, though, is always black: the hotel
 * floats in darkness whatever the app theme, and a bright corridor
 * suspended in a black void is the liminal look. Every themed surface
 * color lives in THEME_COLORS; one shared material per role (see
 * HotelMaterials) is lerped between its day and night targets by a single
 * useFrame in Corridor, so a theme toggle eases over ~a second instead of
 * snapping. Exported: the integrator keeps the scene background/fog on
 * VOID_COLORS so the corridor's end-fade planes always match.
 */
export const VOID_COLORS = { night: "#101219", day: "#101219" } as const;

/** Surface palette per theme — warm neutrals, day lifted from the night set. */
const THEME_COLORS = {
  floor: { night: "#6b5d4f", day: "#bfae93" }, // wood; the runner below carries the carpet
  wall: { night: "#8a7f70", day: "#d9d2c5" }, // greige → warm off-white
  trim: { night: "#463f36", day: "#8f867a" }, // baseboards, frames, brackets
  slab: { night: "#7b6d5c", day: "#cbbfa9" }, // door slabs
  desk: { night: "#7a6a58", day: "#c4b49b" },
  cushion: { night: "#9c8b76", day: "#ded4c3" },
  pot: { night: "#5f5648", day: "#a79d8c" },
  foliage: { night: "#7d8a66", day: "#9cae87" },
  carpet: { night: "#54222b", day: "#9c626c" }, // corridor runner — deep wine → dusty rose
  carpetEdge: { night: "#33141b", day: "#6e4249" }, // runner binding stripes
} as const;

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

/** The void targets, likewise preallocated (EndFade lerps between them). */
const VOID_TARGETS = {
  day: new Color(VOID_COLORS.day),
  night: new Color(VOID_COLORS.night),
};

/** Corridor sconce glow — warm constant, architecture rather than memory. */
const SCONCE_COLOR = "#ffd9a0";
const LAMP_COLOR = "#ffb46b";

const CHUNK_RADIUS = 1;
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

function createHotelMaterials(night: boolean): HotelMaterials {
  const make = (role: HotelRole) =>
    new MeshStandardMaterial({
      color: THEME_COLORS[role][night ? "night" : "day"],
      roughness: 1,
      metalness: 0,
    });
  return {
    floor: make("floor"),
    wall: make("wall"),
    trim: make("trim"),
    slab: make("slab"),
    desk: make("desk"),
    cushion: make("cushion"),
    pot: make("pot"),
    carpet: make("carpet"),
    carpetEdge: make("carpetEdge"),
    // Icosahedron foliage keeps its faceted low-poly read.
    foliage: new MeshStandardMaterial({
      color: THEME_COLORS.foliage[night ? "night" : "day"],
      roughness: 1,
      metalness: 0,
      flatShading: true,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Dimming — one LIGHT_LEVELS table + the useDimLerp hook              */
/* ------------------------------------------------------------------ */

/**
 * Full vs dimmed levels for every light and glow material in the scene.
 * Single source of truth: the JSX initial values read `.full` from here
 * and the dimming lerp targets `.dimmed`, so the two can never drift
 * apart. Dimmed emissive/opacity levels are ~30% of full (a ~70% cut);
 * real lights dim to the task-specified levels. Entries with a `day`
 * override use it instead of `full` while the app is in light mode
 * (sconce pools switch off — daylight needs no fake glow — and the
 * hemisphere opens up).
 */
const LIGHT_LEVELS = {
  hemisphere: { full: 0.55, dimmed: 0.04, day: 0.85 },
  chunkLight: { full: 6, dimmed: 0.3 },
  lobbyLamp: { full: 5, dimmed: 0.5 },
  lampShade: { full: 1.4, dimmed: 0.42 },
  sconceShade: { full: 1.2, dimmed: 0.36 },
  sconcePoolOuter: { full: 0.07, dimmed: 0.021, day: 0 },
  sconcePoolInner: { full: 0.15, dimmed: 0.045, day: 0 },
  doorGlow: { full: 1.6, dimmed: 0.48 },
  doorHalo: { full: 0.14, dimmed: 0.042 },
  doorStrip: { full: 2.2, dimmed: 0.66 },
  plaque: { full: 1, dimmed: 0.15 },
} as const;

interface LightLevels {
  readonly full: number;
  readonly dimmed: number;
  readonly day?: number;
}

/**
 * Lerp rates for the dimming hook. Recovery (dimmed → full) keeps the
 * game canvas's atmosphere rate (game-canvas.tsx ATMOSPHERE_LERP_RATE,
 * 2.5/s) so the hotel returns gently; the descent toward dimmed runs
 * faster (6/s) because it ends in an unmount — by HIDE_DELAY_MS it is
 * ~95% dark, so removing the last ghost of geometry does not pop. Same
 * dt clamp as the canvas so a background tab never overshoots.
 */
const DIM_LERP_RATE = 2.5;
const DIM_LERP_RATE_DESCEND = 6;
const DIM_MAX_DT = 0.05;
/**
 * Delay between `dimmed` turning true and the hotel unmounting. Tuned
 * against DIM_LERP_RATE_DESCEND: 0.5 s ≈ three descent time constants.
 * Exported: the game canvas mirrors this delay so the space-side door
 * slab mounts exactly when the corridor's slab unmounts — never both.
 */
export const HIDE_DELAY_MS = 500;

/** Day/night color & level transitions ease at the atmosphere rate. */
const THEME_LERP_RATE = 2.5;

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
function corridorSpan(index: number): { xStart: number; xEnd: number } {
  const { xStart, xEnd } = chunkBounds(index);
  return index === 0 ? { xStart, xEnd: 0 } : { xStart, xEnd };
}

/**
 * X positions of the north-wall sconces for one chunk: one per door bay
 * (CHUNK_DOORS of them), each centered between two door centers — door
 * centers sit half a bay in from the chunk edges, so bays step
 * DOOR_SPACING from xStart + DOOR_SPACING through xEnd inclusive. Every
 * chunk span is exactly CHUNK_DOORS bays, and each boundary sconce is
 * owned by the chunk whose xEnd it is, so adjacent chunks never draw the
 * same sconce and the rhythm continues seamlessly across boundaries.
 * Independent of door materialization: a bay whose slice is not allocated
 * yet still gets its lamp.
 */
function sconcePositions(xStart: number, xEnd: number): number[] {
  const xs: number[] = [];
  for (let x = xStart + DOOR_SPACING; x <= xEnd + 1e-6; x += DOOR_SPACING) {
    xs.push(x);
  }
  return xs;
}

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
  const desk = {
    position: [rangeInt(rng, 95, 108) / 10, 0, rangeInt(rng, -6, 6) / 10] as Vec3,
    rotationY: 0, // counter faces west, toward the lobby entrance
  };
  const chairX = rangeInt(rng, 42, 56) / 10;
  const chairOffset = rangeInt(rng, 12, 18) / 10;
  const chairAngle = pick(rng, [-0.35, -0.2, 0.2, 0.35] as const);
  const armchairs = [
    {
      position: [chairX, 0, chairOffset] as Vec3,
      rotationY: -Math.PI / 2 + chairAngle, // faces the desk (+x-ish)
    },
    {
      position: [chairX + rangeInt(rng, -3, 3) / 10, 0, -chairOffset] as Vec3,
      rotationY: Math.PI / 2 - chairAngle,
    },
  ];
  const plantX = rangeInt(rng, 12, 24) / 10;
  const plantZ = rangeInt(rng, 20, 25) / 10;
  const plantSign = pick(rng, [1, -1] as const);
  const plants = [
    { position: [plantX, 0, plantSign * plantZ] as Vec3, scale: rangeInt(rng, 9, 11) / 10 },
    {
      position: [plantX + rangeInt(rng, 8, 14) / 10, 0, -plantSign * plantZ] as Vec3,
      scale: rangeInt(rng, 8, 10) / 10,
    },
  ];
  const lamps = [
    { position: [rangeInt(rng, 30, 45) / 10, 0, rangeInt(rng, -14, 14) / 10] as Vec3 },
    { position: [rangeInt(rng, 72, 88) / 10, 0, rangeInt(rng, -14, 14) / 10] as Vec3 },
  ];
  return { desk, armchairs, plants, lamps };
}

const LOBBY_LAYOUT = buildLobbyLayout();

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
    <mesh position={[(x0 + x1) / 2, height / 2, z]} material={mats.wall}>
      <boxGeometry args={[length, height, WALL_THICKNESS]} />
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
  return (
    <group>
      {segments.map((s) => (
        <WallBox key={`${s.x0}:${s.x1}`} x0={s.x0} x1={s.x1} height={height} z={z} mats={mats} />
      ))}
      {doors.map((d) => (
        <mesh
          key={`lintel-${d.index}-${d.side}`}
          position={[d.x, (WALL_HEIGHT + DOOR_HEIGHT) / 2, z]}
          material={mats.wall}
        >
          <boxGeometry args={[DOOR_WIDTH, WALL_HEIGHT - DOOR_HEIGHT, WALL_THICKNESS]} />
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
 * slice always hangs its own time on the wall, on any machine. Ids that
 * do not match the format (fixtures, tests) simply get no signage.
 */
const SLICE_ID_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{4})$/;

function sliceClock(sliceId: string): { date: string; time: string } | null {
  const m = SLICE_ID_RE.exec(sliceId);
  return m ? { date: `${m[2]}·${m[3]}`, time: m[4] } : null;
}

/** The calendar date of a door bay (north slice first, south fallback). */
function bayDate(sliceIds: readonly string[], i: number): string | null {
  if (i < 0) return null;
  const clock = sliceClock(sliceIds[2 * i] ?? "") ??
    sliceClock(sliceIds[2 * i + 1] ?? "");
  return clock ? clock.date : null;
}

const PLATE_BG = "#17130f";
const PLATE_INK = "#ece2cc";

/**
 * One small dark plaque with light monospace text — shared builder for
 * door plates and date plaques (`glow` bakes a soft halo for the latter).
 * 2:1 canvas at 384×192 so the digits survive the diorama camera's long
 * view down to a readable glyph.
 */
function createPlaqueTexture(text: string, glow: boolean): CanvasTexture {
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
    ctx.fillStyle = PLATE_INK;
    ctx.font = "900 104px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (glow) {
      ctx.shadowColor = PLATE_INK;
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
}: {
  door: DoorRef;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  const texture = useMemo(() => {
    const clock = sliceClock(door.sliceId);
    return clock ? createPlaqueTexture(clock.time, false) : null;
  }, [door.sliceId]);
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
  const faceZ = door.z + inward * (WALL_THICKNESS / 2);
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
}: {
  door: DoorRef;
  archetype?: ArchetypeId;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}) {
  // The doorway light is the room's own tone (ground→sky, lifted), not a
  // decorative accent — the glimpse through the frame must read as THAT
  // room's light before the room itself ever renders.
  const glowColor = useMemo(() => {
    const recipe = compileSpaceRecipe(door.sliceId);
    return doorGlowColor(
      (archetype === undefined ? recipe : { ...recipe, archetype }).palette,
    );
  }, [door.sliceId, archetype]);

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
      >
        <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
      </mesh>
      <mesh
        position={[door.x + DOOR_WIDTH / 2 + 0.05, DOOR_HEIGHT / 2 + 0.05, frameZ]}
        material={mats.trim}
      >
        <boxGeometry args={[0.1, DOOR_HEIGHT + 0.1, 0.24]} />
      </mesh>
      <mesh position={[door.x, DOOR_HEIGHT + 0.11, frameZ]} material={mats.trim}>
        <boxGeometry args={[DOOR_WIDTH + 0.2, 0.12, 0.24]} />
      </mesh>
      {/* Hinged slab — a real door, opaque, swinging on its left jamb. */}
      <group ref={hingeRef} position={[door.x - DOOR_WIDTH / 2 + 0.02, 0, door.z]}>
        <mesh position={[DOOR_WIDTH / 2 - 0.02, DOOR_HEIGHT / 2, 0]} material={mats.slab}>
          <boxGeometry args={[DOOR_WIDTH - 0.04, DOOR_HEIGHT - 0.04, 0.05]} />
        </mesh>
        {/* Handle: a small dark knob on the corridor face, free-end side. */}
        <mesh position={[DOOR_WIDTH - 0.22, DOOR_HEIGHT / 2, inward * 0.05]} material={mats.trim}>
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
      <DoorPlate door={door} dimRef={dimRef} mats={mats} />
    </group>
  );
}

/**
 * One wall sconce on the north wall: a dark bracket box, a warm emissive
 * cone shade at ~2.55 m (below the 4.0 m wall top, above the paintings),
 * and a fake light pool on the floor below, faked by two concentric
 * additive circles so the falloff reads soft without any texture.
 */
function WallSconce({
  x,
  dimRef,
  darkRef,
  mats,
}: {
  x: number;
  dimRef: MutableRefObject<boolean>;
  darkRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  const faceZ = WALL_Z - WALL_THICKNESS / 2; // inner face of the north wall

  // Shade emissive + pool opacities follow the hotel-wide dimming; the
  // pools additionally switch off in day mode (daylight needs no fake glow).
  const shadeMatRef = useRef<MeshStandardMaterial>(null);
  const poolOuterMatRef = useRef<MeshBasicMaterial>(null);
  const poolInnerMatRef = useRef<MeshBasicMaterial>(null);
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
    LIGHT_LEVELS.sconcePoolOuter,
    () => poolOuterMatRef.current?.opacity ?? null,
    (v) => {
      const m = poolOuterMatRef.current;
      if (m) m.opacity = v;
    },
    darkRef,
  );
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.sconcePoolInner,
    () => poolInnerMatRef.current?.opacity ?? null,
    (v) => {
      const m = poolInnerMatRef.current;
      if (m) m.opacity = v;
    },
    darkRef,
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
      {/* Fake light pool on the floor below (double circle = soft falloff). */}
      <mesh position={[x, 0.012, 2.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.5, 24]} />
        <meshBasicMaterial
          ref={poolOuterMatRef}
          color={SCONCE_COLOR}
          transparent
          opacity={LIGHT_LEVELS.sconcePoolOuter.full}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[x, 0.016, 2.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.8, 20]} />
        <meshBasicMaterial
          ref={poolInnerMatRef}
          color={SCONCE_COLOR}
          transparent
          opacity={LIGHT_LEVELS.sconcePoolInner.full}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Seeded corridor dressing — art, plants, bins, date plaques          */
/* ------------------------------------------------------------------ */

/**
 * Muted abstract-art palette for the corridor paintings. A fixed pool —
 * the art hangs in either theme; the lighting moves around it.
 */
const ART_PALETTE = [
  "#8a4a3a",
  "#c8b48a",
  "#5a6b7a",
  "#7a8a5a",
  "#a3748a",
  "#4a4a58",
  "#b0643f",
  "#6d7f8c",
] as const;

const PAINTING_W = 1.0;
const PAINTING_H = 1.3;

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
function paintingLayout(index: number, gapXs: readonly number[]): PaintingSpec[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, `corridor-chunk-${index}`, "style"));
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
        (WALL_Z - WALL_THICKNESS / 2 - 0.03) * (spec.side === "north" ? 1 : -1),
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
 * positions come from hotel.ts, not the materialized doors).
 */
function propLayout(
  index: number,
  xStart: number,
  length: number,
  gapXs: readonly number[],
): PropSpec[] {
  const rng = createRng(deriveSubSeed(WORLD_SEED, `corridor-chunk-${index}`, "layout"));
  const count = rangeInt(rng, 0, 2);
  const doorXs = Array.from({ length: CHUNK_DOORS }, (_, k) =>
    doorPosition(k - index * CHUNK_DOORS, "north").x,
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
      position={[x, 3.2, (WALL_Z - WALL_THICKNESS / 2 - 0.03) * (side === "north" ? 1 : -1)]}
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

/** One treadmill chunk: floor slab, carpet runner, both wall runs,
 *  baseboards, doors, sconces, seeded dressing (paintings, props, date
 *  plaques), and its single real point light. */
function CorridorChunk({
  index,
  sliceIds,
  doorArchetypes,
  dimRef,
  darkRef,
  mats,
  playerRef,
}: {
  index: number;
  sliceIds: readonly string[];
  doorArchetypes: ReadonlyMap<string, ArchetypeId | undefined>;
  dimRef: MutableRefObject<boolean>;
  darkRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}) {
  const { xStart, xEnd } = corridorSpan(index);
  const length = xEnd - xStart;
  const centerX = (xStart + xEnd) / 2;
  const doors = useMemo(() => doorsInChunk(index, sliceIds), [index, sliceIds]);
  const northDoors = doors.filter((d) => d.side === "north");
  const southDoors = doors.filter((d) => d.side === "south");
  const sconces = useMemo(() => sconcePositions(xStart, xEnd), [xStart, xEnd]);
  // Interior wall gaps (bay midpoints minus the far seam) — where paintings
  // hang and where the date plaques check for a calendar-day change. The
  // sconce helper already owns this arithmetic; reuse it rather than
  // re-deriving bay positions here.
  const gapXs = useMemo(() => sconces.slice(0, CHUNK_DOORS - 1), [sconces]);
  const paintings = useMemo(() => paintingLayout(index, gapXs), [index, gapXs]);
  const props = useMemo(
    () => propLayout(index, xStart, length, gapXs),
    [index, xStart, length, gapXs],
  );
  // Sconce j sits at the boundary BEFORE bay (base + CHUNK_DOORS − 1 − j);
  // a date plaque goes up wherever the calendar day changes across it.
  const datePlaques = useMemo(() => {
    const base = -index * CHUNK_DOORS;
    const plaques: { x: number; label: string }[] = [];
    sconces.forEach((x, j) => {
      const i = base + CHUNK_DOORS - 1 - j;
      const prev = bayDate(sliceIds, i - 1);
      const cur = bayDate(sliceIds, i);
      if (prev && cur && prev !== cur) plaques.push({ x, label: cur });
    });
    return plaques;
  }, [index, sliceIds, sconces]);

  // The chunk's real light follows the hotel-wide dimming.
  const lightRef = useRef<PointLight>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.chunkLight,
    () => lightRef.current?.intensity ?? null,
    (v) => {
      const l = lightRef.current;
      if (l) l.intensity = v;
    },
  );

  return (
    <group>
      {/* Floor slab, top surface at y = 0. */}
      <mesh
        position={[centerX, -FLOOR_THICKNESS / 2, 0]}
        material={mats.floor}
      >
        <boxGeometry args={[length, FLOOR_THICKNESS, CORRIDOR_WIDTH]} />
      </mesh>
      {/* Carpet runner down the corridor's spine — one stretch per chunk,
          bound by two dark stripes, hovering a hair over the floor. */}
      <mesh position={[centerX, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mats.carpet}>
        <planeGeometry args={[length, 2.2]} />
      </mesh>
      <mesh position={[centerX, 0.009, 1.03]} rotation={[-Math.PI / 2, 0, 0]} material={mats.carpetEdge}>
        <planeGeometry args={[length, 0.14]} />
      </mesh>
      <mesh position={[centerX, 0.009, -1.03]} rotation={[-Math.PI / 2, 0, 0]} material={mats.carpetEdge}>
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
        position={[centerX, 0.06, WALL_Z - WALL_THICKNESS / 2 - 0.02]}
        material={mats.trim}
      >
        <boxGeometry args={[length, 0.12, 0.04]} />
      </mesh>
      <mesh
        position={[centerX, 0.06, -WALL_Z + WALL_THICKNESS / 2 + 0.02]}
        material={mats.trim}
      >
        <boxGeometry args={[length, 0.12, 0.04]} />
      </mesh>
      {doors.map((door) => (
        <DoorAssembly
          key={`${door.index}-${door.side}`}
          door={door}
          archetype={doorArchetypes.get(door.sliceId)}
          dimRef={dimRef}
          mats={mats}
          playerRef={playerRef}
        />
      ))}
      {/* North-wall sconces + the chunk's one real light. */}
      {sconces.map((x) => (
        <WallSconce key={x} x={x} dimRef={dimRef} darkRef={darkRef} mats={mats} />
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
      <pointLight
        ref={lightRef}
        position={[centerX, 3.0, 0]}
        color={SCONCE_COLOR}
        intensity={LIGHT_LEVELS.chunkLight.full}
        distance={16}
        decay={2}
      />
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
      <mesh position={[0, 0.525, 0]} material={mats.desk}>
        <boxGeometry args={[2.0, 1.05, 0.7]} />
      </mesh>
      <mesh position={[0, 1.1, 0]} material={mats.trim}>
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
      <mesh position={[0, 0.24, 0]} material={mats.desk}>
        <boxGeometry args={[0.72, 0.32, 0.72]} />
      </mesh>
      <mesh position={[0.03, 0.46, 0]} material={mats.cushion}>
        <boxGeometry args={[0.64, 0.14, 0.62]} />
      </mesh>
      <mesh position={[-0.29, 0.68, 0]} material={mats.desk}>
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
      <mesh position={[0, 0.18, 0]} material={mats.pot}>
        <cylinderGeometry args={[0.24, 0.19, 0.36, 10]} />
      </mesh>
      <mesh position={[0, 0.82, 0]} material={mats.foliage}>
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
      <mesh position={[0, 0.28, 0]} material={mats.trim}>
        <cylinderGeometry args={[0.2, 0.16, 0.56, 10]} />
      </mesh>
      <mesh position={[0, 0.59, 0]} material={mats.trim}>
        <cylinderGeometry args={[0.23, 0.2, 0.07, 10]} />
      </mesh>
    </group>
  );
}

/** One of the two real point lights in the scene (plus the hemisphere). */
function FloorLamp({
  position,
  dimRef,
  mats,
}: {
  position: Vec3;
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  // The lamp's real light and its glowing shade follow the dimming.
  const lightRef = useRef<PointLight>(null);
  const shadeMatRef = useRef<MeshStandardMaterial>(null);
  useDimLerp(
    dimRef,
    LIGHT_LEVELS.lobbyLamp,
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
      <mesh position={[0, 0.02, 0]} material={mats.trim}>
        <cylinderGeometry args={[0.16, 0.18, 0.04, 10]} />
      </mesh>
      <mesh position={[0, 0.78, 0]} material={mats.trim}>
        <cylinderGeometry args={[0.03, 0.03, 1.52, 8]} />
      </mesh>
      {/* Shade glows — reads as the bulb. */}
      <mesh position={[0, 1.58, 0]}>
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
        intensity={LIGHT_LEVELS.lobbyLamp.full}
        distance={13}
        decay={2}
      />
    </group>
  );
}

/** The lobby: floor, three walls (west end open into the corridor), props. */
function Lobby({
  dimRef,
  mats,
}: {
  dimRef: MutableRefObject<boolean>;
  mats: HotelMaterials;
}) {
  const { desk, armchairs, plants, lamps } = LOBBY_LAYOUT;
  const centerX = LOBBY_LENGTH / 2;
  return (
    <group>
      <mesh position={[centerX, -FLOOR_THICKNESS / 2, 0]} material={mats.floor}>
        <boxGeometry args={[LOBBY_LENGTH, FLOOR_THICKNESS, CORRIDOR_WIDTH]} />
      </mesh>
      {/* North wall, full height; south wall, cutaway height; east end, full. */}
      <mesh position={[centerX, WALL_HEIGHT / 2, WALL_Z]} material={mats.wall}>
        <boxGeometry args={[LOBBY_LENGTH, WALL_HEIGHT, WALL_THICKNESS]} />
      </mesh>
      <mesh position={[centerX, SOUTH_WALL_HEIGHT / 2, -WALL_Z]} material={mats.wall}>
        <boxGeometry args={[LOBBY_LENGTH, SOUTH_WALL_HEIGHT, WALL_THICKNESS]} />
      </mesh>
      <mesh position={[LOBBY_LENGTH, WALL_HEIGHT / 2, 0]} material={mats.wall}>
        <boxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, CORRIDOR_WIDTH + WALL_THICKNESS]} />
      </mesh>
      {/* Baseboards. */}
      <mesh
        position={[centerX, 0.06, WALL_Z - WALL_THICKNESS / 2 - 0.02]}
        material={mats.trim}
      >
        <boxGeometry args={[LOBBY_LENGTH, 0.12, 0.04]} />
      </mesh>
      <mesh
        position={[centerX, 0.06, -WALL_Z + WALL_THICKNESS / 2 + 0.02]}
        material={mats.trim}
      >
        <boxGeometry args={[LOBBY_LENGTH, 0.12, 0.04]} />
      </mesh>
      <FrontDesk position={desk.position} rotationY={desk.rotationY} mats={mats} />
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
 * Fog-colored fade at one open end of the treadmill — hides the pop when a
 * chunk unmounts. A solid "white board" version of this plane used to stand
 * across the corridor (very visible in day mode) and, worse, read as a hard
 * veil slicing walls and doors whenever the window scrolled. Now the curtain
 * DISSOLVES into the void: a CanvasTexture alpha gradient, fully opaque
 * above the wall line — where the world ends and the void begins, and the
 * color is identical to the scene background — easing to nearly transparent
 * at floor level, where the rendered floor and the far doorway stay
 * untouched. The base color is the void color for the active theme (the
 * canvas owner keeps the scene background/fog on the same value) and eases
 * between day and night with everything else; fog is disabled on the
 * material so the curtain stays exactly that color. The texture is shared
 * white — the material color tints it — and is disposed on unmount.
 */
const FADE_WIDTH = CHUNK_LENGTH;
const FADE_HEIGHT = WALL_HEIGHT * 3;
/** Alpha never quite reaches 0 — a whisper of haze keeps the raw floor cut
 *  at the world edge soft even where the gradient bottoms out. */
const FADE_ALPHA_FLOOR = 0.1;
const FADE_RAMP_Y0 = 0.2; // meters — gradient starts just above the floor
const FADE_RAMP_Y1 = WALL_HEIGHT; // opaque from the wall top up

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Vertical alpha ramp for the end curtain, painted once into a canvas:
 * row 0 (canvas top, plane top) opaque, easing to near-transparent at the
 * floor line and below. World y maps linearly from −(FADE_HEIGHT −
 * WALL_HEIGHT)/2 at the bottom row to that plus FADE_HEIGHT at the top.
 */
function createEndFadeTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new CanvasTexture(canvas);
  const bottomY = WALL_HEIGHT / 2 - FADE_HEIGHT / 2;
  for (let row = 0; row < canvas.height; row++) {
    const v = 1 - row / (canvas.height - 1); // 1 at canvas top
    const y = bottomY + v * FADE_HEIGHT;
    const a =
      FADE_ALPHA_FLOOR +
      (1 - FADE_ALPHA_FLOOR) * smoothstep((y - FADE_RAMP_Y0) / (FADE_RAMP_Y1 - FADE_RAMP_Y0));
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.fillRect(0, row, canvas.width, 1);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function EndFade({ x, darkRef }: { x: number; darkRef: MutableRefObject<boolean> }) {
  const texture = useMemo(() => createEndFadeTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);
  const matRef = useRef<MeshBasicMaterial>(null);
  useFrame((_, rawDt) => {
    const m = matRef.current;
    if (!m) return;
    const k = 1 - Math.exp(-THEME_LERP_RATE * Math.min(rawDt, DIM_MAX_DT));
    m.color.lerp(darkRef.current ? VOID_TARGETS.night : VOID_TARGETS.day, k);
  });
  return (
    <mesh position={[x, WALL_HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
      <planeGeometry args={[FADE_WIDTH, FADE_HEIGHT]} />
      <meshBasicMaterial
        ref={matRef}
        color={VOID_COLORS.night}
        map={texture}
        transparent
        side={DoubleSide}
        depthWrite={false}
        fog={false}
      />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */
/* Corridor                                                            */
/* ------------------------------------------------------------------ */

export function Corridor({
  playerRef,
  doors,
  dimmed = false,
  dark = true,
}: {
  playerRef: MutableRefObject<{ x: number; z: number }>;
  doors: readonly CorridorDoor[];
  dimmed?: boolean; // true while a space is active
  dark?: boolean; // false = light mode (the app theme, read by the integrator)
}): JSX.Element {
  const sliceIds = useMemo(() => doors.map((d) => d.sliceId), [doors]);
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
  const [mats] = useState(() => createHotelMaterials(dark));
  useEffect(() => {
    return () => {
      for (const m of Object.values(mats)) m.dispose();
    };
  }, [mats]);
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

  // Visible window, future-ward first — same order as
  // visibleChunkIndices(playerX, CHUNK_RADIUS). Seeded from the player's
  // initial position; after that only useFrame updates it.
  const [chunkIndices, setChunkIndices] = useState<number[]>(() => {
    const center = chunkIndexForX(playerRef.current.x);
    const indices: number[] = [];
    for (let i = center + CHUNK_RADIUS; i >= center - CHUNK_RADIUS; i--) {
      indices.push(i);
    }
    return indices;
  });

  useFrame(() => {
    const center = chunkIndexForX(playerRef.current.x);
    // Guarded update: same center → same array reference → React bails out
    // with no re-render and zero allocations on the (common) steady frames.
    setChunkIndices((prev) =>
      prev[CHUNK_RADIUS] === center
        ? prev
        : Array.from({ length: CHUNK_RADIUS * 2 + 1 }, (_, i) => center + CHUNK_RADIUS - i),
    );
  });

  const futureEdge = chunkBounds(chunkIndices[0]).xEnd + 0.4;
  const pastEdge = chunkBounds(chunkIndices[chunkIndices.length - 1]).xStart - 0.4;

  // Fully faded out inside a space: render nothing, but keep this component
  // (and its chunk window) mounted so the hotel returns intact on exit.
  if (hidden) return <group />;

  return (
    <group>
      {/* Diorama fill light — without it the corridor is black between
          lamps. Follows the hotel-wide dimming. */}
      <hemisphereLight
        ref={hemisphereRef}
        args={["#cfc4b4", "#3a332b", LIGHT_LEVELS.hemisphere.full]}
      />
      <Lobby dimRef={dimRef} mats={mats} />
      {chunkIndices.map((index) => (
        <CorridorChunk
          key={index}
          index={index}
          sliceIds={sliceIds}
          doorArchetypes={doorArchetypes}
          dimRef={dimRef}
          darkRef={darkRef}
          mats={mats}
          playerRef={playerRef}
        />
      ))}
      <EndFade key={`future-${futureEdge}`} x={futureEdge} darkRef={darkRef} />
      <EndFade key={`past-${pastEdge}`} x={pastEdge} darkRef={darkRef} />
    </group>
  );
}
