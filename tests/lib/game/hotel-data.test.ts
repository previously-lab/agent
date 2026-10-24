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
  captureHotelDataRequest,
  invalidateHotelData,
  hotelDataEpoch,
  readHotelData,
  readHotelDataAtEpoch,
  writeHotelData,
  writeHotelDataAtEpoch,
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

  it("keys the lane by scope as well as locale", () => {
    const scoped = lane();
    writeHotelData("en", scoped, "source-a");
    expect(readHotelData("en", "source-a")).toBe(scoped);
    expect(readHotelData("en", "source-b")).toBeNull();
    expect(readHotelData("en")).toBeNull();
  });

  it("rejects a write captured before invalidation instead of restamping it", () => {
    const request = captureHotelDataRequest("source-a");
    const stale = lane({ doors: [] });
    invalidateHotelData();
    expect(writeHotelDataAtEpoch("en", stale, request)).toBe(false);
    expect(readHotelData("en", "source-a")).toBeNull();
    expect(readHotelDataAtEpoch("en", request)).toBeNull();

    const current = captureHotelDataRequest("source-a");
    const fresh = lane();
    expect(writeHotelDataAtEpoch("en", fresh, current)).toBe(true);
    expect(readHotelDataAtEpoch("en", current)).toBe(fresh);
    expect(readHotelData("en", "source-a")).toBe(fresh);
  });
});
