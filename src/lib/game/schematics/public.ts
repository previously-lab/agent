/**
 * The public family — Lane C's blueprints (v0.12b P2b).
 *
 * Lane C owns THIS FILE and nothing else: gallery-module, dining-hall,
 * sunroom and pool-deck join here, each a `RoomSchematic` against the
 * shared vocabulary in ./types. Empty today; appending here never
 * disturbs another lane (the global splice order lives in ./index.ts).
 */
import type { RoomSchematic } from "./types";

/** Lane C's blueprints — the public family. */
export const PUBLIC_SCHEMATICS: readonly RoomSchematic[] = [];
