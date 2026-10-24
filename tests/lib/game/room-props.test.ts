/**
 * Tests for the room-props pure layout helpers
 * (src/components/game/room-props.tsx): the per-book row layout is
 * deterministic, grouped, gapped and budgeted (the 2026-10-25 art overhaul's
 * clustered shelf rhythm — ≤10 books per ordinary row, real gaps between
 * groups), the bookpile stack keeps its shape, and the plant leaves stay
 * finite and seeded. The module imports react/three/fiber but these helpers
 * never touch the DOM or the renderer — safe under the node test
 * environment.
 */
import { describe, it, expect } from "vitest";
import {
  layoutBookPile,
  layoutBookRow,
  layoutPlantLeaves,
  propDetailKey,
} from "@/components/game/room-props";

describe("layoutBookRow", () => {
  it("is deterministic: same seed key yields the identical row", () => {
    const a = layoutBookRow("shelf-wall:0:0", 1.4, 0.3, 0.25);
    const b = layoutBookRow("shelf-wall:0:0", 1.4, 0.3, 0.25);
    expect(a).toEqual(b);
  });

  it("groups the row: ≤10 books per ordinary row, with real gaps between groups", () => {
    for (const key of ["a", "b", "c", "d", "e"]) {
      const specs = layoutBookRow(key, 1.4, 0.3, 0.25);
      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs.length).toBeLessThanOrEqual(10);
      // Sorted spine edges; adjacent books from DIFFERENT groups leave a
      // real empty span (≥ 6 cm — the authored gap, wider than any lean).
      const edges = specs
        .map((s) => [s.x - s.sx / 2, s.x + s.sx / 2] as const)
        .sort((p, q) => p[0] - q[0]);
      let maxGap = 0;
      for (let i = 1; i < edges.length; i++) {
        maxGap = Math.max(maxGap, edges[i][0] - edges[i - 1][1]);
      }
      expect(maxGap).toBeGreaterThanOrEqual(0.06);
    }
  });

  it("fills the row within its width budget and never exceeds the height", () => {
    for (const key of ["a", "b", "c"]) {
      const specs = layoutBookRow(key, 1.4, 0.3, 0.25);
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

  it("keeps the old default layout when called without a seed key", () => {
    expect(layoutBookPile()).toEqual(layoutBookPile("room-props:bookpile"));
  });

  it("is stable for the same instance key and differs between instances and rooms", () => {
    const a1 = layoutBookPile(propDetailKey("bookpile", "room-a", 0));
    const a2 = layoutBookPile(propDetailKey("bookpile", "room-a", 0));
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(layoutBookPile(propDetailKey("bookpile", "room-a", 1)));
    expect(a1).not.toEqual(layoutBookPile(propDetailKey("bookpile", "room-b", 0)));
  });

  it("respects the stacking constraints for a keyed instance too", () => {
    const specs = layoutBookPile(propDetailKey("bookpile", "room-a", 3));
    expect(specs).toHaveLength(5);
    let stackTop = 0;
    for (const s of specs.slice(0, 4)) {
      expect(Math.abs(s.y - (stackTop + s.sy / 2))).toBeLessThan(0.06);
      stackTop = Math.max(stackTop, s.y + s.sy / 2);
      expect(s.colorIndex).toBeGreaterThanOrEqual(0);
      expect(s.colorIndex).toBeLessThan(8);
    }
  });
});

describe("propDetailKey", () => {
  it("is stable per room+instance and separates kind, room and instance", () => {
    expect(propDetailKey("bookshelf", "room-a", 0)).toBe(propDetailKey("bookshelf", "room-a", 0));
    expect(propDetailKey("bookshelf", "room-a", 0)).not.toBe(
      propDetailKey("bookshelf", "room-a", 1),
    );
    expect(propDetailKey("bookshelf", "room-a", 0)).not.toBe(
      propDetailKey("bookshelf", "room-b", 0),
    );
    expect(propDetailKey("bookshelf", "room-a", 0)).not.toBe(
      propDetailKey("plant", "room-a", 0),
    );
    // Numeric and string identities collapse to the same key space.
    expect(propDetailKey("plant", "room-a", 2)).toBe(propDetailKey("plant", "room-a", "2"));
  });
});

describe("bookshelf instance identity (via layoutBookRow keys)", () => {
  const row = (roomId: string, instance: number, i: number): ReturnType<typeof layoutBookRow> =>
    layoutBookRow(`${propDetailKey("bookshelf", roomId, instance)}:row:${i}`, 1.58, 0.31, 0.3);

  it("rebuilds the identical row for the same room+instance+row on revisit", () => {
    expect(row("room-a", 0, 1)).toEqual(row("room-a", 0, 1));
  });

  it("gives different book layouts to different instances and different rooms", () => {
    const base = row("room-a", 0, 1);
    expect(base).not.toEqual(row("room-a", 1, 1));
    expect(base).not.toEqual(row("room-b", 0, 1));
    // The shared `bookshelf:i` key is gone: no two instances can collide.
    expect(row("room-a", 0, 1)).not.toEqual(row("room-a", 0, 2));
  });

  it("keeps every instanced row inside the bookshelf's row budget", () => {
    for (const key of [
      propDetailKey("bookshelf", "room-a", 0),
      propDetailKey("bookshelf", "room-a", 1),
      propDetailKey("bookshelf", "room-b", 7),
    ]) {
      for (let i = 0; i < 3; i++) {
        const specs = layoutBookRow(`${key}:row:${i}`, 1.58, 0.31, 0.3);
        // The clustered rhythm: a 1.58 m row holds no more than 10 books.
        expect(specs.length).toBeGreaterThanOrEqual(3);
        expect(specs.length).toBeLessThanOrEqual(10);
        for (const s of specs) {
          const halfExtent = s.sx / 2 + Math.abs(Math.sin(s.rotZ)) * (s.sy / 2);
          expect(Math.abs(s.x) + halfExtent).toBeLessThanOrEqual(1.58 / 2 + 0.02);
          expect(s.sy).toBeLessThanOrEqual(0.31 + 1e-6);
          expect(s.sz).toBeLessThanOrEqual(0.3);
        }
      }
    }
  });
});

describe("layoutPlantLeaves", () => {
  it("returns twelve leaves with all fields finite", () => {
    const leaves = layoutPlantLeaves(propDetailKey("plant", "room-a", 0));
    expect(leaves).toHaveLength(12);
    for (const leaf of leaves) {
      const [dx, dy, dz] = leaf.dir.toArray();
      for (const v of [dx, dy, dz, leaf.h, leaf.dist, leaf.len, leaf.jitter]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // dir is normalized and points outward/up (droop keeps a real y).
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 6);
      expect(dy).toBeGreaterThan(0);
      expect(leaf.h).toBeGreaterThan(0);
      expect(leaf.dist).toBeGreaterThan(0);
      expect(leaf.len).toBeGreaterThan(0);
    }
  });

  it("keeps the old default layout when called without a seed key", () => {
    expect(layoutPlantLeaves()).toEqual(layoutPlantLeaves("room-props:plant-leaves"));
  });

  it("is stable for the same instance and differs between instances and rooms", () => {
    const a = propDetailKey("plant", "room-a", 0);
    expect(layoutPlantLeaves(a)).toEqual(layoutPlantLeaves(a));
    expect(layoutPlantLeaves(a)).not.toEqual(layoutPlantLeaves(propDetailKey("plant", "room-a", 1)));
    expect(layoutPlantLeaves(a)).not.toEqual(layoutPlantLeaves(propDetailKey("plant", "room-b", 0)));
    // No-arg default is also distinct from any identified instance.
    expect(layoutPlantLeaves()).not.toEqual(layoutPlantLeaves(a));
  });
});
