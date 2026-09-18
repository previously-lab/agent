/**
 * Tests for the hotel data cache (src/lib/game/hotel-data.ts) — the module
 * that lets GameShell's derived lane (doors, roomDoors, timelines) survive
 * field ↔ game view switches. These lock down the invalidation contract:
 * a hit is only ever served for the SAME locale and the SAME epoch, an
 * epoch bump (a settled turn) always misses, and a fresh write replaces the
 * slot — so a cache hit can never serve data staler than the view it
 * replaces.
 */
import { describe, it, expect } from "vitest";
import {
  invalidateHotelData,
  hotelDataEpoch,
  readHotelData,
  writeHotelData,
  type HotelData,
} from "@/lib/game/hotel-data";

const DOOR_A = { sliceId: "2026-09-15-1401", label: "Sep 15 · 14:01", start: "2026-09-15T14:01:00.000Z" };

function lane(overrides: Partial<HotelData> = {}): HotelData {
  return {
    doors: [DOOR_A],
    roomDoors: new Map(),
    timelines: new Map(),
    ...overrides,
  };
}

describe("hotel-data cache", () => {
  it("misses before anything is written", () => {
    expect(readHotelData("en")).toBeNull();
  });

  it("returns what was written for the same locale", () => {
    const data = lane();
    writeHotelData("en", data);
    expect(readHotelData("en")).toBe(data);
  });

  it("misses for a different locale", () => {
    writeHotelData("en", lane());
    expect(readHotelData("zh")).toBeNull();
    // The en slot is still there.
    expect(readHotelData("en")).not.toBeNull();
  });

  it("misses after invalidateHotelData — the settled-turn rule", () => {
    writeHotelData("en", lane());
    invalidateHotelData();
    expect(readHotelData("en")).toBeNull();
    expect(hotelDataEpoch()).toBe(1);
  });

  it("serves a fresh write after the bump (re-derivation sticks)", () => {
    writeHotelData("en", lane());
    invalidateHotelData();
    const fresh = lane({ doors: [] });
    writeHotelData("en", fresh);
    expect(readHotelData("en")).toBe(fresh);
  });

  it("stamps entries with the epoch at write time", () => {
    const before = hotelDataEpoch();
    writeHotelData("en", lane());
    invalidateHotelData();
    // An entry written under the old epoch must not resurface.
    invalidateHotelData();
    const fresh = lane();
    writeHotelData("en", fresh);
    expect(readHotelData("en")).toBe(fresh);
    expect(hotelDataEpoch()).toBe(before + 2);
  });
});
