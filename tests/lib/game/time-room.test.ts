import { describe, expect, it } from "vitest";

import { describeRoom, formatRoomDescription } from "@/lib/game/describe-room";
import { deriveRoomProfile } from "@/lib/game/room-profile";
import {
  TIME_ROOM_ID,
  normalizeTimeZone,
  selectFrozenRoomFrame,
  timeRoomAtmosphere,
  timeRoomGeometrySignature,
  timeRoomNavigation,
  timeRoomRecipe,
} from "@/lib/game/time-room";

const entries = [
  { sliceId: "2026-07-03-1200", label: "newest" },
  { sliceId: "2026-07-02-1200", label: "middle" },
  { sliceId: "2026-07-01-1200", label: "oldest" },
];

describe("fixed time room", () => {
  it("keeps architecture and furniture seeds stable across slices and timezones", () => {
    const signatures = [
      timeRoomGeometrySignature(timeRoomRecipe("2026-01-01-0000", "UTC")),
      timeRoomGeometrySignature(timeRoomRecipe("2026-07-01-0600", "Asia/Shanghai")),
      timeRoomGeometrySignature(timeRoomRecipe("2026-12-31-2359", "America/New_York")),
    ];
    expect(new Set(signatures).size).toBe(1);
    expect(timeRoomRecipe(entries[0].sliceId).sliceId).toBe(TIME_ROOM_ID);
    expect(timeRoomRecipe(entries[0].sliceId).archetype).toBe("library");
    expect(timeRoomRecipe(entries[0].sliceId).fixedModule).toBe("study");
  });

  it("derives a deterministic decorative atmosphere in the explicit user timezone", () => {
    const sliceId = "2026-07-01-0600";
    const utc = timeRoomAtmosphere(sliceId, "UTC");
    const shanghai = timeRoomAtmosphere(sliceId, "Asia/Shanghai");
    const shanghaiAgain = timeRoomAtmosphere(sliceId, "Asia/Shanghai");

    expect(utc.dayNight).toBe("dawn");
    expect(shanghai.dayNight).toBe("day");
    expect(shanghai.season).toBe("summer");
    expect(shanghaiAgain).toEqual(shanghai);
    expect(timeRoomAtmosphere(sliceId, "invalid/timezone")).toEqual(utc);
    expect(normalizeTimeZone("invalid/timezone")).toBe("UTC");
  });

  it("rejects impossible slice dates without reading the current clock", () => {
    expect(timeRoomAtmosphere("2026-02-30-1200", "Asia/Shanghai")).toEqual(
      timeRoomAtmosphere("not-a-slice", "UTC"),
    );
  });
});

describe("time navigation", () => {
  it("defaults to newest and traverses the same chronological list", () => {
    const newest = timeRoomNavigation(entries);
    expect(newest.active?.sliceId).toBe(entries[0].sliceId);
    expect(newest.nextIndex).toBeNull();
    const older = timeRoomNavigation(entries, newest.entries[newest.previousIndex!].sliceId);
    expect(older.active?.label).toBe("middle");
    expect(older.previousIndex).toBe(0);
    expect(older.nextIndex).toBe(2);
    const newestAgain = timeRoomNavigation(entries, older.entries[older.nextIndex!].sliceId);
    expect(newestAgain.active?.sliceId).toBe(entries[0].sliceId);
  });

  it("honors deep links and retains a valid current slice across data refreshes", () => {
    expect(timeRoomNavigation(entries, entries[2].sliceId).active?.label).toBe("oldest");
    expect(timeRoomNavigation(entries, "missing", entries[1].sliceId).active?.label).toBe("middle");
    expect(timeRoomNavigation([], entries[0].sliceId).active).toBeNull();
  });
});

describe("versioned room descriptions", () => {
  it("describes the actual v2 fixed geometry and timezone atmosphere", () => {
    const first = describeRoom("2026-07-01-0600", {
      generatorVersion: 2,
      timezone: "Asia/Shanghai",
      profile: deriveRoomProfile({ focus: "writing a novel" }),
    });
    const second = describeRoom("2026-12-01-0600", {
      generatorVersion: 2,
      timezone: "Asia/Shanghai",
    });
    expect(first.generatorVersion).toBe(2);
    expect(first.roomId).toBe(TIME_ROOM_ID);
    expect(first.atmosphere?.dayNight).toBe("day");
    expect(first.layout).toMatchObject({ kind: "modules", modules: [{ id: "study" }] });
    expect(first.width).toBe(6);
    expect(first.extent).toBe(6);
    expect(timeRoomGeometrySignature(first.recipe)).toBe(timeRoomGeometrySignature(second.recipe));
    expect(first.furnishing).toEqual(second.furnishing);
    const pieces = first.furnishing?.flatMap((kit) => kit.pieces) ?? [];
    expect(pieces).toEqual(expect.arrayContaining(["desk", "chair", "bookshelf", "bookpile", "rug"]));
    expect(pieces).not.toContain("column");
    expect(pieces).not.toContain("log");
    expect(formatRoomDescription(first, "en")).toContain("Fixed room outline");
    expect(formatRoomDescription(first, "en")).toContain("not historical weather");
    expect(formatRoomDescription(first, "en")).not.toContain("strand doors");
  });

  it("leaves v1 procedural descriptions on their legacy generator", () => {
    const legacy = describeRoom("2026-07-01-0600", {
      generatorVersion: 1,
      profile: deriveRoomProfile({ focus: "writing a novel" }),
    });
    expect(legacy.generatorVersion).toBe(1);
    expect(legacy.atmosphere).toBeNull();
    expect(legacy.roomId).toBe("2026-07-01-0600");
    expect(legacy.profile.activity).not.toBe("neutral");
  });
});

describe("frozen committed room frame", () => {
  it("retains snapshot, atmosphere, selection and papers until resume", () => {
    const committedFrame = {
      snapshot: { sliceId: "2026-07-01-0600", timezone: "Asia/Shanghai" },
      atmosphere: "summer/day/clear",
      selection: 2,
      papers: [{ ref: "records/2026-07-01-0600" }],
    };
    const liveFrame = {
      snapshot: { sliceId: "2026-07-02-0600", timezone: "UTC" },
      atmosphere: "summer/dawn/rain",
      selection: 3,
      papers: [{ ref: "records/2026-07-02-0600" }],
    };
    const committed = { laneKey: "cloud/user", frame: committedFrame };
    expect(selectFrozenRoomFrame(committed, liveFrame, true, "cloud/user")).toBe(committedFrame);
    expect(selectFrozenRoomFrame(committed, liveFrame, false, "cloud/user")).toBe(liveFrame);
  });

  it("never restores a held frame into another source/persona lane", () => {
    const committed = { laneKey: "cloud/user", frame: { sliceId: "old" } };
    const live = { sliceId: "new" };
    expect(selectFrozenRoomFrame(committed, live, true, "local/alice")).toBe(live);
  });
});
