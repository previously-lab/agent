/**
 * The v0.12b split guard — the evidence that moving the catalogue data out
 * of room-schematic.ts / room-modules.ts into the lane-owned family files
 * (src/lib/game/schematics/*, src/lib/game/modules/*) changed nothing.
 *
 * The fixture ./__fixtures__/catalog-v0.12.json holds the PRE-refactor
 * fingerprint, captured at HEAD 2df0df9 (branch v0.11-streams) by a one-off
 * script. Serialization is normalized, not snapshotted: object keys are
 * recursively sorted (stable, diffable) and values JSON.stringify would
 * silently drop (functions, regexps, undefined, bigints) are tagged
 * explicitly — an entry can never pass by accident of omission. Arrays keep
 * their order: array order IS catalogue order.
 *
 * Semantics, deliberately asymmetric:
 *  - MODULES: the module catalogue is FROZEN — the live id list must equal
 *    the fixture's exactly and every entry must be field-for-field
 *    identical. A lane never adds or edits a module unilaterally (zones /
 *    kits / features / heroKit changes go through the main agent), so any
 *    drift here is either a refactor accident or a contract violation —
 *    both must fail loudly.
 *  - SCHEMATICS: the P2b lanes legitimately ADD blueprints to their family
 *    files, so the live catalogue is a SUPERSET of the fixture. Every
 *    fixture id must still exist, byte-identical; additions are validated
 *    by the shared audit (room-schematic.test.ts) and each lane's family
 *    test, not by this guard.
 *
 *  v0.13 RESAMPLE: the fixture's module entries were regenerated after the
 *  module-grid snap (footprints 8–16 m → 6 m cell multiples) — ids, zones,
 *  kits, features and every schematic entry are byte-unchanged; only the
 *  13 `size` fields moved. The pre-snap fingerprint remains in git history
 *  (HEAD 2df0df9's tree).
 *
 *  世界分类收口（2026-09）: the module side of the fixture was re-recorded
 *  again — gallery-module and pool-deck came OFF the registry (user
 *  ruling: no room bigger than the standard set; "large" is more standard
 *  rooms), so `modules` pins the 11 ids/entries on MODULE_ORDER today.
 *  The two halls' entries remain in git history, and their definitions,
 *  blueprints and kits stay dormant in modules/public.ts +
 *  schematics/public.ts. The SCHEMATICS side still pins every pre-
 *  refactor blueprint byte-identical — the two halls' blueprints are
 *  data like any other and stay pinned (superset semantics unchanged).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOM_MODULES } from "@/lib/game/room-modules";
import { roomSchematics } from "@/lib/game/room-schematic";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface CatalogFixture {
  generated: string;
  modules: { ids: string[]; entries: Json[] };
  schematics: { ids: string[]; entries: Json[] };
}

/** Stable serialization — MUST mirror the (deleted) one-off dump script:
 *  object keys recursively sorted; non-serializable values tagged instead
 *  of dropped; arrays keep order. */
function normalize(value: unknown): Json {
  if (value === null) return null;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") {
    return value as number | string | boolean;
  }
  if (t === "undefined") return { $undefined: true };
  if (t === "function") {
    return { $function: (value as { name?: string }).name || "anonymous" };
  }
  if (t === "bigint") return { $bigint: (value as bigint).toString() };
  if (value instanceof RegExp) return { $regexp: value.toString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (t === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return { $unknown: String(value) };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/catalog-v0.12.json", import.meta.url)), "utf8"),
) as CatalogFixture;

describe("the v0.12b family split changed no catalogue bytes", () => {
  it("pins the module catalogue exactly: ids in the frozen global order", () => {
    expect(ROOM_MODULES.map((m) => m.id)).toEqual(fixture.modules.ids);
  });

  it("pins every module entry field-for-field", () => {
    const live = ROOM_MODULES.map(normalize);
    expect(live.length).toBe(fixture.modules.entries.length);
    for (let i = 0; i < live.length; i++) {
      expect(live[i], `module "${fixture.modules.ids[i]}" drifted`).toEqual(
        fixture.modules.entries[i],
      );
    }
  });

  it("pins every pre-refactor blueprint byte-identical (additions allowed)", () => {
    const live = new Map(roomSchematics().map((s) => [s.moduleId, s]));
    for (let i = 0; i < fixture.schematics.ids.length; i++) {
      const id = fixture.schematics.ids[i];
      const entry = live.get(id);
      expect(entry, `blueprint "${id}" missing after the split`).toBeDefined();
      expect(normalize(entry), `blueprint "${id}" drifted`).toEqual(
        fixture.schematics.entries[i],
      );
    }
  });
});
