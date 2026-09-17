/**
 * Tests for the palette data (v0.11-room-interiors §11.1 + the abundance
 * pass's interior layers). The contract under test:
 *
 *  - A5's "one dominant hue + one contrast" holds: every palette's accent
 *    is a member of the brand palette family (palette-family.ts, derived
 *    from #0066ff) — the dominant hues stay the palette's own.
 *  - Every palette authors its four interior layers (ground / wall /
 *    fabric / wood) as a SET: the wall is not the floor, the textile is
 *    not the wall — a room must never read as one colour again. Measured
 *    in OKLab so "different" means perceptibly different, not just a
 *    different hex string.
 *  - The abundance pass's counts: 8 quiet + 10 vivid = 18 palettes, each
 *    with a unique id that the PaletteId union covers (compile time) and
 *    the recipe compiler can draw (space-recipe.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
  PALETTES,
  VIVID_PALETTES,
  type Palette,
} from "@/lib/game/space-types";
import {
  FAMILY_SIZE,
  familyMember,
  oklabDistance,
} from "@/lib/theme/palette-family";

const ALL: readonly Palette[] = [...PALETTES, ...VIVID_PALETTES];
const HEX = /^#[0-9a-f]{6}$/;

describe("palette data (§11.1 + interior layers)", () => {
  it("ships 18 palettes — 8 quiet + 10 vivid — with unique ids", () => {
    expect(PALETTES).toHaveLength(8);
    expect(VIVID_PALETTES).toHaveLength(10);
    expect(new Set(ALL.map((p) => p.id)).size).toBe(ALL.length);
  });

  it("keeps every accent inside the brand palette family (A5's one contrast)", () => {
    const family = new Set(
      Array.from({ length: FAMILY_SIZE }, (_, i) => familyMember(i)),
    );
    for (const p of ALL) {
      expect(family.has(p.accent)).toBe(true);
    }
  });

  it("authors all four interior layers on every palette, as valid hex", () => {
    for (const p of ALL) {
      for (const colour of [p.ground, p.wall, p.fabric, p.wood]) {
        expect(colour).toBeDefined();
        expect(colour).toMatch(HEX);
      }
    }
  });

  it("never lets a room read as ONE colour — the layers are perceptibly apart", () => {
    // ~0.04 in OKLab ≈ 4 JND: clearly tellable apart at a glance. The
    // wall must stand off the floor, the textile off both, the timber off
    // all three — the "整间房一色" failure is what this bounds.
    for (const p of ALL) {
      const layers: [string, string][] = [
        [p.ground, p.wall!],
        [p.ground, p.fabric!],
        [p.ground, p.wood!],
        [p.wall!, p.fabric!],
        [p.wall!, p.wood!],
        [p.fabric!, p.wood!],
      ];
      for (const [a, b] of layers) {
        expect(oklabDistance(a, b)).toBeGreaterThan(0.04);
      }
    }
  });

  it("keeps the ambient floor at or above 0.25 (night never goes pitch black)", () => {
    for (const p of ALL) {
      expect(p.ambient).toBeGreaterThanOrEqual(0.25);
    }
  });
});
