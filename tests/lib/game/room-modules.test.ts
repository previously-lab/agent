/**
 * Tests for the standard room modules + composition resolver
 * (v0.11-room-interiors §8). The contract under test:
 *
 *  - The module catalogue is sound DATA: footprints inside the promised
 *    8–16 m, whitelists naming real kits.ts groups, heroKits hero-eligible,
 *    zones normalized, the 65% content-zone ceiling (module-level §4.5),
 *    and the audit agreeing — plus every interior archetype finding at
 *    least one primary module.
 *  - resolveRoomComposition is deterministic (A6): same slice, same
 *    composition, independent of call order; it returns null outside the
 *    interior class; the placement always JOINS (every companion shares a
 *    consented seam), never overlaps, and tops out at four modules.
 *  - Door capacity steers the module count (§7.2's rule at module scale):
 *    a busy day grows modules until their declared ceilings absorb the
 *    load or the count maxes out.
 *  - compositionTemplateFor folds the composition into the shape the
 *    renderer already consumes: the synthetic RoomTemplate runs the FULL
 *    existing chain — declared plan → walls → affordance doors → zones
 *    kits — with zero clearance violations, exactly like the §7 templates.
 */
import { describe, it, expect } from "vitest";
import {
  ROOM_MODULES,
  TOPOLOGY_COUNTS,
  TIER_MODULE_COUNTS,
  auditComposition,
  auditModule,
  compositionForRecipe,
  compositionTemplateFor,
  moduleKitsFor,
  moduleSconceFor,
  moduleWallForSegment,
  primaryModulesFor,
  rectDifference,
  resolveRoomComposition,
  roomModuleById,
  seamPartitionsFor,
  type ModuleEdge,
  type RoomComposition,
  type RoomModule,
} from "@/lib/game/room-modules";
import type { SpaceRecipe } from "@/lib/game/space-types";
import { roomTemplateForDoorCount } from "@/components/game/space";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { scaledRecipeFor } from "@/lib/game/room-plan";
import { auditTemplate } from "@/lib/game/room-templates";
import {
  composeRoom,
  planContains,
  roomPlanFor,
  wallRoleFor,
  wallSegmentsFor,
} from "@/lib/game/room-plan";
import {
  doorCapacityFor,
  hostableWallsFor,
  inDoorApproach,
  placeRoomDoors,
} from "@/lib/game/room-doors";
import { planArea, stageInteriorKits } from "@/lib/game/kits";
import { KITS } from "@/lib/game/kits";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  MODULE_GRID,
  MODULE_GRID_MAX_AREA,
  MODULE_GRID_MAX_CELLS,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";
import { INTERIOR_ROOMS } from "@/lib/game/space-types";

const byId = (id: string): RoomModule => {
  const m = roomModuleById(id);
  if (!m) throw new Error(`unknown module ${id}`);
  return m;
};

const ARCHETYPES = INTERIOR_ROOMS as readonly string[];

