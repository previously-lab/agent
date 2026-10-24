import { describe, expect, it } from "vitest";
import {
  deriveRoomProfile,
  NEUTRAL_ROOM_PROFILE,
  type FunctionalRoomActivity,
  type RoomPrimaryModule,
} from "@/lib/game/room-profile";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  auditComposition,
  compositionForRecipe,
} from "@/lib/game/room-modules";
import { scaledRecipeFor } from "@/lib/game/room-plan";
import {
  describeRoom,
  formatRoomDescription,
} from "@/lib/game/describe-room";
import { WORLD_SEED } from "@/lib/game/seed";

const ACTIVITY_INPUTS: {
  activity: FunctionalRoomActivity;
  focus: string;
  primaryModule: RoomPrimaryModule;
  archetype: "hotel-room" | "library";
}[] = [
  { activity: "writing", focus: "撰写小说", primaryModule: "study", archetype: "hotel-room" },
  { activity: "research", focus: "阅读文献", primaryModule: "reading-room", archetype: "library" },
  { activity: "making", focus: "修复代码", primaryModule: "workshop", archetype: "hotel-room" },
  { activity: "planning", focus: "安排计划", primaryModule: "study", archetype: "hotel-room" },
  { activity: "conversation", focus: "聊聊相处", primaryModule: "living", archetype: "hotel-room" },
  { activity: "reflection", focus: "回顾日记", primaryModule: "sunroom", archetype: "hotel-room" },
];

describe("profile-aware space compilation", () => {
  it("keeps omitted and neutral profiles byte-for-byte on the legacy fallback", () => {
    for (const sliceId of ["2026-10-01-0900", "2026-10-02-1015", "not-a-record"]) {
      const legacy = compileSpaceRecipe(sliceId, WORLD_SEED);
      expect(compileSpaceRecipe(sliceId, WORLD_SEED, NEUTRAL_ROOM_PROFILE)).toEqual(legacy);
      expect("profile" in legacy).toBe(false);
    }
  });

  it("keeps the debug gallery ahead of semantic profiles", () => {
    const sliceId = "dbg-m:study";
    const gallery = compileSpaceRecipe(sliceId, WORLD_SEED);
    const semantic = compileSpaceRecipe(
      sliceId,
      WORLD_SEED,
      deriveRoomProfile({ focus: "修复代码" }),
    );
    expect(semantic).toEqual(gallery);
    expect(compositionForRecipe(semantic)?.modules.map((placed) => placed.module.id)).toEqual([
      "study",
    ]);
  });

  it.each(ACTIVITY_INPUTS)(
    "pins $activity to a compatible archetype and primary module",
    ({ activity, focus, primaryModule, archetype }) => {
      const profile = deriveRoomProfile({ focus });
      expect(profile.activity).toBe(activity);
      const recipe = compileSpaceRecipe("2026-10-24-0930", WORLD_SEED, profile);
      expect(recipe.worldClass).toBe("interior");
      expect(recipe.archetype).toBe(archetype);
      expect(recipe.size.id).toBe("S");
      expect(recipe.profile).toEqual(profile);

      for (const doorCount of [0, 2, 5]) {
        const composition = compositionForRecipe(recipe, WORLD_SEED, doorCount);
        expect(composition).not.toBeNull();
        if (!composition) return;
        expect(composition.modules[0].module.id).toBe(primaryModule);
        expect(composition.modules[0].primary).toBe(true);
        expect(composition.modules.length).toBeLessThanOrEqual(3);
        expect(composition.modules.map((placed) => placed.module.id)).not.toContain("bath");
        expect(composition.modules.map((placed) => placed.module.id)).not.toContain("pool-deck");
        expect(auditComposition(composition)).toEqual([]);
        if (doorCount === 0) expect(composition.modules).toHaveLength(1);
      }
    },
  );

  it("gives one ID different functional modules from different real activities", () => {
    const sliceId = "2026-10-24-1030";
    const writing = compileSpaceRecipe(
      sliceId,
      WORLD_SEED,
      deriveRoomProfile({ focus: "写作" }),
    );
    const making = compileSpaceRecipe(
      sliceId,
      WORLD_SEED,
      deriveRoomProfile({ focus: "开发" }),
    );
    const legacy = compileSpaceRecipe(sliceId, WORLD_SEED);
    expect(compositionForRecipe(writing)?.modules[0].module.id).toBe("study");
    expect(compositionForRecipe(making)?.modules[0].module.id).toBe("workshop");
    expect(writing.layoutSeed).toBe(legacy.layoutSeed);
    expect(making.layoutSeed).toBe(legacy.layoutSeed);
    expect(writing.lightSeed).toBe(legacy.lightSeed);
    expect(making.lightSeed).toBe(legacy.lightSeed);
    expect(writing.palette).toEqual(legacy.palette);
    expect(making.palette).toEqual(legacy.palette);
  });

  it("does not reseed layout or composition from text, punctuation or semantic revision", () => {
    const sliceId = "2026-10-24-1130";
    const a = deriveRoomProfile({ focus: "写 作！" });
    const b = deriveRoomProfile({ focus: "写作" });
    expect(a).toEqual(b);
    expect(compileSpaceRecipe(sliceId, WORLD_SEED, a)).toEqual(
      compileSpaceRecipe(sliceId, WORLD_SEED, b),
    );

    const moreEvidence = deriveRoomProfile({ focus: "写作", tags: ["创作"] });
    expect(moreEvidence.activity).toBe(a.activity);
    expect(moreEvidence.revision).not.toBe(a.revision);
    const recipeA = compileSpaceRecipe(sliceId, WORLD_SEED, a);
    const recipeB = compileSpaceRecipe(sliceId, WORLD_SEED, moreEvidence);
    const { profile: _profileA, ...spaceA } = recipeA;
    const { profile: _profileB, ...spaceB } = recipeB;
    expect(spaceA).toEqual(spaceB);
    expect(compositionForRecipe(recipeA)).toEqual(compositionForRecipe(recipeB));
  });
});

