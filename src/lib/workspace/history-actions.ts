"use server";

import { setDemoPersona } from "@/lib/demo/demo-fs";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";
import { sliceEntryFromDisk } from "@/lib/episodic/timeline/store";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { sliceIdToRelPath } from "@/lib/episodic/paths";
import { withGitHubReadBudget } from "@/lib/github/client";
import {
  selectWorkspaceHistoryIds,
  type WorkspaceHistoryPage,
} from "@/lib/workspace/history-page";

const READ_CONCURRENCY = 4;

async function readHeaders(ids: readonly string[]): Promise<TimelineSliceEntry[]> {
  const results = new Array<TimelineSliceEntry | null>(ids.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < ids.length) {
      const index = next;
      next += 1;
      results[index] = await sliceEntryFromDisk(sliceIdToRelPath(ids[index]));
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(READ_CONCURRENCY, ids.length) },
    () => worker(),
  ));
  return results.filter((entry): entry is TimelineSliceEntry => entry !== null);
}

export async function getWorkspaceHistoryPage(
  beforeId: string | null = null,
  limit = 20,
  persona?: string,
): Promise<WorkspaceHistoryPage> {
  if (persona) setDemoPersona(persona);
  return withGitHubReadBudget(async () => {
    const relativeIds = await enumerateSliceIds();
    const selected = selectWorkspaceHistoryIds(
      relativeIds.map((id) => id.replaceAll("/", "-")),
      beforeId,
      limit,
    );
    const entries = await readHeaders(selected.ids);
    return {
      entries,
      nextBeforeId: selected.nextBeforeId,
      hasMore: selected.hasMore,
    };
  });
}
