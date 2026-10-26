import type {
  DocumentCatalogItem,
  DocumentCatalogPage,
  DocumentCatalogQuery,
} from "./document-catalog-actions";

export type DocumentCatalogView = {
  scope: string;
  items: DocumentCatalogItem[];
  status: "idle" | "loading" | "success" | "error";
  nextCursor: string | null;
  loadingMore: boolean;
  activeIndex: number;
};

export type DocumentCatalogLookup = (input: DocumentCatalogQuery) => Promise<DocumentCatalogPage>;

const CLOSED_VIEW: DocumentCatalogView = {
  scope: "closed",
  items: [],
  status: "idle",
  nextCursor: null,
  loadingMore: false,
  activeIndex: 0,
};

const PENDING_VIEW: DocumentCatalogView = {
  scope: "pending",
  items: [],
  status: "loading",
  nextCursor: null,
  loadingMore: false,
  activeIndex: 0,
};

function scopeOf(open: boolean, query: string, persona: string): string {
  return JSON.stringify([open, query, persona]);
}

export function createDocumentCatalogController(
  lookup: DocumentCatalogLookup,
  debounceMs = 250,
) {
  let state = CLOSED_VIEW;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const setSearch = (open: boolean, query: string, persona: string): void => {
    generation += 1;
    cancelTimer();
    const scope = scopeOf(open, query, persona);
    state = {
      scope,
      items: [],
      status: open ? "loading" : "idle",
      nextCursor: null,
      loadingMore: false,
      activeIndex: 0,
    };
    emit();
    if (!open) return;
    const ticket = generation;
    timer = setTimeout(() => {
      timer = null;
      void lookup({ query, persona, limit: 12 }).then((page) => {
        if (generation !== ticket || state.scope !== scope) return;
        state = {
          ...state,
          items: page.items,
          status: "success",
          nextCursor: page.nextCursor,
          loadingMore: false,
        };
        emit();
      }).catch(() => {
        if (generation !== ticket || state.scope !== scope) return;
        state = { ...state, items: [], status: "error", nextCursor: null, loadingMore: false };
        emit();
      });
    }, debounceMs);
  };

  return {
    getSnapshot(open: boolean, query: string, persona: string): DocumentCatalogView {
      return state.scope === scopeOf(open, query, persona)
        ? state
        : open ? PENDING_VIEW : CLOSED_VIEW;
    },
    setSearch,
    setActiveIndex(index: number): void {
      if (state.activeIndex === index) return;
      state = { ...state, activeIndex: index };
      emit();
    },
    loadMore(open: boolean, query: string, persona: string): void {
      const scope = scopeOf(open, query, persona);
      if (
        state.scope !== scope ||
        state.status !== "success" ||
        !state.nextCursor ||
        state.loadingMore
      ) return;
      const cursor = state.nextCursor;
      const ticket = ++generation;
      state = { ...state, loadingMore: true };
      emit();
      void lookup({ query, persona, cursor, limit: 12 }).then((page) => {
        if (generation !== ticket || state.scope !== scope) return;
        const known = new Set(state.items.map((item) => item.ref));
        state = {
          ...state,
          items: [...state.items, ...page.items.filter((item) => !known.has(item.ref))],
          status: "success",
          nextCursor: page.nextCursor,
          loadingMore: false,
        };
        emit();
      }).catch(() => {
        if (generation !== ticket || state.scope !== scope) return;
        state = { ...state, status: "error", loadingMore: false };
        emit();
      });
    },
    retry(open: boolean, query: string, persona: string): void {
      setSearch(open, query, persona);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      generation += 1;
      cancelTimer();
      listeners.clear();
    },
  };
}
