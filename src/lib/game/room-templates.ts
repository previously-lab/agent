/**
 * Room layout templates (v0.11-room-interiors §7) — the design layer. Rooms
 * are generated the way interiors are designed: from a small set of
 * PRE-AUTHORED layouts. A room's identity is (palette, template, size tier,
 * contents), all seeded from the slice id.
 *
 * A template is DATA, never code: it declares its footprint, which walls may
 * carry strand doors and how many, its feature slots, and its content zones
 * — and the existing pure modules own all the geometry. Consuming a template
 * goes THROUGH room-plan.ts (the declared plan silhouette), room-doors.ts
 * (the door affordance over wall roles) and kits.ts (the content zones),
 * never around them, so the validated clearance/accessibility math cannot
 * fork (§7.3).
 *
 * DOORS STAY RANDOM (user, 2026-09-18): the template declares which walls
 * MAY host doors and its door CAPACITY; the seed still picks the positions
 * (room-doors.ts placeRoomDoors). Capacity is enforced here, at selection:
 * a 20-strand day selects a template that can absorb 20 doors instead of
 * cramming them into a closet.
 *
 * Determinism (A6): selection is a pure function of
 * (worldSeed, sliceId, worldClass, archetype, extent tier, door count) via
 * its own hash-derived stream ("room-template"), independent of every other
 * facet's stream. No three.js, no React, no Math.random, no wall clock.
 */
import type { DoorAffordance } from "./room-doors";
import type { KitZones, KitZoneRect } from "./kits";
import type { PlanId, RoomPlan, TemplatePlan, WallRole } from "./room-plan";
import { createRng, hashString, WORLD_SEED } from "./seed";
import type { ArchetypeId, WorldClass } from "./space-types";

/* ------------------------------------------------------------------ */
/* The data model (§7.2)                                               */
/* ------------------------------------------------------------------ */

/** Geometric feature slots (§3.2's six): the template's authored dressing.
 *  Declared here as data; the RENDERER builds the geometry (niche, inlay…)
 *  when it adopts the template layer. */
export type FeatureKind =
  | "niche"
  | "raised-platform"
  | "pilaster-rhythm"
  | "floor-inlay"
  | "water-rill"
  | "mezzanine";

export interface FeatureSlot {
  kind: FeatureKind;
  /** Wall role the feature attaches to, or "floor" for floor features. */
  at: WallRole | "floor";
  /** Normalized span along the wall / across the floor (0..1). */
  span?: readonly [number, number];
}

/**
 * One content zone, authored in NORMALIZED plan coordinates: x ∈ [0, 1]
 * maps to (−halfW, +halfW), z ∈ [0, 1] maps to (0, extent) — so the zone
 * survives the room's size tier, width factor, and scale notation.
 * `mirrorWithLSide` mirrors the x span when the plan's l-shape keeps its
 * −x half: zones of an l-shape template are authored for lSide = +1 and
 * follow the kept wing (the guest room's bed corner).
 */
export interface TemplateZone {
  kind: "hero" | "cluster" | "keep-empty";
  rect: { x: readonly [number, number]; z: readonly [number, number] };
  mirrorWithLSide?: boolean;
}

/** A pre-authored room layout — the unit of the design layer. */
export interface RoomTemplate {
  id: string;
  /** Authoring label (设计稿上的名字). */
  label: string;
  /** World classes that may select this template. */
  worldClasses: readonly WorldClass[];
  /** Optional archetype whitelist within those classes. */
  archetypes?: readonly ArchetypeId[];
  /** The plan silhouette the layout is built on. */
  footprint: PlanId;
  /** Minimum UNSCALED extent tier (16/32/64/96): a small room never picks
   *  a hall. */
  minExtent: number;
  /** Maximum strand doors this layout absorbs gracefully. Selection
   *  guarantees doorCount ≤ capacity whenever any eligible template fits. */
  doorCapacity: number;
  /** Wall roles that may carry strand doors — never the shelf-run wall,
   *  never the niche wall (§7.2). Positions stay seed-drawn. */
  doorWalls: readonly WallRole[];
  /** Feature slots (§3.2 dressing) the renderer will build. */
  features: readonly FeatureSlot[];
  /** Content zones: hero, kit clusters, must-stay-empty. */
  zones: readonly TemplateZone[];
  /** Optional hero pin: this kit id anchors the hero zone (§4.1's composed
   *  focal point made explicit — the reading hall's long table). */
  heroKit?: string;
  /** Selection weight among the eligible candidates. */
  weight: number;
}

/* ------------------------------------------------------------------ */
/* The three interior templates (§7.5)                                  */
/* ------------------------------------------------------------------ */

