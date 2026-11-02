/** Lightweight handoff registry shared by the shell and native frame owners.
 * Each registered writer bounds its own request/acknowledgement wait. */
export const readingFlushers = new Map<Element, () => Promise<void>>();

/** Save the outgoing reading surface before its execution lease is released.
 * A broken writer must not prevent the remaining writers from being flushed. */
export async function flushNativeReading(root: Element | null): Promise<void> {
  if (!root) return;
  await Promise.allSettled([...readingFlushers].filter(([element]) => root.contains(element)).map(([, flush]) => flush()));
}
