/**
 * The v0.12 P4 DISTRIBUTION READOUT (doc/design/v0.12-room-realism.md's P4
 * acceptance: 分布读数 — 同一结构出现多少种皮肤/配色组合).
 *
 * Over N real memory slices (every slice dir under
 * memory/episodic/slices, topped up to 200 with deterministic synthetic
 * ids when the dataset is smaller — the report says which is which), this
 * test compiles each slice's recipe + skin + (for interiors) its module
 * composition through the SAME pure chain the renderer builds from, and
 * prints:
 *
 *   - world-class / skin / palette histograms;
 *   - per STRUCTURE rows: how many slices, and how many distinct
 *     skins, palettes and (skin × palette) worlds each structure saw
 *     (structure = the module composition for interiors, the archetype
 *     × size tier for every other class);
 *   - the XL cross-slice sameness check (the W4 leftover): how many
 *     interior slice PAIRS read as the same room — identical module
 *     composition AND palette, then identical furnishing signature;
 *   - the palette↔skin linkage before/after: the legacy uniform draw is
 *     reproduced on the same style stream and both draws are scored
 *     against the world↔palette affinity table — clashing combos are
 *     indistinguishable mush, so the affinity-weighted draw must spend
 *     visibly fewer slices on them while keeping every palette possible.
 *
 * The numbers are printed so a report can quote them verbatim; the
 * assertions pin the post-P4 floors (clash rate, per-structure world
 * counts, XL composition spread) so a regression fails loudly.
 *
 * Pure and deterministic: the slice set is either on-disk data (stable
 * within a checkout) or fixed synthetic ids; every derivation is the
 * pure chain (A6) — no Math.random, no wall clock.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  compileSpaceRecipe,
  paletteAffinityFor,
} from "@/lib/game/space-recipe";
import { skinForSlice } from "@/lib/game/skins";
import { compositionForRecipe } from "@/lib/game/room-modules";
import { describeRoom } from "@/lib/game/describe-room";
import { createRng, deriveSubSeed, pick, WORLD_SEED } from "@/lib/game/seed";
import {
  INTERIOR_ROOMS,
  NATURE_BIOMES,
  PALETTES,
  VIVID_PALETTES,
  WONDER_ROOMS,
  type ArchetypeId,
  type PaletteId,
  type WorldClass,
} from "@/lib/game/space-types";

const TARGET_N = 200;
const SLICES_ROOT = path.resolve("memory/episodic/slices");

/** Real slice ids from the on-disk episodic dataset
 * (YYYY/MM/DD/HHMM dirs → the manager's `YYYY-MM-DD-HHMM` slice id). */
