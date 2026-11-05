import { createHash } from "node:crypto";
import type { DialogueFiles, DialogueStorage } from "./storage";
import type { ExpressionFence } from "./types";

export interface ScopeState {
  userSeq: number;
  publicSeq: number;
  eventSeq: number;
  resultSeq: number;
  wakeVersion: number;
  epoch: number;
  pausedThrough: number;
  lease?: ExpressionFence & { until: number };
}

export interface Item<T> { id: string; seq: number; state: string; dueAt: number; value: T }
type IndexEntry = Omit<Item<unknown>, "value">;
const PAGE = 64;
const ORDERED = new Set(["input", "publication", "event"]);
const ACTIVE: Record<string, readonly string[]> = {
  work: ["queued", "running"], result: ["ready", "deferred"], outbox: ["ready", "leased"],
};

const rowFile = (kind: string, id: string) => `items/${kind}/${createHash("sha256").update(id).digest("hex")}.json`;
const pageFile = (kind: string, page: number) => `pages/${kind}/${page}.json`;
const ordinalPage = (seq: number) => Math.floor((seq - 1) / PAGE);
const indexFile = (kind: string) => `indexes/${kind}.json`;
async function json<T>(files: DialogueFiles, path: string, fallback: T): Promise<T> {
  const raw = await files.read(path);
  return raw === null ? fallback : JSON.parse(raw) as T;
}

export class DialogueRows {
  constructor(readonly files: DialogueFiles, readonly scope: string) {}

  async get<T>(kind: string, id: string): Promise<Item<T> | undefined> {
    if (kind === "event") {
      const seq = Number(id);
      if (!Number.isSafeInteger(seq) || seq <= 0) return undefined;
      return (await json<Item<T>[]>(this.files, pageFile(kind, ordinalPage(seq)), [])).find((item) => item.id === id);
    }
    return json<Item<T> | undefined>(this.files, rowFile(kind, id), undefined);
  }

  async list<T>(kind: string, options: { states?: string[]; after?: number; due?: number; newest?: boolean; limit: number }): Promise<Item<T>[]> {
    if (ORDERED.has(kind)) {
      const high = await json<number>(this.files, indexFile(kind), 0);
      const after = options.after ?? 0;
      if (after >= high) return [];
      const first = ordinalPage(after + 1);
      const last = ordinalPage(high);
      const items: Item<T>[] = [];
      for (let page = options.newest ? last : first; page >= first && page <= last; page += options.newest ? -1 : 1) {
        const entries = await json<Item<T>[]>(this.files, pageFile(kind, page), []);
        const eligible = entries.filter((entry) => entry.seq > after);
        items.push(...(options.newest ? eligible.reverse() : eligible));
        if (items.length >= options.limit) break;
      }
      return items.slice(0, options.limit);
    }
    if (!ACTIVE[kind]) throw new Error("Unknown dialogue query index");
    const metadata = await json<IndexEntry[]>(this.files, indexFile(kind), []);
    const chosen = metadata.filter((item) => (!options.states || options.states.includes(item.state)) &&
      (options.due === undefined || item.dueAt <= options.due)).sort((a, b) =>
        kind === "outbox" ? a.dueAt - b.dueAt || a.seq - b.seq || a.id.localeCompare(b.id)
          : (options.newest ? b.seq - a.seq : a.seq - b.seq) || a.id.localeCompare(b.id)
      ).slice(0, options.limit);
    const result = await Promise.all(chosen.map(({ id }) => this.get<T>(kind, id)));
    if (result.some((item) => !item)) throw new Error("Incomplete dialogue index");
    return result as Item<T>[];
  }

  async remove(kind: string, id: string): Promise<void> {
    if (ACTIVE[kind] || ORDERED.has(kind)) throw new Error("Cannot remove an indexed dialogue item");
    this.files.write(rowFile(kind, id), null);
  }

  async put<T>(kind: string, id: string, value: T, seq = 0, state = "", dueAt = 0): Promise<void> {
    const item = { id, seq, state, dueAt, value };
    if (kind !== "event") this.files.write(rowFile(kind, id), JSON.stringify(item));
    if (ORDERED.has(kind)) {
      const path = pageFile(kind, ordinalPage(seq));
      const page = await json<Item<T>[]>(this.files, path, []);
      this.files.write(path, JSON.stringify([...page.filter((entry) => entry.id !== id), item].sort((a, b) => a.seq - b.seq)));
      const high = await json<number>(this.files, indexFile(kind), 0);
      if (seq > high) this.files.write(indexFile(kind), JSON.stringify(seq));
    }
    if (ACTIVE[kind]) {
      const index = indexFile(kind);
      const metadata = (await json<IndexEntry[]>(this.files, index, [])).filter((entry) => entry.id !== id);
      if (ACTIVE[kind].includes(state)) metadata.push({ id, seq, state, dueAt });
      this.files.write(index, JSON.stringify(metadata));
      if (kind === "outbox") this.files.schedule(metadata.reduce<number | null>((min, entry) => min === null ? entry.dueAt : Math.min(min, entry.dueAt), null));
    }
  }
}

const initial: ScopeState = { userSeq: 0, publicSeq: 0, eventSeq: 0, resultSeq: 0, wakeVersion: 0, epoch: 0, pausedThrough: -1 };

export function withDialogueScope<T>(storage: DialogueStorage, scope: string, operation: (rows: DialogueRows, state: ScopeState, now: number) => Promise<T>): Promise<T> {
  return storage.transaction(scope, async (files, now) => {
    const state = await json<ScopeState>(files, "state.json", { ...initial });
    const before = JSON.stringify(state);
    const result = await operation(new DialogueRows(files, scope), state, now);
    const after = JSON.stringify(state);
    if (after !== before) files.write("state.json", after);
    return result;
  });
}
