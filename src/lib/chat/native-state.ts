export type NativeJsonValue =
  | null
  | boolean
  | number
  | string
  | NativeJsonValue[]
  | { [key: string]: NativeJsonValue };

export type NativeControlValue = string | boolean | string[];

export interface NativeControlSnapshot {
  id: string;
  value: NativeControlValue;
}

export interface NativeSnapshot {
  controls: NativeControlSnapshot[];
  scroll: { x: number; y: number };
  custom?: NativeJsonValue;
}

export interface NativeStateIdentity {
  persona: string;
  contextId: string;
  turnId: string;
  blockId: string;
  sourceVersion: string;
}

export interface NativeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredSnapshot {
  scope: string;
  json: string;
  updatedAt: number;
}

export const NATIVE_STATE_STORAGE_KEY = "previously:native-replies:v1";
export const NATIVE_STATE_MAX_CHARS = 16_384;
export const NATIVE_STATE_MAX_ENTRIES = 64;
export const NATIVE_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const MAX_STORE_CHARS = 262_144;
const MAX_SCOPE_CHARS = 2_048;
const MAX_CONTROLS = 256;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validJsonValue(value: unknown, depth = 0, budget = { nodes: 512 }): value is NativeJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth > 8 || budget.nodes-- <= 0 || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((entry) => validJsonValue(entry, depth + 1, budget));
  }
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, entry]) =>
    key.length <= 128 && validJsonValue(entry, depth + 1, budget));
}

function validControl(value: unknown): value is NativeControlSnapshot {
  if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 192) return false;
  const state = value.value;
  if (typeof state === "boolean") return true;
  if (typeof state === "string") return state.length <= 8_192;
  return Array.isArray(state) && state.length <= 64 && state.every((entry) =>
    typeof entry === "string" && entry.length <= 1_024);
}

export function parseNativeSnapshot(json: string): NativeSnapshot | null {
  if (json.length > NATIVE_STATE_MAX_CHARS) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isObject(value) || !Array.isArray(value.controls) || value.controls.length > MAX_CONTROLS) return null;
    if (!value.controls.every(validControl) || !isObject(value.scroll)) return null;
    const { x, y } = value.scroll;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
    const snapshot: NativeSnapshot = {
      controls: value.controls.map((control) => ({ id: control.id, value: control.value })),
      scroll: {
        x: Math.max(0, Math.min(1_000_000, Math.round(x))),
        y: Math.max(0, Math.min(1_000_000, Math.round(y))),
      },
    };
    if ("custom" in value) {
      if (!validJsonValue(value.custom)) return null;
      snapshot.custom = value.custom;
    }
    return JSON.stringify(snapshot).length <= NATIVE_STATE_MAX_CHARS ? snapshot : null;
  } catch {
    return null;
  }
}

export function nativeStateScope(identity: NativeStateIdentity): string {
  return JSON.stringify([
    identity.persona,
    identity.contextId,
    identity.turnId,
    identity.blockId,
    identity.sourceVersion,
  ]);
}

export class NativeStateStore {
  private readonly memory = new Map<string, StoredSnapshot>();

  constructor(
    private readonly storage?: NativeStorageLike,
    private readonly now: () => number = Date.now,
  ) {}

  private readPersistent(): StoredSnapshot[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(NATIVE_STATE_STORAGE_KEY);
      if (!raw || raw.length > MAX_STORE_CHARS * 2) return [];
      const envelope: unknown = JSON.parse(raw);
      if (!isObject(envelope) || envelope.version !== 1 || !Array.isArray(envelope.entries)) return [];
      return envelope.entries.flatMap((entry): StoredSnapshot[] => {
        if (!isObject(entry) || typeof entry.scope !== "string" || entry.scope.length > MAX_SCOPE_CHARS) return [];
        if (typeof entry.json !== "string" || entry.json.length > NATIVE_STATE_MAX_CHARS) return [];
        if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) return [];
        return parseNativeSnapshot(entry.json) ? [{ scope: entry.scope, json: entry.json, updatedAt: entry.updatedAt }] : [];
      });
    } catch {
      return [];
    }
  }

  private writePersistent(entries: StoredSnapshot[]): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(NATIVE_STATE_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
    } catch {
      // The in-memory copy remains available when storage is denied or full.
    }
  }

  private prune(entries: StoredSnapshot[]): StoredSnapshot[] {
    const cutoff = this.now() - NATIVE_STATE_TTL_MS;
    const alive = entries.filter((entry) => entry.updatedAt >= cutoff);
    alive.sort((a, b) => a.updatedAt - b.updatedAt);
    while (alive.length > NATIVE_STATE_MAX_ENTRIES || JSON.stringify(alive).length > MAX_STORE_CHARS) alive.shift();
    return alive;
  }

  private readRecord(scope: string): StoredSnapshot | null {
    const cutoff = this.now() - NATIVE_STATE_TTL_MS;
    const persistent = this.readPersistent().find((entry) => entry.scope === scope) ?? null;
    const memory = this.memory.get(scope) ?? null;
    const record = persistent && memory
      ? (persistent.updatedAt >= memory.updatedAt ? persistent : memory)
      : (persistent ?? memory);
    if (!record || record.updatedAt < cutoff) return null;
    return record;
  }

  read(scope: string): NativeSnapshot | null {
    const record = this.readRecord(scope);
    return record ? parseNativeSnapshot(record.json) : null;
  }

  write(scope: string, snapshot: NativeSnapshot): boolean {
    const json = JSON.stringify(snapshot);
    if (!parseNativeSnapshot(json)) return false;
    const record: StoredSnapshot = { scope, json, updatedAt: this.now() };
    this.memory.set(scope, record);
    for (const [key, entry] of this.memory) {
      if (entry.updatedAt < this.now() - NATIVE_STATE_TTL_MS) this.memory.delete(key);
    }
    while (this.memory.size > NATIVE_STATE_MAX_ENTRIES) {
      const oldest = [...this.memory.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      this.memory.delete(oldest[0]);
    }
    if (scope.length > MAX_SCOPE_CHARS) return true;
    const entries = this.readPersistent().filter((entry) => entry.scope !== scope);
    entries.push(record);
    this.writePersistent(this.prune(entries));
    return true;
  }

  migrate(fromScope: string, toScope: string): void {
    if (fromScope === toScope) return;
    const source = this.readRecord(fromScope);
    const target = this.readRecord(toScope);
    if (source && (!target || source.updatedAt > target.updatedAt)) {
      const snapshot = parseNativeSnapshot(source.json);
      if (snapshot) this.write(toScope, snapshot);
    }
    if (source || target) this.clear(fromScope);
  }

  clear(scope: string): void {
    this.memory.delete(scope);
    this.writePersistent(this.readPersistent().filter((entry) => entry.scope !== scope));
  }
}

let sharedStore: NativeStateStore | undefined;

export function getNativeStateStore(): NativeStateStore {
  if (!sharedStore) {
    let storage: NativeStorageLike | undefined;
    try {
      if (typeof window !== "undefined") storage = window.localStorage;
    } catch {
      storage = undefined;
    }
    sharedStore = new NativeStateStore(storage);
  }
  return sharedStore;
}
