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

/* ------------------------------------------------------------------ */
/* THE EMPTY-ROOM GUARD — the playground sweep that burned us: the     */
/* readout reported "0 件 · no kits staged" for bath and pool-deck     */
/* while the render showed a furnished room. The lock: through the     */
/* SAME pure chain the readout consumes (describeRoom on the           */
/* playground slice id), every standard room under every skin must     */
/* stage at least one piece of furniture. An empty standard room is    */
/* a HARD defect — the blueprint may forfeit, but the generic          */
/* fallback must always be able to furnish.                            */
/* ------------------------------------------------------------------ */

describe("the playground sweep never stages an empty room (78 combos)", () => {
  /** null = the temperate baseline (无皮肤 ≡ 温带 — the dropdown's
   *  "none" option) plus the four world-owning skins. */
  const SKIN_CHOICES = [null, "dune", "grove", "moss", "shallows"] as const;

  interface Combo {
    moduleId: string;
    skinId: (typeof SKIN_CHOICES)[number];
    seedTag: string | null;
  }
  const combos: Combo[] = [];
  for (const moduleId of PLAYGROUND_MODULE_IDS) {
    for (const skinId of SKIN_CHOICES) {
      combos.push({ moduleId, skinId, seedTag: null });
    }
  }
  // The two rooms the sweep caught get a seed sweep too — the seed rides
  // the room's own streams, so a reseeded room is a DIFFERENT arrangement
  // of the same module and must furnish all the same.
  for (const moduleId of ["bath", "pool-deck"]) {
    for (const skinId of SKIN_CHOICES) {
      for (const seedTag of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
        combos.push({ moduleId, skinId, seedTag });
      }
    }
  }

  const pieceTotal = (d: ReturnType<typeof describeRoom>) =>
    (d.furnishing ?? []).reduce((n, f) => n + f.pieces.length, 0);

  it.each(
    combos.map((c) => [
      `${c.moduleId} × ${c.skinId ?? "baseline"}${c.seedTag ? ` seed ${c.seedTag}` : ""}`,
      c,
    ] as const),
  )("furnishes %s (≥1 piece)", (_title, c) => {
    const sliceId = playgroundSliceId({
      moduleId: c.moduleId,
      skinId: c.skinId,
      seedTag: c.seedTag,
    });
    const desc = describeRoom(sliceId);
    const total = pieceTotal(desc);
    expect(
      total,
      `空房是硬缺陷：回退路径必须能 furnish — ${c.moduleId} × ` +
        `${c.skinId ?? "baseline"}${c.seedTag ? ` (seed ${c.seedTag})` : ""} ` +
        `staged ${total} pieces through the readout chain (furnishing ` +
        `${desc.furnishing === null ? "null" : "empty"})`,
    ).toBeGreaterThan(0);
    // The blueprint path names its groups "<module>:<group>"; a room that
    // furnished with NO such group furnished through the generic fallback
    // — both paths are legal, neither may come out empty.
    const viaBlueprint = desc.furnishing!.some((f) =>
      f.kit.startsWith(`${c.moduleId}:`),
    );
    expect(
      viaBlueprint || desc.furnishing!.length > 0,
      `${c.moduleId}: neither the blueprint nor the fallback staged anything`,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* THE DOORED EMPTY-ROOM GUARD — the v0.13.1 door-load lane's product  */
/* lock. The lane (room-modules.ts doorLoadBearingFor) grows a room    */
/* its floor cannot bear; these combos are exactly the ones that used  */
/* to double-zero — the blueprint rolled back AND the generic fallback */
/* staged nothing (bath 6×6 and bedroom 6w at 1–2 doors, measured).   */
/* A doored standard room must furnish on BOTH corridor sides.         */
/* ------------------------------------------------------------------ */

describe("the doored sweep never stages an empty room (78 combos)", () => {
  interface Combo {
    moduleId: string;
    doors: number;
    side: "north" | "south";
  }
  const combos: Combo[] = [];
  for (const moduleId of PLAYGROUND_MODULE_IDS) {
    for (const doors of [1, 2, 3]) {
      for (const side of ["north", "south"] as const) {
        combos.push({ moduleId, doors, side });
      }
    }
  }

  const pieceTotal = (d: ReturnType<typeof describeRoom>) =>
    (d.furnishing ?? []).reduce((n, f) => n + f.pieces.length, 0);

  it.each(
    combos.map((c) => [`${c.moduleId} × ${c.doors} doors, ${c.side} side`, c] as const),
  )("furnishes %s (≥1 piece)", (_title, c) => {
    const desc = describeRoom(
      playgroundSliceId({ moduleId: c.moduleId, skinId: null, seedTag: null }),
      { strandDoors: c.doors, corridorSide: c.side },
    );
    const total = pieceTotal(desc);
    expect(
      total,
      `空房是硬缺陷：带 ${c.doors} 扇线索门也必须能 furnish — ${c.moduleId} ` +
        `(${c.side}) staged ${total} pieces through the readout chain`,
    ).toBeGreaterThan(0);
  });
});

