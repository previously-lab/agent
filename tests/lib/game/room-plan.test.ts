/**
 * Tests for the room-language module (v0.11 §3): scale notation, plan
 * variation, and composition. The contract under test: everything is a
 * deterministic pure function of (worldSeed, sliceId, dims) — same memory,
 * same room, on any machine (axiom A6) — and the structural invariants the
 * renderer relies on always hold: the entrance doorway is never narrowed,
 * scale factors stay inside the §3 notation ranges, the hero sits in the
 * far third, and the walk path/clusters respect each other.
 */
import { describe, it, expect } from "vitest";
import {
  composeRoom,
  distToPath,
  planContains,
  roomPlanFor,
  scaleNotationFor,
  scaledRecipeFor,
  scaledWallHeight,
  wallRoleFor,
  wallSegmentsFor,
  type RoomPlan,
} from "@/lib/game/room-plan";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  compositionForRecipe,
  TIER_MODULE_COUNTS,
} from "@/lib/game/room-modules";
import { hashString, WORLD_SEED } from "@/lib/game/seed";
import {
  DOOR_GAP_HALF,
  PLAN_NONRECT_MIN_EXTENT,
  PORTAL_HEIGHT,
  ROOM_WALL_THICKNESS,
  WALL_HEIGHT_MAX,
  WALL_HEIGHT_MIN,
} from "@/lib/game/tuning/room";

/** 400 fixed slice ids — deterministic input, not Math.random(). */
const SLICE_IDS = Array.from({ length: 400 }, (_, i) => `2026-09-${i}`);

const COLONNADE_BAY = 4;

describe("scaleNotationFor", () => {
  it("is deterministic per sliceId", () => {
    for (const sliceId of SLICE_IDS.slice(0, 30)) {
      expect(scaleNotationFor(sliceId)).toEqual(scaleNotationFor(sliceId));
    }
  });

  it("draws the single human-scale tier for every slice (v0.13)", () => {
    // 尺度收敛: the tier draw is retired — no slice may roll a giant or
    // miniature room; factor is identically 1 (and the "scale" stream is
    // never read, so no other facet's stream is perturbed).
    for (const sliceId of SLICE_IDS) {
      expect(scaleNotationFor(sliceId)).toEqual({ id: "normal", factor: 1 });
    }
  });
});

describe("scaledRecipeFor", () => {
  it("is the identity view for rooms without a composition", () => {
    // 世界分类收口（2026-09）：非标准间从注册表下架、世界只留室内 —
    // every real slice is interior now and takes its plan dims from a
    // module composition, so scaledRecipeFor always rebuilds the recipe
    // for them. The no-copy identity promise survives exactly where the
    // world class resolves no composition: the debug gallery's nature /
    // wonder archetype pins (dbg-a:), which still reach those dormant
    // worlds (space-types.ts's biome/wonder lists are untouched data).
    for (const sliceId of ["dbg-a:meadow", "dbg-a:ducks"]) {
      const recipe = compileSpaceRecipe(sliceId);
      const { recipe: view, scale } = scaledRecipeFor(recipe);
      expect(compositionForRecipe(recipe)).toBeNull();
      if (scale.factor === 1) {
        expect(view).toBe(recipe);
      }
    }
  });

  it("multiplies only the plan dims by the factor", () => {
    for (const sliceId of SLICE_IDS.slice(0, 40)) {
      const recipe = compileSpaceRecipe(sliceId);
      const { recipe: view, scale } = scaledRecipeFor(recipe);
      // Modular rooms (§8): interior rooms take their plan dims from the
      // module composition, not the tier — the factor multiplies THOSE.
      const composition = compositionForRecipe(recipe);
      const baseWidth = composition ? composition.width : recipe.width;
      const baseExtent = composition ? composition.extent : recipe.size.extent;
      expect(view.width).toBeCloseTo(baseWidth * scale.factor, 10);
      expect(view.size.extent).toBeCloseTo(baseExtent * scale.factor, 10);
      expect(view.size.id).toBe(recipe.size.id);
      expect(view.sliceId).toBe(recipe.sliceId);
      expect(view.palette).toEqual(recipe.palette);
      expect(view.layoutSeed).toBe(recipe.layoutSeed);
    }
  });

  it("leaves non-interior rooms byte-identical (no composition)", () => {
    for (const sliceId of SLICE_IDS) {
      const recipe = compileSpaceRecipe(sliceId);
      if (recipe.worldClass === "interior") continue;
      const { recipe: view, scale } = scaledRecipeFor(recipe);
      expect(compositionForRecipe(recipe)).toBeNull();
      expect(view.width).toBeCloseTo(recipe.width * scale.factor, 10);
      expect(view.size.extent).toBeCloseTo(recipe.size.extent * scale.factor, 10);
      if (scale.factor === 1) expect(view).toBe(recipe);
    }
  });

  it("sizes interior rooms by their composition, scaled like any dims", () => {
    let composed = 0;
    for (const sliceId of SLICE_IDS) {
      const recipe = compileSpaceRecipe(sliceId);
      const composition = compositionForRecipe(recipe);
      if (!composition) continue;
      composed += 1;
      const { recipe: view, scale } = scaledRecipeFor(recipe);
      expect(view.width).toBeCloseTo(composition.width * scale.factor, 10);
      expect(view.size.extent).toBeCloseTo(composition.extent * scale.factor, 10);
      // §8.3 convergence: the tier hints the module count (S=1, M=2, L=3,
      // XL=4) — more modules, never a bigger one. The hint is a REQUEST:
      // an archetype-gated catalogue may not supply four joinable modules
      // (a pool-hall's companions are few), so the resolver falls down
      // deterministically — L/XL land at 3–4, S stays a single module.
      if (recipe.size.id === "S") {
        expect(composition.modules.length).toBe(1);
      } else {
        expect(composition.modules.length).toBeGreaterThanOrEqual(2);
        expect(composition.modules.length).toBeLessThanOrEqual(4);
      }
    }
    // The 400-slice sample draws interior at 25% — far above the noise floor.
    expect(composed).toBeGreaterThan(40);
  });
});

