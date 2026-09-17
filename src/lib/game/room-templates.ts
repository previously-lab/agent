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
 * CAPACITY IS MEASURED, NOT TIER-CLAIMED (Finding A, 2026-10): the
 * template's `doorCapacity` is a declared CEILING (a huge room may not
 * demand an absurd door count), but the capacity selection steers by is
 * measured in hostable wall metres on the SCALED plan the caller already
 * computes — room-doors.ts's doorCapacityFor over the template's permitted
 * wall roles at the ladder's domestic spacing. A miniature ×0.2 colossal
 * room then gets the four doors its 13m door wall truly hosts, not the 24
 * its tier was authored for. Callers pass the measurement in via
 * resolveRoomTemplate's optional `capacityFor`; omitting it reproduces the
 * pre-measurement selection exactly (declared ceiling only).
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
  /** Declared CEILING on the strand doors this layout may be asked to
   *  absorb: a huge room cannot demand an absurd door count. The capacity
   *  selection actually steers by is min(this ceiling, the measured
   *  capacity of the scaled plan's permitted walls) — see the module
   *  header (Finding A). */
  doorCapacity: number;
  /** Optional minimum door count (Finding B): a door-absorber layout only
   *  reads as designed when it genuinely carries many doors, so it stays
   *  INELIGIBLE below this count and can never steal an ordinary room from
   *  the domestic templates. Undefined = eligible at any count. */
  minDoors?: number;
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
/* The interior templates (§7.5's three + Finding B's mid-capacity     */
/* hall + the abundance pass's salon / twin-suite / lido, §8 modular)  */
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
    // 列门厅 — a hall whose FAR wall is a designed row of doors (Finding
    // B): the mid-capacity interior the set was missing. Where a busy day
    // asks an M-tier library or hotel room for a dozen strand doors, the
    // reading hall (ceiling 4) and guest room (ceiling 5) had to loosen
    // their wall bans; this hall was authored for exactly that load. The
    // minDoors gate keeps it ineligible below six doors — one more than
    // the largest domestic ceiling — so an ordinary room never loses its
    // reading hall or guest room to a door wall it does not need.
    id: "door-hall",
    label: "列门厅",
    worldClasses: ["interior"],
    archetypes: ["library", "ballroom", "hotel-room"],
    footprint: "rect",
    minExtent: 32,
    minDoors: 6,
    doorCapacity: 16,
    doorWalls: ["far"],
    features: [
      // The door row is the dressing: pilasters rhythm the door wall, an
      // inlay band leads down the hall's axis toward it.
      { kind: "pilaster-rhythm", at: "far" },
      { kind: "floor-inlay", at: "floor", span: [0.3, 0.7] },
    ],
    heroKit: "reading", // the one hero-eligible kit whitelisted for all
    // three archetypes — an armchair facing the door row, the calm trace.
    zones: [
      // 厅心焦点(门墙之前)
      { kind: "hero", rect: { x: [0.36, 0.64], z: [0.52, 0.74] } },
      // 两侧陪衬簇
      { kind: "cluster", rect: { x: [0.06, 0.28], z: [0.12, 0.55] } },
      { kind: "cluster", rect: { x: [0.72, 0.94], z: [0.12, 0.55] } },
      // 中央通道留白(入口到焦点的轴)
      { kind: "keep-empty", rect: { x: [0.42, 0.58], z: [0, 0.5] } },
      // 门墙前围裙留白 — the door row keeps its approach, wall to wall
      { kind: "keep-empty", rect: { x: [0, 1], z: [0.8, 1] } },
    ],
    weight: 1, // below the domestic templates and the gallery: it wins
    // only where it is the sole fitting candidate, or shares an overflow
    // pool at the low ticket.
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

  /* -------------------------------------------------------------- */
  /* The abundance pass (2026-10): three more layouts, authored in    */
  /* §8's modular spirit — each one says WHICH functional modules it  */
  /* combines (a living module, a bedroom wing, a deck pair) and HOW  */
  /* they connect, instead of one big room to scatter into. Domestic  */
  /* ceilings stay ≤ 5 so the door hall's minDoors gate (6) still     */
  /* reads as "one more than the largest domestic ceiling".           */
  /* -------------------------------------------------------------- */

  {
    // 沙龙 — the reception module writ large: a conversation pair as the
    // composed centrepiece, reading and bench clusters along both
    // pilastered sides, a far-side row of quiet corners. Doors break the
    // side walls only; the far composition wall stays whole.
    id: "salon",
    label: "沙龙",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    footprint: "rect",
    minExtent: 64,
    doorCapacity: 5,
    doorWalls: ["left", "right"],
    features: [
      { kind: "floor-inlay", at: "floor", span: [0.2, 0.8] },
      { kind: "pilaster-rhythm", at: "left" },
      { kind: "pilaster-rhythm", at: "right" },
    ],
    heroKit: "sofa-group",
    zones: [
      // 对坐沙发(厅心)
      { kind: "hero", rect: { x: [0.32, 0.68], z: [0.5, 0.74] } },
      // 两侧陪衬簇
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.15, 0.6] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.15, 0.6] } },
      // 远端静角排
      { kind: "cluster", rect: { x: [0.1, 0.9], z: [0.8, 0.96] } },
      // 入口围裙 + 中央走道留白
      { kind: "keep-empty", rect: { x: [0, 1], z: [0, 0.08] } },
      { kind: "keep-empty", rect: { x: [0.42, 0.58], z: [0.08, 0.46] } },
    ],
    weight: 2,
  },
  {
    // 双拼套房 — two modules joined at the l-shape's step (§8's 组合):
    // the near zone is the LIVING module (sofa group as its focus,
    // luggage by the door), the kept wing is the BEDROOM module (the
    // bed corner and its companions). The hall spine and the wing
    // crossing stay empty so the two modules read as connected, not
    // merged. Doors line the hall walls and the step; the bedroom wing's
    // own walls never carry one.
    id: "twin-suite",
    label: "双拼套房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room"],
    footprint: "l-shape",
    minExtent: 64,
    doorCapacity: 5,
    doorWalls: ["left", "right", "step"],
    features: [{ kind: "floor-inlay", at: "floor", span: [0.3, 0.7] }],
    heroKit: "sofa-group",
    zones: [
      // 起居模块焦点(近区 — the step sits at 45–60% depth, this is
      // always before it)
      { kind: "hero", rect: { x: [0.12, 0.42], z: [0.14, 0.42] } },
      // 卧室翼(保留翼深处 — authored for lSide = +1, mirrored otherwise)
      {
        kind: "cluster",
        rect: { x: [0.55, 0.95], z: [0.62, 0.95] },
        mirrorWithLSide: true,
      },
      // 行李区(门厅旁)
      { kind: "cluster", rect: { x: [0.66, 0.94], z: [0.1, 0.48] } },
      // 门厅脊线留白 — door to wing crossing
      { kind: "keep-empty", rect: { x: [0.46, 0.62], z: [0, 0.52] } },
    ],
    weight: 1,
  },
  {
    // 池厅 — the pool hall's deck pair (§8: two side-deck modules joined
    // by the water between them): loungers and towel stations face the
    // pool from both sides, the composed centrepiece is the lounger pair
    // on the far deck, and the pool's near rim keeps its walkway. Doors
    // break the side decks' walls only — the far deck's composition wall
    // and the water itself never carry one.
    id: "lido",
    label: "池厅",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    footprint: "rect",
    minExtent: 32,
    doorCapacity: 5,
    doorWalls: ["left", "right"],
    features: [
      { kind: "floor-inlay", at: "floor", span: [0.15, 0.85] },
      { kind: "pilaster-rhythm", at: "left" },
      { kind: "pilaster-rhythm", at: "right" },
    ],
    heroKit: "pool-loungers",
    zones: [
      // 远岸甲板焦点(the pool's water spans ~z 0.33–0.78 of depth —
      // the hero stands clear of it on the far deck)
      { kind: "hero", rect: { x: [0.3, 0.7], z: [0.82, 0.94] } },
      // 两侧甲板簇
      { kind: "cluster", rect: { x: [0.02, 0.22], z: [0.06, 0.95] } },
      { kind: "cluster", rect: { x: [0.78, 0.98], z: [0.06, 0.95] } },
      // 入口围裙 + 近岸步道留白
      { kind: "keep-empty", rect: { x: [0, 1], z: [0, 0.06] } },
      { kind: "keep-empty", rect: { x: [0, 1], z: [0.24, 0.32] } },
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
 *  door-capacity pass). `doorCount` (optional, default 0) additionally
 *  gates the door-absorber layouts on their declared `minDoors` — an
 *  ordinary room never even sees the door hall. Omitting it reproduces
 *  the pre-Finding-B eligibility exactly (no template then declared a
 *  minimum). */
export function eligibleTemplates(
  worldClass: string,
  archetype: string,
  baseExtent: number,
  doorCount: number = 0,
): readonly RoomTemplate[] {
  return ROOM_TEMPLATES.filter(
    (t) =>
      (t.worldClasses as readonly string[]).includes(worldClass) &&
      (!t.archetypes || (t.archetypes as readonly string[]).includes(archetype)) &&
      baseExtent >= t.minExtent &&
      doorCount >= (t.minDoors ?? 0),
  );
}

/**
 * Resolve the room's layout template. Deterministic (A6): same slice, same
 * door count ⇒ same template, always.
 *
 * The door count is a SELECTION input, not a placement constraint (§7.2):
 * candidates that can absorb `doorCount` within their effective capacity
 * are preferred; when none can (more strands than any candidate holds),
 * the highest-capacity candidates carry the overflow and room-doors.ts's
 * spacing ladder does what it always did — relax, never drop.
 *
 * `capacityFor` (optional, Finding A) measures one candidate's graceful
 * capacity on THIS room's scaled plan — room-doors.ts's doorCapacityFor
 * over the candidate's permitted wall roles. The effective capacity is
 * min(the declared ceiling, the measurement), so a miniature room's
 * shortened wall shrinks the claim while a colossal room stays capped.
 * Omitting it steers by the declared ceilings alone — exactly the
 * pre-measurement behaviour.
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
  capacityFor?: (template: RoomTemplate) => number,
): RoomTemplate | null {
  const eligible = eligibleTemplates(worldClass, archetype, baseExtent, doorCount);
  if (eligible.length === 0) return null;
  const effective = (t: RoomTemplate): number =>
    capacityFor ? Math.min(t.doorCapacity, capacityFor(t)) : t.doorCapacity;
  const fitting = eligible.filter((t) => effective(t) >= doorCount);
  const pool =
    fitting.length > 0
      ? fitting
      : eligible.filter(
          (t) => effective(t) === Math.max(...eligible.map(effective)),
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
