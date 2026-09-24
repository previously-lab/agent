/**
 * describeRoom (design v0.11-room-interiors §13, decision 4) — the game's
 * SECOND and last contribution to the agent: a COMPUTED outline of what a
 * slice's room contains, so Previously can answer "这间房里有什么" without
 * eyes.
 *
 * NO SUMMARY LOGIC OF ITS OWN. Every fact below is derived by calling the
 * same pure chain the renderer builds the room from —
 * space-recipe.ts (compileSpaceRecipe) → room-plan.ts (scaledRecipeFor /
 * scaleNotationFor / roomPlanFor / wallSegmentsFor / composeRoom) →
 * room-modules.ts (compositionForRecipe / compositionTemplateFor) or
 * room-templates.ts (resolveRoomTemplate) → room-doors.ts (doorCapacityFor /
 * placeRoomDoors) → kits.ts (stageInteriorKits) — with the same arguments
 * space.tsx / game-canvas.tsx pass them, so the description can never drift
 * from the render: change the render's pure modules and this outline changes
 * with them. A room is a pure function of its slice id, so describeRoom is
 * total and fully deterministic: same slice ⇒ same outline, on any machine,
 * independent of call order.
 *
 * WHAT IS NOT DERIVABLE from a slice id (and therefore never claimed):
 *   - the actual STRAND-DOOR placements. They are a function of the runtime
 *     strand graph (the door count) and the corridor door's side (the room's
 *     mirror, roomOrientationFor). Pass `strandDoors` + `corridorSide` to
 *     place them exactly as the renderer would; without them the outline
 *     reports the PERMITTED walls and the MEASURED capacity instead.
 *   - the pool hall's water-anchored LEGACY rim scatter (the pre-module
 *     fixtures — their obstacle discs live inside space.tsx, outside the
 *     pure chain). A COMPOSED pool room (the bath / pool-deck module
 *     rooms) furnishes from its modules' whitelists and blueprints ONLY —
 *     space.tsx hands the legacy scatter an empty list the moment a
 *     composition exists — so its kit staging is pure-chain and IS
 *     enumerated like every other interior room. What stays un-derivable
 *     is only the scatter itself (and the wonder rooms' animals +
 *     oversized rugs — buildAnimals / furnishInterior — outside the pure
 *     chain; their KITS are staged by the same pure call as everything
 *     else and ARE enumerated).
 *   - kit staging assumes the strand doors it was told about: without
 *     `strandDoors` + `corridorSide` the furnishing list matches a doorless
 *     render, and a room that grew strand doors may shift a side kit off a
 *     door approach the outline could not see.
 *
 * The window/lamp/clerestory notes mirror the authored rules of
 * space.tsx's buildRoomFixtures (windows prefer the east/west side walls —
 * §10.5 axial semantics — and since the v0.12 declarations audit the
 * window host pool EXCLUDES every wall that hosts a built wall feature —
 * niche, pilaster rhythm, arch, column order, platform, mezzanine — not
 * just the niche; the clerestory band exists on every non-interior room
 * plus the pool hall) and the light register mirrors its
 * lightRegisterFor draw (same lightSeed salt, same tuning weights). The
 * v0.12 P3 skin line mirrors skins.ts's skinForSlice — the SAME pure
 * source the renderer's skin lane reads, so the outline names the world
 * the render draws — and the same skin object also FEEDS the staging
 * call below (§6.2 overrides replace the slot kinds, the skin's decks
 * take over the draw), so the furnishing enumeration lists exactly the
 * pieces a skinned render stages. WONDER rooms are the one exception,
 * restated from the renderer's wonder branch: the skin stops at the VIEW
 * there — the diorama's authored deck is its structure, so the staging
 * call below receives NO skin for a wonder room (deck takeover never
 * displaces the playthings). A THIRD restated rule is the roomId
 * STRIP (debug-slice.ts debugSliceIdWithoutSkin): every seeded derivation
 * below runs on the skin-stripped id, so a forced skin never perturbs
 * the room's own streams (无皮肤 ≡ 温带) — the renderer's skin lane must
 * strip identically before ITS salt derivations, or the outline and the
 * render drift apart on skinned slices. Those are the ONLY renderer rules
 * restated here —
 * flagged so a change to
 * buildRoomFixtures' rules updates both places. `featureHostWalls`
 * derives the host pool from the same resolved template the renderer
 * builds the features from (the DECLARED wall features — a slot the host
 * rules refused builds nothing and hosts nothing, so the derived pool is
 * a superset of the render's actual one, and the window's exclusion only
 * tightens).
 *
 * Output: `describeRoom` returns structured, locale-free data;
 * `formatRoomDescription` renders it as an outline in English or Chinese —
 * the caller (the chat tool) picks by the turn's locale, so the pure module
 * never touches the i18n layer.
 */

