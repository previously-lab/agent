/**
 * Lobby tests (v0.11-room-interiors §9.2/§10.3/§10.5) — the pieces the
 * L's short leg owns: the RETURN DOORS' lateral semantics and the EAST
 * arrival door's 西出东进 semantics (one door per wall the trips in came
 * from; each door unwinds the newest trip of ITS side; the east door's
 * arrival/return positions mirror each other), the hotel clamp that makes
 * the leg walkable (south return door, east arrival door, and the
 * register board must be approachable), plus the register board's data
 * (every slice in the window and the gaps between them, off the same
 * timestamps the corridor's pitch consumes).
 */
import { describe, expect, it, vi } from "vitest";

// game-canvas.tsx is a client component: its import chain pulls next-themes,
// which imports next/navigation and cannot resolve under the node test
// environment (same stub as strand-transition.test.ts). The pure functions
// under test never touch it.
vi.mock("@teispace/next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

import {
  clampToHotel,
  eastDoorArrivalPos,
  returnDoorSides,
  splitReturnTrip,
  westEndArrivalPos,
  type HotelRef,
  type NavEntry,
} from "@/components/game/game-canvas";
import { buildLobbyRegister, LOBBY_BLOCKERS } from "@/components/game/corridor";
import {
  CORRIDOR_Z_LIMIT,
  GAP_HALF,
  GAP_Z_LIMIT,
  LOBBY_CLEAR,
} from "@/lib/game/clamps";
import { LOBBY_LENGTH, LOBBY_SOUTH_REACH } from "@/lib/game/hotel";
import {
  EAST_DOOR_PASS_DEPTH,
  LOBBY_ARRIVAL_INSET,
  RETURN_DOOR_SOUTH_X,
  RETURN_DOOR_X,
  WEST_END_ARRIVAL_INSET,
} from "@/lib/game/tuning/hotel";

/* ------------------------------------------------------------------ */
/* Return-door laterals + the east arrival door (§10.5)                */
/* ------------------------------------------------------------------ */

const hotel = (timelineId: string, windowIndex = 0): HotelRef => ({
  timelineId,
  windowIndex,
});
/** A page-door/travel hop: east-west, no room to return into. */
const pageTrip = (id: string): NavEntry => ({
  hotel: hotel(id),
  returnTo: null,
  side: "east",
});
const northTrip = (id: string): NavEntry => ({
  hotel: hotel(id),
  returnTo: { sliceId: "2026-09-15-0746", key: `k:${id}` },
  side: "north",
});
const southTrip = (id: string): NavEntry => ({
  hotel: hotel(id),
  returnTo: { sliceId: "2026-09-15-0746", key: `k:${id}` },
  side: "south",
});

describe("returnDoorSides", () => {
  it("hangs no door on an empty stack (the spawn hotel's lobby)", () => {
    expect(returnDoorSides([])).toEqual({ north: false, south: false, east: false });
  });

  it("hangs ONE door per side however many trips share it", () => {
    expect(returnDoorSides([northTrip("a"), northTrip("b"), northTrip("c")])).toEqual({
      north: true,
      south: false,
      east: false,
    });
    expect(returnDoorSides([pageTrip("a"), pageTrip("b")])).toEqual({
      north: false,
      south: false,
      east: true,
    });
  });

  it("hangs a door per side when the stack mixes laterals and east-west trips", () => {
    expect(returnDoorSides([pageTrip("a"), southTrip("b"), northTrip("c")])).toEqual({
      north: true,
      south: true,
      east: true,
    });
  });
});

describe("splitReturnTrip", () => {
  it("unwinds the NEWEST trip of the door's own side", () => {
    const stack = [northTrip("a"), southTrip("b"), northTrip("c")];
    const trip = splitReturnTrip(stack, "south");
    expect(trip?.entry.hotel.timelineId).toBe("b");
    // The newer north trip ("c") is walked past, not unwound; the stack
    // resumes below the south trip.
    expect(trip?.rest.map((e) => e.hotel.timelineId)).toEqual(["a"]);
  });

  it("unwinds the newest EAST-WEST trip for the arrival door", () => {
    const stack = [pageTrip("a"), southTrip("b"), pageTrip("c")];
    const trip = splitReturnTrip(stack, "east");
    expect(trip?.entry.hotel.timelineId).toBe("c");
    // The south trip ("b") sits BELOW the east trip and stays on the stack;
    // nothing newer than "c" exists to walk past.
    expect(trip?.rest.map((e) => e.hotel.timelineId)).toEqual(["a", "b"]);
  });

  it("walks past newer other-side trips without unwinding them", () => {
    const stack = [pageTrip("a"), southTrip("b")];
    const trip = splitReturnTrip(stack, "east");
    expect(trip?.entry.hotel.timelineId).toBe("a");
    expect(trip?.rest).toHaveLength(0);
  });

  it("pops exactly one entry when the newest trip matches the door's side", () => {
    const stack = [northTrip("a"), southTrip("b")];
    const trip = splitReturnTrip(stack, "south");
    expect(trip?.entry.hotel.timelineId).toBe("b");
    expect(trip?.rest).toHaveLength(1);
  });

  it("returns null when no trip of that side exists (the door is not hung)", () => {
    expect(splitReturnTrip([northTrip("a")], "south")).toBeNull();
    expect(splitReturnTrip([southTrip("a")], "east")).toBeNull();
    expect(splitReturnTrip([], "north")).toBeNull();
  });

  it("does not mutate the input stack", () => {
    const stack = [northTrip("a"), southTrip("b")];
    splitReturnTrip(stack, "south");
    expect(stack).toHaveLength(2);
  });

  it("round-trips a page-door hop: push east, split east, stack empties", () => {
    const stack: NavEntry[] = [];
    const pushed = [...stack, pageTrip("a")];
    expect(returnDoorSides(pushed).east).toBe(true);
    const back = splitReturnTrip(pushed, "east");
    expect(back?.entry.hotel.timelineId).toBe("a");
    expect(back?.rest).toHaveLength(0);
    expect(returnDoorSides(back?.rest ?? [])).toEqual({
      north: false,
      south: false,
      east: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* The hotel clamp — the walkable lobby leg                            */
/* ------------------------------------------------------------------ */

const SOUTH_FLOOR_LIMIT = -(LOBBY_SOUTH_REACH - LOBBY_CLEAR);

describe("clampToHotel", () => {
  it("delegates the corridor band (x ≤ 0) to the corridor clamp", () => {
    const p = { x: -3, z: 10 };
    clampToHotel(p, [], undefined, null, false);
    expect(p.z).toBe(CORRIDOR_Z_LIMIT);
  });

  it("keeps the junction band's north-wall rule (gaps over doorXs)", () => {
    const solid = { x: 5, z: 10 };
    clampToHotel(solid, [RETURN_DOOR_X], undefined, null, false);
    expect(solid.z).toBe(CORRIDOR_Z_LIMIT);
    const inGap = { x: RETURN_DOOR_X, z: 10 };
    clampToHotel(inGap, [RETURN_DOOR_X], undefined, null, false);
    expect(inGap.z).toBe(GAP_Z_LIMIT);
  });

  it("opens the leg down to the south wall (the board is approachable)", () => {
    const p = { x: 5, z: -30 };
    clampToHotel(p, [], undefined, null, false);
    expect(p.z).toBe(SOUTH_FLOOR_LIMIT);
  });

  it("caps the lobby east wall", () => {
    const p = { x: 30, z: 0 };
    clampToHotel(p, [], undefined, null, false);
    expect(p.x).toBe(LOBBY_LENGTH - LOBBY_CLEAR);
  });

  it("relaxes the east wall only inside the arrival door's gap, only when hung", () => {
    // Door hung, inside the gap: the east bound relaxes past the wall
    // plane so ARRIVAL_DOOR_CROSS_DEPTH is reachable.
    const inGap = { x: 30, z: 0 };
    clampToHotel(inGap, [], undefined, null, true);
    expect(inGap.x).toBe(LOBBY_LENGTH + EAST_DOOR_PASS_DEPTH);
    // Door hung, beside the gap: solid wall.
    const beside = { x: 30, z: GAP_HALF + 0.1 };
    clampToHotel(beside, [], undefined, null, true);
    expect(beside.x).toBe(LOBBY_LENGTH - LOBBY_CLEAR);
    // No door (no east-west trip on the stack): solid even inside z = 0.
    const noDoor = { x: 30, z: 0 };
    clampToHotel(noDoor, [], undefined, null, false);
    expect(noDoor.x).toBe(LOBBY_LENGTH - LOBBY_CLEAR);
  });

  it("blocks the west parapet only deep in the leg, not in the junction", () => {
    const deep = { x: 0.2, z: -10 };
    clampToHotel(deep, [], undefined, null, false);
    expect(deep.x).toBeCloseTo(0.5);
    const junction = { x: 0.2, z: -4 };
    clampToHotel(junction, [], undefined, null, false);
    expect(junction.x).toBeCloseTo(0.2);
  });

  it("relaxes the south wall only inside the south return door's gap", () => {
    const inGap = { x: RETURN_DOOR_SOUTH_X, z: -30 };
    clampToHotel(inGap, [], undefined, RETURN_DOOR_SOUTH_X, false);
    expect(inGap.z).toBe(-(LOBBY_SOUTH_REACH + 0.6));
    const beside = { x: RETURN_DOOR_SOUTH_X + GAP_HALF + 0.1, z: -30 };
    clampToHotel(beside, [], undefined, RETURN_DOOR_SOUTH_X, false);
    expect(beside.z).toBe(SOUTH_FLOOR_LIMIT);
  });

  it("pushes the player out of the front desk along the shallowest axis", () => {
    const desk = LOBBY_BLOCKERS[0];
    // Just inside the north face: the shallowest way out is north.
    const p = { x: (desk.x0 + desk.x1) / 2, z: desk.z1 - 0.05 };
    clampToHotel(p, [], undefined, null, false);
    expect(p.z).toBe(desk.z1);
  });
});

/* ------------------------------------------------------------------ */
/* Arrival positions (§10.5 西出东进)                                   */
/* ------------------------------------------------------------------ */

describe("arrival positions", () => {
  it("eastDoorArrivalPos lands just inside the east wall, on the corridor axis", () => {
    const p = eastDoorArrivalPos();
    expect(p.x).toBe(LOBBY_LENGTH - LOBBY_ARRIVAL_INSET);
    expect(p.z).toBe(0);
    // Inside the lobby, facing west toward the corridor (x > 0).
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(LOBBY_LENGTH);
  });

  it("westEndArrivalPos lands just inside the west end's page door", () => {
    const endX = -40;
    const p = westEndArrivalPos(endX);
    expect(p.x).toBe(endX + WEST_END_ARRIVAL_INSET);
    expect(p.z).toBe(0);
    // EAST of the end wall — inside the corridor, never past the trigger.
    expect(p.x).toBeGreaterThan(endX);
  });
});

/* ------------------------------------------------------------------ */
/* The register board's data (§9.2/§10.3)                              */
/* ------------------------------------------------------------------ */

describe("buildLobbyRegister", () => {
  const door = (sliceId: string, start?: string) => ({ sliceId, label: sliceId, start });

  it("lists the window's slices newest-first with their own clocks", () => {
    const doors = Array.from({ length: 10 }, (_, i) =>
      door(`2026-09-${String(20 - i).padStart(2, "0")}-0746`),
    );
    const w0 = buildLobbyRegister(doors, 0);
    expect(w0.entries).toHaveLength(8);
    expect(w0.entries[0]).toEqual({
      sliceId: "2026-09-20-0746",
      date: "09·20",
      time: "0746",
    });
    const w1 = buildLobbyRegister(doors, 1);
    expect(w1.entries).toHaveLength(2);
    expect(w1.entries[0].sliceId).toBe("2026-09-12-0746");
  });

  it("computes whole-day gaps from the ISO starts (the corridor's own rule)", () => {
    const doors = [
      door("2026-09-20-1200", "2026-09-20T12:00:00Z"),
      door("2026-09-17-1200", "2026-09-17T12:00:00Z"),
      door("2026-09-17-1300", "2026-09-17T13:00:00Z"),
    ];
    const { gaps } = buildLobbyRegister(doors, 0);
    expect(gaps).toEqual([3, 0]);
  });

  it("falls back to parsing the slice id when start is absent", () => {
    const doors = [door("2026-09-20-0746"), door("2026-09-15-0746")];
    expect(buildLobbyRegister(doors, 0).gaps).toEqual([5]);
  });

  it("marks an unknown gap null rather than inventing one", () => {
    const doors = [door("2026-09-20-0746"), door("fixture")];
    expect(buildLobbyRegister(doors, 0).gaps).toEqual([null]);
  });
});
