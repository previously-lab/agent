/**
 * Seed & RNG primitives for the hotel game — the reproducibility root.
 *
 * Every procedurally generated space (the room behind a door) is rebuilt
 * from seeds alone: the same world seed + sliceId + derivation key always
 * yields the same sub-seed, the same PRNG sequence, and therefore the same
 * space — today, tomorrow, on any machine. All entropy enters as explicit
 * string seeds; nothing here is random in the unrepeatable sense.
 *
 * Hard rule for all game code: NEVER call Math.random(). Any randomness a
 * gameplay decision depends on must come from a createRng() stream whose
 * seed traces back to WORLD_SEED + the sliceId. An unseeded random call
 * would make a rebuilt space diverge from the one the player remembers.
 */

/**
 * The world seed for this hotel build. Bump it (previously-hotel-v2, …) to
 * force a full regeneration of every space while keeping the derivation
 * rules unchanged.
 */
export const WORLD_SEED = "previously-hotel-v1";

/**
 * Which aspect of a space a sub-seed feeds. Each concern gets its own
 * independent stream so layout decisions can never perturb lighting, etc.
 */
export type SeedKey =
  | "size"
  | "type"
  | "style"
  | "layout"
  | "light"
  | "class"
  | "width"
  | "structure"
  | "furniture"
  | "animals"
  | "props"
  | "skin";

/**
 * cyrb53 string hash — full 53-bit-quality avalanche hash folded to a
 * uint32 for seeding mulberry32. Deterministic: same string, same uint32.
 */
export function hashString(input: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // The 53-bit cyrb53 result is quality material; game code only needs a
  // uint32, so keep the low word.
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)) >>> 0;
}

/**
 * mulberry32 PRNG: a uint32 seed in, a deterministic float stream in
 * [0, 1) out. Cheap and good enough for procedural generation; all game
 * randomness flows through here.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic sub-seed for one concern of one space:
 * hashString(`${worldSeed}:${sliceId}:${key}`). Same sliceId always
 * rebuilds the same space because every aspect of it derives from here.
 */
export function deriveSubSeed(
  worldSeed: string,
  sliceId: string,
  key: SeedKey,
): number {
  return hashString(`${worldSeed}:${sliceId}:${key}`);
}

/**
 * Uniform pick from `items` using the next draw of `rng`. Throws on an
 * empty array rather than letting undefined leak into game state.
 */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("pick: cannot pick from an empty array");
  }
  return items[Math.floor(rng() * items.length)];
}

/**
 * Integer in [min, max] inclusive from the next draw of `rng`.
 */
export function rangeInt(
  rng: () => number,
  min: number,
  max: number,
): number {
  return min + Math.floor(rng() * (max - min + 1));
}
