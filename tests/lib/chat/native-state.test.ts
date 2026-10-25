import { describe, expect, it } from "vitest";
import {
  NATIVE_STATE_MAX_ENTRIES,
  NATIVE_STATE_STORAGE_KEY,
  NATIVE_STATE_TTL_MS,
  NativeStateStore,
  nativeStateScope,
  parseNativeSnapshot,
  type NativeSnapshot,
  type NativeStorageLike,
} from "@/lib/chat/native-state";

function snapshot(value = "20"): NativeSnapshot {
  return {
    controls: [{ id: "input:amount:0", value }],
    scroll: { x: 0, y: 120 },
    custom: { selected: true, values: [1, 2, 3] },
  };
}

function memoryStorage(): NativeStorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("native snapshot validation", () => {
  it("roundtrips bounded controls, scroll and custom JSON", () => {
    const original = snapshot("42");
    expect(parseNativeSnapshot(JSON.stringify(original))).toEqual(original);
  });

  it("rejects corrupt, oversized and deeply nested state", () => {
    expect(parseNativeSnapshot("not json")).toBeNull();
    expect(parseNativeSnapshot("{}")).toBeNull();
    expect(parseNativeSnapshot(JSON.stringify({ ...snapshot(), controls: [{ id: "x", value: { no: true } }] }))).toBeNull();
    expect(parseNativeSnapshot(JSON.stringify({ ...snapshot(), custom: "x".repeat(20_000) }))).toBeNull();
    let deep: unknown = null;
    for (let index = 0; index < 12; index++) deep = [deep];
    expect(parseNativeSnapshot(JSON.stringify({ ...snapshot(), custom: deep }))).toBeNull();
  });

  it("clamps scroll coordinates to bounded non-negative integers", () => {
    const restored = parseNativeSnapshot(JSON.stringify({ ...snapshot(), scroll: { x: -4, y: 2_000_000 } }));
    expect(restored?.scroll).toEqual({ x: 0, y: 1_000_000 });
  });
});

describe("bounded native state store", () => {
  it("isolates persona, source, ordinary turns, blocks and source versions", () => {
    const store = new NativeStateStore(memoryStorage());
    const base = { persona: "alpha", contextId: "source-a", turnId: "turn", blockId: "native-0", sourceVersion: "v1" };
    const first = nativeStateScope(base);
    const otherPersona = nativeStateScope({ ...base, persona: "beta" });
    const otherContext = nativeStateScope({ ...base, contextId: "source-b" });
    const otherTurn = nativeStateScope({ ...base, turnId: "other-turn" });
    const otherBlock = nativeStateScope({ ...base, blockId: "native-1" });
    const otherVersion = nativeStateScope({ ...base, sourceVersion: "v2" });
    store.write(first, snapshot("55"));
    for (const scope of [otherPersona, otherContext, otherTurn, otherBlock, otherVersion]) {
      expect(store.read(scope)).toBeNull();
    }
    store.write(otherVersion, snapshot("35"));
    expect(store.read(first)?.controls[0].value).toBe("55");
    expect(store.read(otherVersion)?.controls[0].value).toBe("35");
  });

  it("migrates provisional identity to terminal turn identity without losing controls", () => {
    const store = new NativeStateStore(memoryStorage());
    store.write("message-random", snapshot("73"));
    store.migrate("message-random", "terminal-turn");
    expect(store.read("message-random")).toBeNull();
    expect(store.read("terminal-turn")?.controls[0].value).toBe("73");
  });

  it("keeps the newer alias snapshot and the canonical snapshot on an exact tie", () => {
    let now = 100;
    const newer = new NativeStateStore(memoryStorage(), () => now);
    newer.write("provisional", snapshot("20"));
    now = 200;
    newer.write("canonical", snapshot("40"));
    now = 300;
    newer.write("provisional", snapshot("60"));
    newer.migrate("provisional", "canonical");
    expect(newer.read("canonical")?.controls[0].value).toBe("60");
    expect(newer.read("provisional")).toBeNull();

    now = 400;
    const tied = new NativeStateStore(memoryStorage(), () => now);
    tied.write("provisional", snapshot("70"));
    tied.write("canonical", snapshot("80"));
    tied.migrate("provisional", "canonical");
    expect(tied.read("canonical")?.controls[0].value).toBe("80");

    now = 500;
    const older = new NativeStateStore(memoryStorage(), () => now);
    older.write("provisional", snapshot("90"));
    now = 600;
    older.write("canonical", snapshot("95"));
    older.migrate("provisional", "canonical");
    expect(older.read("canonical")?.controls[0].value).toBe("95");
  });

  it("expires old records and evicts the least recently written beyond the LRU cap", () => {
    let now = 1_000;
    const store = new NativeStateStore(memoryStorage(), () => now);
    store.write("expired", snapshot());
    now += NATIVE_STATE_TTL_MS + 1;
    expect(store.read("expired")).toBeNull();
    for (let index = 0; index < NATIVE_STATE_MAX_ENTRIES + 2; index++) {
      now++;
      store.write(`scope-${index}`, snapshot(String(index)));
    }
    expect(store.read("scope-0")).toBeNull();
    expect(store.read("scope-1")).toBeNull();
    expect(store.read(`scope-${NATIVE_STATE_MAX_ENTRIES + 1}`)).not.toBeNull();
  });

  it("degrades to memory on corrupt storage, denied reads and quota errors", () => {
    const corrupt = new NativeStateStore({ getItem: () => "not-json", setItem: () => { throw new Error("quota"); } });
    expect(() => corrupt.write("scope", snapshot("9"))).not.toThrow();
    expect(corrupt.read("scope")?.controls[0].value).toBe("9");
    const denied = new NativeStateStore({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    denied.write("scope", snapshot("10"));
    expect(denied.read("scope")?.controls[0].value).toBe("10");
    const ssr = new NativeStateStore();
    expect(ssr.read("missing")).toBeNull();
  });

  it("persists one bounded envelope instead of creating a key per token", () => {
    const storage = memoryStorage();
    const store = new NativeStateStore(storage);
    for (let index = 0; index < 20; index++) store.write("same-turn", snapshot(String(index)));
    expect([...storage.values.keys()]).toEqual([NATIVE_STATE_STORAGE_KEY]);
    expect(store.read("same-turn")?.controls[0].value).toBe("19");
  });
});
