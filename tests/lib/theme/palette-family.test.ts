import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BRAND_HEX,
  FAMILY_BANDS,
  FAMILY_HUE_MAX,
  FAMILY_HUE_MIN,
  FAMILY_SIZE,
  familyAccentForName,
  familyIndexForName,
  familyMember,
  familyOklch,
  oklabDistance,
} from "@/lib/theme/palette-family";
import { fnv1a, normalizeStrandName, strandIndex } from "@/lib/timeline3d/ink";
import { PALETTES, VIVID_PALETTES } from "@/lib/game/space-types";

const ALL_PALETTES = [...PALETTES, ...VIVID_PALETTES];

const CORPUS: Record<string, string[]> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../memory/episodic/strands.json", import.meta.url)),
    "utf8",
  ),
);
const STRAND_NAMES = Object.keys(CORPUS);

/** The distinguishability metric: Euclidean distance in OKLab. ~0.01 is
 *  one just-noticeable difference, so the floor below (~0.017) is ≈1.7 JND
 *  — the most a 96-member family squeezed into a 180° hue arc can promise
 *  (measured 0.0177 at design time; the cyan corner of sRGB is the
 *  binding constraint, see the module header). */
const MIN_PAIR_DISTANCE = 0.017;

/** Accent ↔ ground separation floor for room palettes. Below this the
 *  accent stops reading as the room's contrast colour (axiom A5). The
 *  weakest assignment (cool, a rose on a teal-grey ground) measures 0.160. */
const MIN_ACCENT_GROUND_DISTANCE = 0.15;

/** palette id → family index. THE contract between the room palettes and
 *  the family: every accent is exactly `familyMember(index)`, hand-assigned
 *  for contrast against the palette's own ground (complement hue folded
 *  into the family arc, lightness band opposed to the ground's). */
const ACCENT_ASSIGNMENT: Record<string, number> = {
  dawn: 27,
  noon: 10,
  dusk: 9,
  night: 87,
  warm: 24,
  cool: 31,
  coral: 3,
  mint: 30,
  butter: 8,
  lavender: 16,
  sky: 13,
  peach: 21,
  grass: 29,
  salt: 15,
};

function collisionStats(slots: number[]) {
  const buckets = new Map<number, number>();
  for (const s of slots) buckets.set(s, (buckets.get(s) ?? 0) + 1);
  let shared = 0;
  let worst = 0;
  for (const n of buckets.values()) {
    if (n > 1) {
      shared += n;
      worst = Math.max(worst, n);
    }
  }
  return { slotsUsed: buckets.size, shared, worst };
}