export const ROOM_TEMPLATES: readonly RoomTemplate[] = [
  {
    // 阅览厅 — shelf runs on three walls, a long central table, a niche at
    // the far end. The niche wall never carries a door; doors break the
    // side shelf runs only (domestic, low capacity).
    id: "reading-hall",
    label: "阅览厅",
    worldClasses: ["interior"],
    archetypes: ["library", "ballroom"],
    footprint: "rect",
    minExtent: 32,
    doorCapacity: 4,
    doorWalls: ["left", "right"],
    features: [
      { kind: "niche", at: "far", span: [0.4, 0.6] },
      { kind: "pilaster-rhythm", at: "left" },
      { kind: "pilaster-rhythm", at: "right" },
    ],
    heroKit: "dining", // the long central table — pinned where dining is
    // whitelisted (ballroom); in a library the hero falls back to the
    // seeded draw among hero-eligible kits (the pin never widens a kit's
    // archetype whitelist on its own).
    zones: [
      // 中央长桌
      { kind: "hero", rect: { x: [0.32, 0.68], z: [0.3, 0.66] } },
      // 左 / 右书架墙前
      { kind: "cluster", rect: { x: [0, 0.2], z: [0.08, 0.95] } },
      { kind: "cluster", rect: { x: [0.8, 1], z: [0.08, 0.95] } },
      // 远端墙前(凹龛两侧)
      { kind: "cluster", rect: { x: [0.1, 0.9], z: [0.78, 0.97] } },
      // 入口围裙留白
      { kind: "keep-empty", rect: { x: [0, 1], z: [0, 0.1] } },
    ],
    weight: 3,
  },
  {
    // 客房 — an l-shape whose near zone is the entrance-ish 门厅 and whose
    // kept wing is the bedroom: bed corner deep in the wing, luggage by the
    // hall. Doors line the hall walls and the step wall; the bed corner's
    // far wall and the wing's inner wall never carry one.
    id: "guest-room",
    label: "客房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room"],
    footprint: "l-shape",
    minExtent: 32,
    doorCapacity: 5,
    doorWalls: ["left", "right", "step"],
    features: [{ kind: "floor-inlay", at: "floor", span: [0.3, 0.7] }],
    heroKit: "bed-corner",
    zones: [
      // 床角(保留翼深处 — authored for lSide = +1, mirrored otherwise)
      {
        kind: "hero",
        rect: { x: [0.58, 0.92], z: [0.64, 0.92] },
        mirrorWithLSide: true,
      },
      // 卧室翼
      {
        kind: "cluster",
        rect: { x: [0.55, 0.95], z: [0.6, 0.95] },
        mirrorWithLSide: true,
      },
      // 行李区(门厅旁)
      { kind: "cluster", rect: { x: [0.1, 0.42], z: [0.1, 0.4] } },
      // 门厅脊线留白
      { kind: "keep-empty", rect: { x: [0.42, 0.58], z: [0, 0.6] } },
    ],
    weight: 2,
  },
  {
    // 画廊 — a colonnade with a floor inlay and ONE WHOLE WALL built to
    // carry many doors: the template that absorbs a 20-strand day. The
    // colonnade's sides are open bays (no segments, never hosts), so every
    // door gathers on the far wall — a door wall, read as such.
    id: "gallery",
    label: "画廊",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    footprint: "colonnade",
    minExtent: 64,
    doorCapacity: 24,
    doorWalls: ["far"],
    features: [
      { kind: "floor-inlay", at: "floor", span: [0.15, 0.85] },
      { kind: "pilaster-rhythm", at: "far" },
    ],
    zones: [
      // 展品焦点(柱廊与门墙之间)
      { kind: "hero", rect: { x: [0.36, 0.64], z: [0.6, 0.82] } },
      // 两翼簇
      { kind: "cluster", rect: { x: [0.08, 0.3], z: [0.15, 0.7] } },
      { kind: "cluster", rect: { x: [0.7, 0.92], z: [0.15, 0.7] } },
      // 中央通道留白(门到焦点的轴)
      { kind: "keep-empty", rect: { x: [0.4, 0.6], z: [0, 0.55] } },
    ],
    weight: 2,
  },
];

/** Look up a template by id. */
export function roomTemplateById(id: string): RoomTemplate | undefined {
  return ROOM_TEMPLATES.find((t) => t.id === id);
}

/* ------------------------------------------------------------------ */
/* Selection (§7.2: 门数匹配在源头承担)                                  */
/* ------------------------------------------------------------------ */

/** Templates a room of this class/archetype/tier may select (before the
 *  door-capacity pass). */
export function eligibleTemplates(
  worldClass: string,
  archetype: string,
  baseExtent: number,
): readonly RoomTemplate[] {
  return ROOM_TEMPLATES.filter(
    (t) =>
      (t.worldClasses as readonly string[]).includes(worldClass) &&
      (!t.archetypes || (t.archetypes as readonly string[]).includes(archetype)) &&
      baseExtent >= t.minExtent,
  );
}