import { compileSpaceRecipe } from "./space-recipe";
import {
  composeRoom,
  roomPlanFor,
  scaledRecipeFor,
  wallSegmentsFor,
  wallRoleFor,
  type PlanId,
  type ScaleNotation,
  type WallRole,
} from "./room-plan";
import {
  compositionForRecipe,
  compositionTemplateFor,
  type LightRegister as ModuleLight,
  type FloorRole,
  type WallRoleM,
  type TopologyId,
} from "./room-modules";
import {
  doorAffordanceFor,
  resolveRoomTemplate,
  templatePlanFor,
  templateZonesFor,
  type FeatureKind,
} from "./room-templates";
import {
  doorCapacityFor,
  doorClearanceSet,
  hostableWallsFor,
  placeRoomDoors,
} from "./room-doors";
import { planArea, stageInteriorKits, type KitKind } from "./kits";
import { schematicPlacementsFor } from "./room-schematic";
import { terrainHeight, waterRectFor } from "./terrain";
import {
  skinForSlice,
  type SkinFloorKind,
  type SkinHorizon,
  type SkinSilhouette,
  type SkinWalk,
  type SkinWallKind,
} from "./skins";
import { debugSliceIdWithoutSkin } from "./debug-slice";
import {
  ARCHETYPES,
  type ArchetypeId,
  type PaletteId,
  type WorldClass,
} from "./space-types";
import { createRng, deriveSubSeed, WORLD_SEED } from "./seed";
import {
  COLONNADE_BAY,
  LIGHT_REGISTER_WEIGHTS,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
  type LightRegister,
} from "./tuning/room";

export interface DescribeRoomOptions {
  /** The runtime strand-door count (the strand graph's say). When given
   *  WITH `corridorSide`, the doors are placed exactly as the renderer
   *  places them; alone it steers BOTH the module composition's sizing
   *  (§8.4 — a busy day grows modules) and the template selection, exactly
   *  as the real count does at render time. Absent = 0, the doorless
   *  derivation a room frozen before the strand lane resolved has. */
  strandDoors?: number;
  /** Which side of the corridor the room's door sits on — the room's
   *  mirror (roomOrientationFor: a north-side door means dir = 1). Needed
   *  for exact door placement: the camera-facing sill walls differ per
   *  side. Omit = report capacity, not placements. */
  corridorSide?: "north" | "south";
}

/** One module of a composed interior room (room-modules.ts §8). */
export interface RoomModuleOutline {
  id: string;
  /** The module's authoring label (设计稿上的中文名). */
  label: string;
  primary: boolean;
  floor: FloorRole;
  wall: WallRoleM;
  light: ModuleLight;
}

/** One actually-placed strand door (only with strandDoors + corridorSide). */
export interface PlacedDoorOutline {
  /** Wall role the door hangs on (far/step = the axial north faces). */
  wall: WallRole;
  /** 0 = on the perimeter wall; 1 = the freestanding screen row (§10.5 ②). */
  row: 0 | 1;
}

