import { z } from "zod";

import { parseSliceId } from "@/lib/episodic/turn-parser";
import { normalizeTimeZone, TIME_ROOM_ID } from "./time-room";
import {
  parseRoomProfile,
  validateRoomProfile,
  type RoomProfile,
} from "./room-profile";

/** Current normal-room generator. Legacy hotel snapshots remain readable. */
export const ROOM_SNAPSHOT_GENERATOR_VERSION = 2 as const;
export const LEGACY_ROOM_SNAPSHOT_GENERATOR_VERSION = 1 as const;

/** Bounds the legacy strand-door input on untrusted snapshots. */
export const ROOM_SNAPSHOT_MAX_DOOR_COUNT = 200 as const;
export const ROOM_CORRIDOR_SIDES = ["north", "south"] as const;

const roomProfileSnapshotSchema = z
  .custom<RoomProfile>(validateRoomProfile, "Invalid RoomProfile snapshot")
  .transform(parseRoomProfile);

const sliceIdSchema = z.string().refine((value) => parseSliceId(value) !== null, {
  message: "Invalid slice ID",
});

/** The complete, bounded visual state of the legacy procedural hotel room. */
export const legacyRoomSnapshotSchema = z
  .object({
    sliceId: sliceIdSchema,
    generatorVersion: z.literal(LEGACY_ROOM_SNAPSHOT_GENERATOR_VERSION),
    profile: roomProfileSnapshotSchema,
    roomDoorCount: z.number().int().min(0).max(ROOM_SNAPSHOT_MAX_DOOR_COUNT),
    corridorSide: z.enum(ROOM_CORRIDOR_SIDES),
  })
  .strict();

/**
 * The normal game's fixed-room snapshot. Architecture is identified by
 * roomId; the date-derived atmosphere is reproducible from sliceId, so no
 * decorative weather or lighting claim needs to be trusted from the wire.
 */
export const timeRoomSnapshotSchema = z
  .object({
    sliceId: sliceIdSchema,
    generatorVersion: z.literal(ROOM_SNAPSHOT_GENERATOR_VERSION),
    profile: roomProfileSnapshotSchema,
    roomId: z.literal(TIME_ROOM_ID),
    timezone: z.string().max(64).transform(normalizeTimeZone),
  })
  .strict();

export const roomSnapshotSchema = z.discriminatedUnion("generatorVersion", [
  legacyRoomSnapshotSchema,
  timeRoomSnapshotSchema,
]);

export type LegacyRoomSnapshot = z.infer<typeof legacyRoomSnapshotSchema>;
export type TimeRoomSnapshot = z.infer<typeof timeRoomSnapshotSchema>;
export type RoomSnapshot = LegacyRoomSnapshot | TimeRoomSnapshot;
export type RoomCorridorSide = LegacyRoomSnapshot["corridorSide"];

/** Parse an untrusted snapshot into a fresh, JSON-serializable value. */
export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  return roomSnapshotSchema.parse(value);
}
