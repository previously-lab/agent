import { getRun } from "workflow/api";
import { cachedFetch, CACHE_TTLS } from "@/lib/cache/data-cache";

interface StreamPrefix<T> {
  entries: T[];
  nextStreamIndex: number;
}

/** Return the same partial view as a live read on early EOF, without caching it. */
class IncompletePrefix<T> extends Error {
  constructor(readonly prefix: StreamPrefix<T>) { super("Workflow stream ended before its observed tail"); }
}

/** Each namespace has one projection. Cache only selected dialogue records,
 * never raw stream chunks, model output deltas, or an unverified tail.
 * A terminal run can still own an open namespace, so obtain its tail on
 * every read. An append selects a new immutable prefix immediately.
 */
export async function readWorkflowStreamPrefix<T>(
  runId: string, namespace: string | undefined, select: (chunk: unknown) => T | undefined,
  cacheScope?: string,
): Promise<StreamPrefix<T>> {
  const readable = getRun(runId).getReadable({ namespace, startIndex: 0 });
  const tail = await readable.getTailIndex();
  if (tail < 0) return { entries: [], nextStreamIndex: 0 };
  const read = async (): Promise<StreamPrefix<T>> => {
    const reader = readable.getReader();
    const prefix: StreamPrefix<T> = { entries: [], nextStreamIndex: 0 };
    try {
      while (prefix.nextStreamIndex <= tail) {
        const next = await reader.read();
        if (next.done) throw new IncompletePrefix(prefix);
        prefix.nextStreamIndex++;
        const selected = select(next.value);
        if (selected !== undefined) prefix.entries.push(selected);
      }
      return prefix;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  try {
    if (cacheScope === undefined) return await read();
    return await cachedFetch(["workflow", "dialogue-prefix-v1", cacheScope, runId, namespace ?? "", String(tail)],
      CACHE_TTLS.BLOB_SECONDS, [], read);
  } catch (error) {
    if (error instanceof IncompletePrefix) return error.prefix;
    throw error;
  }
}
