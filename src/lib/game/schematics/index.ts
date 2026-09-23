/**
 * The whole schematic catalogue: the three lane-owned families, spliced
 * in the FIXED order residential → service → public. room-schematic.ts
 * queries this array; the resolution machinery never lives here.
 */
import type { RoomSchematic } from "./types";
import { RESIDENTIAL_SCHEMATICS } from "./residential";
import { SERVICE_SCHEMATICS } from "./service";
import { PUBLIC_SCHEMATICS } from "./public";

export const SCHEMATICS: readonly RoomSchematic[] = [
  ...RESIDENTIAL_SCHEMATICS,
  ...SERVICE_SCHEMATICS,
  ...PUBLIC_SCHEMATICS,
];

export { RESIDENTIAL_SCHEMATICS, SERVICE_SCHEMATICS, PUBLIC_SCHEMATICS };
