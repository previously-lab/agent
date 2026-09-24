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
import { skinById } from "@/lib/game/skins";

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
      // A composed interior is furnished from the pure chain (pool-hall
      // excluded — its legacy fixtures live in space.tsx).
      if (recipe.archetype !== "pool-hall") {
        expect(desc.furnishing).not.toBeNull();
      } else {
        expect(desc.furnishing).toBeNull();
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

describe("describeRoom worldClass furnishing (nature/wonder kits in the outline)", () => {
  /** The decks, mirrored from kits.ts — every enumerated kit must belong
   *  to the room's own world-class deck. */
  const NATURE_DECK = [
    "fallen-log",
    "stone-circle",
    "jetty",
    "fence-ruin",
    "campfire",
    "path-marker",
    "boulder-cluster",
    "reeds",
  ];
  const WONDER_DECK = [
    "toy-blocks",
    "marble-run",
    "giant-chess",
    "paper-boats",
    "lantern-cluster",
    "swing-frame",
  ];

  // Scan a deterministic spread of slice ids for one room of each shape —
  // compileSpaceRecipe hashes any string, so the probe ids are as good
  // as dates (A6: the same scan returns the same rooms on any machine).
  const findSlice = (
    pred: (r: ReturnType<typeof compileSpaceRecipe>) => boolean,
    limit = 600,
  ): string => {
    for (let i = 0; i < limit; i++) {
      const id = `outline-probe-${i}`;
      if (pred(compileSpaceRecipe(id))) return id;
    }
    throw new Error("no matching slice found in the scan window");
  };

  it("enumerates the nature kits for a nature room — the world's skin owns the draw", () => {
    const id = findSlice(
      (r) => r.worldClass === "nature" && r.archetype !== "pool",
    );
    const desc = describeRoom(id);
    expect(desc.furnishing).not.toBeNull();
    const kits = desc.furnishing!.map((f) => f.kit);
    expect(kits.length).toBeGreaterThan(0);
    // P3 step three: the room's WORLD owns the vocabulary — every
    // enumerated kit rides the resolved skin's decks (which are curated
    // from the nature set, so the catalogue assertion still holds).
    expect(desc.skin).not.toBeNull();
    const skinDecks = skinById(desc.skin!.id)!.furnishing.decks ?? [];
    for (const kit of kits) expect(skinDecks).toContain(kit);
    for (const kit of kits) expect(NATURE_DECK).toContain(kit);
    // The zh outline's 陈设 line names the hero kit first.
    const zh = formatRoomDescription(desc, "zh");
    expect(zh).toContain("陈设：主角套件");
    expect(zh).toContain(kits[0]);
  });

  it("furnishes the outdoor pool biome from its shallows skin's shore kits", () => {
    // P3 step three: the pool biome is a nature room like any other — the
    // shallows skin's decks REPLACE the empty archetype gate, and its shore
    // kits (jetty, reeds) are water-bound, so the basin finally furnishes.
    const id = findSlice(
      (r) => r.worldClass === "nature" && r.archetype === "pool",
    );
    const desc = describeRoom(id);
    expect(desc.skin?.id).toBe("shallows");
    expect(desc.furnishing).not.toBeNull();
    const kits = desc.furnishing!.map((f) => f.kit);
    expect(kits.length).toBeGreaterThan(0);
    const shallowsDecks = skinById("shallows")!.furnishing.decks ?? [];
    for (const kit of kits) expect(shallowsDecks).toContain(kit);
    expect(desc.water).not.toBeNull();
  });

  it("enumerates the wonder kits for a wonder room (view skin, authored deck)", () => {
    const id = findSlice((r) => r.worldClass === "wonder");
    const desc = describeRoom(id);
    // The wonder room WEARS its world's skin (view)…
    expect(desc.skin).not.toBeNull();
    // …but keeps its authored playthings: the deck is the diorama's
    // structure, so the skin's nature decks never enter the enumeration.
    expect(desc.furnishing).not.toBeNull();
    const kits = desc.furnishing!.map((f) => f.kit);
    expect(kits.length).toBeGreaterThan(0);
    for (const kit of kits) expect(WONDER_DECK).toContain(kit);
    // Same line count in both locales with the furnishing line present.
    const en = formatRoomDescription(desc, "en");
    const zh = formatRoomDescription(desc, "zh");
    expect(en).toContain("hero kit");
    expect(en).toContain(kits[0]);
    expect(zh.split("\n")).toHaveLength(en.split("\n").length);
  });

  it("keeps the outline deterministic for the new world classes", () => {
    for (const cls of ["nature", "wonder"] as const) {
      const id = findSlice((r) => r.worldClass === cls);
      const a = JSON.stringify(describeRoom(id));
      describeRoom(findSlice((r) => r.worldClass === "interior"));
      const b = JSON.stringify(describeRoom(id));
      expect(b).toBe(a);
    }
  });
});