describe("describeRoom semantic parity", () => {
  it("returns the exact recipe and profile shared with composition and geometry", () => {
    const sliceId = "2026-10-24-1230";
    const profile = deriveRoomProfile({ focus: "修复登录缺陷" });
    const options = { profile, strandDoors: 3, corridorSide: "north" as const };
    const description = describeRoom(sliceId, options);
    const recipe = compileSpaceRecipe(sliceId, WORLD_SEED, profile);
    const composition = compositionForRecipe(recipe, WORLD_SEED, 3);
    const scaled = scaledRecipeFor(recipe, 3).recipe;

    expect(description.recipe).toEqual(recipe);
    expect(description.profile).toEqual(profile);
    expect(description.width).toBe(scaled.width);
    expect(description.extent).toBe(scaled.size.extent);
    expect(composition).not.toBeNull();
    expect(description.layout.kind).toBe("modules");
    if (description.layout.kind === "modules" && composition) {
      expect(description.layout.modules.map((module) => module.id)).toEqual(
        composition.modules.map((placed) => placed.module.id),
      );
      expect(description.layout.modules.find((module) => module.primary)?.id).toBe("workshop");
    }
    expect(description.doors.placed?.doors).toHaveLength(3);

    const en = formatRoomDescription(description, "en");
    const zh = formatRoomDescription(description, "zh");
    for (const text of [en, zh]) {
      expect(text).toContain(profile.ruleVersion);
      expect(text).toContain(profile.revision);
      expect(text).toContain("workshop");
      expect(text).not.toContain("登录缺陷");
    }
    expect(en).toContain("Activity: making");
    expect(zh).toContain("功能：制作/修复");
  });

  it("describes the unchanged legacy recipe for a neutral profile", () => {
    const sliceId = "2026-10-24-1330";
    const description = describeRoom(sliceId, { profile: NEUTRAL_ROOM_PROFILE });
    expect(description.profile).toBe(NEUTRAL_ROOM_PROFILE);
    expect(description.recipe).toEqual(compileSpaceRecipe(sliceId, WORLD_SEED));
    expect(formatRoomDescription(description)).not.toContain("Activity:");
  });
});
