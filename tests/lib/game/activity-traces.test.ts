import { describe, expect, it } from "vitest";
import {
  activityTraceFor, activityTraceFits, resolveActivityDressing,
  type ActivityTraceHost, type ActivityTraceItem, type ActivityTraceKind,
} from "@/lib/game/activity-traces";
import {
  ACTIVITY_FOOTPRINTS, ACTIVITY_SUPPORTS, ACTIVITY_SURFACE_HEIGHTS,
} from "@/lib/game/prop-dimensions";
import { KITS, placeKit, stageInteriorKits, planArea } from "@/lib/game/kits";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { deriveRoomProfile } from "@/lib/game/room-profile";
import { composeRoom, roomPlanFor, scaledRecipeFor } from "@/lib/game/room-plan";
import { compositionForRecipe, compositionKitZonesFor, compositionTemplateFor } from "@/lib/game/room-modules";
import { schematicPlacementsFor } from "@/lib/game/room-schematic";
import { templatePlanFor } from "@/lib/game/room-templates";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import { COLONNADE_BAY, PROP_SCALE_EXP, ROOM_WALL_THICKNESS } from "@/lib/game/tuning/room";

function actualKit(id: string, scale = 1, rotY = 0): ActivityTraceHost[] {
  const kit = KITS.find((k) => k.id === id)!;
  expect(kit).toBeDefined();
  return placeKit(kit, { x: 3, z: 5, scale, rotY }).map((p, i) => ({
    ...p, y: .1 + p.dy, kitIndex: 0, instanceId: `${id}:${i}`,
  }));
}

function supportFor(trace: ActivityTraceItem, pieces: readonly ActivityTraceHost[]) {
  const host = pieces.find((p) => p.instanceId === trace.instanceId)!;
  expect(host).toBeDefined();
  return host;
}

/** Independently project all drawn silhouette corners into the host.
 * This checks whole sheets, not merely the chosen placement origin. */
function expectWholeTraceSupported(trace: ActivityTraceItem, host: ActivityTraceHost) {
  const c = Math.cos(host.rotY), s = Math.sin(host.rotY);
  const dx = (trace.x - host.x) / host.scale, dz = (trace.z - host.z) / host.scale;
  const cx = dx * c - dz * s, cz = dx * s + dz * c;
  const yaw = trace.rotY - host.rotY, yc = Math.cos(yaw), ys = Math.sin(yaw);
  const support = ACTIVITY_SUPPORTS[host.kind];
  for (const shape of ACTIVITY_FOOTPRINTS[trace.kind]) {
    const sx = cx + shape.x * yc + shape.z * ys;
    const sz = cz - shape.x * ys + shape.z * yc;
    if (shape.shape === "circle") {
      expect(Math.abs(sx) + shape.radius).toBeLessThanOrEqual(support.hx + 1e-9);
      expect(Math.abs(sz) + shape.radius).toBeLessThanOrEqual(support.hz + 1e-9);
    } else {
      const a = yaw + shape.rotY;
      for (const x of [-shape.hx, shape.hx]) for (const z of [-shape.hz, shape.hz]) {
        expect(Math.abs(sx + x * Math.cos(a) + z * Math.sin(a))).toBeLessThanOrEqual(support.hx + 1e-9);
        expect(Math.abs(sz - x * Math.sin(a) + z * Math.cos(a))).toBeLessThanOrEqual(support.hz + 1e-9);
      }
    }
  }
  expect(trace.y).toBeCloseTo(host.y + ACTIVITY_SURFACE_HEIGHTS[host.kind] * host.scale, 10);
}