export interface RoomDescription {
  sliceId: string;
  worldClass: WorldClass;
  archetype: ArchetypeId;
  /** The archetype's ground shape (flat / rolling / sunken basin). */
  ground: "flat" | "rolling" | "sunken";
  sizeTier: "S" | "M" | "L" | "XL";
  /** Scale notation: v0.13 retired the tier draw — always normal ×1. */
  scale: ScaleNotation;
  /** Scaled floor-plan dims in meters (what the player walks). */
  width: number;
  extent: number;
  palette: PaletteId;
  /** The room's one light mood (tungsten / fluorescent / daylight / ember). */
  lightRegister: LightRegister;
  walled: boolean;
  ceiling: boolean;
  plan: {
    id: PlanId;
    /** l-shape only: which half is kept past the step (+1 east, −1 west). */
    lSide: 1 | -1 | null;
    /** colonnade only: the side-wall column count. */
    columns: number;
  };
  /** How the room's layout was authored: a module composition (§8 interiors),
   *  a catalogue template (§7), or the plain seeded draw. */
  layout:
    | {
        kind: "modules";
        topology: TopologyId;
        modules: RoomModuleOutline[];
        /** Consented interior seams (partition walls with an opening). */
        seams: number;
      }
    | { kind: "template"; id: string; label: string }
    | { kind: "none" };
  /** Authored geometric dressing (niche, inlay, pilasters…) — the resolved
   *  template's feature slots, module-synthesized for composed rooms. */
  features: { kind: FeatureKind; at: WallRole | "floor" }[];
  /** The water rect (pool / lake / sea), scaled meters — null when dry. */
  water: { width: number; depth: number; coverage: number } | null;
  /** The v0.12 P3 biome skin this room wears — the world assignment for a
   *  real slice (skins.ts: the compiled archetype's skin; interior worlds
   *  resolve null, the temperate baseline) or the `dbg-skin:` debug force.
   *  Same pure source the renderer reads, so the outline can never describe
   *  a different world than the render draws. WONDER rooms wear their
   *  skin's VIEW (floor/walls/outside/fog) but keep their authored deck —
   *  the diorama's playthings are its structure, not its world's. */
  skin: {
    id: string;
    floor: SkinFloorKind;
    /** dry walks at full speed; wade walks slower (speed < 1). */
    walk: SkinWalk;
    wall: SkinWallKind;
    outside: SkinSilhouette;
    horizon: SkinHorizon;
    /** §6.2 environment slot overrides (role → environment kind). */
    overrides: { role: string; feature: KitKind }[];
  } | null;
  /** Interior furnishing staged by kits.ts — the EXACT kit placements the
   *  renderer builds (hero first). Present for EVERY interior room: the
   *  pool-hall modules (bath, pool-deck) furnish from their whitelists and
   *  blueprints exactly like the other modules — only the pre-module
   *  water-anchored rim scatter lived outside the pure chain, and the
   *  renderer retires it the moment a composition exists. Present for
   *  EVERY nature and hybrid room (the world's skin owns the draw
   *  vocabulary; a water biome furnishes from its skin's shore kits), and
   *  for wonder rooms (the rugs and animals stay outside the pure chain —
   *  the kits are staged by the same pure call as everything else and ARE
   *  enumerated). Null everywhere else. */
  furnishing: { kit: string; pieces: KitKind[] }[] | null;
  doors: {
    /** Wall roles strand doors may hang on — null = no template, so any
     *  solid non-entrance wall may host (north/south first, §10.5). */
    permittedWalls: readonly WallRole[] | null;
    /** The template's declared ceiling (null when untemplated). */
    declaredCapacity: number | null;
    /** The MEASURED capacity of the permitted north/south walls at domestic
     *  spacing, on this room's scaled plan (Finding A). */
    measuredCapacity: number;
    /** Exact placements — present only when strandDoors + corridorSide were
     *  given. */
    placed?: {
      doors: PlacedDoorOutline[];
      relaxed: boolean;
      doubleRow: boolean;
      axialOverflow: boolean;
    };
  };
  fixtures: {
    /** Every room grows a lamp and a window; the window prefers an
     *  east/west side wall (§10.5 axial semantics). */
    windowPrefersSideWall: boolean;
    /** v0.12: the window host pool excludes every wall hosting a wall
     *  feature (niche, pilaster rhythm, arch, column order, platform,
     *  mezzanine) — derived from this room's declared wall features (see
     *  the module header's same-source note). */
    featureHostWalls: readonly WallRole[];
    /** The high clerestory band: every non-interior room + the pool hall. */
    clerestory: boolean;
  };
}

/**
 * The room's light register — MIRRORS space.tsx's lightRegisterFor (same
 * lightSeed salt, same LIGHT_REGISTER_WEIGHTS): one room, one light mood,
 * drawn off the recipe's light stream. Restated here because space.tsx is a
 * renderer module the pure chain cannot import; if that draw changes, change
 * this one too.
 */
function lightRegisterForRecipe(lightSeed: number): LightRegister {
  const r = createRng((lightSeed ^ 0x51f15e) >>> 0)();
  let acc = 0;
  for (const entry of LIGHT_REGISTER_WEIGHTS) {
    acc += entry.weight;
    if (r < acc) return entry.id;
  }
  return "tungsten";
}

/**
 * Compute the outline of the room behind slice `sliceId`'s door. Pure and
 * total: any string is a valid slice id (compileSpaceRecipe never throws),
 * and the result is a deterministic function of (sliceId, options).
 */
