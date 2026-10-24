import { z } from "zod";

import { parseSliceId } from "@/lib/episodic/turn-parser";
import {
  parseRoomProfile,
  validateRoomProfile,
  type RoomProfile,
} from "./room-profile";

/** Version of the visual generator contract carried by a frozen room view. */
export const ROOM_SNAPSHOT_GENERATOR_VERSION = 1 as const;

/** Matches the 200-door hotel window and bounds pure layout work on untrusted input. */
export const ROOM_SNAPSHOT_MAX_DOOR_COUNT = 200 as const;

export const ROOM_CORRIDOR_SIDES = ["north", "south"] as const;

const roomProfileSnapshotSchema = z
  .custom<RoomProfile>(validateRoomProfile, "Invalid RoomProfile snapshot")
  .transform(parseRoomProfile);

/**
 * The complete, bounded visual state of the active room. It contains semantic
 * labels only — never the record text those labels were derived from — and is
 * descriptive context, not read/write authorization.
 */
export const roomSnapshotSchema = z
  .object({
    sliceId: z.string().refine((value) => parseSliceId(value) !== null, {
      message: "Invalid slice ID",
    }),
    generatorVersion: z.literal(ROOM_SNAPSHOT_GENERATOR_VERSION),
    profile: roomProfileSnapshotSchema,
    roomDoorCount: z
      .number()
      .int()
      .min(0)
      .max(ROOM_SNAPSHOT_MAX_DOOR_COUNT),
    corridorSide: z.enum(ROOM_CORRIDOR_SIDES),
  })
  .strict();

export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
export type RoomCorridorSide = RoomSnapshot["corridorSide"];

/** Parse an untrusted snapshot into a fresh, JSON-serializable value. */
export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  return roomSnapshotSchema.parse(value);
}