describe("scaledWallHeight", () => {
  it("stays human at factor 1 and clamped at the extremes", () => {
    expect(scaledWallHeight(1)).toBeCloseTo(4, 5);
    expect(scaledWallHeight(20)).toBeLessThanOrEqual(WALL_HEIGHT_MAX);
    expect(scaledWallHeight(0.2)).toBeGreaterThanOrEqual(WALL_HEIGHT_MIN);
  });

  it("leaves the ×1 draw on the S^0.5 curve", () => {
    // The portal floor (3.5m) only binds below factor ~0.77 — nothing the
    // single ×1 draw can reach — and the curve tops out far under
    // WALL_HEIGHT_MAX at any factor a future draw might add.
    expect(scaledWallHeight(1)).toBeCloseTo(4 * Math.sqrt(1), 5);
    expect(scaledWallHeight(2.5)).toBeCloseTo(4 * Math.sqrt(2.5), 5);
    expect(scaledWallHeight(3.5)).toBeCloseTo(4 * Math.sqrt(3.5), 5);
    // The clamp rail still works for any larger factor a future draw adds.
    expect(scaledWallHeight(20)).toBe(WALL_HEIGHT_MAX);
  });

  it("never lets small-room walls drop below the unscaled doorway", () => {
    // The door never scales (A4 human-scale anchor), so the wall must
    // always contain the 3.2m portal — the invariant the old 0.05 floor
    // silently violated. Sweep the retired miniature band, endpoints
    // included: the portal floor holds across all of it.
    for (let i = 0; i <= 100; i++) {
      const factor = 0.2 + (i / 100) * 0.15;
      expect(scaledWallHeight(factor)).toBeGreaterThanOrEqual(PORTAL_HEIGHT);
    }
    expect(scaledWallHeight(1)).toBeGreaterThanOrEqual(PORTAL_HEIGHT);
  });
});

