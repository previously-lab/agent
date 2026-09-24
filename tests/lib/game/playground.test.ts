/**
 * Tests for the playground's pure half (lib/game/playground.ts) and its
 * bite on the EXISTING debug-slice parse path: the room/skin/seed URL
 * params must compose into a slice id that (a) still pins the module,
 * (b) still forces the skin, and (c) keeps the seed INSIDE the room's own
 * seeded streams (debugSliceIdWithoutSkin strips only the skin) — while
 * every real memory slice and the gallery's plain pins parse byte-for-byte
 * as before.
 */
import { describe, it, expect } from "vitest";
import {
  PLAYGROUND_DEFAULT_MODULE,
  PLAYGROUND_MODULE_IDS,
  PLAYGROUND_SKIN_IDS,
  parsePlaygroundParams,
  playgroundFrameFor,
  playgroundSliceId,
  type PlaygroundParams,
} from "@/lib/game/playground";
import {
  debugSliceIdWithoutSkin,
  parseDebugSeed,
  parseDebugSlice,
} from "@/lib/game/debug-slice";
import { skinForSlice } from "@/lib/game/skins";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { roomModuleById } from "@/lib/game/room-modules";
import { describeRoom } from "@/lib/game/describe-room";

const LIVING = "living";

describe("parsePlaygroundParams", () => {
  it("falls back to the default room with no params", () => {
    expect(parsePlaygroundParams({})).toEqual({
      moduleId: PLAYGROUND_DEFAULT_MODULE,
      skinId: null,
      seedTag: null,
    });
  });

  it("accepts a valid module / skin / seed triple", () => {
    expect(
      parsePlaygroundParams({ m: "bath", skin: "dune", seed: "run-2" }),
    ).toEqual({ moduleId: "bath", skinId: "dune", seedTag: "run-2" });
  });

  it("rejects an unknown module and falls back", () => {
    expect(parsePlaygroundParams({ m: "penthouse" }).moduleId).toBe(
      PLAYGROUND_DEFAULT_MODULE,
    );
  });

  it("treats temperate — and only temperate — as the no-skin baseline", () => {
    expect(parsePlaygroundParams({ skin: "temperate" }).skinId).toBeNull();
    expect(parsePlaygroundParams({ skin: "shallows" }).skinId).toBe("shallows");
    expect(parsePlaygroundParams({ skin: "rainforest" }).skinId).toBeNull();
  });

  it("sanitizes the seed tag (no +, spaces, dots; length-capped)", () => {
    for (const bad of ["a b", "x+y", "../etc", "a".repeat(30), ""]) {
      expect(parsePlaygroundParams({ seed: bad }).seedTag).toBeNull();
    }
    expect(parsePlaygroundParams({ seed: "Ab_9-z" }).seedTag).toBe("Ab_9-z");
  });

  it("takes the first entry of a repeated param", () => {
    expect(parsePlaygroundParams({ m: ["kitchen", "bath"] }).moduleId).toBe(
      "kitchen",
    );
  });

  it("vocabulary matches the catalogues it claims to mirror", () => {
    expect(PLAYGROUND_MODULE_IDS).toContain("gallery-module");
    expect(PLAYGROUND_MODULE_IDS).toContain("pool-deck");
    expect(PLAYGROUND_SKIN_IDS).toEqual(
      expect.arrayContaining(["temperate", "dune", "grove", "moss", "shallows"]),
    );
  });
});

describe("playgroundSliceId", () => {
  const base: PlaygroundParams = {
    moduleId: LIVING,
    skinId: null,
    seedTag: null,
  };

  it("builds the plain module pin with nothing optional", () => {
    expect(playgroundSliceId(base)).toBe("dbg-m:living");
  });

  it("prefixes the skin segment FIRST (parseDebugSkin reads only it)", () => {
    expect(playgroundSliceId({ ...base, skinId: "dune" })).toBe(
      "dbg-skin:dune+dbg-m:living",
    );
  });

  it("rides the seed between the skin and the pin", () => {
    expect(playgroundSliceId({ ...base, seedTag: "7" })).toBe(
      "dbg-seed:7+dbg-m:living",
    );
    expect(
      playgroundSliceId({ ...base, skinId: "dune", seedTag: "7" }),
    ).toBe("dbg-skin:dune+dbg-seed:7+dbg-m:living");
  });
});

