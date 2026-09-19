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
 * into the render path.
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
import {
  ARCHETYPE_IDS,
  DEBUG_PAGES,
  debugSliceId,
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

/** Every unit on one page, in authored order. */
export function debugUnitsFor(page: DebugPage): DebugUnit[] {
  if (page === "modules") {
    return ROOM_MODULES.map((module) => ({
      page,
      id: module.id,
      label: `${prettyUnitLabel(module.id)} · ${module.label}`,
      sliceId: debugSliceId(page, module.id),
    }));
  }
  if (page === "templates") {
    return ROOM_TEMPLATES.map((template) => ({
      page,
      id: template.id,
      label: `${prettyUnitLabel(template.id)} · ${template.label}`,
      sliceId: debugSliceId(page, template.id),
    }));
  }
  return ARCHETYPE_IDS.map((id) => ({
    page,
    id,
    label: prettyUnitLabel(id),
    sliceId: debugSliceId(page, id),
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
