import { describe, expect, it } from "vitest";

import { parseCurrentView } from "@/lib/chat/current-view";
import { deriveRoomProfile } from "@/lib/game/room-profile";
import {
  parseRoomSnapshot,
  ROOM_SNAPSHOT_GENERATOR_VERSION,
  ROOM_SNAPSHOT_MAX_DOOR_COUNT,
  type RoomSnapshot,
} from "@/lib/game/room-snapshot";

const SLICE_ID = "2026-10-24-0930";

function validSnapshot(): RoomSnapshot {
  return {
    sliceId: SLICE_ID,
    generatorVersion: ROOM_SNAPSHOT_GENERATOR_VERSION,
    profile: deriveRoomProfile({ focus: "撰写一本关于虚构森林的小说" }),
    roomDoorCount: 3,
    corridorSide: "north",
  };
}

describe("RoomSnapshot wire contract", () => {
  it("round-trips bounded JSON data without retaining source prose", () => {
    const snapshot = validSnapshot();
    const parsed = parseRoomSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(parsed).toEqual(snapshot);
    expect(parsed).not.toBe(snapshot);
    expect(parsed.profile).not.toBe(snapshot.profile);
    expect(JSON.stringify(parsed)).not.toContain("虚构森林");
    expect(JSON.stringify(parsed)).not.toContain("小说");
  });

  it("rejects unknown versions and fields instead of stripping them", () => {
    const snapshot = validSnapshot();
    const candidates: unknown[] = [
      { ...snapshot, generatorVersion: 999 },
      { ...snapshot, sourceText: "用户原文" },
      { ...snapshot, profile: { ...snapshot.profile, focus: "用户原文" } },
      { ...snapshot, profile: { ...snapshot.profile, revision: "forged" } },
      { ...snapshot, profile: { ...snapshot.profile, activity: "unknown" } },
      { ...snapshot, corridorSide: "east" },
      { ...snapshot, sliceId: "not-a-slice" },
    ];

    for (const candidate of candidates) {
      expect(() => parseRoomSnapshot(candidate)).toThrow();
    }
  });

  it.each([0, ROOM_SNAPSHOT_MAX_DOOR_COUNT])("accepts the bounded door count %i", (roomDoorCount) => {
    expect(parseRoomSnapshot({ ...validSnapshot(), roomDoorCount }).roomDoorCount).toBe(roomDoorCount);
  });

  it.each([-1, ROOM_SNAPSHOT_MAX_DOOR_COUNT + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"])(
    "rejects an unbounded or non-integer door count: %s",
    (roomDoorCount) => {
      expect(() => parseRoomSnapshot({ ...validSnapshot(), roomDoorCount })).toThrow();
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

  it("accepts a snapshot only for the exact viewed room slice", () => {
    const snapshot = validSnapshot();
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
