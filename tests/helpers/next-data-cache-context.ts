import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

/** Real Next cache semantics; only the persistence adapter is a fixture. */
export function createNextDataCacheContext() {
  const globals = globalThis as typeof globalThis & {
    AsyncLocalStorage?: typeof AsyncLocalStorage;
  };
  globals.AsyncLocalStorage ??= AsyncLocalStorage;
  const require = createRequire(import.meta.url);
  const { IncrementalCache } = require("next/dist/server/lib/incremental-cache/index.js");
  const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
  class Persistence {
    entries = new Map<string, { value: unknown; lastModified: number }>();
    async get(key: string) { return this.entries.get(key) ?? null; }
    async set(key: string, value: unknown) {
      this.entries.set(key, { value, lastModified: Date.now() });
    }
    async revalidateTag() {}
  }
  const incrementalCache = new IncrementalCache({
    dev: false, flushToDisk: false, minimalMode: false, requestHeaders: {},
    getPrerenderManifest: () => ({
      version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [],
      preview: { previewModeId: "test-cache-context" },
    }),
    CurCacheHandler: Persistence,
  });
  const store: {
    route: string;
    page: string;
    incrementalCache: unknown;
    isStaticGeneration: boolean;
    pendingRevalidates?: Record<string, Promise<unknown>>;
    pendingRevalidatedTags?: Array<{ tag: string; profile?: unknown }>;
  } = {
    route: "/.well-known/workflow/v1/flow",
    page: "/.well-known/workflow/v1/flow/route",
    incrementalCache,
    isStaticGeneration: false,
  };
  return {
    store,
    run: <T>(fn: () => Promise<T>): Promise<T> => workAsyncStorage.run(store, fn),
    flush: async () => {
      await Promise.all(Object.values(store.pendingRevalidates ?? {}));
    },
  };
}
