/**
 * Tests for the corridor pitch — the pure conversion of time gaps into door
 * spacing (v0.11-strand-field §1: the timeline is its intervals). The
 * acceptance bar is the backward-compatibility proof: when every gap is one
 * day or less, the computed door positions must be byte-identical to the
 * legacy uniform grid x = -(i + 0.5) * 6.
 */
import { describe, it, expect } from "vitest";
import {
  DOOR_PITCH_BASE,
  DOOR_PITCH_GAIN,
  DOOR_PITCH_MAX,
  DOOR_PITCH_MIN,
} from "@/lib/game/tuning/hotel";
import { DOOR_SPACING } from "@/lib/game/hotel";
import {
  bayBoundaryX,
  bayCenterX,
  bayGeometry,
  buildCorridorLayout,
  corridorLayoutFromDoors,
  cumulativePitchBefore,
  doorPitchMeters,
  layoutPitchAt,
} from "@/lib/game/corridor-pitch";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Arbitrary fixed anchor — no wall clock anywhere in this suite. */
const T0 = Date.UTC(2026, 8, 15, 12, 0);

describe("pitch constants", () => {
  it("pins the spec values", () => {
    expect(DOOR_PITCH_BASE).toBe(6);
    expect(DOOR_PITCH_GAIN).toBe(12);
    expect(DOOR_PITCH_MIN).toBe(5);
    expect(DOOR_PITCH_MAX).toBe(24);
  });

  it("keeps the legacy grid constant equal to the pitch base", () => {
    // hotel.ts extends unallocated bays at DOOR_SPACING, corridor-pitch at
    // DOOR_PITCH_BASE — the two paths must never drift apart.
    expect(DOOR_SPACING).toBe(DOOR_PITCH_BASE);
  });
});

describe("doorPitchMeters", () => {
  it("maps gaps of one day or less to the legacy 6 m spacing", () => {
    expect(doorPitchMeters(0)).toBe(6);
    expect(doorPitchMeters(0.5)).toBe(6);
    expect(doorPitchMeters(1)).toBe(6);
  });

  it("adds GAIN meters per decade of days", () => {
    expect(doorPitchMeters(10)).toBe(18); // 6 + 12 * log10(10)
    expect(doorPitchMeters(100)).toBe(DOOR_PITCH_MAX); // 30, clamped
    expect(doorPitchMeters(2)).toBeCloseTo(6 + 12 * Math.log10(2), 10);
  });

  it("clamps at MAX around a month and a half of silence", () => {
    expect(doorPitchMeters(31)).toBeLessThan(DOOR_PITCH_MAX);
    expect(doorPitchMeters(32)).toBe(DOOR_PITCH_MAX);
    expect(doorPitchMeters(3650)).toBe(DOOR_PITCH_MAX);
  });

  it("never goes below MIN, and floors non-positive gaps at BASE", () => {
    expect(doorPitchMeters(-7)).toBe(6); // misordered input reads as dense
    for (const g of [-100, 0, 1, 5, 10, 100, 1e6]) {
      expect(doorPitchMeters(g)).toBeGreaterThanOrEqual(DOOR_PITCH_MIN);
      expect(doorPitchMeters(g)).toBeLessThanOrEqual(DOOR_PITCH_MAX);
    }
  });
});

