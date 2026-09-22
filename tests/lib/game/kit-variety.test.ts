/* Kit variety (§6 anti-warehouse rule, 2026-10 XL repetition audit) — the
 * checkable half of "sets must not repeat": ONE room never hosts more than
 * KIT_ROOM_CAP (+ the saturated-fallback slack of one) placements of any
 * single kit id, and the cure never costs the B.12 density it exists to
 * protect. The XL sweep replays space.tsx's interior staging chain (the
 * same pure modules, no renderer) over a fixed slice matrix so the numbers
 * are reproducible, and pins the zones' "strict widening" contract: the
 * module-attributed zones (compositionKitZonesFor) claim the SAME rects as
 * the plain template fold, plus each module's whitelist on its clusters.
 */
import { describe, it, expect } from "vitest";
import {
  compositionForRecipe,
  compositionKitZonesFor,
  compositionTemplateFor,
} from "@/lib/game/room-modules";
import { templatePlanFor, templateZonesFor } from "@/lib/game/room-templates";
import { composeRoom, roomPlanFor, scaleNotationFor } from "@/lib/game/room-plan";
import { KITS, planArea, stageInteriorKits } from "@/lib/game/kits";
import {
  COLONNADE_BAY,
  KIT_ROOM_CAP,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import {
  PALETTES,
  SIZE_TIERS,
  type ArchetypeId,
  type SpaceRecipe,
} from "@/lib/game/space-types";

const XL = SIZE_TIERS.find((t) => t.id === "XL")!;
const ARCHETYPES: ArchetypeId[] = ["hotel-room", "library", "ballroom"];

interface SweepRow {
  placements: number;
  maxRepeat: number;
  /** Room scale factor (scaleNotationFor) — B.12's density law was
   *  ratified on normal-scale rooms; miniature dollhouses (×0.2–0.35) are
   *  deliberate spectacles whose floor physically cannot hold a kit per
   *  the density table, so the per-room floor binds only at f = 1. */
  factor: number;
}

function sweepXl(sliceId: string, archetype: ArchetypeId): SweepRow {
  const recipe: SpaceRecipe = {
    sliceId,
    worldClass: "interior",
    archetype,
    size: XL,
    width: 96,
    palette: PALETTES[0],
    layoutSeed: 1,
    lightSeed: 0,
  };
  const comp = compositionForRecipe(recipe, WORLD_SEED, 0);
  if (!comp) throw new Error(`no composition for ${sliceId}`);
  const template = compositionTemplateFor(comp);
  const f = scaleNotationFor(sliceId).factor;
  const plan = roomPlanFor(
    sliceId,
    comp.width * f,
    comp.extent * f,
    COLONNADE_BAY * Math.sqrt(Math.max(f, 0.35)),
    WORLD_SEED,
    templatePlanFor(template),
  );
  const roomComp = composeRoom(sliceId, plan, f);
  const rng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "furniture"));
  const pieces = stageInteriorKits({
    rng,
    archetype,
    plan,
    comp: roomComp,
    baseExtent: 96,
    propScale: Math.pow(f, PROP_SCALE_EXP),
    wallThick: ROOM_WALL_THICKNESS * Math.max(f, 0.35),
    water: null,
    doors: [],
    kitIds: [...new Set(comp.modules.flatMap((p) => p.module.kits))],
    openFields: comp.openFields.map((r) => ({
      x0: r.x0 * f,
      z0: r.z0 * f,
      x1: r.x1 * f,
      z1: r.z1 * f,
    })),
    zones: compositionKitZonesFor(comp, plan),
    baseArea: planArea(plan) / (f * f),
    heightAt: () => 0,
  });
  const counts = new Map<string, number>();
  const seen = new Set<number>();
  for (const p of pieces) {
    if (p.trace || seen.has(p.kitIndex)) continue;
    seen.add(p.kitIndex);
    counts.set(p.kitId, (counts.get(p.kitId) ?? 0) + 1);
  }
  return {
    placements: seen.size,
    maxRepeat: Math.max(0, ...counts.values()),
    factor: f,
  };
}