describe("familyMember — determinism and shape", () => {
  it("is a pure function of the index", () => {
    for (const i of [0, 1, 15, 16, 47, 80, 95]) {
      expect(familyMember(i)).toBe(familyMember(i));
      expect(familyMember(i)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("rejects indices outside the family", () => {
    expect(() => familyMember(-1)).toThrow(RangeError);
    expect(() => familyMember(FAMILY_SIZE)).toThrow(RangeError);
    expect(() => familyMember(1.5)).toThrow(RangeError);
  });

  it("has FAMILY_SIZE distinct members", () => {
    const all = new Set(Array.from({ length: FAMILY_SIZE }, (_, i) => familyMember(i)));
    expect(all.size).toBe(FAMILY_SIZE);
  });

  it("covers the corpus: the family is at least as large as the real strand count", () => {
    expect(FAMILY_SIZE).toBeGreaterThanOrEqual(STRAND_NAMES.length);
  });

  it("keeps every member inside the brand hue arc", () => {
    // The family resemblance argument: no member can be a yellow, orange or
    // green, because the arc is brand hue ± 90° and nothing else.
    for (let i = 0; i < FAMILY_SIZE; i++) {
      const { h } = familyOklch(i);
      expect(h).toBeGreaterThanOrEqual(FAMILY_HUE_MIN);
      expect(h).toBeLessThanOrEqual(FAMILY_HUE_MAX);
    }
  });

  it("reserves the brand blue itself — no member may collide with #0066ff", () => {
    // The core timeline's surfaces wear the brand; a family member at the
    // same paint would make a strand hotel indistinguishable from it.
    for (let i = 0; i < FAMILY_SIZE; i++) {
      expect(oklabDistance(familyMember(i), BRAND_HEX)).toBeGreaterThan(0.05);
    }
  });
});

describe("familyMember — pairwise distinguishability", () => {
  it("keeps the worst-case pair at or above the documented floor", () => {
    const members = Array.from({ length: FAMILY_SIZE }, (_, i) => familyMember(i));
    let min = Infinity;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        min = Math.min(min, oklabDistance(members[i], members[j]));
      }
    }
    expect(min).toBeGreaterThanOrEqual(MIN_PAIR_DISTANCE);
  });

  it("spaces adjacent hue steps evenly within each band", () => {
    // Even spacing is the deterministic part of the promise: if a future
    // edit clusters hues, this fails before the visual review does.
    for (let band = 0; band < FAMILY_BANDS.length; band++) {
      for (let step = 0; step + 1 < 16; step++) {
        const a = familyOklch(band * 16 + step);
        const b = familyOklch(band * 16 + step + 1);
        expect(b.h - a.h).toBeCloseTo(12, 6);
      }
    }
  });
});

describe("familyIndexForName — the strand → family mapping", () => {
  it("is deterministic and normalised like the card view's hash", () => {
    expect(familyAccentForName("fitness")).toBe(familyAccentForName("fitness"));
    for (const variant of ["Fitness", "  FITNESS ", "ｆｉｔｎｅｓｓ"]) {
      expect(familyIndexForName(variant)).toBe(familyIndexForName("fitness"));
    }
    expect(familyIndexForName("")).toBe(0);
  });

  it("fixes the real corpus's collisions — before %5 / after family-of-96", () => {
    // The documented defect (doc/design/v0.11-strand-field.md §2.7) was
    // hash % 5 over ~93 strands. This pins the repair against the REAL
    // corpus and keeps the numbers in the test output for the report.
    const normalized = STRAND_NAMES.map(normalizeStrandName);
    const before = collisionStats(normalized.map((n) => fnv1a(n) % 5));
    const cardView = collisionStats(STRAND_NAMES.map(strandIndex));
    const after = collisionStats(STRAND_NAMES.map(familyIndexForName));
    console.log(
      `strand corpus (${STRAND_NAMES.length}): ` +
        `%5=${JSON.stringify(before)} %10(card)=${JSON.stringify(cardView)} ` +
        `%96(family)=${JSON.stringify(after)}`,
    );
    // Before: pigeonholed — every strand shares, the worst colour holds 21.
    expect(before.shared).toBe(STRAND_NAMES.length);
    // After: collisions are a birthday accident, not a construction —
    // most strands get a private accent and none shares with more than a few.
    expect(after.slotsUsed).toBeGreaterThanOrEqual(STRAND_NAMES.length / 2);
    expect(after.worst).toBeLessThanOrEqual(4);
    expect(after.shared).toBeLessThan(before.shared * 0.7);
  });

  it("gives colliding strands the best separation the family has", () => {
    // Where two strands DO share a slot their colours are identical by
    // definition; the guarantee worth pinning is the other direction —
    // the smallest distance between any two DISTINCT colours the corpus
    // actually draws equals the family floor, i.e. the hash did not
    // cluster the corpus into one corner of the arc.
    const drawn = [...new Set(STRAND_NAMES.map(familyAccentForName))];
    let min = Infinity;
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        min = Math.min(min, oklabDistance(drawn[i], drawn[j]));
      }
    }
    console.log(`corpus draws ${drawn.length} distinct accents; worst distinct pair ${min.toFixed(4)}`);
    expect(min).toBeGreaterThanOrEqual(MIN_PAIR_DISTANCE);
  });
});

describe("room palettes — accents are family members", () => {
  it("every palette's accent is exactly its assigned family member", () => {
    for (const p of ALL_PALETTES) {
      const index = ACCENT_ASSIGNMENT[p.id];
      expect(index, `no family assignment for palette ${p.id}`).toBeDefined();
      expect(p.accent, `${p.id} accent drifted from family #${index}`).toBe(
        familyMember(index),
      );
    }
  });

  it("assignments are unique — no two rooms share an accent", () => {
    expect(new Set(Object.values(ACCENT_ASSIGNMENT)).size).toBe(
      Object.keys(ACCENT_ASSIGNMENT).length,
    );
  });

  it("every accent still reads as its palette's contrast colour (A5)", () => {
    for (const p of ALL_PALETTES) {
      expect(
        oklabDistance(p.accent, p.ground),
        `${p.id}: accent too close to its ground`,
      ).toBeGreaterThanOrEqual(MIN_ACCENT_GROUND_DISTANCE);
    }
  });
});