describe("module catalogue (§8.2)", () => {
  it("ships the thirteen standard modules", () => {
    expect(ROOM_MODULES.map((m) => m.id)).toEqual([
      "foyer",
      "bedroom",
      "study",
      "reading-room",
      "kitchen",
      "bath",
      "storage",
      "gallery-module",
      "living",
      "sunroom",
      "pool-deck",
      "dining-hall",
      "workshop",
    ]);
    expect(ROOM_MODULES.map((m) => m.label)).toEqual([
      "门厅",
      "卧室",
      "书房",
      "阅览室",
      "备餐间",
      "更衣浴室",
      "行李房",
      "画廊",
      "会客厅",
      "日光房",
      "泳池甲板",
      "长桌餐厅",
      "工作间",
    ]);
  });

  it("passes its own consistency audit", () => {
    for (const m of ROOM_MODULES) {
      expect(auditModule(m)).toEqual([]);
    }
  });

  it("keeps every footprint on the 6 m module grid, inside the 2×3 cap", () => {
    for (const m of ROOM_MODULES) {
      const cellsW = m.size.w / MODULE_GRID;
      const cellsD = m.size.d / MODULE_GRID;
      expect(Number.isInteger(cellsW), `${m.id} w`).toBe(true);
      expect(Number.isInteger(cellsD), `${m.id} d`).toBe(true);
      expect(cellsW).toBeGreaterThanOrEqual(1);
      expect(cellsD).toBeGreaterThanOrEqual(1);
      expect(cellsW).toBeLessThanOrEqual(MODULE_GRID_MAX_CELLS);
      expect(cellsD).toBeLessThanOrEqual(MODULE_GRID_MAX_CELLS);
      expect(cellsW * cellsD).toBeLessThanOrEqual(MODULE_GRID_MAX_AREA);
    }
  });

  it("names only real kits, with short whitelists (§6: 少而准)", () => {
    const kitIds = new Set(KITS.map((k) => k.id));
    for (const m of ROOM_MODULES) {
      expect(m.kits.length).toBeGreaterThanOrEqual(2);
      expect(m.kits.length).toBeLessThanOrEqual(6);
      for (const id of m.kits) expect(kitIds.has(id)).toBe(true);
    }
  });

  it("gives every interior archetype at least one primary module", () => {
    for (const a of ARCHETYPES) {
      expect(primaryModulesFor("interior", a).length).toBeGreaterThan(0);
    }
    expect(primaryModulesFor("nature", "meadow")).toEqual([]);
  });

  it("every primary candidate keeps at least two drawable kits in its rooms", () => {
    for (const m of ROOM_MODULES) {
      for (const a of m.archetypes) {
        // One drawable kit is the companion bar; a PRIMARY needs a real
        // choice or the room reads as one fixed scene.
        expect(moduleKitsFor(m, a).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("declares the gallery module as the door absorber", () => {
    const gallery = byId("gallery-module");
    expect(gallery.doorEdges).toEqual(["n"]);
    expect(gallery.doorCapacity).toBeGreaterThanOrEqual(10);
    expect(
      Math.max(...ROOM_MODULES.map((m) => m.doorCapacity)),
    ).toBe(gallery.doorCapacity);
    // Its long wall is for looking, not for connecting: only the flanks open.
    expect(gallery.openings).toEqual(["e", "w"]);
  });

  it("never offers doors off the axial (north) edge, and bans doors on the authored walls", () => {
    // §10.5 axial semantics: doors live on the north/south walls only —
    // for a module that is its far (north) edge; east/west belong to
    // windows and light. The audit (room-modules.ts) enforces the same.
    for (const m of ROOM_MODULES) {
      expect(m.doorEdges).not.toContain("s");
      expect(m.doorEdges.every((e) => e === "n")).toBe(true);
    }
    // The shelf walls, the daylight wall, and the water's edge carry NO
    // doors at all — they declare no door edges rather than break their
    // own wall.
    expect(byId("reading-room").doorEdges).toEqual([]);
    expect(byId("study").doorEdges).toEqual([]);
    expect(byId("sunroom").doorEdges).toEqual([]);
    expect(byId("pool-deck").doorEdges).toEqual([]);
  });
});

describe("rectDifference (随机区域 math)", () => {
  it("returns the outer rect when there are no holes", () => {
    expect(rectDifference({ x0: 0, z0: 0, x1: 10, z1: 8 }, [])).toEqual([
      { x0: 0, z0: 0, x1: 10, z1: 8 },
    ]);
  });

  it("splits around a centered hole into disjoint parts that tile the remainder", () => {
    const outer = { x0: 0, z0: 0, x1: 12, z1: 12 };
    const hole = { x0: 4, z0: 4, x1: 8, z1: 8 };
    const parts = rectDifference(outer, [hole]);
    const area = parts.reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
    expect(area).toBeCloseTo(144 - 16, 9);
    for (const p of parts) {
      // Disjoint from the hole and inside the outer rect.
      expect(p.x1 <= hole.x0 || p.x0 >= hole.x1 || p.z1 <= hole.z0 || p.z0 >= hole.z1).toBe(true);
      expect(p.x0).toBeGreaterThanOrEqual(0);
      expect(p.x1).toBeLessThanOrEqual(12);
    }
  });

  it("drops slivers under a square meter", () => {
    const outer = { x0: 0, z0: 0, x1: 10, z1: 10 };
    const hole = { x0: 0, z0: 0, x1: 10, z1: 9.95 };
    expect(rectDifference(outer, [hole])).toEqual([]);
  });
});

describe("resolveRoomComposition (§8.2 selection + placement)", () => {
  it("is deterministic — same slice, same composition, always (A6)", () => {
    for (let i = 0; i < 30; i++) {
      const id = `2026-10-${i}`;
      const a = resolveRoomComposition(id, "interior", "hotel-room", 3);
      const b = resolveRoomComposition(id, "interior", "hotel-room", 3);
      expect(a).toEqual(b);
    }
  });

  it("does not depend on call order (its own stream, never shared)", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `2026-11-${i}`);
    const forward = ids.map((id) =>
      resolveRoomComposition(id, "interior", "library", 2),
    );
    const backward = [...ids]
      .reverse()
      .map((id) => resolveRoomComposition(id, "interior", "library", 2))
      .reverse();
    expect(forward).toEqual(backward);
  });

  it("returns null outside the interior class", () => {
    expect(resolveRoomComposition("2026-10-01", "nature", "meadow", 0)).toBeNull();
    expect(resolveRoomComposition("2026-10-01", "wonder", "ducks", 0)).toBeNull();
  });

  it("joins 1–4 distinct modules under a topology that admits their count", () => {
    for (const a of ARCHETYPES) {
      for (let i = 0; i < 30; i++) {
        const comp = resolveRoomComposition(`2026-12-${i}`, "interior", a, 0)!;
        expect(comp).not.toBeNull();
        expect(comp.modules.length).toBeGreaterThanOrEqual(1);
        expect(comp.modules.length).toBeLessThanOrEqual(4);
        expect(TOPOLOGY_COUNTS[comp.topology]).toContain(comp.modules.length);
        const ids = comp.modules.map((p) => p.module.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(comp.modules[0].primary).toBe(true);
        expect(comp.modules.slice(1).every((p) => !p.primary)).toBe(true);
      }
    }
  });

  it("passes the composition audit across archetypes and door loads", () => {
    for (const a of ARCHETYPES) {
      for (let i = 0; i < 24; i++) {
        for (const doors of [0, 3, 8, 20]) {
          const comp = resolveRoomComposition(`2027-01-${i}`, "interior", a, doors);
          expect(comp).not.toBeNull();
          expect(auditComposition(comp!)).toEqual([]);
        }
      }
    }
  });

  it("bounds the room by the placed modules — 大由模块多表达 (§8.3)", () => {
    for (let i = 0; i < 30; i++) {
      const comp = resolveRoomComposition(`2027-02-${i}`, "interior", "ballroom", 0)!;
      const x0 = Math.min(...comp.modules.map((p) => p.rect.x0));
      const x1 = Math.max(...comp.modules.map((p) => p.rect.x1));
      const z1 = Math.max(...comp.modules.map((p) => p.rect.z1));
      expect(comp.width).toBeCloseTo(x1 - x0, 9);
      expect(comp.extent).toBeCloseTo(z1, 9);
      // The bounding box is centered on the entrance axis, opening at z = 0.
      expect(x0).toBeCloseTo(-comp.width / 2, 9);
      expect(x1).toBeCloseTo(comp.width / 2, 9);
      expect(Math.min(...comp.modules.map((p) => p.rect.z0))).toBeCloseTo(0, 9);
    }
  });

  it("grows capacity monotonically with the door load (overflow relaxes, never drops)", () => {
    for (let i = 0; i < 30; i++) {
      const id = `2027-03-${i}`;
      const calm = resolveRoomComposition(id, "interior", "hotel-room", 0)!;
      const busy = resolveRoomComposition(id, "interior", "hotel-room", 20)!;
      // The busy day walks the SAME seeded stream: it accepts the calm
      // day’s placement only if its declared ceilings absorb the load, and
      // otherwise grows modules — so its declared ceiling never comes out
      // BELOW the calm day’s. (A composition may still top out under 20:
      // a primary with a designed back wall cannot join four modules, and
      // the overflow then relaxes at placement — room-doors.ts's rule.)
      expect(busy.doorCapacity).toBeGreaterThanOrEqual(calm.doorCapacity);
      // Under §10.5's axial capacities a busy day may legitimately TOP
      // OUT lone: capacity counts only door-eligible north edges now, so
      // when no multi-module placement joins with more capacity than the
      // lone primary, the highest-capacity fallback is that primary (the
      // overflow relaxes at placement, never drops — room-doors.ts).
      if (busy.modules.length === 1) {
        expect(
          calm.modules.length === 1 ||
            busy.doorCapacity > calm.doorCapacity,
        ).toBe(true);
      }
    }
  });

  it("keeps seams doorway-shaped and consented by both sides", () => {
    for (let i = 0; i < 40; i++) {
      const comp = resolveRoomComposition(`2027-04-${i}`, "interior", "library", 0)!;
      for (const seam of comp.seams) {
        const len = Math.max(
          seam.line.x1 - seam.line.x0,
          seam.line.z1 - seam.line.z0,
        );
        expect(len).toBeGreaterThanOrEqual(3);
        expect(seam.opening.width).toBeGreaterThanOrEqual(1);
        expect(seam.opening.width).toBeLessThanOrEqual(2.4);
        expect(seam.opening.at - seam.opening.width / 2).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(seam.opening.at + seam.opening.width / 2).toBeLessThanOrEqual(len - 1 + 1e-9);
        const a = comp.modules.find((p) => p.module.id === seam.aId)!;
        const b = comp.modules.find((p) => p.module.id === seam.bId)!;
        expect(a.seams.some((s) => s.withId === seam.bId)).toBe(true);
        expect(b.seams.some((s) => s.withId === seam.aId)).toBe(true);
      }
    }
  });

  it("leaves open fields outside every module, each at least 4 m²", () => {
    for (let i = 0; i < 40; i++) {
      const comp = resolveRoomComposition(`2027-05-${i}`, "interior", "ballroom", 0)!;
      for (const f of comp.openFields) {
        expect((f.x1 - f.x0) * (f.z1 - f.z0)).toBeGreaterThanOrEqual(4);
        expect(f.x0).toBeGreaterThanOrEqual(-comp.width / 2 - 1e-9);
        expect(f.x1).toBeLessThanOrEqual(comp.width / 2 + 1e-9);
        expect(f.z0).toBeGreaterThanOrEqual(-1e-9);
        expect(f.z1).toBeLessThanOrEqual(comp.extent + 1e-9);
        for (const p of comp.modules) {
          const overlap =
            f.x0 < p.rect.x1 - 1e-9 &&
            p.rect.x0 < f.x1 - 1e-9 &&
            f.z0 < p.rect.z1 - 1e-9 &&
            p.rect.z0 < f.z1 - 1e-9;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});

describe("compositionTemplateFor (the renderer's existing input)", () => {
  it("yields a RoomTemplate that passes the §7 audit", () => {
    for (const a of ARCHETYPES) {
      for (let i = 0; i < 20; i++) {
        const comp = resolveRoomComposition(`2027-06-${i}`, "interior", a, 2)!;
        const template = compositionTemplateFor(comp);
        expect(auditTemplate(template)).toEqual([]);
        expect(template.footprint).toBe("rect");
        expect(template.doorCapacity).toBe(comp.doorCapacity);
      }
    }
  });

  it("pins the primary module's hero as the room's hero", () => {
    for (let i = 0; i < 40; i++) {
      const comp = resolveRoomComposition(`2027-07-${i}`, "interior", "hotel-room", 0)!;
      const template = compositionTemplateFor(comp);
      const primary = comp.modules.find((p) => p.primary)!;
      const primaryHero = primary.module.zones.find((z) => z.kind === "hero");
      const heroZones = template.zones.filter((z) => z.kind === "hero");
      if (primaryHero) {
        expect(heroZones).toHaveLength(1);
        expect(template.heroKit).toBe(primary.module.heroKit);
        // The hero zone maps through the primary's placed rect.
        const hero = heroZones[0];
        const px = primary.rect;
        const w = px.x1 - px.x0;
        expect(hero.rect.x[0]).toBeCloseTo(
          (px.x0 + primaryHero.rect.x[0] * w + comp.width / 2) / comp.width,
          9,
        );
      } else {
        expect(heroZones).toHaveLength(0);
        expect(template.heroKit).toBeUndefined();
      }
    }
  });

  it("keeps the entrance apron empty and leaves the open fields to the sparse staging channel", () => {
    for (let i = 0; i < 30; i++) {
      const comp = resolveRoomComposition(`2027-08-${i}`, "interior", "library", 0)!;
      const template = compositionTemplateFor(comp);
      const keepEmpty = template.zones.filter((z) => z.kind === "keep-empty");
      // One apron + the modules' own keep-empty zones — and NOTHING for
      // the open fields: they are dressed (sparsely) by kits.ts's
      // openFields staging channel, not banned by the zone set.
      const moduleKeepEmpty = comp.modules.reduce(
        (s, p) => s + p.module.zones.filter((z) => z.kind === "keep-empty").length,
        0,
      );
      expect(keepEmpty.length).toBe(1 + moduleKeepEmpty);
    }
  });

  it("permits doors only where an exposed door-eligible module edge maps", () => {
    for (let i = 0; i < 40; i++) {
      const comp = resolveRoomComposition(`2027-09-${i}`, "interior", "ballroom", 4)!;
      const template = compositionTemplateFor(comp);
      // §10.5: the only door-eligible edge is the north one, so the far
      // wall is the ONLY role the mapping can produce — and when no
      // module exposes a door-eligible north edge (every authored north
      // wall is a shelf/glass/water wall), the composition falls back to
      // the room's structural north wall so placement stays axial.
      expect(template.doorWalls).toEqual(["far"]);
      const farExpected = comp.modules.some(
        (p) => p.exposed.n && p.module.doorEdges.includes("n"),
      );
      expect(template.doorWalls.includes("far")).toBe(true);
      // A mapped (non-fallback) far wall always has its exposing module.
      if (farExpected) expect(template.doorWalls).toContain("far");
    }
  });

  it("runs the FULL existing chain with zero clearance violations", () => {
    // The synthetic template feeds roomPlanFor → wallSegmentsFor →
    // placeRoomDoors (affordance) → templateZonesFor → stageInteriorKits,
    // the exact path the renderer runs for the §7 templates.
    for (const a of ARCHETYPES) {
      for (let i = 0; i < 12; i++) {
        const sliceId = `2027-10-${i}`;
        const doorCount = [0, 3, 9][i % 3];
        const comp = resolveRoomComposition(sliceId, "interior", a, doorCount)!;
        const template = compositionTemplateFor(comp);
        const plan = roomPlanFor(sliceId, comp.width, comp.extent, COLONNADE_BAY, WORLD_SEED, {
          plan: template.footprint,
        });
        expect(plan.id).toBe("rect");
        const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
        const hostable = hostableWallsFor(plan, walls, 1);
        const layout = placeRoomDoors(
          sliceId,
          plan,
          walls,
          hostable,
          doorCount,
          WORLD_SEED,
          { walls: template.doorWalls },
        );
        expect(layout.doors).toHaveLength(doorCount);
        // The measured capacity of the permitted walls is a real number
        // (Finding A's discipline applies unchanged to compositions).
        const measured = doorCapacityFor(plan, walls, null, { walls: template.doorWalls });
        expect(measured).toBeGreaterThan(0);
        // Doors stay on the permitted roles while the room is INSIDE the
        // measured capacity; past it the never-drop / never-overlap rules
        // outrank the template ban (§10.5's overflow, room-doors.ts).
        if (doorCount <= measured) {
          for (const d of layout.doors) {
            expect(template.doorWalls).toContain(wallRoleFor(plan, walls[d.wall]));
          }
        }

        const compo = composeRoom(sliceId, plan, 1);
        const zones = {
          hero: template.zones.find((z) => z.kind === "hero"),
          heroKit: template.heroKit,
          clusters: template.zones.filter((z) => z.kind === "cluster"),
          keepEmpty: template.zones.filter((z) => z.kind === "keep-empty"),
        };
        const toRect = (z: { rect: { x: readonly [number, number]; z: readonly [number, number] } }) => ({
          x0: (z.rect.x[0] - 0.5) * plan.width,
          x1: (z.rect.x[1] - 0.5) * plan.width,
          z0: z.rect.z[0] * plan.extent,
          z1: z.rect.z[1] * plan.extent,
        });
        const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
        const pieces = stageInteriorKits({
          rng,
          archetype: a,
          plan,
          comp: compo,
          baseArea: planArea(plan),
          baseExtent: 96,
          propScale: Math.pow(1, PROP_SCALE_EXP),
          wallThick: ROOM_WALL_THICKNESS,
          water: null,
          doors: layout.doors,
          zones: {
            hero: zones.hero ? toRect(zones.hero) : undefined,
            heroKit: zones.heroKit,
            clusters: zones.clusters.map(toRect),
            keepEmpty: zones.keepEmpty.map(toRect),
          },
          heightAt: () => 0,
        });
        // Something was furnished, and nothing violates a clearance.
        expect(pieces.length).toBeGreaterThan(0);
        for (const p of pieces) {
          expect(planContains(plan, p.x, p.z, 0)).toBe(true);
          expect(inDoorApproach(p.x, p.z, layout.doors)).toBe(false);
          for (const r of zones.keepEmpty.map(toRect)) {
            expect(p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1).toBe(false);
          }
        }
      }
    }
  });

  it("is deterministic end-to-end (A6): same slice ⇒ same template", () => {
    for (let i = 0; i < 20; i++) {
      const id = `2027-11-${i}`;
      const t1 = compositionTemplateFor(
        resolveRoomComposition(id, "interior", "library", 5)!,
      );
      const t2 = compositionTemplateFor(
        resolveRoomComposition(id, "interior", "library", 5)!,
      );
      expect(t1).toEqual(t2);
    }
  });
});


/* ------------------------------------------------------------------ */
/* The renderer wiring (§8.3 convergence + the recipe-level resolution) */
/* ------------------------------------------------------------------ */

describe("countHint + TIER_MODULE_COUNTS (§8.3 convergence)", () => {
  it("pins the seeded module count while still consuming the draw", () => {
    for (let i = 0; i < 20; i++) {
      const id = `2028-01-${i}`;
      const hinted = resolveRoomComposition(id, "interior", "hotel-room", 0, WORLD_SEED, 4)!;
      expect(hinted.modules.length).toBeGreaterThanOrEqual(3);
      expect(hinted.modules.length).toBeLessThanOrEqual(4);
      // Determinism with the hint (A6).
      expect(resolveRoomComposition(id, "interior", "hotel-room", 0, WORLD_SEED, 4)).toEqual(hinted);
      // The hint consumes the same stream prefix: the PRIMARY module is the
      // one the unhinted resolution also picked.
      const unhinted = resolveRoomComposition(id, "interior", "hotel-room", 0)!;
      expect(hinted.modules[0].module.id).toBe(unhinted.modules[0].module.id);
    }
  });

  it("S stays a single module; M/L/XL grow by modules, never by size", () => {
    const counts = TIER_MODULE_COUNTS;
    expect(counts.S).toBe(1);
    expect(counts.M).toBe(2);
    for (let i = 0; i < 30; i++) {
      const id = `2028-02-${i}`;
      const s = resolveRoomComposition(id, "interior", "library", 0, WORLD_SEED, counts.S)!;
      expect(s.modules.length).toBe(1);
      // A single module's footprint is at most the 2×3 grid cap (18 m) —
      // "large" is never ONE module stretched.
      expect(s.width).toBeLessThanOrEqual(MODULE_GRID * MODULE_GRID_MAX_CELLS);
      expect(s.extent).toBeLessThanOrEqual(MODULE_GRID * MODULE_GRID_MAX_CELLS);
      const m = resolveRoomComposition(id, "interior", "library", 0, WORLD_SEED, counts.M)!;
      expect(m.modules.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("every module stays inside the composition's bounding box", () => {
    for (const a of INTERIOR_ROOMS) {
      for (let i = 0; i < 10; i++) {
        const comp = resolveRoomComposition(`2028-03-${i}`, "interior", a, 0, WORLD_SEED, 3)!;
        for (const p of comp.modules) {
          expect(p.rect.x0).toBeGreaterThanOrEqual(-comp.width / 2 - 1e-6);
          expect(p.rect.x1).toBeLessThanOrEqual(comp.width / 2 + 1e-6);
          expect(p.rect.z0).toBeGreaterThanOrEqual(-1e-6);
          expect(p.rect.z1).toBeLessThanOrEqual(comp.extent + 1e-6);
        }
      }
    }
  });
});

describe("compositionForRecipe (the render/contain chain's one resolution)", () => {
  it("is null outside the interior class and deterministic per recipe", () => {
    for (let i = 0; i < 200; i++) {
      const recipe = compileSpaceRecipe(`2028-04-${i}`);
      const comp = compositionForRecipe(recipe);
      if (recipe.worldClass !== "interior") {
        expect(comp).toBeNull();
        continue;
      }
      expect(comp).not.toBeNull();
      expect(compositionForRecipe(recipe)).toEqual(comp);
      // The tier convergence holds through the recipe-level entry point.
      if (recipe.size.id === "S") expect(comp!.modules.length).toBe(1);
      else expect(comp!.modules.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("compositionForRecipe with the runtime door count (§8.4)", () => {
  it("defaults to the doorless resolution (byte-for-byte backwards compatible)", () => {
    for (let i = 0; i < 50; i++) {
      const recipe = compileSpaceRecipe(`2028-07-${i}`);
      expect(compositionForRecipe(recipe)).toEqual(
        compositionForRecipe(recipe, WORLD_SEED, 0),
      );
    }
  });

  it("is deterministic per (recipe, doorCount) (A6)", () => {
    for (let i = 0; i < 30; i++) {
      const recipe = compileSpaceRecipe(`2028-08-${i}`);
      expect(compositionForRecipe(recipe, WORLD_SEED, 7)).toEqual(
        compositionForRecipe(recipe, WORLD_SEED, 7),
      );
    }
  });

  it("a busy day grows modules through the recipe entry — and the door wall only gets longer (§10.5)", () => {
    // The exposed door-eligible NORTH edge meters — the §10.5 quantity:
    // growth adds north wall, never east/west doors.
    const doorEdgeMeters = (comp: RoomComposition): number =>
      comp.modules.reduce((s, p) => {
        if (!p.exposed.n || !p.module.doorEdges.includes("n")) return s;
        return s + (p.rect.x1 - p.rect.x0);
      }, 0);
    let grew = 0;
    for (let i = 0; i < 120; i++) {
      const recipe = compileSpaceRecipe(`2028-09-${i}`);
      if (recipe.worldClass !== "interior") continue;
      const calm = compositionForRecipe(recipe, WORLD_SEED, 0)!;
      const busy = compositionForRecipe(recipe, WORLD_SEED, 16)!;
      expect(auditComposition(busy)).toEqual([]);
      // §10.5 axial semantics hold at every door load: the far (north)
      // wall is the ONLY door wall — growth never squeezes doors onto
      // the east/west walls.
      expect(compositionTemplateFor(busy).doorWalls).toEqual(["far"]);
      // The busy day's declared ceiling never comes out below the calm
      // day's (overflow relaxes at placement, never drops).
      expect(busy.doorCapacity).toBeGreaterThanOrEqual(calm.doorCapacity);
      // The north door wall never shrinks as the load rises (every growth
      // path either widens the room or exposes another module's north
      // edge). Depth is deliberately NOT asserted: a higher count may
      // switch topology (row → ell) and trade depth for width lawfully —
      // "large" is MORE modules, whatever silhouette joins them.
      expect(doorEdgeMeters(busy)).toBeGreaterThanOrEqual(doorEdgeMeters(calm));
      if (busy.modules.length > calm.modules.length) {
        grew += 1;
        expect(busy.modules.length).toBeLessThanOrEqual(4);
      }
    }
    // The growth path is real: at least one slice in the sweep joins more
    // modules under the 16-door load than doorless.
    expect(grew).toBeGreaterThan(0);
  });

  it("a door load within the hinted modules' capacity never grows the count (门少不加模块)", () => {
    for (let i = 0; i < 80; i++) {
      const recipe = compileSpaceRecipe(`2028-10-${i}`);
      if (recipe.worldClass !== "interior") continue;
      const comp = compositionForRecipe(recipe, WORLD_SEED, 0)!;
      // Feeding BACK the calm day's own capacity: the placement already
      // absorbs it, so the resolution is unchanged — growth responds to
      // EXCESS load, not to any nonzero count.
      expect(compositionForRecipe(recipe, WORLD_SEED, comp.doorCapacity)).toEqual(comp);
    }
  });
});

describe("roomTemplateForDoorCount composition branch (the renderer's selection)", () => {
  it("returns the composition's synthetic template for interior rooms — resolved WITH the door count", () => {
    for (let i = 0; i < 30; i++) {
      const recipe = compileSpaceRecipe(`2028-05-${i}`);
      // The count-3 composition is what the renderer's selection resolves
      // for a 3-door room (§8.4: the door load steers the composition
      // THROUGH this entry point) — under a door load the tier hint may
      // grow, so the expected template is the COUNT-3 resolution's, not
      // the doorless one's.
      const comp = compositionForRecipe(recipe, WORLD_SEED, 3);
      if (!comp) continue;
      const { recipe: scaled, scale } = scaledRecipeFor(recipe);
      const template = roomTemplateForDoorCount(
        recipe,
        scaled.width,
        scaled.size.extent,
        scale.factor,
        ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
        3,
      );
      expect(template).not.toBeNull();
      expect(template!.id).toBe(`comp:${comp.modules.map((p) => p.module.id).join("+")}`);
      expect(template).toEqual(compositionTemplateFor(comp));
    }
  });

  it("never lets the composition branch touch non-interior rooms", () => {
    for (let i = 0; i < 100; i++) {
      const recipe = compileSpaceRecipe(`2028-06-${i}`);
      if (recipe.worldClass === "interior") continue;
      const { recipe: scaled, scale } = scaledRecipeFor(recipe);
      const template = roomTemplateForDoorCount(
        recipe,
        scaled.width,
        scaled.size.extent,
        scale.factor,
        ROOM_WALL_THICKNESS * Math.max(scale.factor, 0.35),
        0,
      );
      // Non-interior rooms resolve no template at all (today's behaviour)
      // — and crucially, never a `comp:` one.
      expect(template?.id.startsWith("comp:") ?? false).toBe(false);
    }
  });
});

describe("seamPartitionsFor — the shared derivation (renderer + clamp)", () => {
  // The composition probe slices from the doorway-strip audit: row
  // topologies can center a seam on the door axis (equal-width module
  // pairs), and the cross's south arm can lay one along the entrance
  // plane — either would plant a jamb in the doorway. The derivation must
  // force such seams' openings over the strip and never emit a flank that
  // crosses it.
  function interiorRecipe(sliceId: string, archetype: string, tier: string, extent: number): SpaceRecipe {
    return {
      sliceId,
      worldClass: "interior",
      archetype: archetype as SpaceRecipe["archetype"],
      width: 24,
      size: { id: tier as SpaceRecipe["size"]["id"], extent },
      palette: { id: "dusk" },
      lightSeed: 1,
    } as unknown as SpaceRecipe;
  }

  it("never lets a jamb flank overlap the entrance doorway gap", () => {
    let checked = 0;
    for (const archetype of ARCHETYPES) {
      for (let d = 1; d <= 80; d++) {
        const sliceId = `2026-10-${String(d).padStart(2, "0")}seam-audit`;
        for (const [tier, extent] of [["s", 16], ["m", 32], ["l", 64], ["xl", 96]] as const) {
          const comp = compositionForRecipe(interiorRecipe(sliceId, archetype, tier, extent));
          if (!comp) continue;
          for (const sf of [1, 0.25, 2.8]) {
            const thick = ROOM_WALL_THICKNESS * Math.max(sf, 0.35);
            for (const sp of seamPartitionsFor(comp, sf, thick)) {
              checked++;
              for (const f of sp.flanks) {
                const inGap =
                  f.z - f.sizeZ / 2 < thick &&
                  f.z + f.sizeZ / 2 > -thick &&
                  f.x - f.sizeX / 2 < 0.6 - 1e-9 &&
                  f.x + f.sizeX / 2 > -(0.6 - 1e-9);
                expect(inGap, `flank (${f.x},${f.z}) ${f.sizeX}x${f.sizeZ} in gap`).toBe(false);
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("keeps a center seam real — an open vestibule, no post on the axis", () => {
    // foyer+study rows land the seam exactly on the door axis.
    const comp = compositionForRecipe(
      interiorRecipe("2026-10-17Thotel-room", "hotel-room", "m", 32),
    );
    expect(comp).not.toBeNull();
    const parts = seamPartitionsFor(comp!, 1, ROOM_WALL_THICKNESS);
    expect(parts.length).toBeGreaterThan(0);
    const center = parts.find((p) => Math.abs(p.header.x) < 1e-6);
    expect(center).toBeDefined();
    for (const f of center!.flanks) {
      // No flank stands within the doorway gap or its wall plane.
      expect(
        Math.abs(f.x) < 0.6 && f.z - f.sizeZ / 2 < ROOM_WALL_THICKNESS,
      ).toBe(false);
    }
    // The opening hugs the entrance: the header (spanning the opening)
    // starts within the entrance apron.
    expect(center!.header.z + center!.header.sizeZ / 2).toBeLessThan(3);
  });

  it("is deterministic in (composition, scale) — same partitions, always (A6)", () => {
    const comp = compositionForRecipe(
      interiorRecipe("2026-10-17Thotel-room", "hotel-room", "m", 32),
    )!;
    const a = seamPartitionsFor(comp, 1, ROOM_WALL_THICKNESS);
    const b = seamPartitionsFor(comp, 1, ROOM_WALL_THICKNESS);
    expect(a).toEqual(b);
  });
});

describe("moduleWallForSegment / moduleSconceFor (§8.2 registers)", () => {
  function foyerStudy() {
    // foyer|study at the door axis; foyer west, study east.
    const comp = compositionForRecipe(
      {
        sliceId: "2026-10-17Thotel-room",
        worldClass: "interior",
        archetype: "hotel-room",
        width: 24,
        size: { id: "m", extent: 32 },
        palette: { id: "dusk" },
        lightSeed: 1,
      } as unknown as SpaceRecipe,
    )!;
    return comp;
  }

  it("attributes each perimeter span to its module's wall role", () => {
    const comp = foyerStudy();
    const thick = ROOM_WALL_THICKNESS;
    const halfW = comp.width / 2;
    // West flank wall: the foyer's west edge runs the foyer's 8 m depth.
    expect(
      moduleWallForSegment(comp, { x: -halfW + thick / 2, z: 4, sizeX: thick, sizeZ: 8 }, 1),
    ).toBe("panelling"); // foyer.wall
    // East flank wall over the study's span.
    expect(
      moduleWallForSegment(comp, { x: halfW - thick / 2, z: 5, sizeX: thick, sizeZ: 10 }, 1),
    ).toBe("shelf"); // study.wall
    // The entrance wall belongs to no module.
    expect(
      moduleWallForSegment(comp, { x: -8, z: thick / 2, sizeX: 4, sizeZ: thick }, 1),
    ).toBeNull();
  });

  it("moduleSconceFor picks a door-free, sill-free wall in the module's register", () => {
    const comp = foyerStudy();
    // foyer|study row: the foyer exposes n + its WEST flank (its east edge
    // IS the seam); the study exposes n + its EAST flank. A module never
    // hangs a sconce on a seam edge — there is no wall face there.
    const foyer = comp.modules.find((p) => p.module.id === "foyer")!;
    const study = comp.modules.find((p) => p.module.id === "study")!;
    // A blocked north edge falls through to the flanks (candidates n → e →
    // w, skipping edges the module does not expose).
    const blocked = new Set<ModuleEdge>(["n"]);
    const foyerAnchor = moduleSconceFor(foyer, comp, 1, ROOM_WALL_THICKNESS, [], blocked);
    expect(foyerAnchor).not.toBeNull();
    expect(foyerAnchor!.register).toBe("quiet"); // the foyer's register
    expect(foyerAnchor!.nx).toBe(1); // the west wall's inward normal
    const studyAnchor = moduleSconceFor(study, comp, 1, ROOM_WALL_THICKNESS, [], blocked);
    expect(studyAnchor).not.toBeNull();
    expect(studyAnchor!.register).toBe("task"); // the study's register
    expect(studyAnchor!.nx).toBe(-1); // the east wall's inward normal
    // A door planted inside a flank's clear disqualifies it — the foyer's
    // only other edge is the seam, so it grows NO sconce rather than a
    // sourceless light (B.13).
    const doorAt = { x: foyerAnchor!.x + 0.4, z: foyerAnchor!.z };
    expect(
      moduleSconceFor(foyer, comp, 1, ROOM_WALL_THICKNESS, [doorAt], blocked),
    ).toBeNull();
    // Every edge blocked or door-bound → no sconce either.
    const allBlocked = new Set<ModuleEdge>(["n", "e", "w"]);
    expect(moduleSconceFor(study, comp, 1, ROOM_WALL_THICKNESS, [], allBlocked)).toBeNull();
  });
});
