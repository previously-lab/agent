/**
 * Debug slice ids — the force that lets the gallery corridor walk the STANDARD
 * units one by one (the user's "decorate each standard room, then let the
 * random combinations inherit the polish" pass).
 *
 * THE FORCE RIDES IN THE SLICE ID: `dbg-m:<moduleId>` pins a standard room
 * module, `dbg-t:<templateId>` an authored layout, `dbg-a:<archetypeId>` an
 * archetype. v0.12 P3 adds `dbg-skin:<skinId>` (skins.ts) — the biome-skin
 * force: it composes with any unit pin as `dbg-skin:<skinId>+dbg-m:<moduleId>`
 * (skin segment FIRST), or stands alone (`dbg-skin:<skinId>`) to force a skin
 * on the otherwise-seeded room. Nothing mutable is involved, so a debug room
 * stays a pure function of its id (A6 — same id, same room), and the normal
 * path can never see one: `parseDebugSlice` answers null for every real
 * memory slice, and the pipeline branches below are all "no id, no change".
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

/** Query parameter carrying the gallery's biome-skin force (v0.12 P3):
 *  `?view=game&debug=rooms&page=modules&skin=dune` prefixes every gallery
 *  door's slice id with `dbg-skin:dune+`. Only the gallery reads it; the
 *  room pipeline sees the force inside the slice id, as always. */
export const DEBUG_SKIN_PARAM = "skin";

const PREFIX: Record<DebugPage, string> = {
  modules: "dbg-m:",
  templates: "dbg-t:",
  archetypes: "dbg-a:",
};

/** The v0.12 P3 biome-skin force (skins.ts). A LEADING `dbg-skin:<skinId>`
 *  segment, alone or `+`-composed before a unit pin. */
const SKIN_PREFIX = "dbg-skin:";

/** The synthetic slice id one unit builds from. */
export function debugSliceId(page: DebugPage, id: string): string {
  return `${PREFIX[page]}${id}`;
}

/** A synthetic slice id with the skin force composed in FRONT — the shape
 *  the gallery builds when `&skin=` is present:
 *  `dbg-skin:<skinId>+dbg-m:<id>`. Pure concatenation (the parser is the
 *  single validation point at consumption time); the skin id's membership
 *  in the catalogue is the CALLER's job (debug-catalog.ts validates before
 *  calling). */
export function debugSliceIdWithSkin(skinId: string, sliceId: string): string {
  return `${SKIN_PREFIX}${skinId}+${sliceId}`;
}

/** The slice id with a leading `dbg-skin:<skinId>+` segment REMOVED — the
 *  ROOM's identity for every seeded derivation. The skin is a VIEW-layer
 *  force (surfaces / light mood / outside / fog, plus the staging lane's
 *  slot-kind swaps and deck takeover); it must never perturb the room's
 *  own streams, so the same unit stages byte-for-byte under every skin —
 *  无皮肤 ≡ 温带. Identity for every non-skinned id (real memory slices
 *  above all). A BARE `dbg-skin:<skinId>` (nothing left after the strip)
 *  keeps the full id: the seeded room stays seeded, only its view is
 *  skinned. Inverse of debugSliceIdWithSkin. */
export function debugSliceIdWithoutSkin(sliceId: string): string {
  const skin = parseDebugSkin(sliceId);
  if (skin === null) return sliceId;
  const rest = sliceId.slice(SKIN_PREFIX.length + skin.length);
  const stripped = rest.startsWith("+") ? rest.slice(1) : rest;
  return stripped.length > 0 ? stripped : sliceId;
}

/**
 * The skin id a slice id forces — the leading `dbg-skin:<skinId>` segment's
 * body, or null when absent (every real memory slice, and bare `dbg-skin:`
 * with no id). The skin segment may stand alone (`dbg-skin:dune`) or
 * introduce a composed pin (`dbg-skin:dune+dbg-m:living`); either way only
 * the FIRST segment is read — the remainder belongs to parseDebugSlice.
 * Validation against the skin catalogue is the caller's job (skins.ts
 * answers null for unknown ids, so a stale pin degrades, never crashes).
 */
export function parseDebugSkin(sliceId: string): string | null {
  if (!sliceId.startsWith(SKIN_PREFIX)) return null;
  const body = sliceId.slice(SKIN_PREFIX.length);
  const plus = body.indexOf("+");
  const id = plus === -1 ? body : body.slice(0, plus);
  return id.length > 0 ? id : null;
}

/** The unit a slice id pins, or null for every real memory slice. */
export function parseDebugSlice(
  sliceId: string,
): { page: DebugPage; id: string } | null {
  // A leading `dbg-skin:<skinId>+` segment composes with the pin below —
  // strip it first so the page loop sees the plain unit id, exactly as it
  // did before skins existed. A bare `dbg-skin:<skinId>` pins no unit: the
  // loop falls through to null like every real memory slice (the skin
  // force alone lives in parseDebugSkin).
  const skin = parseDebugSkin(sliceId);
  let rest = sliceId;
  if (skin !== null) {
    rest = sliceId.slice(SKIN_PREFIX.length + skin.length);
    if (rest.startsWith("+")) rest = rest.slice(1);
  }
  for (const page of DEBUG_PAGES) {
    const prefix = PREFIX[page];
    if (!rest.startsWith(prefix)) continue;
    const id = rest.slice(prefix.length);
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
