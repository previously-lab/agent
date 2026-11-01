import { describe, expect, it } from "vitest";

import { parseCurrentView } from "@/lib/chat/current-view";
import { deriveRoomProfile } from "@/lib/game/room-profile";
import {
  LEGACY_ROOM_SNAPSHOT_GENERATOR_VERSION,
  parseRoomSnapshot,
  ROOM_SNAPSHOT_GENERATOR_VERSION,
  ROOM_SNAPSHOT_MAX_DOOR_COUNT,
  type LegacyRoomSnapshot,
  type TimeRoomSnapshot,
} from "@/lib/game/room-snapshot";
import { TIME_ROOM_ID } from "@/lib/game/time-room";

const SLICE_ID = "2026-10-24-0930";
const profile = deriveRoomProfile({ focus: "撰写一本关于虚构森林的小说" });

function legacySnapshot(): LegacyRoomSnapshot {
  return {
    sliceId: SLICE_ID,
    generatorVersion: LEGACY_ROOM_SNAPSHOT_GENERATOR_VERSION,
    profile,
    roomDoorCount: 3,
    corridorSide: "north",
  };
}

function timeSnapshot(): TimeRoomSnapshot {
  return {
    sliceId: SLICE_ID,
    generatorVersion: ROOM_SNAPSHOT_GENERATOR_VERSION,
    profile,
    roomId: TIME_ROOM_ID,
    timezone: "Asia/Shanghai",
  };
}

describe("RoomSnapshot wire contract", () => {
  it.each([legacySnapshot, timeSnapshot])("round-trips bounded JSON without source prose", (makeSnapshot) => {
    const snapshot = makeSnapshot();
    const parsed = parseRoomSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(parsed).toEqual(snapshot);
    expect(parsed).not.toBe(snapshot);
    expect(parsed.profile).not.toBe(snapshot.profile);
    expect(JSON.stringify(parsed)).not.toContain("虚构森林");
    expect(JSON.stringify(parsed)).not.toContain("小说");
  });

  it("keeps v1 hotel geometry and v2 fixed-room identity distinct", () => {
    expect(parseRoomSnapshot(legacySnapshot())).toEqual(legacySnapshot());
    expect(parseRoomSnapshot(timeSnapshot())).toEqual(timeSnapshot());
    expect(() => parseRoomSnapshot({ ...timeSnapshot(), generatorVersion: 1 })).toThrow();
    expect(() => parseRoomSnapshot({ ...legacySnapshot(), generatorVersion: 2 })).toThrow();
  });

  it("rejects unknown versions and fields instead of stripping them", () => {
    const candidates: unknown[] = [
      { ...timeSnapshot(), generatorVersion: 999 },
      { ...timeSnapshot(), sourceText: "用户原文" },
      { ...timeSnapshot(), roomDoorCount: 0 },
      { ...timeSnapshot(), roomId: "another-room" },
      { ...timeSnapshot(), profile: { ...profile, focus: "用户原文" } },
      { ...timeSnapshot(), profile: { ...profile, revision: "forged" } },
      { ...timeSnapshot(), profile: { ...profile, activity: "unknown" } },
      { ...legacySnapshot(), corridorSide: "east" },
      { ...timeSnapshot(), sliceId: "not-a-slice" },
    ];

    for (const candidate of candidates) {
      expect(() => parseRoomSnapshot(candidate)).toThrow();
    }
  });

  it("normalizes an unknown v2 timezone to UTC", () => {
    expect(parseRoomSnapshot({ ...timeSnapshot(), timezone: "not/a timezone" })).toMatchObject({ timezone: "UTC" });
    expect(parseRoomSnapshot({ ...timeSnapshot(), timezone: "" })).toMatchObject({ timezone: "UTC" });
  });

  it.each([0, ROOM_SNAPSHOT_MAX_DOOR_COUNT])("accepts the bounded v1 door count %i", (roomDoorCount) => {
    expect(parseRoomSnapshot({ ...legacySnapshot(), roomDoorCount })).toMatchObject({ roomDoorCount });
  });

  it.each([-1, ROOM_SNAPSHOT_MAX_DOOR_COUNT + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"])(
    "rejects an unbounded or non-integer v1 door count: %s",
    (roomDoorCount) => {
      expect(() => parseRoomSnapshot({ ...legacySnapshot(), roomDoorCount })).toThrow();
    },
  );
});

describe("CurrentView snapshot compatibility", () => {
  it("keeps legacy room/card views without a snapshot", () => {
    expect(parseCurrentView({ sliceId: SLICE_ID, surface: "room" })).toEqual({
      sliceId: SLICE_ID,
      surface: "room",
    });
    expect(parseCurrentView({ sliceId: SLICE_ID, surface: "card" })).toEqual({
      sliceId: SLICE_ID,
      surface: "card",
    });
  });

  it.each([legacySnapshot, timeSnapshot])("accepts a snapshot only for the exact viewed room slice", (makeSnapshot) => {
    const snapshot = makeSnapshot();
    expect(parseCurrentView({ sliceId: SLICE_ID, surface: "room", snapshot })).toEqual({
      sliceId: SLICE_ID,
      surface: "room",
      snapshot,
    });

    const mismatches: unknown[] = [
      { sliceId: "2026-10-24-0931", surface: "room", snapshot },
      { sliceId: SLICE_ID, surface: "card", snapshot },
      { sliceId: SLICE_ID, surface: "room", snapshot, sourceText: "用户原文" },
    ];
    for (const candidate of mismatches) {
      expect(() => parseCurrentView(candidate)).toThrow();
    }
  });
});