describe("activity traces on actual authored kits", () => {
  const cases: [ActivityTraceKind, string][] = [
    ["writing", "writing-desk"], ["research", "writing-desk"],
    ["planning", "writing-desk"], ["making", "workbench-corner"],
    ["conversation", "reading"], ["reflection", "coat-bench"],
  ];
  it.each(cases)("%s survives real %s dressing at several scales and orientations", (activity, kitId) => {
    for (const scale of [.25, 1, 1.7]) for (const yaw of [0, Math.PI / 3, Math.PI]) {
      const pieces = actualKit(kitId, scale, yaw);
      const trace = activityTraceFor(activity, "fictional-record", pieces);
      expect(trace, `${activity}, scale=${scale}, yaw=${yaw}`).not.toBeNull();
      if (!trace) continue;
      const host = supportFor(trace, pieces);
      expectWholeTraceSupported(trace, host);
      expect(activityTraceFits(trace, host, pieces)).toBe(true);
      expect(activityTraceFor(activity, "fictional-record", pieces)).toEqual(trace);
    }
  });

  it("the same local arrangement scales and rotates together, including occupancy", () => {
    const base = activityTraceFor("making", "same-record", actualKit("workbench-corner"))!;
    for (const scale of [.25, 1.7]) {
      const yaw = Math.PI / 3;
      const transformed = activityTraceFor("making", "same-record", actualKit("workbench-corner", scale, yaw))!;
      const x = (base.x - 3) * scale, z = (base.z - 5) * scale;
      expect(transformed.x).toBeCloseTo(3 + x * Math.cos(yaw) + z * Math.sin(yaw), 10);
      expect(transformed.z).toBeCloseTo(5 - x * Math.sin(yaw) + z * Math.cos(yaw), 10);
      expect(transformed.rotY).toBeCloseTo(base.rotY + yaw, 10);
    }
  });

  it("semantic traces replace the old automatic trace without deleting authored lamps/piles", () => {
    const pieces = actualKit("writing-desk");
    const desk = pieces.find((p) => p.kind === "desk")!;
    const oldTrace = { ...desk, kind: "bookpile", y: desk.y + .8, trace: true, instanceId: "old-trace" };
    const input = [...pieces, oldTrace];
    const result = resolveActivityDressing("writing", "record", input);
    expect(result.trace).not.toBeNull();
    expect(result.furniture).toEqual(pieces);
    expect(result.furniture.some((p) => p.kind === "desklamp")).toBe(true);
    expect(result.furniture.some((p) => p.kind === "bookpile")).toBe(true);
    expect(input).toHaveLength(pieces.length + 1);
    expect(resolveActivityDressing("neutral", "record", input).furniture).toBe(input);
    expect(resolveActivityDressing("making", "record", input)).toEqual({ furniture: input, trace: null });
  });
});

function stageSemanticRoom(focus: string) {
  const id = "2026-10-24-0930";
  const profile = deriveRoomProfile({ focus });
  const recipe = compileSpaceRecipe(id, WORLD_SEED, profile);
  const { recipe: scaled, scale } = scaledRecipeFor(recipe, 0);
  const composition = compositionForRecipe(recipe, WORLD_SEED, 0)!;
  const template = compositionTemplateFor(composition);
  const plan = roomPlanFor(id, scaled.width, scaled.size.extent,
    COLONNADE_BAY * Math.sqrt(Math.max(scale.factor, .35)), WORLD_SEED, templatePlanFor(template));
  const staged = stageInteriorKits({
    rng: createRng(deriveSubSeed(WORLD_SEED, id, "furniture")),
    worldClass: "interior", archetype: recipe.archetype, plan,
    comp: composeRoom(id, plan, scale.factor),
    baseExtent: recipe.size.extent, baseArea: planArea(plan) / scale.factor ** 2,
    propScale: scale.factor ** PROP_SCALE_EXP,
    wallThick: ROOM_WALL_THICKNESS * Math.max(scale.factor, .35),
    water: null, doors: [], obstacles: [], skin: null,
    kitIds: [...new Set(composition.modules.flatMap((p) => p.module.kits))],
    schematics: schematicPlacementsFor(composition.modules, scale.factor),
    zones: compositionKitZonesFor(composition, plan),
    openFields: composition.openFields.map((f) => ({
      x0: f.x0 * scale.factor, x1: f.x1 * scale.factor,
      z0: f.z0 * scale.factor, z1: f.z1 * scale.factor,
    })),
    heightAt: () => 0,
  }).map((p, i) => ({ ...p, instanceId: `${p.kitId}:${p.kitIndex}:${i}` }));
  return { id, profile, staged };
}

