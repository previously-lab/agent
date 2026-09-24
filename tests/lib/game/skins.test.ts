/**
 * Tests for the v0.12 P3 biome-skin catalogue (lib/game/skins.ts) and its
 * debug force (lib/game/debug-slice.ts's `dbg-skin:` prefix).
 *
 * The contract under test:
 *  1. every skin FILLS all six slots (floor / wall / furnishing / light /
 *     window / fog) — no empty slot anywhere;
 *  2. furnishing decks reference real kits.ts catalogue ids;
 *  3. §6.2 slot overrides: features are existing KitKinds inside the
 *     curated environment whitelist, roles are authored schematic roles;
 *  4. THE TRANSPARENCY BUDGET: only water/glass surfaces carry alpha;
 *  5. the five skins are pairwise visually distinguishable (same tuple
 *     never twice; window skies, fog tints, floor/wall kinds, silhouettes
 *     and horizons all distinct), each with a day AND a night state;
 *  6. A6: same slice (+ same skin) ⇒ same skin / same outline;
 *  7. the debug prefix composes with `dbg-m:` and leaves the default path
 *     byte-for-byte untouched.
 */
import { describe, expect, it } from "vitest";
import {
  ALPHA_FLOOR_KINDS,
  ALPHA_WALL_KINDS,
  ENVIRONMENT_FEATURE_KINDS,
  SKIN_IDS,
  SKINS,
  isSkinId,
  skinById,
  skinForSlice,
  skinLightFixture,
  skinSlotFeatureFor,
  type BiomeSkin,
} from "@/lib/game/skins";
import { parseDebugSkin, parseDebugSlice } from "@/lib/game/debug-slice";
import { KITS, type KitKind } from "@/lib/game/kits";
import { roomSchematics } from "@/lib/game/room-schematic";
import { MODULE_LIGHT_FIXTURES } from "@/lib/game/tuning/room";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { compositionForRecipe } from "@/lib/game/room-modules";
import {
  describeRoom,
  formatRoomDescription,
} from "@/lib/game/describe-room";

const KIT_IDS = new Set(KITS.map((k) => k.id));
const SCHEMATIC_ROLES = new Set(
  roomSchematics().flatMap((s) => s.slots.map((slot) => slot.role)),
);

