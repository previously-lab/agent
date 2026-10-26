import { describe, expect, it } from "vitest";
import {
  olderHistoryRequest,
  selectWorkspaceHistoryIds,
  workspaceHistoryLimit,
  WORKSPACE_HISTORY_MAX_LIMIT,
} from "@/lib/workspace/history-page";

function idsInOneMonth(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(Math.floor(index / 24) + 1).padStart(2, "0");
    const hour = String(index % 24).padStart(2, "0");
    return `2026-10-${day}-${hour}00`;
  });
}

describe("hard-capped ID-cursor history pages", () => {
  it("never exceeds the read cap and does not skip records within one month", () => {
    const ids = idsInOneMonth(75);
    const seen: string[] = [];
    const sizes: number[] = [];
    let beforeId: string | null = null;
    for (;;) {
      const page = selectWorkspaceHistoryIds(ids, beforeId);
      expect(page.ids.length).toBeLessThanOrEqual(20);
      sizes.push(page.ids.length);
      seen.push(...page.ids);
      if (!page.hasMore) break;
      beforeId = page.nextBeforeId;
    }
    expect(sizes).toEqual([20, 20, 20, 15]);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual(ids);
  });

  it("enforces the absolute maximum even when the caller asks for more", () => {
    const ids = idsInOneMonth(75);
    expect(selectWorkspaceHistoryIds(ids, null, 1000).ids).toHaveLength(WORKSPACE_HISTORY_MAX_LIMIT);
    expect(workspaceHistoryLimit(Number.NaN)).toBe(20);
    expect(workspaceHistoryLimit(0)).toBe(1);
    expect(workspaceHistoryLimit(33)).toBe(32);
  });

  it("uses the exclusive ID cursor and rejects a repeated older request", () => {
    const ids = idsInOneMonth(75);
    const first = selectWorkspaceHistoryIds(ids, null);
    const second = selectWorkspaceHistoryIds(ids, first.nextBeforeId);
    expect(second.ids.at(-1)).toBe(ids[ids.indexOf(first.nextBeforeId!) - 1]);
    expect(second.ids).not.toContain(first.nextBeforeId);
    const request = olderHistoryRequest(
      { beforeId: null, generation: 0 },
      { entries: [], nextBeforeId: second.nextBeforeId, hasMore: true },
    );
    expect(request).toEqual({ beforeId: second.nextBeforeId, generation: 1 });
    expect(olderHistoryRequest(request!, {
      entries: [],
      nextBeforeId: second.nextBeforeId,
      hasMore: true,
    })).toBeNull();
  });
});
