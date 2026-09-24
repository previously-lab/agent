/**
 * The gallery's door list — every STANDARD unit the room pipeline can be forced
 * into, ready to be laid out as a corridor.
 *
 * WHAT IT IS FOR. Reviewing the standard rooms one at a time (a module at a
 * time, a layout at a time, an archetype at a time) instead of waiting for the
 * seed to show one: `?view=game&debug=rooms&page=modules` swaps the corridor's
 * doors for this list, one door per unit, and the plate carries the authoring
 * label. Walking through a door builds exactly that unit — the force travels in
 * the synthetic slice id (debug-slice.ts), so nothing here needs to be wired
 * into the render path. `&skin=<id>` (v0.12 P3) additionally prefixes every
 * door with the biome-skin force, for the same-unit-across-worlds pass.
 *
 * THREE PAGES:
 *   - `modules`    — the thirteen standard room modules (§8.2), the sets the
 *                    composition layer draws from. The ones worth decorating.
 *   - `templates`  — the seven authored layouts (§7.5 + the abundance pass).
 *   - `archetypes` — every world/biome archetype (interior, nature, wonder),
 *                    for the "what does this kind of place look like" pass.
 *
 * Pure data: same page ⇒ same list, same order, same ids.
 */
import { ROOM_MODULES } from "./room-modules";
import { ROOM_TEMPLATES } from "./room-templates";
import { isSkinId } from "./skins";
import {
  ARCHETYPE_IDS,
  DEBUG_PAGES,
  debugSliceId,
  debugSliceIdWithSkin,
  parseDebugSlice,
  prettyUnitLabel,
  type DebugPage,
} from "./debug-slice";

export interface DebugUnit {
  page: DebugPage;
  /** The pinned unit's id (module / template / archetype). */
  id: string;
  /** What the door plate reads. */
  label: string;
  /** The synthetic slice id that builds it. */
  sliceId: string;
}

/** Every unit on one page, in authored order.
 *
 *  The optional `skinId` (the gallery's `&skin=` parameter, v0.12 P3)
 *  prefixes every door's slice id with the skin force
 *  (`dbg-skin:dune+dbg-m:living`), so one gallery walk reviews the SAME
 *  unit across worlds — the "one living room × four skins" acceptance
 *  pass. An ABSENT or UNKNOWN id is IGNORED: the doors stay plain
 *  `dbg-m:*`, byte-for-byte today's gallery (a typo degrades to the
 *  un-skinned review, never to a broken door). A6 holds either way — the
 *  skin rides in the slice id, so a door's world is a pure function of
 *  its id. */
export function debugUnitsFor(page: DebugPage, skinId?: string | null): DebugUnit[] {
  const skin = skinId != null && isSkinId(skinId) ? skinId : null;
  const sliceIdFor = (id: string): string => {
    const base = debugSliceId(page, id);
    return skin === null ? base : debugSliceIdWithSkin(skin, base);
  };
  if (page === "modules") {
    return ROOM_MODULES.map((module) => ({
      page,
      id: module.id,
      label: `${prettyUnitLabel(module.id)} · ${module.label}`,
      sliceId: sliceIdFor(module.id),
    }));
  }
  if (page === "templates") {
    return ROOM_TEMPLATES.map((template) => ({
      page,
      id: template.id,
      label: `${prettyUnitLabel(template.id)} · ${template.label}`,
      sliceId: sliceIdFor(template.id),
    }));
  }
  return ARCHETYPE_IDS.map((id) => ({
    page,
    id,
    label: prettyUnitLabel(id),
    sliceId: sliceIdFor(id),
  }));
}

/** The unit a slice id pins, with its plate label, or undefined. */
export function debugUnitBySliceId(sliceId: string): DebugUnit | undefined {
  const parsed = parseDebugSlice(sliceId);
  if (!parsed) return undefined;
  return debugUnitsFor(parsed.page).find((unit) => unit.id === parsed.id);
}

/** Is this `?page=` value one of the gallery's pages? */
export function isDebugPage(value: string | null | undefined): value is DebugPage {
  return (
    typeof value === "string" && (DEBUG_PAGES as readonly string[]).includes(value)
  );
}
