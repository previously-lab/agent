/**
 * Tests for the seed module (src/lib/game/seed.ts) — the reproducibility
 * root of the hotel game. These lock down the contract other agents build
 * against: same seed inputs always rebuild the same space, sub-seeds are
 * cleanly separated per sliceId and per concern, and the PRNG streams stay
 * in their documented bounds with sane distribution.
 */
import { describe, it, expect } from "vitest";
import {
  hashString,
  createRng,
  deriveSubSeed,
  pick,
  rangeInt,
  WORLD_SEED,
  type SeedKey,
} from "@/lib/game/seed";

const SEED_KEYS: readonly SeedKey[] = [
  "size",
  "type",
  "style",
  "layout",
  "light",
];

describe("WORLD_SEED", () => {
  it("pins the hotel world seed (bumping it forces full regeneration)", () => {
    expect(WORLD_SEED).toBe("previously-hotel-v1");
  });
});

describe("hashString", () => {
  it("returns identical values across separate calls with the same input", () => {
    expect(hashString("door:alpha")).toBe(hashString("door:alpha"));
  });

  it("returns a uint32", () => {
    for (const input of ["", "a", "door:alpha", "🚪:suite"]) {
      const h = hashString(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("spreads nearby inputs apart", () => {
    expect(hashString("slice-1")).not.toBe(hashString("slice-2"));
  });
});

describe("createRng", () => {
  it("reproduces the same sequence across separate streams with the same seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 32 }, () => a());
    const seqB = Array.from({ length: 32 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("stays within [0, 1) over 1000 draws", () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("deriveSubSeed", () => {
  it("is deterministic across separate calls", () => {
    expect(deriveSubSeed(WORLD_SEED, "slice-1", "layout")).toBe(
      deriveSubSeed(WORLD_SEED, "slice-1", "layout"),
    );
  });

  it("matches the documented hashString composition", () => {
    expect(deriveSubSeed("world", "slice-1", "light")).toBe(
      hashString("world:slice-1:light"),
    );
  });

  it("different sliceIds yield different sub-seeds for the same key", () => {
    for (const key of SEED_KEYS) {
      expect(deriveSubSeed(WORLD_SEED, "slice-1", key)).not.toBe(
        deriveSubSeed(WORLD_SEED, "slice-2", key),
      );
    }
  });

  it("different keys yield different sub-seeds for the same sliceId", () => {
    for (let i = 0; i < SEED_KEYS.length; i++) {
      for (let j = i + 1; j < SEED_KEYS.length; j++) {
        expect(deriveSubSeed(WORLD_SEED, "slice-1", SEED_KEYS[i])).not.toBe(
          deriveSubSeed(WORLD_SEED, "slice-1", SEED_KEYS[j]),
        );
      }
    }
  });
});

describe("pick", () => {
  it("returns only members of the input array", () => {
    const items = ["single", "double", "suite"] as const;
    const rng = createRng(7);
    for (let i = 0; i < 500; i++) {
      expect(items).toContain(pick(rng, items));
    }
  });

  it("reproduces the same pick sequence for a fixed seed", () => {
    const items = [10, 20, 30, 40, 50];
    const run = () => {
      const rng = createRng(99);
      return Array.from({ length: 32 }, () => pick(rng, items));
    };
    expect(run()).toEqual(run());
  });

  it("changes the pick sequence when the seed changes", () => {
    const items = [10, 20, 30, 40, 50];
    const run = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 32 }, () => pick(rng, items));
    };
    expect(run(1)).not.toEqual(run(2));
  });

  it("throws on an empty array instead of returning undefined", () => {
    expect(() => pick(createRng(1), [])).toThrow();
  });
});

describe("rangeInt", () => {
  it("draws stay within [min, max] inclusive over 1000 draws", () => {
    const rng = createRng(2024);
    for (let i = 0; i < 1000; i++) {
      const v = rangeInt(rng, 0, 3);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it("hits both extremes within 1000 draws (min=0, max=3)", () => {
    const rng = createRng(2024);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      seen.add(rangeInt(rng, 0, 3));
    }
    expect(seen.has(0)).toBe(true);
    expect(seen.has(3)).toBe(true);
  });

  it("stays within 15% of uniform over 10_000 draws (min=0, max=7)", () => {
    const rng = createRng(31337);
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 10_000; i++) {
      counts[rangeInt(rng, 0, 7)] += 1;
    }
    const expected = 10_000 / 8;
    for (const count of counts) {
      expect(Math.abs(count - expected)).toBeLessThanOrEqual(
        expected * 0.15,
      );
    }
  });
});
