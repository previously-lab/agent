/**
 * First-byte timeout fetch wrapper for provider model calls.
 *
 * Why this mechanism: the chat turn's `agent.stream()` cannot carry a timeout
 * — the workflow sandbox VM provisions no `AbortSignal` global, so the AI
 * SDK's `timeout` stream option crashes every turn (see the agent NOTE in
 * turn-workflow.ts), and `AbortSignal.timeout()` is explicitly blocked inside
 * workflow functions. The provider factories DO accept a custom `fetch`, and
 * that fetch runs INSIDE the step in ordinary Node compute, where real timers
 * are safe — so the deadline lives here, at the HTTP boundary.
 *
 * Semantics: a per-request deadline on the FIRST response-body chunk. A
 * provider that takes the connection but never answers (the outage shape —
 * hung socket, or response headers followed by a stalled SSE body) aborts at
 * the deadline. The abort reason is an error named "TimeoutError", which the
 * AI SDK passes through unwrapped (provider-utils treats that name as
 * abort-class) and `classifyWorkflowError` maps to the `timeout` continuation
 * path. Once the first chunk arrives the deadline disarms: legitimately long
 * generations stream continuously and stay bounded by the platform step wall,
 * not by this timer. Total worst-case burn per timed-out call is the deadline
 * plus the step runtime's own retry budget.
 */

/** First-byte deadline for provider model calls (120s — well inside the 300s platform step wall). */
export const MODEL_FIRST_BYTE_TIMEOUT_MS = 120_000;

/**
 * Error thrown (as the abort reason) when the deadline fires. The NAME is the
 * contract: provider-utils' `isAbortError` passes "TimeoutError"-named errors
 * through unwrapped, and the workflow error classifier maps that name to the
 * `timeout` kind. The message also carries the literal word "timeout" so the
 * message-regex fallback classifies a dehydrated copy the same way.
 */
export class ModelFirstByteTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Model request timeout: no response bytes within ${Math.round(timeoutMs / 1000)}s`,
    );
    this.name = "TimeoutError";
  }
}

/**
 * Wrap a fetch implementation with a per-request first-byte deadline.
 * Stateless apart from the per-call state — safe to share across calls.
 */
export function withFirstByteTimeout(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    // Compose with any upstream signal (the SDK passes its own abortSignal):
    // an upstream abort cancels the underlying request with the same reason.
    const upstream = init?.signal ?? null;
    const onUpstreamAbort = () => controller.abort(upstream?.reason);
    if (upstream) {
      if (upstream.aborted) onUpstreamAbort();
      else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
    // Arm before the request starts so a connect-level hang is covered too.
    const timer = setTimeout(() => {
      controller.abort(new ModelFirstByteTimeoutError(timeoutMs));
    }, timeoutMs);
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      if (!response.body) {
        // Bodyless response (204/304/HEAD) — nothing can stall.
        clearTimeout(timer);
        return response;
      }
      // Wrap the body so the deadline disarms on the first chunk: headers can
      // arrive while the SSE body still hangs (the provider-outage shape).
      const reader = response.body.getReader();
      const wrapped = new ReadableStream<Uint8Array>({
        async start(streamController) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              clearTimeout(timer); // first chunk — idempotent after that
              streamController.enqueue(value);
            }
            streamController.close();
          } catch (err) {
            clearTimeout(timer);
            streamController.error(err);
          } finally {
            reader.releaseLock();
          }
        },
        cancel(reason) {
          clearTimeout(timer);
          return reader.cancel(reason);
        },
      });
      return new Response(wrapped, response);
    } catch (err) {
      clearTimeout(timer);
      throw err;
    } finally {
      if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
    }
  };
}
