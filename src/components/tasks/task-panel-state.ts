import type {
  TaskPanelFilter,
  TaskPanelItem,
  TaskPanelResponse,
} from "@/lib/tasks/panel";

/**
 * Pure UI-state helpers for the task panel (v0.11 streams), factored out of
 * the component so the stale-response and reset behaviour is testable without
 * a browser. The rule: a response is applied only when its request id is
 * still the latest one — anything slower (a closed panel, a superseded
 * filter, a newer refresh) is ignored, and closing resets everything.
 */

export interface TaskPanelUiState {
  /** Monotonic id of the latest request; responses carry the id they answer. */
  requestId: number;
  filter: TaskPanelFilter;
  loading: boolean;
  /** True when the latest request rejected (network/server failure). */
  requestFailed: boolean;
  response: TaskPanelResponse | null;
  /** Accumulated items across load-more pages (reset on filter/open/refresh). */
  items: TaskPanelItem[];
}

export function initialTaskPanelUiState(): TaskPanelUiState {
  return {
    requestId: 0,
    filter: "active",
    loading: false,
    requestFailed: false,
    response: null,
    items: [],
  };
}

/** Begin a request: bump the id, mark loading, optionally reset the page. */
export function beginPanelRequest(
  state: TaskPanelUiState,
  filter: TaskPanelFilter,
  reset: boolean,
): TaskPanelUiState {
  return {
    ...state,
    requestId: state.requestId + 1,
    filter,
    loading: true,
    requestFailed: false,
    ...(reset ? { response: null, items: [] } : {}),
  };
}

/**
 * Apply a response. Returns null when the response is stale (its request id
 * is not the latest) — callers keep the current state untouched.
 */
export function applyPanelResponse(
  state: TaskPanelUiState,
  requestId: number,
  response: TaskPanelResponse,
): TaskPanelUiState | null {
  if (requestId !== state.requestId) return null;
  return {
    ...state,
    loading: false,
    requestFailed: false,
    response,
    items:
      response.status === "ready"
        ? [...state.items, ...response.items]
        : [],
  };
}

/** Mark the latest request as failed; null when the failure is stale. */
export function failPanelRequest(
  state: TaskPanelUiState,
  requestId: number,
): TaskPanelUiState | null {
  if (requestId !== state.requestId) return null;
  return { ...state, loading: false, requestFailed: true };
}

/** The next offset for a load-more request; null when there is no more. */
export function panelNextOffset(state: TaskPanelUiState): number | null {
  return state.response?.status === "ready"
    ? state.response.nextOffset
    : null;
}

/** Restore the simulation's prior pause, unless a document transition started
 *  while the folio was open and now owns the freeze. */
export function simulationFreezeAfterTaskPanel(
  previousFreeze: boolean,
  transitionActive: boolean,
): boolean {
  return previousFreeze || transitionActive;
}

const WORLD_NAVIGATION_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "PageUp", "PageDown", "Home", "End",
  "w", "a", "s", "d", "W", "A", "S", "D",
  "+", "=", "-", "0", ".",
]);

/** Escape closes; world/navigation keys stop inside the modal; Tab, Enter,
 *  Space and control activation retain their native dialog behaviour. */
export function taskPanelKeyDisposition(
  key: string,
): "close" | "stop-world" | "allow" {
  if (key === "Escape") return "close";
  return WORLD_NAVIGATION_KEYS.has(key) ? "stop-world" : "allow";
}
