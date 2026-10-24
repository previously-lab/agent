import { describe, expect, it, vi } from "vitest";
import {
  currentRoomView,
  type WorldPose,
  type WorldViewDriver,
} from "@/components/shell/world-view";
import { parseCurrentView } from "@/lib/chat/current-view";
import { deriveRoomProfile } from "@/lib/game/room-profile";
import {
  ROOM_SNAPSHOT_GENERATOR_VERSION,
  type RoomSnapshot,
} from "@/lib/game/room-snapshot";

function room(sliceId = "2026-10-24-1200"): RoomSnapshot {
  return {
    sliceId,
    generatorVersion: ROOM_SNAPSHOT_GENERATOR_VERSION,
    profile: deriveRoomProfile({ focus: "Rewrite the ending of my short story." }),
    roomDoorCount: 2,
    corridorSide: "south",
  };
}

function world(
  snapshot: RoomSnapshot | null,
  pose: WorldPose = { settled: "game" },
): WorldViewDriver {
  return {
    getPose: vi.fn(() => pose),
    getRoomSnapshot: vi.fn(() => snapshot),
  };
}

describe("send-time room view", () => {
  it("carries the actual frozen snapshot, including layout inputs, through the wire parser", () => {
    const snapshot = room();
    const view = currentRoomView(world(snapshot), false);
    expect(view).toEqual({ sliceId: snapshot.sliceId, surface: "room", snapshot });
    expect(view?.snapshot).toBe(snapshot);
    expect(parseCurrentView(JSON.parse(JSON.stringify(view)))).toEqual(view);
  });

  it("sends no room from the corridor, even if a navigation cursor still names a record", () => {
    // The driver can remember navigation separately; only a mounted snapshot
    // is evidence of the room. No cursor is accepted by the view contract.
    const driver = { ...world(null), cursor: "2026-10-24-1200" };
    expect(currentRoomView(driver, false)).toBeUndefined();
  });

  it("reads the room at call time instead of retaining the previously visited room", () => {
    let active: RoomSnapshot | null = room();
    const driver: WorldViewDriver = {
      getPose: () => ({ settled: "game" }),
      getRoomSnapshot: () => active,
    };
    expect(currentRoomView(driver, false)?.sliceId).toBe("2026-10-24-1200");
    active = null;
    expect(currentRoomView(driver, false)).toBeUndefined();
    active = room("2026-10-24-1300");
    expect(currentRoomView(driver, false)?.snapshot).toBe(active);
  });

  it("suppresses a just-opened document before the world transition commits", () => {
    const driver = world(room());
    expect(currentRoomView(driver, true)).toBeUndefined();
    expect(driver.getRoomSnapshot).not.toHaveBeenCalled();
  });

  it.each<WorldPose>([
    { settled: "field" },
    { settled: "game", transitioning: true },
    { settled: "field", transitioning: true },
    { settled: "game", suspended: true },
  ])("sends no background room for pose %j", (pose) => {
    const driver = world(room(), pose);
    expect(currentRoomView(driver, false)).toBeUndefined();
    expect(driver.getRoomSnapshot).not.toHaveBeenCalled();
  });

  it("resumes with the same frozen snapshot after reading, without rebuilding it", () => {
    const snapshot = room();
    const pose: WorldPose = { settled: "game" };
    const driver = world(snapshot, pose);
    const before = currentRoomView(driver, false);
    pose.settled = "field";
    pose.suspended = true;
    expect(currentRoomView(driver, true)).toBeUndefined();
    pose.settled = "game";
    pose.suspended = false;
    expect(currentRoomView(driver, false)?.snapshot).toBe(before?.snapshot);
  });

  it("has no view on a route without a registered world", () => {
    expect(currentRoomView(null, false)).toBeUndefined();
  });
});