describe("roomPlanFor", () => {
  it("is deterministic per (sliceId, dims)", () => {
    for (const sliceId of SLICE_IDS.slice(0, 20)) {
      const a = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      expect(roomPlanFor(sliceId, 48, 64, COLONNADE_BAY)).toEqual(a);
    }
  });

  it("never gives small tiers a non-rectangular plan (anti-cramp)", () => {
    for (const sliceId of SLICE_IDS) {
      const plan = roomPlanFor(sliceId, 16, 16, COLONNADE_BAY);
      expect(plan.id).toBe("rect");
      const small = roomPlanFor(sliceId, 21, PLAN_NONRECT_MIN_EXTENT - 1, COLONNADE_BAY);
      expect(small.id).toBe("rect");
    }
  });

  it("produces all three plan kinds across a slice sample", () => {
    const kinds = new Set<string>();
    for (const sliceId of SLICE_IDS) {
      kinds.add(roomPlanFor(sliceId, 48, 64, COLONNADE_BAY).id);
    }
    expect(kinds).toContain("rect");
    expect(kinds).toContain("l-shape");
    expect(kinds).toContain("colonnade");
  });

  it("keeps the doorway inside the walkable footprint on every plan", () => {
    for (const sliceId of SLICE_IDS) {
      const plan = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      // The door axis just inside the threshold must always be walkable.
      expect(planContains(plan, 0, 1, 0.1)).toBe(true);
      expect(planContains(plan, DOOR_GAP_HALF * 0.5, 0.5, 0.1)).toBe(true);
    }
  });

  it("l-shape abandons exactly one far quadrant", () => {
    for (const sliceId of SLICE_IDS) {
      const plan = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      if (plan.id !== "l-shape") continue;
      expect(plan.stepZ).toBeGreaterThan(64 * 0.4);
      expect(plan.stepZ).toBeLessThan(64 * 0.65);
      const keptX = plan.lSide * 12;
      const lostX = -plan.lSide * 12;
      // Before the step both halves exist; beyond it only the kept half.
      expect(planContains(plan, keptX, plan.stepZ - 2, 0.5)).toBe(true);
      expect(planContains(plan, lostX, plan.stepZ - 2, 0.5)).toBe(true);
      expect(planContains(plan, keptX, plan.stepZ + 6, 0.5)).toBe(true);
      expect(planContains(plan, lostX, plan.stepZ + 6, 0.5)).toBe(false);
      // The kept leg is never a cramped corridor: at least a quarter of the
      // bounding width on the room side of the inner wall.
      expect(plan.width / 2).toBeGreaterThanOrEqual(4);
    }
  });

  it("colonnade fills the bounding rect and rows columns on both sides", () => {
    for (const sliceId of SLICE_IDS) {
      const plan = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      if (plan.id !== "colonnade") continue;
      expect(planContains(plan, -20, 40, 0.5)).toBe(true);
      expect(plan.columns.length).toBeGreaterThanOrEqual(4);
      expect(plan.columns.length % 2).toBe(0);
      for (const c of plan.columns) {
        expect(Math.abs(Math.abs(c.x) - 24)).toBeLessThan(1e-9);
        expect(c.z).toBeGreaterThan(0);
        expect(c.z).toBeLessThan(64);
      }
    }
  });
});

describe("wallSegmentsFor", () => {
  const plans = SLICE_IDS.map((id) => roomPlanFor(id, 48, 64, COLONNADE_BAY));

  it("always leaves the 2.4m doorway gap in the entrance edge", () => {
    for (const plan of plans) {
      const segs = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
      const entrance = segs.filter((s) => s.entrance);
      expect(entrance).toHaveLength(2);
      // No entrance segment may intrude into |x| < DOOR_GAP_HALF.
      for (const s of entrance) {
        expect(Math.abs(s.x) - s.sizeX / 2).toBeGreaterThanOrEqual(DOOR_GAP_HALF - 1e-9);
        expect(s.z).toBeLessThan(1);
      }
    }
  });

  it("rect reproduces the legacy five-segment enclosure", () => {
    const rect = roomPlanFor("rect-probe", 48, 64, COLONNADE_BAY);
    expect(rect.id).toBe("rect");
    const segs = wallSegmentsFor(rect, ROOM_WALL_THICKNESS);
    // 2 entrance + 2 sides + 1 far.
    expect(segs).toHaveLength(5);
    const far = segs.find((s) => !s.entrance && s.z > 60);
    expect(far).toBeDefined();
  });

  it("keeps every segment inside the bounding box (plus corner overlap)", () => {
    for (const plan of plans) {
      const segs = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
      for (const s of segs) {
        expect(Math.abs(s.x) - s.sizeX / 2).toBeLessThanOrEqual(plan.width / 2 + 1e-9);
        expect(s.z - s.sizeZ / 2).toBeGreaterThanOrEqual(-1e-9);
        expect(s.z + s.sizeZ / 2).toBeLessThanOrEqual(plan.extent + 1e-9);
      }
    }
  });

  it("colonnade replaces side walls with open bays", () => {
    for (const plan of plans) {
      if (plan.id !== "colonnade") continue;
      const segs = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
      // Entrance pair + far wall only — no side segments at |x| ≈ halfW
      // running the full depth.
      const sides = segs.filter(
        (s) => !s.entrance && s.sizeZ > plan.extent * 0.5,
      );
      expect(sides).toHaveLength(0);
    }
  });
});