describe("the composed id on the existing parse path", () => {
  it("still pins the module with every optional segment present", () => {
    for (const id of [
      "dbg-m:living",
      "dbg-seed:7+dbg-m:living",
      "dbg-skin:dune+dbg-seed:7+dbg-m:living",
      "dbg-skin:moss+dbg-m:living",
    ]) {
      expect(parseDebugSlice(id)).toEqual({ page: "modules", id: "living" });
    }
  });

  it("leaves real memory slices and plain pins parsing as before", () => {
    expect(parseDebugSlice("2026-09-12-0941")).toBeNull();
    expect(parseDebugSlice("dbg-t:reading-hall")).toEqual({
      page: "templates",
      id: "reading-hall",
    });
    expect(parseDebugSlice("dbg-a:ducks")).toEqual({
      page: "archetypes",
      id: "ducks",
    });
  });

  it("reads the seed tag back (skin or no skin)", () => {
    expect(parseDebugSeed("dbg-seed:7+dbg-m:living")).toBe("7");
    expect(parseDebugSeed("dbg-skin:dune+dbg-seed:7+dbg-m:living")).toBe("7");
    expect(parseDebugSeed("dbg-skin:dune+dbg-m:living")).toBeNull();
    expect(parseDebugSeed("2026-09-12-0941")).toBeNull();
  });

  it("strips ONLY the skin — the seed stays in the room's own streams", () => {
    expect(debugSliceIdWithoutSkin("dbg-skin:dune+dbg-seed:7+dbg-m:living")).toBe(
      "dbg-seed:7+dbg-m:living",
    );
    expect(debugSliceIdWithoutSkin("dbg-seed:7+dbg-m:living")).toBe(
      "dbg-seed:7+dbg-m:living",
    );
  });

  it("forces the skin through skinForSlice on the composed id", () => {
    expect(
      skinForSlice("dbg-skin:dune+dbg-seed:7+dbg-m:living")?.id,
    ).toBe("dune");
    // Seed-only id: interior archetype ⇒ the temperate baseline, never a crash.
    expect(skinForSlice("dbg-seed:7+dbg-m:living")).toBeNull();
  });

  it("compiles the same archetype for every seed, with a different layout stream", () => {
    const pinned = roomModuleById(LIVING);
    expect(pinned).toBeDefined();
    const archetype = pinned!.archetypes[0];
    const a = compileSpaceRecipe("dbg-seed:1+dbg-m:living");
    const b = compileSpaceRecipe("dbg-seed:2+dbg-m:living");
    expect(a.archetype).toBe(archetype);
    expect(b.archetype).toBe(archetype);
    expect(a.layoutSeed).not.toBe(b.layoutSeed);
    // And the pin survives the seed: a seedless pin compiles identically to
    // today's gallery room.
    expect(compileSpaceRecipe("dbg-m:living").archetype).toBe(archetype);
  });

  it("describeRoom follows the same id the canvas renders", () => {
    const d = describeRoom("dbg-skin:dune+dbg-seed:7+dbg-m:living");
    expect(d.sliceId).toBe("dbg-skin:dune+dbg-seed:7+dbg-m:living");
    expect(d.layout.kind).toBe("modules");
    if (d.layout.kind === "modules") {
      expect(d.layout.modules.some((m) => m.id === LIVING)).toBe(true);
    }
    expect(d.skin?.id).toBe("dune");
    expect(d.furnishing).not.toBeNull();
  });
});

describe("playgroundFrameFor", () => {
  const base = { doorZ: 5, wallHeight: 4, aspect: 1.78 };

  it("centers on the footprint and measures its ground radius", () => {
    const f = playgroundFrameFor({ ...base, width: 6, extent: 6 });
    expect(f.centerX).toBe(0);
    expect(f.centerZ).toBe(5 + 3);
    expect(f.groundRadius).toBeCloseTo(Math.hypot(3, 3), 6);
  });

  it("grows with the room's plan dims", () => {
    const small = playgroundFrameFor({ ...base, width: 6, extent: 6 });
    const large = playgroundFrameFor({ ...base, width: 18, extent: 12 });
    expect(large.halfHeight).toBeGreaterThan(small.halfHeight);
    expect(large.groundRadius).toBeGreaterThan(small.groundRadius);
  });

  it("widens the required frame for portrait aspects", () => {
    const land = playgroundFrameFor({ ...base, width: 12, extent: 8, aspect: 1.78 });
    const port = playgroundFrameFor({ ...base, width: 12, extent: 8, aspect: 0.5 });
    expect(port.halfHeight).toBeGreaterThan(land.halfHeight);
  });

  it("keeps taller walls inside the frame", () => {
    const low = playgroundFrameFor({ ...base, width: 10, extent: 10, wallHeight: 4 });
    const high = playgroundFrameFor({ ...base, width: 10, extent: 10, wallHeight: 12 });
    expect(high.halfHeight).toBeGreaterThan(low.halfHeight);
  });
});
