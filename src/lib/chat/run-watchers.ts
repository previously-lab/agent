import type { RunWatchResult } from "./hq-stream";

/** One reader per run. Transport failures retry; only a run terminal announces a change. */
export function createRunWatchers(options: {
  watch: (options: { runId: string; signal: AbortSignal }) => Promise<RunWatchResult>;
  onTerminal: (runId: string) => void;
}) {
  type Entry = { controller: AbortController; attempts: number; timer?: ReturnType<typeof setTimeout> };
  const active = new Map<string, Entry>();
  const finished = new Set<string>();
  let desired = new Set<string>();
  let enabled = false;

  function start(runId: string, attempts = 0) {
    if (!enabled || !desired.has(runId) || active.has(runId) || finished.has(runId)) return;
    const entry: Entry = { controller: new AbortController(), attempts };
    active.set(runId, entry);
    void options.watch({ runId, signal: entry.controller.signal }).catch((): RunWatchResult => ({ kind: "retry" })).then((result) => {
      if (active.get(runId) !== entry || entry.controller.signal.aborted) return;
      if (result.kind === "terminal") {
        active.delete(runId);
        finished.add(runId);
        if (finished.size > 500) finished.delete(finished.values().next().value!);
        options.onTerminal(runId);
      } else if (result.kind === "retry") {
        entry.timer = setTimeout(() => {
          if (active.get(runId) !== entry) return;
          active.delete(runId);
          start(runId, attempts + 1);
        }, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
      } else {
        active.delete(runId);
      }
    });
  }

  function stop(runId: string, entry: Entry) {
    active.delete(runId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.controller.abort();
  }

  return {
    sync(runIds: string[], isEnabled: boolean) {
      desired = new Set(runIds);
      enabled = isEnabled;
      for (const [runId, entry] of active) if (!enabled || !desired.has(runId)) stop(runId, entry);
      if (enabled) for (const runId of desired) start(runId);
    },
    dispose() {
      enabled = false;
      desired.clear();
      for (const [runId, entry] of active) stop(runId, entry);
    },
  };
}