describe("buildCorridorLayout", () => {
  it("is byte-identical to the legacy grid when every gap is under a day", () => {
    // 64 slices 12 hours apart, newest first → 32 bays, every gap 0 days.
    const starts = Array.from({ length: 64 }, (_, k) => T0 - k * 12 * HOUR_MS);
    const layout = buildCorridorLayout(starts);
    expect(layout.pitches).toHaveLength(32);
    expect(layout.doorXs).toHaveLength(32);
    expect(layout.cumulative).toHaveLength(33);
    for (let i = 0; i < 32; i++) {
      expect(layout.pitches[i]).toBe(DOOR_PITCH_BASE);
      expect(layout.cumulative[i]).toBe(6 * i);
      // THE regression: exactly -(i + 0.5) * 6, no epsilon.
      expect(layout.doorXs[i]).toBe(-(i + 0.5) * 6);
    }
    expect(layout.cumulative[32]).toBe(32 * 6);
  });

  it("is byte-identical to the legacy grid when gaps are exactly one day", () => {
    // 36-hour spacing → trunc(1.5) = 1 day gaps → still BASE pitch.
    const starts = Array.from({ length: 16 }, (_, k) => T0 - k * 36 * HOUR_MS);
    const layout = buildCorridorLayout(starts);
    for (let i = 0; i < 8; i++) {
      expect(layout.doorXs[i]).toBe(-(i + 0.5) * 6);
    }
  });

  it("widens the bay whose slice is followed by silence", () => {
    // Four slices, newest first: bay 0 = (s0, s1), bay 1 = (s2, s3).
    // The between-bays gap (s1 → s2) is 10 days → bay 0's pitch is 18;
    // bay 1 has no older neighbor → BASE.
    const starts = [T0, T0 - HOUR_MS, T0 - HOUR_MS - 10 * DAY_MS, T0 - 2 * HOUR_MS - 10 * DAY_MS];
    const layout = buildCorridorLayout(starts);
    expect(layout.pitches).toEqual([18, 6]);
    expect(layout.cumulative).toEqual([0, 18, 24]);
    expect(layout.doorXs).toEqual([-9, -21]);
  });

  it("centers every door in its own bay", () => {
    const starts = [T0, T0 - HOUR_MS, T0 - HOUR_MS - 10 * DAY_MS, T0 - 2 * HOUR_MS - 10 * DAY_MS];
    const layout = buildCorridorLayout(starts);
    for (let i = 0; i < layout.pitches.length; i++) {
      const { xStart, xEnd, length, doorX } = bayGeometry(layout, i);
      expect(doorX).toBe((xStart + xEnd) / 2);
      expect(length).toBe(layout.pitches[i]);
      expect(doorX).toBe(layout.doorXs[i]);
      expect(xEnd).toBe(bayBoundaryX(layout, i));
      expect(xStart).toBe(bayBoundaryX(layout, i + 1));
    }
  });

  it("falls back to BASE when a gap endpoint is missing or null", () => {
    const layout = buildCorridorLayout([T0, null, T0 - 40 * DAY_MS, T0 - 41 * DAY_MS]);
    expect(layout.pitches).toEqual([DOOR_PITCH_BASE, DOOR_PITCH_BASE]);
  });

  it("builds an empty layout from no slices", () => {
    const layout = buildCorridorLayout([]);
    expect(layout.pitches).toEqual([]);
    expect(layout.cumulative).toEqual([0]);
    expect(layout.doorXs).toEqual([]);
  });

  it("exposes the cumulative sums a future ring needs to close the corridor", () => {
    const starts = [T0, T0 - HOUR_MS, T0 - HOUR_MS - 10 * DAY_MS, T0 - 2 * HOUR_MS - 10 * DAY_MS];
    const layout = buildCorridorLayout(starts);
    const total = layout.cumulative[layout.cumulative.length - 1];
    expect(total).toBe(layout.pitches.reduce((a, b) => a + b, 0));
  });
});

describe("accessors extend unallocated bays at base pitch", () => {
  // Two allocated bays (18 + 24 m); everything deeper is uniform 6 m.
  const layout = {
    pitches: [18, 24],
    cumulative: [0, 18, 42],
    doorXs: [-9, -30],
  };

  it("reads allocated bays straight from the layout", () => {
    expect(layoutPitchAt(layout, 0)).toBe(18);
    expect(cumulativePitchBefore(layout, 2)).toBe(42);
    expect(bayCenterX(layout, 1)).toBe(-30);
  });

  it("extends past the end seamlessly — the treadmill never runs out", () => {
    expect(layoutPitchAt(layout, 2)).toBe(DOOR_PITCH_BASE);
    expect(cumulativePitchBefore(layout, 4)).toBe(42 + 2 * DOOR_PITCH_BASE);
    expect(bayCenterX(layout, 2)).toBe(-(42 + 3));
    expect(bayBoundaryX(layout, 5)).toBe(-(42 + 3 * DOOR_PITCH_BASE));
  });
});

describe("corridorLayoutFromDoors", () => {
  it("parses ISO starts without touching the slice ids", () => {
    const layout = corridorLayoutFromDoors([
      { sliceId: "anything", start: "2026-09-15T12:00:00.000Z" },
      { sliceId: "anything", start: "2026-09-15T11:00:00.000Z" },
      { sliceId: "anything", start: "2026-09-05T11:00:00.000Z" },
      { sliceId: "anything", start: "2026-09-05T10:00:00.000Z" },
    ]);
    expect(layout.pitches).toEqual([18, 6]);
  });

  it("falls back to the slice id when start is absent or invalid", () => {
    const layout = corridorLayoutFromDoors([
      { sliceId: "2026-09-15-1200" },
      { sliceId: "2026-09-15-1100", start: "not a date" },
      { sliceId: "2026-09-05-1100" },
      { sliceId: "2026-09-05-1000" },
    ]);
    expect(layout.pitches).toEqual([18, 6]);
  });

  it("treats unparseable doors as unknown gaps (BASE), never as crashes", () => {
    const layout = corridorLayoutFromDoors([
      { sliceId: "fixture-a" },
      { sliceId: "fixture-b" },
    ]);
    expect(layout.pitches).toEqual([DOOR_PITCH_BASE]);
    expect(layout.doorXs).toEqual([-3]);
  });
});
