/**
 * Tests for describeRoom (lib/game/describe-room.ts) — the game's computed
 * room outline for the chat agent (design v0.11-room-interiors §13). The
 * contract under test: the outline is a PURE function of the slice id (same
 * slice → identical outline, any machine, any call order), total over every
 * string, and derived from the render's own pure chain — so it agrees with
 * compileSpaceRecipe / compositionForRecipe / placeRoomDoors rather than
 * re-telling the room in its own words.
 */
import { describe, it, expect } from "vitest";
import {
  describeRoom,
  formatRoomDescription,
} from "@/lib/game/describe-room";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { compositionForRecipe } from "@/lib/game/room-modules";
import { scaledRecipeFor } from "@/lib/game/room-plan";

/** Fixed slice ids — deterministic input, not Math.random(). */
const SLICES = [
  "2026-09-12-0941",
  "2026-09-13-1530",
  "2026-09-14-2207",
  "2026-09-15-1401",
  "2026-07-24-1500",
  "2026-08-19-1400",
  "2026-10-02-0746",
  "2026-11-30-2312",
];

describe("describeRoom", () => {
  it("is deterministic: same slice → identical outline, independent of call order", () => {
    for (const sliceId of SLICES) {
      const first = describeRoom(sliceId);
      // Interleave other slices between the two calls — purity means the
      // second read of the same slice is byte-identical regardless.
      for (const other of SLICES) describeRoom(other);
      const second = describeRoom(sliceId);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it("is total: any string is a valid slice id", () => {
    for (const odd of ["", "not-a-slice", "🚪", "2026-99-99-9999"]) {
      const desc = describeRoom(odd);
      expect(desc.sliceId).toBe(odd);
      expect(formatRoomDescription(desc, "zh").length).toBeGreaterThan(0);
    }
  });

  it("agrees with the recipe compiler — the outline never re-derives the recipe", () => {
    for (const sliceId of SLICES) {
      const desc = describeRoom(sliceId);
      const recipe = compileSpaceRecipe(sliceId);
      expect(desc.worldClass).toBe(recipe.worldClass);
      expect(desc.archetype).toBe(recipe.archetype);
      expect(desc.sizeTier).toBe(recipe.size.id);
      expect(desc.palette).toBe(recipe.palette.id);
      // Scaled dims come from the renderer's scaledRecipeFor, not a copy.
      const { recipe: scaled } = scaledRecipeFor(recipe);
      expect(desc.width).toBe(scaled.width);
      expect(desc.extent).toBe(scaled.size.extent);
    }
  });

  it("mirrors the module composition for interior rooms", () => {
    for (const sliceId of SLICES) {
      const recipe = compileSpaceRecipe(sliceId);
      const desc = describeRoom(sliceId);
      const composition = compositionForRecipe(recipe);
      if (recipe.worldClass !== "interior") {
        expect(desc.layout.kind).not.toBe("modules");
        continue;
      }
      expect(composition).not.toBeNull();
      expect(desc.layout.kind).toBe("modules");
      if (desc.layout.kind !== "modules" || !composition) continue;
      expect(desc.layout.topology).toBe(composition.topology);
      expect(desc.layout.modules.map((m) => m.id)).toEqual(
        composition.modules.map((p) => p.module.id),
      );
      // A composed interior is furnished from the pure chain — the
      // pool-hall modules (bath, pool-deck) included: a composed pool
      // room's content is its modules' whitelists + blueprints alone
      // (the legacy rim scatter retires once a composition exists), so
      // the enumeration names exactly what the render stages.
      expect(desc.furnishing).not.toBeNull();
      expect(desc.furnishing!.length).toBeGreaterThan(0);
      if (recipe.archetype === "pool-hall") {
        expect(desc.water).not.toBeNull();
      }
    }
  });

  it("reports door capacity without runtime inputs, and never invents placements", () => {
    for (const sliceId of SLICES) {
      const desc = describeRoom(sliceId);
      expect(desc.doors.placed).toBeUndefined();
      expect(desc.doors.measuredCapacity).toBeGreaterThanOrEqual(0);
      if (desc.doors.permittedWalls) {
        // §10.5 axial semantics: permitted walls are the north/south faces.
        for (const role of desc.doors.permittedWalls) {
          expect(["far", "step", "left", "right", "inner"]).toContain(role);
        }
      }
    }
  });

  it("places doors exactly when strandDoors + corridorSide are given, inside the permitted walls", () => {
    for (const sliceId of SLICES) {
      for (const side of ["north", "south"] as const) {
        const desc = describeRoom(sliceId, {
          strandDoors: 3,
          corridorSide: side,
        });
        expect(desc.doors.placed).toBeDefined();
        // Exactly the requested count — placement relaxes, never drops.
        expect(desc.doors.placed?.doors).toHaveLength(3);
        // The affordance holds on every ladder rung: a banned wall never
        // receives a door, however tight the room.
        if (desc.doors.permittedWalls) {
          for (const door of desc.doors.placed?.doors ?? []) {
            expect(desc.doors.permittedWalls).toContain(door.wall);
          }
        }
        // Deterministic with the runtime inputs pinned, too.
        const again = describeRoom(sliceId, {
          strandDoors: 3,
          corridorSide: side,
        });
        expect(JSON.stringify(again)).toBe(JSON.stringify(desc));
      }
    }
  });

  it("renders the same facts in English and Chinese", () => {
    for (const sliceId of SLICES.slice(0, 4)) {
      const desc = describeRoom(sliceId);
      const en = formatRoomDescription(desc, "en");
      const zh = formatRoomDescription(desc, "zh");
      expect(en).toContain(sliceId);
      expect(zh).toContain(sliceId);
      // Same line count — one line per fact in both locales.
      expect(zh.split("\n")).toHaveLength(en.split("\n").length);
      // The zh render is actually Chinese; the en render is not.
      expect(zh).toMatch(/[一-鿿]/);
      expect(en).not.toMatch(/[一-鿿]/);
    }
  });

  it("formats a doorless room's entrance and window semantics", () => {
    const desc = describeRoom("2026-09-12-0941");
    const zh = formatRoomDescription(desc, "zh");
    expect(zh).toContain("入口在南墙");
    expect(zh).toContain("东西侧墙");
  });
});


// 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内。
// The "describeRoom worldClass furnishing (nature/wonder kits in the
// outline)" suite lived here — four cases that scanned deterministic
// probe ids for a nature / pool-biome / wonder slice and enumerated the
// resolved skin's decks. With the world draw interior-only no probe id
// can produce those rooms (the scan window comes back empty), and the
// whole block's premise — a real slice drawing a skinned world — is
// unreachable until a class id returns to CLASS_WEIGHTS. The nature /
// wonder kits, the biome and wonder archetype lists, the skins and their
// decks stay dormant in kits.ts, space-types.ts and skins.ts; the
// debug gallery still reaches them (`dbg-a:meadow` etc. — see
// skin-render.test.ts / skins.test.ts), which is where the skinned-world
// contracts are pinned now.