function realSliceIds(root: string): string[] {
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  const safe = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const y of safe(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of safe(path.join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of safe(path.join(root, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        for (const h of safe(path.join(root, y, m, d))) {
          if (!/^\d{4}$/.test(h)) continue;
          ids.push(`${y}-${m}-${d}-${h}`);
        }
      }
    }
  }
  return ids.sort();
}

function sliceSample(): { ids: string[]; real: number } {
  const real = realSliceIds(SLICES_ROOT);
  const ids = [...real];
  for (let i = 0; ids.length < TARGET_N; i++) {
    ids.push(`p4-fill-2026-${String(i).padStart(4, "0")}`);
  }
  return { ids: ids.slice(0, TARGET_N), real: real.length };
}

/** The pre-P4 uniform palette draw, reproduced on the same style stream
 *  (the class/type/size/width draws are untouched by the affinity work,
 *  so re-deriving worldClass from the current recipe is exact). */
function legacyPaletteId(sliceId: string, worldClass: WorldClass): PaletteId {
  const styleRng = createRng(deriveSubSeed(WORLD_SEED, sliceId, "style"));
  const pool =
    (worldClass === "interior" || worldClass === "wonder") && styleRng() < 0.85
      ? VIVID_PALETTES
      : [...PALETTES, ...VIVID_PALETTES];
  return pick(styleRng, pool).id;
}

interface SliceRow {
  id: string;
  worldClass: WorldClass;
  archetype: ArchetypeId;
  sizeTier: string;
  structure: string;
  skinId: string;
  paletteId: PaletteId;
  legacyPaletteId: PaletteId;
  /** Furnishing signature for interiors (kit multiset), else null. */
  furnishingKey: string | null;
}

function structureKey(
  sliceId: string,
  worldClass: WorldClass,
  archetype: ArchetypeId,
  sizeTier: string,
): string {
  if (worldClass === "interior") {
    const comp = compositionForRecipe(compileSpaceRecipe(sliceId));
    if (comp) {
      const mods = comp.modules
        .map((p) => p.module.id)
        .slice()
        .sort()
        .join("+");
      return `mod|${mods}@${comp.topology}`;
    }
  }
  return `arch|${archetype}|${sizeTier}`;
}

function furnishingKey(desc: ReturnType<typeof describeRoom>): string {
  if (!desc.furnishing) return "none";
  return desc.furnishing
    .map((f) => `${f.kit}(${f.pieces.slice().sort().join(",")})`)
    .sort()
    .join("; ");
}

function histogram(values: Iterable<string>): Map<string, number> {
  const h = new Map<string, number>();
  for (const v of values) h.set(v, (h.get(v) ?? 0) + 1);
  return new Map([...h.entries()].sort((a, b) => b[1] - a[1]));
}

function histogramLines(h: Map<string, number>): string[] {
  return [...h.entries()].map(([k, n]) => `    ${k.padEnd(46)} ${n}`);
}

describe("P4 variant distribution readout", () => {
  const { ids, real } = sliceSample();
  const rows: SliceRow[] = ids.map((id) => {
    const recipe = compileSpaceRecipe(id);
    const desc =
      recipe.worldClass === "interior" && recipe.size.id === "XL"
        ? describeRoom(id)
        : null;
    return {
      id,
      worldClass: recipe.worldClass,
      archetype: recipe.archetype,
      sizeTier: recipe.size.id,
      structure: structureKey(id, recipe.worldClass, recipe.archetype, recipe.size.id),
      skinId: skinForSlice(id)?.id ?? "temperate",
      paletteId: recipe.palette.id,
      legacyPaletteId: legacyPaletteId(id, recipe.worldClass),
      furnishingKey: desc ? furnishingKey(desc) : null,
    };
  });

  it("prints structure × skin × palette distribution + linkage before/after", () => {
    const L: string[] = [];
    L.push(`slice sample: ${rows.length} total (${real} real on-disk + ${rows.length - real} synthetic)`);
    L.push(`structures: ${new Set(rows.map((r) => r.structure)).size} · skins: ${new Set(rows.map((r) => r.skinId)).size} · palettes: ${new Set(rows.map((r) => r.paletteId)).size}`);

    L.push("world classes:");
    L.push(...histogramLines(histogram(rows.map((r) => r.worldClass))));
    L.push("skins:");
    L.push(...histogramLines(histogram(rows.map((r) => r.skinId))));
    L.push("palettes (post-P4 draw):");
    L.push(...histogramLines(histogram(rows.map((r) => r.paletteId))));

    // Per-structure worlds.
    const byStructure = new Map<string, SliceRow[]>();
    for (const r of rows) {
      const list = byStructure.get(r.structure) ?? [];
      list.push(r);
      byStructure.set(r.structure, list);
    }
    L.push("per structure (n ≥ 2):");
    const structureStats: { key: string; n: number; worlds: number }[] = [];
    for (const [key, list] of [...byStructure.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (list.length < 2) continue;
      const skins = new Set(list.map((r) => r.skinId));
      const palettes = new Set(list.map((r) => r.paletteId));
      const pairs = new Set(list.map((r) => `${r.skinId}×${r.paletteId}`));
      structureStats.push({ key, n: list.length, worlds: pairs.size });
      L.push(
        `    ${key.padEnd(52)} n=${String(list.length).padStart(3)} skins=${skins.size} palettes=${palettes.size} worlds(pairs)=${pairs.size}`,
      );
    }
    const multi = structureStats.filter((s) => s.n >= 4);
    if (multi.length > 0) {
      const worlds = multi.map((s) => s.worlds).sort((a, b) => a - b);
      L.push(
        `structures with n ≥ 4: ${multi.length}; worlds per structure min=${worlds[0]} median=${worlds[Math.floor(worlds.length / 2)]} max=${worlds[worlds.length - 1]}`,
      );
    }

    // XL cross-slice sameness (the W4 leftover): identical composition AND
    // palette, then identical furnishing signature on top.
    const interiors = rows.filter((r) => r.worldClass === "interior");
    const xl = interiors.filter((r) => r.sizeTier === "XL");
    const pairGroups = (key: (r: SliceRow) => string): number[] => {
      const g = new Map<string, number>();
      for (const r of xl) g.set(key(r), (g.get(key(r)) ?? 0) + 1);
      return [...g.values()].filter((n) => n > 1);
    };
    const compPaletteCollisions = pairGroups(
      (r) => `${r.structure}|${r.paletteId}`,
    );
    const furnishingCollisions = pairGroups(
      (r) => `${r.structure}|${r.paletteId}|${r.furnishingKey ?? "?"}`,
    );
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    L.push(
      `XL interior slices: ${xl.length} · distinct compositions: ${new Set(xl.map((r) => r.structure)).size} · distinct (composition × palette): ${new Set(xl.map((r) => `${r.structure}|${r.paletteId}`)).size} · distinct (+furnishing): ${new Set(xl.map((r) => `${r.structure}|${r.paletteId}|${r.furnishingKey ?? "?"}`)).size}`,
    );
    L.push(
      `XL sameness: slices sharing composition+palette with another slice: ${sum(compPaletteCollisions)} of ${xl.length} (groups: ${compPaletteCollisions.length}) · sharing +furnishing: ${sum(furnishingCollisions)} (groups: ${furnishingCollisions.length})`,
    );
    const xlPaletteHist = histogram(xl.map((r) => r.paletteId));
    L.push(`XL palettes: ${[...xlPaletteHist.entries()].map(([k, n]) => `${k}×${n}`).join(" ") || "(none)"}`);

    // The palette↔skin linkage before/after, over every skinned slice.
    const skinned = rows.filter(
      (r) => paletteAffinityFor(r.archetype, r.paletteId) !== null,
    );
    const rate = (rows_: SliceRow[], pick_: (r: SliceRow) => PaletteId, cls: string): number =>
      rows_.filter((r) => paletteAffinityFor(r.archetype, pick_(r)) === cls).length /
      Math.max(1, rows_.length);
    L.push(
      `skinned slices: ${skinned.length} · legacy draw: harmonize ${(rate(skinned, (r) => r.legacyPaletteId, "harmonize") * 100).toFixed(0)}% neutral ${(rate(skinned, (r) => r.legacyPaletteId, "neutral") * 100).toFixed(0)}% clash ${(rate(skinned, (r) => r.legacyPaletteId, "clash") * 100).toFixed(0)}%`,
    );
    L.push(
      `                      post-P4 draw: harmonize ${(rate(skinned, (r) => r.paletteId, "harmonize") * 100).toFixed(0)}% neutral ${(rate(skinned, (r) => r.paletteId, "neutral") * 100).toFixed(0)}% clash ${(rate(skinned, (r) => r.paletteId, "clash") * 100).toFixed(0)}%`,
    );
    const same = skinned.filter((r) => r.paletteId === r.legacyPaletteId).length;
    L.push(`palette changed by the weighting: ${skinned.length - same} of ${skinned.length} skinned slices`);
    // Same-skin sibling differentiation: per skin, how many distinct
    // palettes each archetype drew (the sub-region split).
    L.push("same-skin siblings (archetype → palettes drawn):");
    for (const skin of new Set(skinned.map((r) => r.skinId))) {
      const sub = histogram(skinned.filter((r) => r.skinId === skin).map((r) => `${r.archetype}`));
      for (const [arch, n] of sub) {
        const palettes = new Set(skinned.filter((r) => r.archetype === arch).map((r) => r.paletteId));
        L.push(`    ${skin.padEnd(9)} ${arch.padEnd(10)} n=${String(n).padStart(3)} palettes=${[...palettes].join(",")}`);
      }
    }

    console.log(`\n═══ P4 distribution readout ═══\n${L.join("\n")}\n`);

    // ── Post-P4 floors (measured on the real+synthetic 200-slice sample;
    //    loosen only with a re-measure recorded here) ─────────────────
    const clashLegacy = rate(skinned, (r) => r.legacyPaletteId, "clash");
    const clashNow = rate(skinned, (r) => r.paletteId, "clash");
    expect(skinned.length).toBeGreaterThanOrEqual(100);
    // Measured on the 200-slice sample: legacy 31% → post-P4 8.4%. The
    // floor weight (0.12) keeps clashes possible, so the share never
    // reaches zero — the cap leaves headroom for the on-disk slice set
    // to grow (the sample re-measures on every run).
    expect(clashNow).toBeLessThan(clashLegacy / 2);
    expect(clashNow).toBeLessThanOrEqual(0.1);
    // every structure seen ≥4 times shows at least 2 worlds
    for (const s of multi) {
      expect(s.worlds, s.key).toBeGreaterThanOrEqual(2);
    }
    // XL rooms do not collapse onto one composition
    expect(new Set(xl.map((r) => r.structure)).size).toBeGreaterThanOrEqual(4);
    // and not onto one palette
    expect(new Set(xl.map((r) => r.paletteId)).size).toBeGreaterThanOrEqual(4);
  });

  it("the affinity table covers exactly the non-interior archetypes", () => {
    for (const arch of NATURE_BIOMES) {
      expect(paletteAffinityFor(arch, "noon"), arch).not.toBeNull();
    }
    for (const arch of WONDER_ROOMS) {
      expect(paletteAffinityFor(arch, "noon"), arch).not.toBeNull();
    }
    for (const arch of INTERIOR_ROOMS) {
      expect(paletteAffinityFor(arch, "noon"), arch).toBeNull();
    }
    // spot-check the measured-family logic: hot palettes fight the water
    // world, the sky family harmonizes with it
    expect(paletteAffinityFor("pool", "butter")).toBe("clash");
    expect(paletteAffinityFor("pool", "sky")).toBe("harmonize");
    expect(paletteAffinityFor("plains", "sky")).toBe("clash");
    expect(paletteAffinityFor("plains", "butter")).toBe("harmonize");
    // siblings sharing the shallows skin occupy different sub-regions
    expect(paletteAffinityFor("ocean", "night")).toBe("harmonize");
    expect(paletteAffinityFor("pool", "night")).not.toBe("harmonize");
    expect(paletteAffinityFor("lake", "grass")).toBe("harmonize");
    expect(paletteAffinityFor("pool", "grass")).not.toBe("harmonize");
  });

  it("A6 holds across the sample: every derivation repeats byte-for-byte", () => {
    for (const id of ids.slice(0, 40)) {
      expect(compileSpaceRecipe(id)).toEqual(compileSpaceRecipe(id));
      expect(skinForSlice(id)).toBe(skinForSlice(id));
      expect(structureKey(id, compileSpaceRecipe(id).worldClass, compileSpaceRecipe(id).archetype, compileSpaceRecipe(id).size.id)).toBe(
        structureKey(id, compileSpaceRecipe(id).worldClass, compileSpaceRecipe(id).archetype, compileSpaceRecipe(id).size.id),
      );
    }
  });
});
