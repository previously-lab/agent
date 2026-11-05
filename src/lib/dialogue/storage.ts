/** Private runtime file views. A transaction callback may run again after a
 * conflict. It must only read and stage files; no models, launches or effects. */
export interface DialogueFiles {
  read(path: string): Promise<string | null>;
  write(path: string, body: string | null): void;
  schedule(due: number | null): void;
}

export interface DialogueStorage {
  view<T>(scope: string, operation: (files: DialogueFiles, now: number) => Promise<T>): Promise<T>;
  transaction<T>(scope: string, operation: (files: DialogueFiles, now: number) => Promise<T>): Promise<T>;
  dueScopes(now: number, limit: number): Promise<string[]>;
}

export function bufferedFiles(read: (path: string) => Promise<string | null>) {
  const writes = new Map<string, string | null>();
  let due: number | null | undefined;
  const reads = new Map<string, Promise<string | null>>();
  const files: DialogueFiles = {
    read(path) {
      if (writes.has(path)) return Promise.resolve(writes.get(path)!);
      const prior = reads.get(path);
      if (prior) return prior;
      const pending = read(path);
      reads.set(path, pending);
      return pending;
    },
    write(path, value) { writes.set(path, value); },
    schedule(value) { due = value; },
  };
  return { files, writes, get due() { return due; } };
}

export const retryConflict = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.min(180, (attempt + 1) * 8) + Math.random() * 15));
