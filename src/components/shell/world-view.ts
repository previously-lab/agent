import type { CurrentView } from "@/lib/chat/current-view";
import type { RoomSnapshot } from "@/lib/game/room-snapshot";
import type { WorldKind } from "@/components/timeline-3d/world-contract";

export interface WorldPose {
  settled: WorldKind;
  transitioning?: boolean;
  suspended?: boolean;
}

export interface WorldViewDriver {
  getPose: () => WorldPose;
  getRoomSnapshot: () => RoomSnapshot | null;
}

/** Read the mounted room at send time. A navigation cursor is not a room:
 * it may still name a record after the player has left for the corridor. */
export function currentRoomView(
  driver: WorldViewDriver | null,
  reading: boolean,
): CurrentView | undefined {
  if (!driver || reading) return undefined;
  const pose = driver.getPose();
  if (pose.settled !== "game" || pose.transitioning || pose.suspended) {
    return undefined;
  }
  const snapshot = driver.getRoomSnapshot();
  return snapshot
    ? { sliceId: snapshot.sliceId, surface: "room", snapshot }
    : undefined;
}
