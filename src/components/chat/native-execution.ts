/** One executable copy per complete source/persona/turn/block/version scope.
 * Reading the same reply on two mounted surfaces must not create two writers. */
export function createNativeExecutionRegistry() {
  const candidates = new Map<string, Map<string, number>>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (scope: string) => listeners.get(scope)?.forEach((listener) => listener());
  return {
    hasOwner(scope: string) { return Boolean(candidates.get(scope)?.size); },
    owns(scope: string, id: string) {
      let owner: string | undefined;
      let priority = -Infinity;
      for (const [candidate, weight] of candidates.get(scope) ?? []) {
        if (weight > priority) { owner = candidate; priority = weight; }
      }
      return owner === id;
    },
    claim(scope: string, id: string, priority: number) {
      let entries = candidates.get(scope);
      if (!entries) { entries = new Map(); candidates.set(scope, entries); }
      entries.set(id, priority);
      notify(scope);
      return () => {
        entries.delete(id);
        if (entries.size === 0) candidates.delete(scope);
        notify(scope);
      };
    },
    subscribe(scope: string, listener: () => void) {
      let entries = listeners.get(scope);
      if (!entries) { entries = new Set(); listeners.set(scope, entries); }
      entries.add(listener);
      return () => {
        entries.delete(listener);
        if (entries.size === 0) listeners.delete(scope);
      };
    },
  };
}

/** Ordinary queued state messages are not acknowledgements of a later flush. */
export function createNativeFlushTracker() {
  const pending = new Map<string, () => void>();
  return {
    wait(requestId: string, done: () => void) { pending.set(requestId, done); },
    forget(requestId: string) { pending.delete(requestId); },
    acknowledge(requestId?: string) {
      if (!requestId) return;
      const done = pending.get(requestId);
      pending.delete(requestId);
      done?.();
    },
    dispose() {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((done) => done());
    },
  };
}
