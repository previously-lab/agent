/**
 * The service family — Lane B's blueprints (v0.12b P2b).
 *
 * Lane B owns THIS FILE and nothing else: foyer, kitchen, bath, storage
 * and workshop join here, each a `RoomSchematic` against the shared
 * vocabulary in ./types. Empty today; appending here never disturbs
 * another lane (the global splice order lives in ./index.ts).
 */
import type { RoomSchematic } from "./types";

/** Lane B's blueprints — the service family. */
export const SERVICE_SCHEMATICS: readonly RoomSchematic[] = [];