function assertHex(color: string): void {
  expect(color).toMatch(/^#[0-9a-f]{6}$/);
}

describe("biome skin catalogue", () => {
  it("authors at least five skins with unique ids", () => {
    expect(SKINS.length).toBeGreaterThanOrEqual(5);
    expect(SKIN_IDS).toEqual(SKINS.map((s) => s.id));
    expect(new Set(SKIN_IDS).size).toBe(SKIN_IDS.length);
    for (const id of SKIN_IDS) expect(isSkinId(id)).toBe(true);
    expect(isSkinId("volcano")).toBe(false);
  });

  it("fills all six slots of every skin — no empty slot", () => {
    for (const skin of SKINS) {
      // Slot 1 — floor: kind + walk semantics + a colour pair.
      expect(skin.floor.kind.length).toBeGreaterThan(0);
      expect(["dry", "wade"]).toContain(skin.floor.walk);
      expect(skin.floor.speed).toBeGreaterThan(0);
      expect(skin.floor.speed).toBeLessThanOrEqual(1);
      if (skin.floor.walk === "wade") expect(skin.floor.speed).toBeLessThan(1);
      assertHex(skin.floor.colors.day);
      assertHex(skin.floor.colors.night);
      // Slot 2 — wall: kind + colour pair.
      expect(skin.wall.kind.length).toBeGreaterThan(0);
      assertHex(skin.wall.colors.day);
      assertHex(skin.wall.colors.night);
      // Slot 3 — furnishing: family + a non-empty deck of real kits.
      expect(["interior", "nature"]).toContain(skin.furnishing.family);
      expect(skin.furnishing.decks.length).toBeGreaterThan(0);
      // Slot 4 — light: one of the five existing module registers.
      expect(MODULE_LIGHT_FIXTURES[skin.light.register]).toBeDefined();
      // Slot 5 — window: four day colours + four night colours + silhouette.
      for (const c of Object.values(skin.window.day)) assertHex(c);
      for (const c of Object.values(skin.window.night)) assertHex(c);
      expect(skin.window.silhouette.length).toBeGreaterThan(0);
      // Slot 6 — fog: a colour pair + a positive density + a horizon.
      assertHex(skin.fog.day);
      assertHex(skin.fog.night);
      expect(skin.fog.density).toBeGreaterThan(0);
      expect(skin.fog.horizon.length).toBeGreaterThan(0);
    }
  });

  it("every furnishing deck id exists in the kits catalogue", () => {
    for (const skin of SKINS) {
      for (const id of skin.furnishing.decks) {
        expect(KIT_IDS.has(id), `${skin.id} deck "${id}"`).toBe(true);
      }
    }
  });

  it("resolves the light fixture through the register table", () => {
    for (const skin of SKINS) {
      const fixture = skinLightFixture(skin);
      const base = MODULE_LIGHT_FIXTURES[skin.light.register];
      expect(fixture.color).toBe(skin.light.tint ?? base.color);
      expect(fixture.intensity).toBe(skin.light.intensity ?? base.intensity);
      expect(fixture.pool).toBe(skin.light.pool ?? base.pool);
      expect(fixture.intensity).toBeGreaterThan(0);
    }
  });

  it("carries a day AND a night state that actually differ", () => {
    for (const skin of SKINS) {
      expect(skin.window.day.sky).not.toBe(skin.window.night.sky);
      expect(skin.fog.day).not.toBe(skin.fog.night);
      expect(skin.floor.colors.day).not.toBe(skin.floor.colors.night);
      expect(skin.wall.colors.day).not.toBe(skin.wall.colors.night);
    }
  });
});

describe("§6.2 slot overrides", () => {
  it("at least three skins declare real, usable overrides", () => {
    const withOverrides = SKINS.filter(
      (s) => (s.slotOverrides?.length ?? 0) > 0,
    );
    expect(withOverrides.length).toBeGreaterThanOrEqual(3);
  });

  it("features are existing KitKinds inside the environment whitelist", () => {
    const kitKinds = new Set<KitKind>(KITS.flatMap((k) => k.pieces.map((p) => p.kind)));
    for (const skin of SKINS) {
      for (const o of skin.slotOverrides ?? []) {
        expect(kitKinds.has(o.feature), `${skin.id}: ${o.feature}`).toBe(true);
        expect(
          (ENVIRONMENT_FEATURE_KINDS as readonly KitKind[]).includes(o.feature),
          `${skin.id}: ${o.feature} is not a curated environment piece`,
        ).toBe(true);
      }
    }
  });

  it("roles are authored schematic roles (an unauthored role would stage nothing)", () => {
    for (const skin of SKINS) {
      for (const o of skin.slotOverrides ?? []) {
        expect(
          SCHEMATIC_ROLES.has(o.role),
          `${skin.id}: role "${o.role}" is not an authored schematic role`,
        ).toBe(true);
      }
    }
  });

  it("no role is overridden twice in one skin", () => {
    for (const skin of SKINS) {
      const roles = (skin.slotOverrides ?? []).map((o) => o.role);
      expect(new Set(roles).size).toBe(roles.length);
    }
  });

  it("the staging hook answers by role and stays silent otherwise", () => {
    const shallows = skinById("shallows")!;
    expect(shallows).toBeDefined();
    expect(skinSlotFeatureFor(shallows, "coffeetable")).toBe("fountain");
    expect(skinSlotFeatureFor(shallows, "plant")).toBe("reeds");
    expect(skinSlotFeatureFor(shallows, "sofa")).toBeUndefined();
    const temperate = skinById("temperate")!;
    expect(skinSlotFeatureFor(temperate, "coffeetable")).toBeUndefined();
  });
});

describe("transparency budget (§5: only water and glass)", () => {
  it("keeps the alpha whitelist exactly water + glass", () => {
    expect(ALPHA_FLOOR_KINDS).toEqual(["shallow-water"]);
    expect([...ALPHA_WALL_KINDS].sort()).toEqual(["glass", "water-wall"]);
  });

  it("no opaque surface of any skin declares alpha", () => {
    for (const skin of SKINS) {
      // Walls: only glass / water-wall may set opacity < 1.
      if (!(ALPHA_WALL_KINDS as readonly string[]).includes(skin.wall.kind)) {
        expect(
          skin.wall.opacity ?? 1,
          `${skin.id}: ${skin.wall.kind} wall must stay opaque`,
        ).toBe(1);
      }
      // Floors carry no opacity field at all (only ALPHA_FLOOR_KINDS
      // render water, and the renderer derives the depth tint from the
      // shared WATER_* tuning, never from a skin alpha).
      expect("opacity" in skin.floor).toBe(false);
      // Window/fog colours are always opaque.
      for (const c of [...Object.values(skin.window.day), ...Object.values(skin.window.night)]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("the one alpha skin is the shallows: water wall + wadeable floor", () => {
    const shallows = skinById("shallows")!;
    expect(shallows.wall.kind).toBe("water-wall");
    expect(shallows.wall.opacity).toBeLessThan(1);
    expect(shallows.floor.kind).toBe("shallow-water");
    expect(shallows.floor.walk).toBe("wade");
    for (const skin of SKINS) {
      if (skin.id === "shallows") continue;
      expect(skin.wall.opacity ?? 1).toBe(1);
    }
  });
});

describe("skins are pairwise distinguishable", () => {
  it("no two skins share their signature tuple", () => {
    const signatures = SKINS.map(
      (s) =>
        `${s.floor.kind}|${s.wall.kind}|${s.window.day.sky}|${s.fog.day}|${s.light.register}|${s.light.tint ?? ""}`,
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("window skies, fog tints, floor/wall kinds, silhouettes and horizons all differ", () => {
    const column = (f: (s: BiomeSkin) => string): void => {
      const values = SKINS.map(f);
      expect(new Set(values).size, values.join(" vs ")).toBe(values.length);
    };
    column((s) => s.window.day.sky);
    column((s) => s.fog.day);
    column((s) => s.floor.kind);
    column((s) => s.wall.kind);
    column((s) => s.window.silhouette);
    column((s) => s.fog.horizon);
  });
});

describe("debug force: dbg-skin prefix (P3 acceptance switch)", () => {
  it("parses the skin segment, alone or composed", () => {
    expect(parseDebugSkin("dbg-skin:dune")).toBe("dune");
    expect(parseDebugSkin("dbg-skin:dune+dbg-m:living")).toBe("dune");
    expect(parseDebugSkin("dbg-m:living")).toBeNull();
    expect(parseDebugSkin("dbg-skin:")).toBeNull();
    expect(parseDebugSkin("dbg-skinned:foo")).toBeNull();
    expect(parseDebugSkin("2026-09-15-0746")).toBeNull();
  });

  it("composes with a unit pin: the pin parses exactly as without the skin", () => {
    expect(parseDebugSlice("dbg-skin:dune+dbg-m:living")).toEqual({
      page: "modules",
      id: "living",
    });
    expect(parseDebugSlice("dbg-skin:grove+dbg-t:reading-hall")).toEqual(
      parseDebugSlice("dbg-t:reading-hall"),
    );
    // The bare skin pins no unit — null, like every real memory slice.
    expect(parseDebugSlice("dbg-skin:dune")).toBeNull();
    // Without a skin segment nothing changed:
    expect(parseDebugSlice("dbg-m:living")).toEqual({
      page: "modules",
      id: "living",
    });
  });

  it("forces the module pin AND the skin together in the real pipeline", () => {
    const recipe = compileSpaceRecipe("dbg-skin:dune+dbg-m:living");
    expect(recipe.worldClass).toBe("interior");
    const composition = compositionForRecipe(recipe);
    expect(composition?.modules.map((m) => m.module.id)).toEqual(["living"]);
    expect(skinForSlice(recipe.sliceId)?.id).toBe("dune");
  });

  it("answers null on the default path — real slices never wear a skin", () => {
    for (const id of [
      "2026-09-15-0746",
      "core",
      "dbg-m:living",
      "dbg-t:reading-hall",
      "dbg-a:library",
      "dbg-skin:volcano",
    ]) {
      expect(skinForSlice(id), id).toBeNull();
    }
  });
});

describe("A6: same slice, same skin, same outline", () => {
  it("resolves a forced skin deterministically", () => {
    const id = "dbg-skin:grove+dbg-m:living";
    expect(skinForSlice(id)).toBe(skinForSlice(id));
    expect(skinForSlice(id)?.id).toBe("grove");
  });

  it("the room outline is identical across repeated calls", () => {
    const id = "dbg-skin:shallows+dbg-m:living";
    const first = describeRoom(id);
    describeRoom("dbg-m:bedroom");
    describeRoom("2026-09-15-0746");
    const second = describeRoom(id);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.skin?.id).toBe("shallows");
    expect(second.skin?.overrides).toContainEqual({
      role: "coffeetable",
      feature: "fountain",
    });
  });

  it("a real slice's outline stays skinless and unchanged", () => {
    const id = "2026-09-15-0746";
    const desc = describeRoom(id);
    expect(desc.skin).toBeNull();
    expect(JSON.stringify(describeRoom(id))).toBe(JSON.stringify(desc));
  });

  it("formats the skin in both locales with matching line counts", () => {
    const id = "dbg-skin:dune+dbg-m:living";
    const en = formatRoomDescription(describeRoom(id), "en");
    const zh = formatRoomDescription(describeRoom(id), "zh");
    expect(en).toContain("Skin: dune");
    expect(en).toContain("floor: sand");
    expect(zh).toContain("环境皮肤：dune");
    expect(zh).toContain("沙地");
    expect(zh).toContain("岩壁");
    expect(zh).toContain("沙丘");
    expect(zh).toContain("槽位替换");
    expect(zh.split("\n")).toHaveLength(en.split("\n").length);
    // The default path gains no line:
    const plain = "2026-09-15-0746";
    expect(formatRoomDescription(describeRoom(plain), "en")).not.toContain("Skin:");
  });
});
