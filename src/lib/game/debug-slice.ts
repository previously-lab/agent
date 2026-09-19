/**
 * Debug slice ids — the force that lets the gallery corridor walk the STANDARD
 * units one by one (the user's "decorate each standard room, then let the
 * random combinations inherit the polish" pass).
 *
 * THE FORCE RIDES IN THE SLICE ID: `dbg-m:<moduleId>` pins a standard room
 * module, `dbg-t:<templateId>` an authored layout, `dbg-a:<archetypeId>` an
 * archetype. Nothing mutable is involved, so a debug room stays a pure function
 * of its id (A6 — same id, same room), and the normal path can never see one:
 * `parseDebugSlice` answers null for every real memory slice, and the pipeline
 * branches below are all "no id, no change".
 *
 * WHY THIS FILE IS A LEAF. room-modules.ts, room-templates.ts and
 * space-recipe.ts import it, so it may import nothing but space-types — the
 * catalogue of units the gallery shows lives in debug-catalog.ts, which is free
 * to import the pipeline's data in the other direction.
 */
import {
  INTERIOR_ROOMS,
  NATURE_BIOMES,
  WONDER_ROOMS,
  type ArchetypeId,
  type WorldClass,
} from "./space-types";

export type DebugPage = "modules" | "templates" | "archetypes";

/** The pages the gallery can show, in the order the plates are laid out. */
export const DEBUG_PAGES: readonly DebugPage[] = [
  "modules",
  "templates",
  "archetypes",
];

/** `?debug=` value that swaps the corridor for the gallery. */
export const DEBUG_QUERY_VALUE = "rooms";

/** Query parameter that carries the mode (`?debug=rooms`). */
export const DEBUG_PARAM = "debug";

/** Query parameter carrying the page (`?debug=rooms&page=modules`). */
export const DEBUG_PAGE_PARAM = "page";

const PREFIX: Record<DebugPage, string> = {
  modules: "dbg-m:",
  templates: "dbg-t:",
  archetypes: "dbg-a:",
};

/** The synthetic slice id one unit builds from. */
export function debugSliceId(page: DebugPage, id: string): string {
  return `${PREFIX[page]}${id}`;
}

/** The unit a slice id pins, or null for every real memory slice. */
export function parseDebugSlice(
  sliceId: string,
): { page: DebugPage; id: string } | null {
  for (const page of DEBUG_PAGES) {
    const prefix = PREFIX[page];
    if (!sliceId.startsWith(prefix)) continue;
    const id = sliceId.slice(prefix.length);
    if (id) return { page, id };
  }
  return null;
}

export function isDebugSlice(sliceId: string): boolean {
  return parseDebugSlice(sliceId) !== null;
}

/** Every archetype the recipe compiler can draw, in one stable order. */
export const ARCHETYPE_IDS: readonly ArchetypeId[] = [
  ...INTERIOR_ROOMS,
  ...NATURE_BIOMES,
  ...WONDER_ROOMS,
];

/**
 * Which world class an archetype belongs to. Mirrors the compiler's own draw
 * order (nature biomes serve nature AND hybrid); the gallery answers "nature"
 * for those rather than re-rolling a class, because a debug page must be
 * reproducible from its id alone.
 */
export function worldClassOfArchetype(id: string): WorldClass {
  if ((WONDER_ROOMS as readonly string[]).includes(id)) return "wonder";
  if ((NATURE_BIOMES as readonly string[]).includes(id)) return "nature";
  return "interior";
}

/** "pool-hall" → "Pool Hall" — a door plate for an id with no authoring label. */
export function prettyUnitLabel(id: string): string {
  return id
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}
