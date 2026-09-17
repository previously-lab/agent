/**
 * Tests for the layout-template layer (v0.11-room-interiors §7). The
 * contract under test:
 *
 *  - The §7.5 templates plus Finding B's mid-capacity door hall are sound
 *    DATA: every doorWall / feature attachment exists on the template's
 *    footprint, zones stay normalized, capacity is positive, and the audit
 *    agrees.
 *  - resolveRoomTemplate is deterministic (A6), respects worldClass /
 *    archetype / minExtent / minDoors eligibility, and prefers templates
 *    whose door capacity absorbs the slice's strand-door count (the
 *    20-door day picks the gallery, never the closet). Capacity is
 *    MEASURED (Finding A): when the caller passes capacityFor, selection
 *    steers by min(declared ceiling, the scaled plan's hostable-wall
 *    capacity); omitted, it steers by the ceilings alone — the
 *    pre-measurement behaviour.
 *  - The consumption adapters feed the EXISTING pure modules: the template
 *    plan declares the silhouette, the affordance bans its walls, the zones
 *    resolve to absolute plan coordinates (l-shape zones mirror with the
 *    kept wing).
 *  - The real-data pass runs the full derivation chain over the repo's own
 *    memory/episodic catalogue and PRINTS the per-template numbers —
 *    selection counts, door load vs capacity, clearance violations — the
 *    coordination data for whether the template set covers reality.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  ROOM_TEMPLATES,
  auditTemplate,
  doorAffordanceFor,
  resolveRoomTemplate,
  roomTemplateById,
  templatePlanFor,
  templateZonesFor,
  type RoomTemplate,
} from "@/lib/game/room-templates";
import {
  composeRoom,
  planContains,
  roomPlanFor,
  scaledRecipeFor,
  wallRoleFor,
  wallSegmentsFor,
} from "@/lib/game/room-plan";
import {
  doorCapacityFor,
  hostableWallsFor,
  inDoorApproach,
  placeRoomDoors,
} from "@/lib/game/room-doors";
import { planArea, stageInteriorKits, type KitZones } from "@/lib/game/kits";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { buildStrandGraph, strandDoorsForSlice } from "@/lib/game/strand-graph";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";

const byId = (id: string): RoomTemplate => {
  const t = roomTemplateById(id);
  if (!t) throw new Error(`unknown template ${id}`);
  return t;
};

describe("template data (§7.2/§7.5)", () => {
  it("ships the three §7.5 interior templates plus Finding B's door hall", () => {
    expect(ROOM_TEMPLATES.map((t) => t.id)).toEqual([
      "reading-hall",
      "guest-room",
      "door-hall",
      "gallery",
    ]);
    expect(ROOM_TEMPLATES.map((t) => t.label)).toEqual([
      "阅览厅",
      "客房",
      "列门厅",
      "画廊",
    ]);
  });

  it("passes its own consistency audit", () => {
    for (const t of ROOM_TEMPLATES) {
      expect(auditTemplate(t)).toEqual([]);
    }
  });

  it("keeps zones normalized and gives every template a hero zone", () => {
    for (const t of ROOM_TEMPLATES) {
      expect(t.zones.some((z) => z.kind === "hero")).toBe(true);
      for (const z of t.zones) {
        for (const [a, b] of [z.rect.x, z.rect.z]) {
          expect(a).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThanOrEqual(1);
          expect(a).toBeLessThan(b);
        }
      }
    }
  });

  it("never permits doors on the entrance wall, and declares a capacity", () => {
    for (const t of ROOM_TEMPLATES) {
      expect(t.doorWalls).not.toContain("entrance");
      expect(t.doorCapacity).toBeGreaterThan(0);
      expect(t.weight).toBeGreaterThan(0);
      expect([16, 32, 64, 96]).toContain(t.minExtent);
    }
  });

  it("declares the gallery as the high-capacity door absorber", () => {
    // The 20-door day: one whole wall built to carry many doors.
    const gallery = byId("gallery");
    expect(gallery.footprint).toBe("colonnade");
    expect(gallery.doorWalls).toEqual(["far"]);
    expect(gallery.doorCapacity).toBeGreaterThanOrEqual(20);
    expect(
      Math.max(...ROOM_TEMPLATES.map((t) => t.doorCapacity)),
    ).toBe(gallery.doorCapacity);
  });

  it("declares the door hall as the mid-capacity interior (Finding B)", () => {
    const hall = byId("door-hall");
    // Hall-sized, M tier and up, every interior archetype that overruns.
    expect(hall.footprint).toBe("rect");
    expect(hall.minExtent).toBe(32);
    expect(hall.archetypes).toEqual(
      expect.arrayContaining(["library", "ballroom", "hotel-room"]),
    );
    // One designed door wall, a dozen-plus ceiling — strictly between the
    // domestic templates and the gallery.
    expect(hall.doorWalls).toEqual(["far"]);
    expect(hall.doorCapacity).toBeGreaterThanOrEqual(12);
    expect(hall.doorCapacity).toBeLessThan(byId("gallery").doorCapacity);
    expect(hall.doorCapacity).toBeGreaterThan(byId("guest-room").doorCapacity);
    // The gate: eligible only above the largest domestic ceiling, so it
    // can never steal an ordinary room from the reading hall / guest room.
    expect(hall.minDoors).toBeGreaterThan(byId("guest-room").doorCapacity);
    expect(hall.minDoors).toBeGreaterThan(byId("reading-hall").doorCapacity);
  });
});

describe("resolveRoomTemplate (§7.2 selection)", () => {
  it("is deterministic — same slice, same template, always (A6)", () => {
    for (let i = 0; i < 40; i++) {
      const id = `2026-10-${i}`;
      const a = resolveRoomTemplate(id, "interior", "ballroom", 64, 3);
      const b = resolveRoomTemplate(id, "interior", "ballroom", 64, 3);
      expect(a).toEqual(b);
    }
  });

  it("returns null where no template is eligible (non-interior classes)", () => {
    expect(resolveRoomTemplate("2026-10-01", "nature", "meadow", 64, 0)).toBeNull();
    expect(resolveRoomTemplate("2026-10-01", "wonder", "ducks", 64, 0)).toBeNull();
  });

  it("enforces minExtent — a small room never picks a hall", () => {
    for (let i = 0; i < 30; i++) {
      // S tier: nothing is eligible (every template needs ≥ 32m).
      expect(
        resolveRoomTemplate(`2026-10-${i}`, "interior", "hotel-room", 16, 0),
      ).toBeNull();
      // M tier: the gallery (minExtent 64) is never drawn.
      const t = resolveRoomTemplate(`2026-10-${i}`, "interior", "ballroom", 32, 0);
      expect(t).not.toBeNull();
      expect(t!.id).toBe("reading-hall");
    }
  });

  it("honours the archetype whitelist", () => {
    // guest-room is hotel-room only; reading-hall is library/ballroom.
    for (let i = 0; i < 30; i++) {
      const hotel = resolveRoomTemplate(`2026-10-${i}`, "interior", "hotel-room", 32, 0);
      expect(hotel!.id).toBe("guest-room");
      const library = resolveRoomTemplate(`2026-10-${i}`, "interior", "library", 32, 0);
      expect(library!.id).toBe("reading-hall");
    }
  });

  it("lets door capacity steer selection — the 20-door day picks the gallery", () => {
    for (let i = 0; i < 30; i++) {
      const t = resolveRoomTemplate(`2026-10-${i}`, "interior", "ballroom", 96, 20);
      expect(t!.id).toBe("gallery");
      expect(t!.doorCapacity).toBeGreaterThanOrEqual(20);
    }
  });

  it("falls back to the highest-capacity eligible template on overflow", () => {
    // hotel-room XL with 30 doors: beyond even the door hall's ceiling, so
    // the highest-capacity eligible candidate carries the overflow —
    // the door hall (16), never the guest room (5) — and placement
    // relaxes, never drops.
    const t = resolveRoomTemplate("2026-10-01", "interior", "hotel-room", 96, 30);
    expect(t!.id).toBe("door-hall");
    // Below the gate the same room keeps its domestic template.
    expect(
      resolveRoomTemplate("2026-10-01", "interior", "hotel-room", 96, 5)!.id,
    ).toBe("guest-room");
  });

  it("gates the door hall behind minDoors — ordinary rooms are never stolen", () => {
    for (let i = 0; i < 30; i++) {
      // M/L-tier library & ballroom at domestic door counts: the door hall
      // is not even eligible, so these selections are exactly the
      // pre-Finding-B ones.
      expect(
        resolveRoomTemplate(`2026-10-${i}`, "interior", "library", 32, 4)!.id,
      ).toBe("reading-hall");
      expect(
        resolveRoomTemplate(`2026-10-${i}`, "interior", "hotel-room", 64, 5)!.id,
      ).toBe("guest-room");
      const ballroom = resolveRoomTemplate(`2026-10-${i}`, "interior", "ballroom", 96, 5);
      expect(ballroom!.id).not.toBe("door-hall");
    }
  });

  it("routes the busy M-tier day to the door hall (Finding B)", () => {
    // 12 strand doors at M tier: the reading hall (ceiling 4) and guest
    // room (ceiling 5) cannot absorb them, the gallery is not eligible at
    // this tier — the door hall is the sole fitting candidate.
    for (let i = 0; i < 30; i++) {
      expect(
        resolveRoomTemplate(`2026-10-${i}`, "interior", "library", 32, 12)!.id,
      ).toBe("door-hall");
      expect(
        resolveRoomTemplate(`2026-10-${i}`, "interior", "hotel-room", 32, 12)!.id,
      ).toBe("door-hall");
    }
  });

  it("steers by min(declared ceiling, measured) when capacityFor is given", () => {
    // XL ballroom, 10 doors. Declared ceilings say the gallery (24) fits
    // — but a miniature scale notation shortens its door wall, so the
    // measured capacity says it does not.
    const measured = new Map([
      ["reading-hall", 1],
      ["door-hall", 3],
      ["gallery", 3],
    ]);
    const capacityFor = (t: RoomTemplate) => measured.get(t.id)!;
    for (let i = 0; i < 30; i++) {
      const t = resolveRoomTemplate(
        `2026-10-${i}`, "interior", "ballroom", 96, 10, WORLD_SEED, capacityFor,
      );
      // Nothing fits: the overflow pool is the highest MEASURED capacity
      // (door hall and gallery tie at 3) — never the reading hall, whose
      // ceiling-first claim (4 > 3) would have won before Finding A.
      expect(t!.id).not.toBe("reading-hall");
    }
    // And when the measurement fits where a bigger ceiling does not, the
    // measurement wins: door hall measured 12 beats gallery measured 3.
    for (let i = 0; i < 30; i++) {
      const t = resolveRoomTemplate(
        `2026-10-${i}`, "interior", "ballroom", 96, 10, WORLD_SEED,
        (tpl) => (tpl.id === "door-hall" ? 12 : 3),
      );
      expect(t!.id).toBe("door-hall");
    }
    // Omitting capacityFor keeps the ceiling-only behaviour: the 10-door
    // day goes to the gallery (24 ≥ 10, the door hall's 16 also fits —
    // the weighted draw decides between the two, never the reading hall).
    for (let i = 0; i < 30; i++) {
      const t = resolveRoomTemplate(`2026-10-${i}`, "interior", "ballroom", 96, 10);
      expect(["door-hall", "gallery"]).toContain(t!.id);
    }
  });

  it("respects weights among fitting candidates", () => {
    // ballroom XL, 0 doors: reading-hall (3) + gallery (2) are both
    // eligible — the weighted draw must pick each at least once in 200
    // fixed probes, and reading-hall more often.
    let hall = 0;
    let gallery = 0;
    for (let i = 0; i < 200; i++) {
      const t = resolveRoomTemplate(`2026-09-${i}`, "interior", "ballroom", 96, 0);
      if (t!.id === "reading-hall") hall += 1;
      else if (t!.id === "gallery") gallery += 1;
    }
    expect(hall).toBeGreaterThan(0);
    expect(gallery).toBeGreaterThan(0);
    expect(hall).toBeGreaterThan(gallery);
  });
});

describe("consumption adapters (§7.3: through the existing modules)", () => {
  it("declares the template's footprint as the plan", () => {
    const t = byId("guest-room");
    const plan = roomPlanFor("2026-10-05", 48, 32, COLONNADE_BAY, WORLD_SEED, templatePlanFor(t));
    expect(plan.id).toBe("l-shape");
  });

  it("confines doors to the template's permitted wall roles", () => {
    const t = byId("gallery");
    const plan = roomPlanFor("2026-10-05", 96, 64, COLONNADE_BAY, WORLD_SEED, templatePlanFor(t));
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const hostable = hostableWallsFor(plan, walls, 1);
    const layout = placeRoomDoors(
      "2026-10-05", plan, walls, hostable, 20, WORLD_SEED, doorAffordanceFor(t),
    );
    expect(layout.doors).toHaveLength(20);
    for (const d of layout.doors) {
      expect(wallRoleFor(plan, walls[d.wall])).toBe("far");
    }
  });

  it("resolves normalized zones to absolute plan coordinates", () => {
    const t = byId("reading-hall");
    const plan = roomPlanFor("2026-10-05", 48, 32, COLONNADE_BAY, WORLD_SEED, templatePlanFor(t));
    const zones = templateZonesFor(t, plan);
    // hero rect x[0.32,0.68] z[0.30,0.66] over 48×32 → centered on the axis.
    expect(zones.hero!.x0).toBeCloseTo(-8.64, 10);
    expect(zones.hero!.x1).toBeCloseTo(8.64, 10);
    expect(zones.hero!.z0).toBeCloseTo(9.6, 10);
    expect(zones.hero!.z1).toBeCloseTo(21.12, 10);
    expect(zones.heroKit).toBe("dining");
    expect(zones.clusters!.length).toBe(3);
    expect(zones.keepEmpty!.length).toBe(1);
    for (const r of [zones.hero!, ...zones.clusters!, ...zones.keepEmpty!]) {
      expect(r.x0).toBeGreaterThanOrEqual(-24);
      expect(r.x1).toBeLessThanOrEqual(24);
      expect(r.z0).toBeGreaterThanOrEqual(0);
      expect(r.z1).toBeLessThanOrEqual(32);
    }
  });

  it("mirrors l-shape zones with the kept wing", () => {
    const t = byId("guest-room");
    // Find one slice per kept side.
    let plusZones: KitZones | undefined;
    let minusZones: KitZones | undefined;
    for (let i = 0; i < 40 && (!plusZones || !minusZones); i++) {
      const plan = roomPlanFor(`2026-11-${i}`, 48, 32, COLONNADE_BAY, WORLD_SEED, templatePlanFor(t));
      const zones = templateZonesFor(t, plan);
      if (plan.lSide > 0) plusZones = zones;
      else minusZones = zones;
    }
    expect(plusZones).toBeDefined();
    expect(minusZones).toBeDefined();
    // The bed-corner hero hugs the +x wing when kept, −x when mirrored.
    expect(plusZones!.hero!.x0).toBeGreaterThan(0);
    expect(minusZones!.hero!.x1).toBeLessThan(0);
    expect(minusZones!.hero!.x0).toBeCloseTo(-plusZones!.hero!.x1, 10);
    expect(minusZones!.hero!.x1).toBeCloseTo(-plusZones!.hero!.x0, 10);
    // The hero rect must land inside the kept wing's footprint.
  });
});

/* ------------------------------------------------------------------ */
/* Real-data pass (task 4): the full derivation chain over the repo's   */
/* own catalogue, with per-template numbers PRINTED for coordination.   */
/* ------------------------------------------------------------------ */