describe("XL repetition budget (the §6 anti-warehouse rule, audited)", () => {
  const archetypes: ArchetypeId[] = ["hotel-room", "library", "ballroom"];
  const rows: SweepRow[] = [];
  for (const archetype of archetypes) {
    for (let i = 0; i < 30; i++) {
      rows.push(sweepXl(`variety-xl-${archetype}-${i}`, archetype));
    }
  }

  it("no kit id repeats past the cap plus one anywhere in the sweep", () => {
    // CAP normally binds hard; the +1 is the deliberate slack for a room
    // whose ENTIRE deck is capped, where the B.12 density promise
    // rightfully outranks the cap (kits.ts drawKit's precedence).
    for (const [i, r] of rows.entries()) {
      expect(r.maxRepeat, `room #${i}`).toBeLessThanOrEqual(KIT_ROOM_CAP + 1);
    }
    // And the tail is rare, not the norm: one repeat at CAP+1 in ten rooms
    // at most (measured 2026-10: 5/90 at ×4, zero at ×5).
    const slack = rows.filter((r) => r.maxRepeat > KIT_ROOM_CAP).length;
    expect(slack).toBeLessThanOrEqual(Math.ceil(rows.length / 10));
  });

  it("the cure never costs the density it protects (B.12)", () => {
    // Measured 2026-10 on NORMAL-scale rooms, BEFORE the fix: mean 12.14
    // placements/room at 18% floor coverage. The cap must not collapse
    // that: a generous floor at ~60% of the legacy mean (7) catches a
    // real regression while leaving the cap's own ~4% mix-shift slack
    // well alone. Scale-notation rooms (miniature/colossal) sit out the
    // per-room floor — a dollhouse physically cannot host the density
    // table, which is the spectacle's whole point (A2).
    const normal = rows.filter((r) => r.factor === 1);
    const mean = normal.reduce((a, r) => a + r.placements, 0) / normal.length;
    expect(mean).toBeGreaterThan(7);
    for (const [i, r] of normal.entries()) {
      expect(r.placements, `normal room #${i}`).toBeGreaterThanOrEqual(3);
    }
    for (const [i, r] of rows.entries()) {
      expect(r.placements, `room #${i}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("compositionKitZonesFor — the strict widening of the plain zones", () => {
  it("claims the same rects as the template fold, plus module decks", () => {
    for (const archetype of ARCHETYPES) {
      for (let i = 0; i < 6; i++) {
        const sliceId = `variety-zones-${archetype}-${i}`;
        const recipe: SpaceRecipe = {
          sliceId,
          worldClass: "interior",
          archetype,
          size: XL,
          width: 96,
          palette: PALETTES[0],
          layoutSeed: 1,
          lightSeed: 0,
        };
        const comp = compositionForRecipe(recipe, WORLD_SEED, 0);
        if (!comp) throw new Error(`no composition for ${sliceId}`);
        const f = scaleNotationFor(sliceId).factor;
        const plan = roomPlanFor(
          sliceId,
          comp.width * f,
          comp.extent * f,
          COLONNADE_BAY * Math.sqrt(Math.max(f, 0.35)),
          WORLD_SEED,
          templatePlanFor(compositionTemplateFor(comp)),
        );
        const plain = templateZonesFor(compositionTemplateFor(comp), plan);
        const rich = compositionKitZonesFor(comp, plan);
        // Same cluster rects in the same order — the widening changes the
        // DEAL, never the claim.
        expect(rich.clusters?.map(({ x0, z0, x1, z1 }) => [x0, z0, x1, z1])).toEqual(
          plain.clusters?.map(({ x0, z0, x1, z1 }) => [x0, z0, x1, z1]),
        );
        expect(rich.hero).toEqual(plain.hero);
        expect(rich.heroKit).toBe(plain.heroKit);
        // Every cluster carries the whitelist of the module whose zone it
        // IS, and only real kit ids (the room's own eligibility filter —
        // archetype, minExtent — narrows the DEAL in staging, exactly as
        // it always has; a whitelist naming a kit the room can't draw is
        // curated intent, e.g. the workshop's lockers in a hotel room,
        // never a widening).
        const allIds = new Set(KITS.map((k) => k.id));
        for (const c of rich.clusters ?? []) {
          expect(c.kitIds?.length).toBeGreaterThan(0);
          for (const id of c.kitIds ?? []) expect(allIds.has(id)).toBe(true);
        }
      }
    }
  });
});