describe("composeRoom", () => {
  it("is deterministic per (sliceId, plan)", () => {
    for (const sliceId of SLICE_IDS.slice(0, 20)) {
      const plan = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      expect(composeRoom(sliceId, plan, 1)).toEqual(composeRoom(sliceId, plan, 1));
    }
  });

  it("puts the hero in the far third, inside the footprint", () => {
    for (const sliceId of SLICE_IDS) {
      const plan = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      expect(comp.hero.z).toBeGreaterThanOrEqual(64 * 0.6);
      expect(comp.hero.z).toBeLessThanOrEqual(64);
      expect(planContains(plan, comp.hero.x, comp.hero.z, 0)).toBe(true);
    }
  });

  it("starts the cleared path at the door and keeps clusters off it", () => {
    for (const sliceId of SLICE_IDS) {
      const plan = roomPlanFor(sliceId, 48, 64, COLONNADE_BAY);
      const comp = composeRoom(sliceId, plan, 1);
      // The path begins AT the door mouth.
      expect(distToPath(comp, 0, 0)).toBeLessThan(1e-9);
      // ...and the doorway strip stays within the cleared half-width.
      expect(distToPath(comp, 0, 0.5)).toBeLessThanOrEqual(comp.pathHalf);
      // The path ends at the hero.
      expect(distToPath(comp, comp.hero.x, comp.hero.z)).toBeLessThan(1e-9);
      expect(comp.clusters.length).toBeGreaterThanOrEqual(1);
      for (const c of comp.clusters) {
        expect(planContains(plan, c.x, c.z, ROOM_WALL_THICKNESS)).toBe(true);
        expect(distToPath(comp, c.x, c.z)).toBeGreaterThanOrEqual(comp.pathHalf);
        expect(Math.hypot(c.x - comp.hero.x, c.z - comp.hero.z)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("widens the path for colossal rooms and narrows it for miniature", () => {
    // ×3.5 = top of the B.12 colossal range — past the clamp(S,…,2) knee,
    // so the widened path still exercises the same clamp the old ×8 hit.
    const wide = composeRoom("probe", roomPlanFor("probe", 168, 224, 7), 3.5);
    const tiny = composeRoom("probe", roomPlanFor("probe", 3, 4, 1.4), 0.1);
    const human = composeRoom("probe", roomPlanFor("probe", 48, 64, COLONNADE_BAY), 1);
    expect(wide.pathHalf).toBeGreaterThan(human.pathHalf);
    expect(tiny.pathHalf).toBeLessThan(human.pathHalf);
  });
});

/* ------------------------------------------------------------------ */
/* Template layer (v0.11-room-interiors §7): the optional TemplatePlan   */
/* parameter and the WallRole classifier. ADDITIVE-ONLY PIN: the hashes  */
/* below were captured from this module BEFORE the parameter existed,    */
/* over the fixed input matrix — omitting it must reproduce today's     */
/* output byte-for-byte.                                                */
/* ------------------------------------------------------------------ */

describe("template plan parameter (§7) — additive", () => {
  const pin = (v: unknown) => {
    const s = JSON.stringify(v);
    return `${s.length}:${hashString(s)}`;
  };
  /** [sliceId, width, extent, "jsonLength:hash"] captured pre-change. */
  const PINS: [string, number, number, string][] = [
    ["2026-10-01", 16, 16, "69:285685599"],
    ["2026-10-02", 32, 32, "69:1603428468"],
    ["2026-10-03", 48, 32, "69:879735255"],
    ["2026-10-04", 64, 64, "69:3973435005"],
    ["2026-10-05", 96, 96, "88:2123447320"],
    ["2026-10-06", 144, 96, "90:1466743983"],
    ["2026-10-07", 21.12, 32, "93:439924525"],
    ["2026-10-08", 64, 64, "69:3973435005"],
  ];

  it("reproduces the pre-template output byte-for-byte when omitted", () => {
    for (const [id, w, e, expected] of PINS) {
      expect(pin(roomPlanFor(id, w, e, COLONNADE_BAY))).toBe(expected);
    }
  });

  it("treats an explicit undefined exactly as omitted", () => {
    for (const [id, w, e] of PINS) {
      expect(roomPlanFor(id, w, e, COLONNADE_BAY, WORLD_SEED, undefined)).toEqual(
        roomPlanFor(id, w, e, COLONNADE_BAY),
      );
    }
  });

  it("declares the silhouette when a template is supplied, deterministically", () => {
    const args = ["2026-10-20", 48, 32, COLONNADE_BAY, WORLD_SEED] as const;
    const l = roomPlanFor(...args, { plan: "l-shape" });
    expect(l.id).toBe("l-shape");
    expect(l.stepZ).toBeGreaterThanOrEqual(32 * 0.45);
    expect(l.stepZ).toBeLessThanOrEqual(32 * 0.6);
    expect(roomPlanFor(...args, { plan: "l-shape" })).toEqual(l); // A6
    const c = roomPlanFor(...args, { plan: "colonnade" });
    expect(c.id).toBe("colonnade");
    expect(c.columns.length).toBeGreaterThan(0);
    expect(roomPlanFor(...args, { plan: "rect" }).id).toBe("rect");
  });

  it("honours the template even below the legacy non-rect extent guard", () => {
    // A miniature M-tier room (scaled extent < 32) keeps its template's
    // layout — sizing is the template's minExtent job, done at selection.
    const plan = roomPlanFor("2026-10-21", 6.4, 6.4, COLONNADE_BAY, WORLD_SEED, {
      plan: "l-shape",
    });
    expect(plan.id).toBe("l-shape");
    // Without the template the same dims draw the legacy S-tier rect.
    expect(roomPlanFor("2026-10-21", 6.4, 6.4, COLONNADE_BAY).id).toBe("rect");
  });
});

describe("wallRoleFor (§7 wall roles)", () => {
  const rolesOf = (plan: RoomPlan) =>
    wallSegmentsFor(plan, ROOM_WALL_THICKNESS).map((w) => wallRoleFor(plan, w));

  it("classifies the rect perimeter", () => {
    expect(rolesOf(roomPlanFor("2026-10-01", 16, 16, COLONNADE_BAY))).toEqual([
      "entrance",
      "entrance",
      "left",
      "right",
      "far",
    ]);
  });

  it("classifies the colonnade perimeter (no side walls at all)", () => {
    const colonnade = roomPlanFor("2026-10-20", 48, 32, COLONNADE_BAY, WORLD_SEED, {
      plan: "colonnade",
    });
    expect(rolesOf(colonnade)).toEqual(["entrance", "entrance", "far"]);
  });

  it("classifies the l-shape perimeter, both kept sides", () => {
    const plus = rolesOf(
      roomPlanFor("2026-10-20", 48, 32, COLONNADE_BAY, WORLD_SEED, { plan: "l-shape" }),
    );
    // lSide is seeded; try a few ids until both signs are covered.
    let sawMinus = plus.includes("inner");
    for (let i = 0; i < 30 && sawMinus; i++) {
      const p = roomPlanFor(`2026-11-${i}`, 48, 32, COLONNADE_BAY, WORLD_SEED, {
        plan: "l-shape",
      });
      if (p.lSide < 0) {
        expect(rolesOf(p)).toEqual([
          "entrance",
          "entrance",
          "left",
          "right",
          "step",
          "inner",
          "left",
          "far",
        ]);
        sawMinus = false;
      }
    }
    expect(sawMinus).toBe(false);
    expect(plus.filter((r) => r === "entrance")).toHaveLength(2);
    expect(plus.filter((r) => r === "step")).toHaveLength(1);
    expect(plus.filter((r) => r === "inner")).toHaveLength(1);
    expect(plus.filter((r) => r === "far")).toHaveLength(1);
  });
});
