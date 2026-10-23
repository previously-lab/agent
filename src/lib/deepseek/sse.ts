/** Incremental SSE decoding, including split UTF-8 and multi-line data fields. */
export async function* readSse(body: ReadableStream<Uint8Array>, options: { signal?: AbortSignal; onActivity?: () => void } = {}): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  let data: string[] = [];
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (value?.length) options.onActivity?.();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A CR at the end of a network fragment may be the first half of CRLF.
      let cursor = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== "\n" && buffer[i] !== "\r") continue;
        if (buffer[i] === "\r" && i === buffer.length - 1 && !done) break;
        const line = buffer.slice(cursor, i);
        if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
        cursor = i + 1;
        if (!line) {
          if (data.length) { yield data.join("\n"); data = []; }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      buffer = buffer.slice(cursor);
      if (done) {
        // An incomplete frame is not an event. In particular, a connection
        // ending halfway through the terminal record must not look complete.
        break;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
