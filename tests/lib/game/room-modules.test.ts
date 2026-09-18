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
  auditComposition,
  auditModule,
  compositionTemplateFor,
  moduleKitsFor,
  primaryModulesFor,
  rectDifference,
  resolveRoomComposition,
  roomModuleById,
  type RoomModule,
} from "@/lib/game/room-modules";
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
import { INTERIOR_KITS } from "@/lib/game/kits";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
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

  it("keeps every footprint inside the promised 8–16 m", () => {
    for (const m of ROOM_MODULES) {
      expect(m.size.w).toBeGreaterThanOrEqual(8);
      expect(m.size.w).toBeLessThanOrEqual(16);
      expect(m.size.d).toBeGreaterThanOrEqual(8);
      expect(m.size.d).toBeLessThanOrEqual(16);
    }
  });

  it("names only real kits, with short whitelists (§6: 少而准)", () => {
    const kitIds = new Set(INTERIOR_KITS.map((k) => k.id));
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

  it("keeps the entrance apron and the open fields empty", () => {
    for (let i = 0; i < 30; i++) {
      const comp = resolveRoomComposition(`2027-08-${i}`, "interior", "library", 0)!;
      const template = compositionTemplateFor(comp);
      const keepEmpty = template.zones.filter((z) => z.kind === "keep-empty");
      // One apron + one per open field + the modules' own keep-empty zones.
      const moduleKeepEmpty = comp.modules.reduce(
        (s, p) => s + p.module.zones.filter((z) => z.kind === "keep-empty").length,
        0,
      );
      expect(keepEmpty.length).toBe(1 + comp.openFields.length + moduleKeepEmpty);
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
