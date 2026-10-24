/**
 * Tests for the room-props pure layout helpers
 * (src/components/game/room-props.tsx): the per-book row layout and the
 * bookpile stack are deterministic, fit their width, respect the height
 * budget, and draw colors only from the muted palette's index range. The
 * module imports react/three/fiber but these helpers never touch the DOM
 * or the renderer — safe under the node test environment.
 */
import { describe, it, expect } from "vitest";
import { layoutBookPile, layoutBookRow } from "@/components/game/room-props";

describe("layoutBookRow", () => {
  it("is deterministic: same seed key yields the identical row", () => {
    const a = layoutBookRow("shelf-wall:0:0", 1.4, 0.3, 0.25);
    const b = layoutBookRow("shelf-wall:0:0", 1.4, 0.3, 0.25);
    expect(a).toEqual(b);
  });

  it("fills the row within its width budget and never exceeds the height", () => {
    for (const key of ["a", "b", "c"]) {
      const specs = layoutBookRow(key, 1.4, 0.3, 0.25);
      expect(specs.length).toBeGreaterThan(8);
      for (const s of specs) {
        // A leaning spine's rotated silhouette extends past sx/2 by
        // |sin(lean)| · sy/2 — budget for the rotation, not just the box.
        const halfExtent = s.sx / 2 + Math.abs(Math.sin(s.rotZ)) * (s.sy / 2);
        expect(Math.abs(s.x) + halfExtent).toBeLessThanOrEqual(1.4 / 2 + 0.02);
        expect(s.sy).toBeLessThanOrEqual(0.3 + 1e-6);
        expect(s.sy).toBeGreaterThan(0);
        expect(s.sz).toBeLessThanOrEqual(0.25);
        expect(s.colorIndex).toBeGreaterThanOrEqual(0);
        expect(s.colorIndex).toBeLessThan(8);
      }
      // The run is centered: first spine left edge ≈ last spine right edge.
      const minX = Math.min(...specs.map((s) => s.x - s.sx / 2));
      const maxX = Math.max(...specs.map((s) => s.x + s.sx / 2));
      expect(minX + maxX).toBeCloseTo(0, 1);
    }
  });

  it("produces different rows for different seed keys", () => {
    const a = layoutBookRow("row:1", 1.4, 0.3, 0.25);
    const b = layoutBookRow("row:2", 1.4, 0.3, 0.25);
    expect(a).not.toEqual(b);
  });

  it("returns an empty spec list on a near-zero width — the consumer renders no mesh at all", () => {
    const specs = layoutBookRow("tiny", 0.01, 0.3, 0.25);
    expect(specs).toHaveLength(0);
  });
});

describe("layoutBookPile", () => {
  it("is a four-book stack plus one leaning book, all inside the muted index range", () => {
    const specs = layoutBookPile();
    expect(specs).toHaveLength(5);
    let stackTop = 0;
    for (const s of specs.slice(0, 4)) {
      // Each stacked book rests on the previous one's top (± jitter).
      expect(Math.abs(s.y - (stackTop + s.sy / 2))).toBeLessThan(0.06);
      stackTop = Math.max(stackTop, s.y + s.sy / 2);
      expect(s.colorIndex).toBeGreaterThanOrEqual(0);
      expect(s.colorIndex).toBeLessThan(8);
    }
    // The leaning book stands on the floor beside the pile.
    const leaner = specs[4];
    expect(leaner.rotZ).not.toBe(0);
    expect(Math.abs(leaner.x)).toBeGreaterThan(0.1);
  });

  it("is deterministic across calls", () => {
    expect(layoutBookPile()).toEqual(layoutBookPile());
  });
});