export function describeRoom(
  sliceId: string,
  options: DescribeRoomOptions = {},
): RoomDescription {
  // The v0.12 P3 biome skin this slice wears (skins.ts skinForSlice) — the
  // SAME pure source the renderer's skin lane reads. The skin rides the
  // FULL slice id; the ROOM's identity strips the prefix
  // (debug-slice.ts debugSliceIdWithoutSkin): a forced skin is a VIEW-layer
  // force and must never perturb the room's own seeded streams — same unit,
  // same plan, same doors, same furniture under every skin
  // (无皮肤 ≡ 温带). Feeding the skin to the staging call below is what
  // keeps the outline's furnishing in lockstep with a skinned render:
  // §6.2-overridden slots list the replacement kinds and the
  // hero/side/open-field kits list the skin's decks. Real slices resolve
  // their world's skin (an interior world answers null — the temperate
  // baseline), and a null skin stages byte-for-byte the legacy way.
  const skin = skinForSlice(sliceId);
  const roomId = debugSliceIdWithoutSkin(sliceId);
  // The renderer's own derivation order (space.tsx SpaceScene /
  // game-canvas.tsx roomGeometryForSpace), same functions, same arguments.
  const recipe = compileSpaceRecipe(roomId, WORLD_SEED);
  // The strand-door count steers the composition the same way the renderer
  // steers it (§8.4): absent = 0, the doorless derivation the renderer's
  // own pre-strand resolutions freeze — a description WITH the count
  // matches a room built WITH it.
  const strandDoors = options.strandDoors ?? 0;
  const { recipe: scaled, scale } = scaledRecipeFor(recipe, strandDoors);
  const scaleFactor = scale.factor;
  const propScale = Math.pow(scaleFactor, PROP_SCALE_EXP);
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  const bay = COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35));
  const width = scaled.width;
  const extent = scaled.size.extent;

  // Layout resolution: a composed interior's template IS its module
  // composition; other rooms draw from the §7 catalogue (measured
  // selection — capacity measured on the scaled plan, like the renderer's
  // roomTemplateForDoorCount).
  const composition = compositionForRecipe(recipe, WORLD_SEED, strandDoors);
  const template = composition
    ? compositionTemplateFor(composition)
    : resolveRoomTemplate(
        roomId,
        recipe.worldClass,
        recipe.archetype,
        recipe.size.extent,
        strandDoors,
        WORLD_SEED,
        (t) => {
          const p = roomPlanFor(
            roomId,
            width,
            extent,
            bay,
            WORLD_SEED,
            templatePlanFor(t),
          );
          return doorCapacityFor(
            p,
            wallSegmentsFor(p, wallThick),
            null,
            doorAffordanceFor(t),
          );
        },
      );

  const plan = roomPlanFor(
    roomId,
    width,
    extent,
    bay,
    WORLD_SEED,
    template ? templatePlanFor(template) : undefined,
  );
  const walls = wallSegmentsFor(plan, wallThick);
  const water = waterRectFor(scaled);
  const spec = ARCHETYPES[recipe.archetype];

  // Strand doors: capacity always (pure); exact placements only when the
  // runtime inputs (count + corridor side) were handed over.
  const affordance = template ? doorAffordanceFor(template) : undefined;
  const placedLayout =
    strandDoors > 0 && options.corridorSide !== undefined
      ? placeRoomDoors(
          roomId,
          plan,
          walls,
          hostableWallsFor(
            plan,
            walls,
            options.corridorSide === "north" ? 1 : -1,
          ),
          strandDoors,
          WORLD_SEED,
          affordance,
        )
      : null;
  const placed = placedLayout
    ? {
        doors: placedLayout.doors.map((d) => ({
          wall: wallRoleFor(plan, walls[d.wall]),
          row: d.row,
        })),
        relaxed: placedLayout.relaxed,
        doubleRow: placedLayout.doubleRow,
        axialOverflow: placedLayout.axialOverflow,
      }
    : undefined;

  // Interior furnishing: the renderer's exact staging (space.tsx's furniture
  // memo) — same "furniture" stream, same kit whitelist, same zones, same
  // heightfield snap. Covered rooms: the INTERIOR classes (module-whitelisted
  // when composed) — INCLUDING the pool-hall modules: a composed pool room
  // furnishes from its modules' whitelists and blueprints alone (space.tsx
  // retires the legacy rim scatter the moment a composition exists — its
  // obstacle discs were the only pure-chain-unreachable input, and they are
  // EMPTY for these rooms), so the enumeration names exactly the pieces the
  // render stages. EVERY nature and hybrid room (the world's skin owns the
  // draw vocabulary — a water biome furnishes from its skin's shore kits, so
  // the outdoor pool biome enumerates like any other), and WONDER rooms (the
  // rugs/animals stay outside the pure chain; the kits are staged here
  // exactly as staged there — under a view-only skin: the wonder deck is
  // the diorama's structure and the skin's decks never replace it). Water
  // biomes subtract their basin from the density area, mirroring the
  // renderer's branches.
  let furnishing: RoomDescription["furnishing"] = null;
  // EVERY standard world class furnishes through the staging machine —
  // interior pool halls included since the module layer (§8) took over
  // their content. (The gate stays a gate, not a constant: a room class
  // outside these four still answers null.)
  const furnishClass =
    recipe.worldClass === "interior" ||
    recipe.worldClass === "wonder" ||
    recipe.worldClass === "nature" ||
    recipe.worldClass === "hybrid"
      ? recipe.worldClass
      : null;
  if (furnishClass) {
    const rng = createRng(deriveSubSeed(WORLD_SEED, roomId, "furniture"));
    const kitIds = composition
      ? [...new Set(composition.modules.flatMap((p) => p.module.kits))]
      : undefined;
    // v0.12 §2: the renderer's schematic input, rebuilt from the same
    // composition — the outline lists exactly the pieces the blueprint
    // stages (kitId "living:seating" etc.), same as the render.
    const schematicPlacements = composition
      ? schematicPlacementsFor(composition.modules, scaleFactor)
      : [];
    const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
    const waterArea = water
      ? (water.halfX * 2 * water.halfZ * 2) / (scaleFactor * scaleFactor)
      : 0;
    const staged = stageInteriorKits({
      rng,
      // A hybrid furnishes on the outdoor machine — its biome's world, the
      // same draw the renderer's nature branch stages.
      worldClass: furnishClass === "hybrid" ? "nature" : furnishClass,
      archetype: recipe.archetype,
      // Wonder rooms wear their skin's VIEW only: the diorama keeps its
      // authored deck (the renderer's wonder branch passes no skin to
      // staging), so the outline enumerates the playthings, not the skin's
      // nature decks.
      skin: recipe.worldClass === "wonder" ? null : skin,
      plan,
      comp: composeRoom(roomId, plan, scaleFactor, WORLD_SEED),
      baseArea: Math.max(0, baseArea - waterArea),
      baseExtent: recipe.size.extent,
      propScale,
      wallThick,
      water,
      // The renderer clears kit pieces off every placed strand door's
      // approach (plus the mirrored screen-row copies). Without the runtime
      // door inputs there are none — the outline then matches a doorless
      // render, and a room that grew strand doors may shift a side kit.
      doors: doorClearanceSet(placedLayout?.doors ?? []),
      ...(kitIds ? { kitIds } : {}),
      ...(schematicPlacements.length > 0 ? { schematics: schematicPlacements } : {}),
      // §8.2 随机区域: the composition's open fields dress sparsely (0–3
      // seeded pieces) — the same scaled plan coordinates the renderer
      // passes, so the outline lists exactly what the room grows.
      ...(composition && composition.openFields.length > 0
        ? {
            openFields: composition.openFields.map((f) => ({
              x0: f.x0 * scaleFactor,
              z0: f.z0 * scaleFactor,
              x1: f.x1 * scaleFactor,
              z1: f.z1 * scaleFactor,
            })),
          }
        : {}),
      ...(template ? { zones: templateZonesFor(template, plan) } : {}),
      heightAt: (x, z) => terrainHeight(scaled, x, z),
    });
    const byPlacement = new Map<number, { kit: string; pieces: KitKind[] }>();
    for (const piece of staged) {
      const entry = byPlacement.get(piece.kitIndex) ?? {
        kit: piece.kitId,
        pieces: [],
      };
      entry.pieces.push(piece.kind);
      byPlacement.set(piece.kitIndex, entry);
    }
    furnishing = [...byPlacement.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
  }

  return {
    sliceId,
    worldClass: recipe.worldClass,
    archetype: recipe.archetype,
    ground: spec.ground,
    sizeTier: recipe.size.id,
    scale,
    width,
    extent,
    palette: recipe.palette.id,
    lightRegister: lightRegisterForRecipe(recipe.lightSeed),
    walled: spec.walled,
    ceiling: spec.ceiling,
    plan: {
      id: plan.id,
      lSide: plan.id === "l-shape" ? plan.lSide : null,
      columns: plan.columns.length,
    },
    layout: composition
      ? {
          kind: "modules",
          topology: composition.topology,
          modules: composition.modules.map((p) => ({
            id: p.module.id,
            label: p.module.label,
            primary: p.primary,
            floor: p.module.floor,
            wall: p.module.wall,
            light: p.module.light,
          })),
          seams: composition.seams.length,
        }
      : template
        ? { kind: "template", id: template.id, label: template.label }
        : { kind: "none" },
    features: (template?.features ?? []).map((f) => ({ kind: f.kind, at: f.at })),
    water: water
      ? {
          width: water.halfX * 2,
          depth: water.halfZ * 2,
          coverage: spec.waterCoverage,
        }
      : null,
    skin: skin
      ? {
          id: skin.id,
          floor: skin.floor.kind,
          walk: skin.floor.walk,
          wall: skin.wall.kind,
          outside: skin.window.silhouette,
          horizon: skin.fog.horizon,
          overrides: (skin.slotOverrides ?? []).map((o) => ({
            role: o.role,
            feature: o.feature,
          })),
        }
      : null,
    furnishing,
    doors: {
      permittedWalls: affordance ? affordance.walls : null,
      declaredCapacity: template ? template.doorCapacity : null,
      measuredCapacity: doorCapacityFor(plan, walls, null, affordance),
      ...(placed ? { placed } : {}),
    },
    fixtures: {
      windowPrefersSideWall: spec.walled,
      featureHostWalls: [
        ...new Set(
          (template?.features ?? [])
            .filter((f) => f.at !== "floor")
            .map((f) => f.at as WallRole),
        ),
      ],
      clerestory: recipe.worldClass !== "interior" || recipe.archetype === "pool-hall",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Localization (the caller's locale renders the structured facts)      */
/* ------------------------------------------------------------------ */

export type RoomDescriptionLocale = "en" | "zh";

const WORLD_CLASS_ZH: Record<WorldClass, string> = {
  nature: "自然",
  interior: "室内",
  hybrid: "混合（自然地貌 + 不属于这里的家具）",
  wonder: "奇景透视盒",
};
const ARCHETYPE_ZH: Record<ArchetypeId, string> = {
  meadow: "草甸",
  plains: "原野",
  pool: "水池",
  forest: "森林",
  ocean: "海洋",
  lake: "湖泊",
  beach: "海滩",
  snowfield: "雪原",
  "hotel-room": "客房",
  "pool-hall": "泳池厅",
  library: "图书馆",
  ballroom: "舞厅",
  ducks: "鸭子",
  cats: "猫",
  dogs: "狗",
  balloons: "气球",
};
const PLAN_ZH: Record<PlanId, string> = {
  rect: "矩形",
  "l-shape": "L 形",
  colonnade: "柱廊（两侧开敞柱间）",
};
const SCALE_ZH: Record<ScaleNotation["id"], string> = {
  normal: "正常尺度",
};
const REGISTER_ZH: Record<LightRegister, string> = {
  tungsten: "钨丝灯",
  fluorescent: "荧光灯",
  daylight: "日光",
  ember: "余烬",
};
const MODULE_LIGHT_ZH: Record<ModuleLight, string> = {
  task: "作业照明",
  wash: "洗墙",
  daylight: "日光",
  "pool-bounce": "水面反光",
  quiet: "静谧",
};
const WALL_ROLE_ZH: Record<WallRole, string> = {
  entrance: "入口墙（南）",
  left: "左墙（西）",
  right: "右墙（东）",
  far: "尽头墙（北）",
  step: "台阶墙（北向）",
  inner: "内墙",
};
const FEATURE_ZH: Record<FeatureKind, string> = {
  niche: "壁龛",
  "raised-platform": "高台",
  "pilaster-rhythm": "壁柱韵律",
  "floor-inlay": "地面镶嵌",
  "water-rill": "水渠",
  mezzanine: "夹层",
  "arch-frame": "拱门框",
  "column-order": "柱式",
};
const FLOOR_ZH: Record<FloorRole, string> = {
  timber: "木地板",
  carpet: "地毯",
  tile: "瓷砖",
  deck: "甲板",
};
const WALL_ZH: Record<WallRoleM, string> = {
  plaster: "灰泥墙",
  panelling: "护墙板",
  tile: "瓷砖墙",
  shelf: "书架墙",
};
const SKIN_FLOOR_ZH: Record<SkinFloorKind, string> = {
  timber: "木地板",
  carpet: "地毯",
  tile: "瓷砖",
  deck: "甲板",
  sand: "沙地",
  grass: "草地",
  moss: "苔藓地面",
  gravel: "碎石地",
  snow: "雪地",
  stone: "石板地",
  "shallow-water": "浅水",
};
const SKIN_WALL_ZH: Record<SkinWallKind, string> = {
  plaster: "灰泥墙",
  panelling: "护墙板",
  tile: "瓷砖墙",
  shelf: "书架墙",
  rock: "岩壁",
  stone: "石砌墙",
  hedge: "树篱墙",
  glass: "玻璃墙",
  "water-wall": "水墙（不可穿越）",
};
const SKIN_SILHOUETTE_ZH: Record<SkinSilhouette, string> = {
  "soft-hills": "远山",
  dunes: "沙丘",
  treeline: "林线",
  "mist-forest": "雾中林影",
  "open-water": "开阔水面",
};
const SKIN_HORIZON_ZH: Record<SkinHorizon, string> = {
  "soft-hills": "柔和丘陵",
  "sand-haze": "沙尘远霭",
  "light-shafts": "林间光柱",
  "wet-mist": "湿雾",
  "clear-depth": "清澈深水",
};
const TOPOLOGY_ZH: Record<TopologyId, string> = {
  row: "一字排开",
  ell: "L 形相接",
  cross: "十字相接",
  ring: "环形相接",
};

const round = (n: number): number => Math.round(n * 10) / 10;

/** The one piece count line for a kit placement: "bed×1, nightstand×2". */
function pieceCounts(pieces: readonly KitKind[]): string {
  const counts = new Map<KitKind, number>();
  for (const p of pieces) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(", ");
}

/**
 * Render a RoomDescription as an outline text the agent can quote from.
 * Locale-free data in → English or Chinese out; every line states only what
 * the pure chain proved (see the module header for what is never claimed).
 */
export function formatRoomDescription(
  desc: RoomDescription,
  locale: RoomDescriptionLocale = "en",
): string {
  const zh = locale === "zh";
  const L: string[] = [];
  const worldClass = zh ? WORLD_CLASS_ZH[desc.worldClass] : desc.worldClass;
  const archetype = zh ? ARCHETYPE_ZH[desc.archetype] : desc.archetype;
  const scale = zh ? SCALE_ZH[desc.scale.id] : desc.scale.id;
  const scaleFactor =
    desc.scale.id === "normal" ? "" : ` ×${round(desc.scale.factor)}`;

  L.push(
    zh
      ? `房间大纲 · slice ${desc.sliceId}（由种子纯推导，与渲染同源）`
      : `Room outline · slice ${desc.sliceId} (derived from the seed — the same pure chain the renderer builds from)`,
  );
  L.push(
    zh
      ? `世界：${worldClass} · ${archetype} ｜ 尺寸档：${desc.sizeTier}（${round(desc.extent)}m 深 × ${round(desc.width)}m 宽）｜ 尺度：${scale}${scaleFactor}`
      : `World: ${worldClass} · ${archetype} | size tier: ${desc.sizeTier} (${round(desc.extent)}m deep × ${round(desc.width)}m wide) | scale: ${scale}${scaleFactor}`,
  );

  const planName = zh ? PLAN_ZH[desc.plan.id] : desc.plan.id;
  const planNote =
    desc.plan.id === "l-shape"
      ? zh
        ? `，保留${desc.plan.lSide === 1 ? "东" : "西"}翼`
        : `, kept ${desc.plan.lSide === 1 ? "east" : "west"} wing`
      : desc.plan.id === "colonnade"
        ? zh
          ? `，${desc.plan.columns} 根柱`
          : `, ${desc.plan.columns} columns`
        : "";
  L.push(zh ? `平面：${planName}${planNote}` : `Plan: ${planName}${planNote}`);

  if (desc.layout.kind === "modules") {
    const modules = desc.layout.modules
      .map((m) => {
        const name = zh ? m.label : m.id;
        const detail = zh
          ? `${FLOOR_ZH[m.floor]}/${WALL_ZH[m.wall]}/${MODULE_LIGHT_ZH[m.light]}`
          : `${m.floor}/${m.wall}/${m.light}`;
        const primary = m.primary ? (zh ? "·主模块" : "·primary") : "";
        return zh ? `${name}（${detail}）${primary}` : `${name} (${detail})${primary}`;
      })
      .join(" + ");
    L.push(
      zh
        ? `布局：模块组合（${TOPOLOGY_ZH[desc.layout.topology]}，${desc.layout.seams} 条打通的隔墙）：${modules}`
        : `Layout: module composition (${desc.layout.topology}, ${desc.layout.seams} open partition(s)): ${modules}`,
    );
  } else if (desc.layout.kind === "template") {
    L.push(
      zh
        ? `布局：模板「${desc.layout.label}」（${desc.layout.id}）`
        : `Layout: template "${desc.layout.label}" (${desc.layout.id})`,
    );
  }

  L.push(
    zh
      ? `调色板：${desc.palette} ｜ 光照寄存器：${REGISTER_ZH[desc.lightRegister]}`
      : `Palette: ${desc.palette} | light register: ${desc.lightRegister}`,
  );

  if (desc.skin) {
    const floor = zh ? SKIN_FLOOR_ZH[desc.skin.floor] : desc.skin.floor;
    const walkNote =
      desc.skin.walk === "wade"
        ? zh
          ? "（涉水可行走，更慢）"
          : " (wadeable, slower)"
        : "";
    const wall = zh ? SKIN_WALL_ZH[desc.skin.wall] : desc.skin.wall;
    const outside = zh
      ? SKIN_SILHOUETTE_ZH[desc.skin.outside]
      : desc.skin.outside;
    const horizon = zh ? SKIN_HORIZON_ZH[desc.skin.horizon] : desc.skin.horizon;
    L.push(
      zh
        ? `环境皮肤：${desc.skin.id}｜地面：${floor}${walkNote}｜墙面：${wall}｜窗外：${outside}｜雾景：${horizon}`
        : `Skin: ${desc.skin.id} | floor: ${floor}${walkNote} | walls: ${wall} | outside: ${outside} | haze: ${horizon}`,
    );
    if (desc.skin.overrides.length > 0) {
      const list = desc.skin.overrides
        .map((o) => `${o.role}→${o.feature}`)
        .join(", ");
      L.push(
        zh
          ? `槽位替换：${list}（净空与朝向不变）`
          : `Slot overrides: ${list} (clearance and facing unchanged)`,
      );
    }
  }

  if (desc.features.length > 0) {
    const features = desc.features
      .map((f) => {
        const kind = zh ? FEATURE_ZH[f.kind] : f.kind;
        const at = f.at === "floor" ? (zh ? "地面" : "floor") : zh ? WALL_ROLE_ZH[f.at] : f.at;
        return `${kind}@${at}`;
      })
      .join(", ");
    L.push(zh ? `特征：${features}` : `Features: ${features}`);
  }

  if (desc.water) {
    L.push(
      zh
        ? `水：${round(desc.water.width)}m × ${round(desc.water.depth)}m（覆盖约 ${Math.round(desc.water.coverage * 100)}% 地面）`
        : `Water: ${round(desc.water.width)}m × ${round(desc.water.depth)}m (about ${Math.round(desc.water.coverage * 100)}% of the floor)`,
    );
  }
  if (desc.worldClass === "wonder") {
    L.push(
      zh
        ? `内容：${archetype}的立体透视盒（动物/气球与大地毯在纯推导链外，不逐一列举；套装见下）`
        : `Content: a seeded ${archetype} diorama (animals/balloons and the oversized rugs live outside the pure chain — kits below)`,
    );
  }

  if (desc.furnishing !== null) {
    if (desc.furnishing.length === 0) {
      L.push(zh ? "陈设：（空）" : "Furnishing: (empty)");
    } else {
      const [hero, ...rest] = desc.furnishing;
      const heroLine = `${hero.kit}(${pieceCounts(hero.pieces)})`;
      const restLine = rest
        .map((k) => `${k.kit}(${pieceCounts(k.pieces)})`)
        .join("; ");
      L.push(
        zh
          ? `陈设：主角套件 ${heroLine}${restLine ? `；其余：${restLine}` : ""}`
          : `Furnishing: hero kit ${heroLine}${restLine ? `; also: ${restLine}` : ""}`,
      );
    }
  } else if (desc.archetype === "pool-hall") {
    L.push(
      zh
        ? "陈设：泳池本体就是内容——水边fixture与甲板套件围绕水面布置（不在纯推导链内，不逐一列举）"
        : "Furnishing: the pool IS the content — water-anchored fixtures and deck kits gather around it (outside the pure chain, not enumerated)",
    );
  }

  const doorWalls = desc.doors.permittedWalls
    ? desc.doors.permittedWalls
        .map((w) => (zh ? WALL_ROLE_ZH[w] : w))
        .join(", ")
    : zh
      ? "任意实心非入口墙（轴向优先南北墙）"
      : "any solid non-entrance wall (north/south first, axial rule)";
  const capacityNote =
    desc.doors.declaredCapacity !== null
      ? zh
        ? `声明上限 ${desc.doors.declaredCapacity}，实测容量 ${desc.doors.measuredCapacity}`
        : `declared ceiling ${desc.doors.declaredCapacity}, measured capacity ${desc.doors.measuredCapacity}`
      : zh
        ? `实测容量 ${desc.doors.measuredCapacity}`
        : `measured capacity ${desc.doors.measuredCapacity}`;
  L.push(
    zh
      ? `门：入口在南墙（永远有一扇）；strand 门可挂：${doorWalls}（${capacityNote}）`
      : `Doors: the entrance is on the south wall (always one); strand doors may hang on: ${doorWalls} (${capacityNote})`,
  );
  if (desc.doors.placed) {
    const { doors, relaxed, doubleRow, axialOverflow } = desc.doors.placed;
    const list = doors
      .map((d) => {
        const wall = zh ? WALL_ROLE_ZH[d.wall] : d.wall;
        return d.row === 1 ? `${wall}${zh ? "（屏风挡）" : " (screen row)"}` : wall;
      })
      .join(", ");
    const flags = [
      relaxed ? (zh ? "间距已放宽" : "spacing relaxed") : null,
      doubleRow ? (zh ? "双排" : "double row") : null,
      axialOverflow ? (zh ? "溢出到东西墙" : "east/west overflow") : null,
    ].filter(Boolean);
    L.push(
      zh
        ? `已挂 strand 门 ${doors.length} 扇：${list}${flags.length ? `（${flags.join("，")}）` : ""}`
        : `Placed strand doors (${doors.length}): ${list}${flags.length ? ` (${flags.join(", ")})` : ""}`,
    );
  }

  const fixtureParts = [
    zh ? "窗优先挂东西侧墙" : "window prefers an east/west side wall",
    desc.fixtures.featureHostWalls.length > 0
      ? zh
        ? `窗避开特征宿主墙（${desc.fixtures.featureHostWalls
            .map((w) => WALL_ROLE_ZH[w])
            .join("、")}）`
        : `window avoids the feature host wall(s): ${desc.fixtures.featureHostWalls.join(", ")}`
      : null,
    desc.fixtures.clerestory
      ? zh
        ? "有高侧窗带"
        : "clerestory band"
      : null,
    zh ? "有一盏落地灯" : "one floor lamp",
  ].filter(Boolean);
  L.push(zh ? `采光：${fixtureParts.join("；")}` : `Light sources: ${fixtureParts.join("; ")}`);

  return L.join("\n");
}
