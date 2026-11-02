export interface NativeNavigationIntent { generation: number }

/** One layout workspace per browser. No state changes during server render;
 * panel folds and shell navigation must retire each other's older intent. */
export const workspaceNativeNavigationIntent: NativeNavigationIntent = { generation: 0 };

/** Explicit view changes may release an interactive document only after its
 * bounded flush. New intent, scope changes and teardown retire old requests. */
export function createNativeNavigationGuard(flush: () => Promise<unknown>, scope: () => string, intent: NativeNavigationIntent = { generation: 0 }) {
  return {
    cancel() { intent.generation++; },
    async run(action: () => void) {
      const request = ++intent.generation;
      const origin = scope();
      try { await flush(); } catch { /* Snapshot failure must not trap navigation. */ }
      if (request === intent.generation && scope() === origin) action();
    },
  };
}