/**
 * Resolve the room's layout template. Deterministic (A6): same slice, same
 * door count ⇒ same template, always.
 *
 * The door count is a SELECTION input, not a placement constraint (§7.2):
 * candidates that can absorb `doorCount` within their declared capacity are
 * preferred; when none can (more strands than any template's capacity), the
 * highest-capacity candidates carry the overflow and room-doors.ts's
 * spacing ladder does what it always did — relax, never drop.
 *
 * Returns null when no template fits at all (today: every non-interior
 * world class — the template set covers interior only, §7.5's first step).
 */
export function resolveRoomTemplate(
  sliceId: string,
  worldClass: string,
  archetype: string,
  baseExtent: number,
  doorCount: number = 0,
  worldSeed: string = WORLD_SEED,
): RoomTemplate | null {
  const eligible = eligibleTemplates(worldClass, archetype, baseExtent);
  if (eligible.length === 0) return null;
  const fitting = eligible.filter((t) => t.doorCapacity >= doorCount);
  const pool =
    fitting.length > 0
      ? fitting
      : eligible.filter(
          (t) => t.doorCapacity === Math.max(...eligible.map((u) => u.doorCapacity)),
        );
  const rng = createRng(hashString(`${worldSeed}:${sliceId}:room-template`));
  let ticket = rng() * pool.reduce((sum, t) => sum + t.weight, 0);
  for (const t of pool) {
    ticket -= t.weight;
    if (ticket < 0) return t;
  }
  return pool[pool.length - 1];
}

/* ------------------------------------------------------------------ */
/* Consumption adapters — the template as the existing modules' input.  */
/* ------------------------------------------------------------------ */

/** The template's declared silhouette, as roomPlanFor's optional plan. */
export function templatePlanFor(template: RoomTemplate): TemplatePlan {
  return { plan: template.footprint };
}

/** The template's door affordance, as placeRoomDoors' optional input. */
export function doorAffordanceFor(template: RoomTemplate): DoorAffordance {
  return { walls: template.doorWalls };
}

/**
 * Resolve the template's normalized content zones into absolute plan
 * coordinates for kits.ts (x fraction → −halfW…+halfW, z fraction →
 * 0…extent; l-shape-mirrored zones follow the kept wing). Pure.
 */
export function templateZonesFor(template: RoomTemplate, plan: RoomPlan): KitZones {
  const toRect = (zone: TemplateZone): KitZoneRect => {
    let [x0, x1] = zone.rect.x;
    if (zone.mirrorWithLSide && plan.id === "l-shape" && plan.lSide < 0) {
      [x0, x1] = [1 - x1, 1 - x0];
    }
    return {
      x0: (x0 - 0.5) * plan.width,
      x1: (x1 - 0.5) * plan.width,
      z0: zone.rect.z[0] * plan.extent,
      z1: zone.rect.z[1] * plan.extent,
    };
  };
  const hero = template.zones.find((z) => z.kind === "hero");
  return {
    hero: hero ? toRect(hero) : undefined,
    heroKit: template.heroKit,
    clusters: template.zones.filter((z) => z.kind === "cluster").map(toRect),
    keepEmpty: template.zones.filter((z) => z.kind === "keep-empty").map(toRect),
  };
}

/**
 * Consistency audit, run by the tests: every doorWall role a template
 * permits must exist on its footprint's perimeter (a colonnade has no side
 * walls; an l-shape has them all), and every wall-bound feature slot must
 * attach to a wall role the footprint has. Returns the violations (empty =
 * sound). Pure data checking — no geometry is re-implemented here.
 */
export function auditTemplate(template: RoomTemplate): string[] {
  const rolesByPlan: Record<PlanId, readonly WallRole[]> = {
    rect: ["entrance", "left", "right", "far"],
    "l-shape": ["entrance", "left", "right", "far", "step", "inner"],
    colonnade: ["entrance", "far"],
  };
  const available = rolesByPlan[template.footprint];
  const problems: string[] = [];
  for (const role of template.doorWalls) {
    if (!available.includes(role)) {
      problems.push(`${template.id}: doorWall "${role}" absent on ${template.footprint}`);
    }
  }
  for (const f of template.features) {
    if (f.at !== "floor" && !available.includes(f.at)) {
      problems.push(`${template.id}: feature ${f.kind}@"${f.at}" absent on ${template.footprint}`);
    }
  }
  if (template.doorWalls.length === 0 && template.doorCapacity > 0) {
    problems.push(`${template.id}: capacity ${template.doorCapacity} with no door walls`);
  }
  return problems;
}
