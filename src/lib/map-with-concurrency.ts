/** Keep at most `limit` independent reads in flight and preserve input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { cause: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };
  const lanes = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  if (failure) throw failure.cause;
  return results;
}