describe("real data pass (memory/episodic)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const strands = JSON.parse(
    readFileSync(`${root}memory/episodic/strands.json`, "utf8"),
  ) as Record<string, string[]>;
  const timeline = JSON.parse(
    readFileSync(`${root}memory/episodic/timeline/index.json`, "utf8"),
  ) as { slices: Array<{ id: string }> };
  const graph = buildStrandGraph(strands);
  // The corridor window exactly as game-shell builds it (strand-doors
  // convention): catalog oldest→newest, capped to the newest 200.
  const sliceIds = timeline.slices.slice(-200).map((s) => s.id).reverse();

  interface TemplateStats {
    rooms: number;
    doors: number;
    maxDoors: number;
    overCapacity: number;
    relaxed: number;
    kits: number;
    heroes: number;
    violations: number;
    capacitySum: number;
  }
  const blank = (): TemplateStats => ({
    rooms: 0, doors: 0, maxDoors: 0, overCapacity: 0,
    relaxed: 0, kits: 0, heroes: 0, violations: 0, capacitySum: 0,
  });

  function runChain() {
    const perTemplate = new Map<string, TemplateStats>();
    let interior = 0;
    let untemplatedInterior = 0;
    let nonInterior = 0;
    const selectionLog: [string, string | null][] = [];

    for (const sliceId of sliceIds) {
      const recipe = compileSpaceRecipe(sliceId);
      const doorCount = strandDoorsForSlice(graph, sliceId).length;
      // The scaled plan dims exactly as the renderer computes them — the
      // measurement Finding A steers selection by (a miniature room's
      // shortened door wall yields a shrunken capacity).
      const { recipe: scaled, scale } = scaledRecipeFor(recipe);
      const scaleFactor = scale.factor;
      const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
      const bay = COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35));
      const planForTemplate = (t: RoomTemplate) =>
        roomPlanFor(sliceId, scaled.width, scaled.size.extent, bay, WORLD_SEED,
          templatePlanFor(t));
      const capacityFor = (t: RoomTemplate) => {
        const p = planForTemplate(t);
        const w = wallSegmentsFor(p, wallThick);
        // Hostable flags are NOT part of the measure: the cutaway-sill
        // distinction is the camera's orientation (a per-slice accident —
        // at dir=1 the far wall is always a sill), while capacity is a
        // property of the wall's length. A sill-hosted door still stands
        // full height from the floor at the same domestic spacing.
        return doorCapacityFor(p, w, null, doorAffordanceFor(t));
      };
      const effectiveCapacity = (t: RoomTemplate) =>
        Math.min(t.doorCapacity, capacityFor(t));
      const template = resolveRoomTemplate(
        sliceId, recipe.worldClass, recipe.archetype, recipe.size.extent,
        doorCount, WORLD_SEED, capacityFor,
      );
      selectionLog.push([sliceId, template?.id ?? null]);
      if (recipe.worldClass !== "interior") {
        nonInterior += 1;
        continue;
      }
      interior += 1;
      if (!template) {
        untemplatedInterior += 1;
        continue;
      }
      const stats = perTemplate.get(template.id) ?? blank();
      perTemplate.set(template.id, stats);
      stats.rooms += 1;
      stats.doors += doorCount;
      stats.maxDoors = Math.max(stats.maxDoors, doorCount);
      const effCapacity = effectiveCapacity(template);
      stats.capacitySum += effCapacity;
      if (doorCount > effCapacity) stats.overCapacity += 1;

      // The full chain, exactly as the renderer will run it once it adopts
      // templates: declared plan → walls → affordance doors → zones kits.
      const propScale = Math.pow(scaleFactor, PROP_SCALE_EXP);
      const plan = planForTemplate(template);
      const walls = wallSegmentsFor(plan, wallThick);
      const hostable = hostableWallsFor(plan, walls, 1);
      const layout = placeRoomDoors(
        sliceId, plan, walls, hostable, doorCount, WORLD_SEED,
        doorAffordanceFor(template),
      );
      // Never a dropped door, never a door on a banned wall role.
      expect(layout.doors).toHaveLength(doorCount);
      if (layout.relaxed) stats.relaxed += 1;
      for (const d of layout.doors) {
        const role = wallRoleFor(plan, walls[d.wall]);
        if (!template.doorWalls.includes(role)) stats.violations += 1;
      }

      const comp = composeRoom(sliceId, plan, scaleFactor);
      const zones = templateZonesFor(template, plan);
      const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
      const pieces = stageInteriorKits({
        rng,
        archetype: recipe.archetype,
        plan,
        comp,
        baseArea: planArea(plan) / (scaleFactor * scaleFactor),
        baseExtent: recipe.size.extent,
        propScale,
        wallThick,
        water: null,
        doors: layout.doors,
        zones,
        heightAt: () => 0,
      });
      const kitCount = new Set(pieces.map((p) => p.kitIndex)).size;
      stats.kits += kitCount;
      if (pieces.some((p) => p.kitIndex === 0)) stats.heroes += 1;
      for (const p of pieces) {
        if (!planContains(plan, p.x, p.z, 0)) stats.violations += 1;
        if (inDoorApproach(p.x, p.z, layout.doors)) stats.violations += 1;
        if (zones.keepEmpty?.some((r) =>
          p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1,
        )) stats.violations += 1;
      }
    }
    return { perTemplate, interior, untemplatedInterior, nonInterior, selectionLog };
  }

  it("runs the chain over the catalogue and prints the coverage numbers", () => {
    const { perTemplate, interior, untemplatedInterior, nonInterior } = runChain();

    console.log(
      `[room-templates real data] window=${sliceIds.length} slices: ` +
        `interior=${interior} (templated=${interior - untemplatedInterior}, ` +
        `untemplated=${untemplatedInterior}), nonInterior=${nonInterior}`,
    );
    for (const t of ROOM_TEMPLATES) {
      const s = perTemplate.get(t.id) ?? blank();
      console.log(
        `  ${t.label} (${t.id}): rooms=${s.rooms}, doors total=${s.doors} ` +
          `max=${s.maxDoors} (ceiling=${t.doorCapacity}, ` +
          `measuredCapacityAvg=${s.rooms ? (s.capacitySum / s.rooms).toFixed(1) : "—"}, ` +
          `overCapacityRooms=${s.overCapacity}), relaxedLayouts=${s.relaxed}, ` +
          `kits avg=${s.rooms ? (s.kits / s.rooms).toFixed(1) : "—"}, ` +
          `heroPlaced=${s.heroes}/${s.rooms}, clearanceViolations=${s.violations}`,
      );
    }

    // The template set covers every interior room of tier ≥ 32 in the
    // catalogue's archetypes; S-tier interiors stay untemplated by design.
    expect(interior).toBeGreaterThan(0);
    const rooms = ROOM_TEMPLATES.map((t) => perTemplate.get(t.id)?.rooms ?? 0);
    expect(rooms.reduce((a, b) => a + b, 0) + untemplatedInterior).toBe(interior);
    // Zero clearance violations across the whole real dataset.
    for (const [, s] of perTemplate) expect(s.violations).toBe(0);
    // Every door requested was placed (asserted per room in the chain).
  });

  it("is deterministic on the real dataset (A6)", () => {
    expect(runChain().selectionLog).toEqual(runChain().selectionLog);
  });
});