describe("six semantic rooms use the actual composition and staging chain", () => {
  it.each([
    ["writing", "撰写小说"], ["research", "阅读文献"], ["making", "修复代码"],
    ["planning", "安排计划"], ["conversation", "聊聊相处"], ["reflection", "回顾日记"],
  ])("%s has a visible, supported trace in its real functional room", (activity, focus) => {
    const { id, profile, staged } = stageSemanticRoom(focus);
    expect(profile.activity).toBe(activity);
    const result = resolveActivityDressing(profile.activity, id, staged);
    expect(result.trace, `${activity}: ${staged.map((p) => p.kind).join(",")}`).not.toBeNull();
    if (!result.trace) return;
    const host = supportFor(result.trace, result.furniture);
    expectWholeTraceSupported(result.trace, host);
    expect(activityTraceFits(result.trace, host, result.furniture)).toBe(true);
    expect(result.furniture.some((p) => p.trace === true)).toBe(false);
  });
});

describe("intrinsic obstacles and true support surfaces", () => {
  it("keeps a diary clear of the nightstand's built-in lamp", () => {
    const pieces = actualKit("reading");
    const trace = activityTraceFor("reflection", "diary", pieces)!;
    expect(trace).not.toBeNull();
    const host = supportFor(trace, pieces);
    expectWholeTraceSupported(trace, host);
    expect(activityTraceFits(trace, host, pieces)).toBe(true);
    expect(activityTraceFits({ ...trace, x: host.x, z: host.z }, host, pieces)).toBe(false);
  });

  it("rejects central paper/cups intersecting the dining table's built-in bowl", () => {
    const host: ActivityTraceHost = { kind: "diningtable", x: 0, y: 0, z: 0, rotY: 0, scale: 1 };
    for (const kind of ["planning", "conversation"] as const) {
      expect(activityTraceFits({ kind, x: 0, y: .7875, z: 0, rotY: 0, scale: 1, instanceId: "test" }, host, [host])).toBe(false);
    }
  });

  it("rejects a planning paper whose center is on the desk but whose edge is outside", () => {
    const desk: ActivityTraceHost = { kind: "desk", x: 0, y: 0, z: 0, rotY: 0, scale: 1 };
    expect(activityTraceFits({ kind: "planning", x: 0, y: .8, z: .27, rotY: 0, scale: 1, instanceId: "test" }, desk, [desk])).toBe(false);
  });

  it("places books above the measured bench board and pool slats, not inside them", () => {
    expect(ACTIVITY_SURFACE_HEIGHTS.bench).toBeCloseTo(.46 + .08 / 2, 10);
    expect(ACTIVITY_SURFACE_HEIGHTS.diningtable).toBeCloseTo(.775 + .025 / 2, 10);
    expect(ACTIVITY_SURFACE_HEIGHTS.poolbench).toBeCloseTo(.385 + .045 / 2, 10);
  });

  it("tries the next support when the first is fully covered; no legal support remains null", () => {
    const first: ActivityTraceHost = { kind: "desk", x: 0, y: 0, z: 0, rotY: 0, scale: 1, instanceId: "blocked" };
    const covering: ActivityTraceHost = { kind: "bookpile", x: 0, y: .8, z: 0, rotY: 0, scale: 10 };
    const second: ActivityTraceHost = { ...first, x: 20, instanceId: "free" };
    expect(activityTraceFor("writing", "record", [first, covering])).toBeNull();
    expect(activityTraceFor("writing", "record", [first, covering, second])?.instanceId).toBe("free");
    expect(activityTraceFor("neutral", "record", [first])).toBeNull();
    expect(activityTraceFor("making", "record", [first])).toBeNull();
  });
});
