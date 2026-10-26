import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

export const WORKSPACE_HISTORY_DEFAULT_LIMIT = 20;
export const WORKSPACE_HISTORY_MAX_LIMIT = 32;

export interface WorkspaceHistoryIdPage {
  ids: string[];
  nextBeforeId: string | null;
  hasMore: boolean;
}

export interface WorkspaceHistoryPage extends Omit<WorkspaceHistoryIdPage, "ids"> {
  entries: TimelineSliceEntry[];
}

export interface HistoryPageRequest {
  beforeId: string | null;
  generation: number;
}

export function workspaceHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return WORKSPACE_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(WORKSPACE_HISTORY_MAX_LIMIT, Math.floor(limit)));
}

export function selectWorkspaceHistoryIds(
  ids: readonly string[],
  beforeId: string | null,
  limit = WORKSPACE_HISTORY_DEFAULT_LIMIT,
): WorkspaceHistoryIdPage {
  const sorted = [...new Set(ids)].sort();
  const eligible = beforeId === null ? sorted : sorted.filter((id) => id < beforeId);
  const pageIds = eligible.slice(-workspaceHistoryLimit(limit));
  return {
    ids: pageIds,
    nextBeforeId: pageIds[0] ?? null,
    hasMore: eligible.length > pageIds.length,
  };
}

export function initialHistoryRequest(): HistoryPageRequest {
  return { beforeId: null, generation: 0 };
}

export function olderHistoryRequest(
  current: HistoryPageRequest,
  page: WorkspaceHistoryPage | null,
): HistoryPageRequest | null {
  if (!page?.hasMore || !page.nextBeforeId) return null;
  if (current.beforeId === page.nextBeforeId) return null;
  return { beforeId: page.nextBeforeId, generation: current.generation + 1 };
}

export function newestHistoryRequest(current: HistoryPageRequest): HistoryPageRequest {
  return { beforeId: null, generation: current.generation + 1 };
}

export function historyRequestKey(request: HistoryPageRequest): string {
  return `${request.beforeId ?? "newest"}:${request.generation}`;
}
