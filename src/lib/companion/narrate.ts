/**
 * The mouth stream — client half of POST /api/companion ("narrate" event).
 *
 * Frozen contract with the endpoint (built in parallel):
 *   request:  { sliceId, event: "narrate", locale?, timezone? }
 *   success:  text/plain; charset=utf-8 — incremental narration prose,
 *             read here with response.body.getReader() + TextDecoder
 *   errors:   JSON { error: string } with 400 / 403 / 429 (budget_exhausted)
 *             / 501 (bridge mode unavailable)
 *
 * This module is deliberately DOM-free (fetch + TextDecoder only) so the
 * whole contract — chunk accumulation, UTF-8 split across chunk boundaries,
 * abort semantics, status→code mapping — is unit-testable under vitest's
 * node environment. The fetch implementation is injectable for the same
 * reason.
 */

/** Stable error codes the UI maps to localized copy. */
export type NarrateErrorCode =
  | "bad_request"
  | "forbidden"
  | "budget_exhausted"
  | "unavailable"
  | "request_failed"
  | "aborted";

export class NarrateError extends Error {
  readonly code: NarrateErrorCode;
  /** The HTTP status when there was one (absent for network/abort). */
  readonly status?: number;

  constructor(code: NarrateErrorCode, message: string, status?: number) {
    super(message);
    this.name = "NarrateError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface NarrateInput {
  sliceId: string;
  locale?: string;
  timezone?: string;
  signal?: AbortSignal;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function codeForStatus(status: number): NarrateErrorCode {
  // 429 carries `budget_exhausted`, 501 means the bridge brain cannot
  // narrate; 400/403 are caller/config problems. Everything else unexpected
  // degrades to the generic code.
  switch (status) {
    case 400:
      return "bad_request";
    case 403:
      return "forbidden";
    case 429:
      return "budget_exhausted";
    case 501:
      return "unavailable";
    default:
      return "request_failed";
  }
}

function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && e instanceof DOMException &&
      e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

/**
 * POST /api/companion and stream the narration, reporting the ACCUMULATED
 * text after every chunk (the caller holds it as one string of state).
 * Rejects with NarrateError on HTTP errors, network failure or abort; the
 * reader is always released, and cancelled when the stream did not finish,
 * so an aborted narration never holds the connection open.
 */
export async function streamNarration(
  input: NarrateInput,
  onChunk: (accumulated: string) => void,
): Promise<string> {
  const { sliceId, locale, timezone, signal } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl("/api/companion", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/plain; charset=utf-8",
      },
      body: JSON.stringify({
        sliceId,
        event: "narrate",
        ...(locale ? { locale } : {}),
        ...(timezone ? { timezone } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) {
      throw new NarrateError("aborted", "narration aborted");
    }
    throw new NarrateError(
      "request_failed",
      e instanceof Error ? e.message : String(e),
    );
  }

  if (!res.ok) {
    // Errors are JSON { error }. Read the server's message when it parses;
    // a malformed/absent body must not mask the status.
    let message: string | null = null;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data?.error === "string" && data.error) message = data.error;
    } catch {
      // Non-JSON error body — fall through to the status-derived message.
    }
    throw new NarrateError(
      codeForStatus(res.status),
      message ?? `companion request failed (${res.status})`,
      res.status,
    );
  }

  if (!res.body) {
    throw new NarrateError(
      "request_failed",
      "companion response carried no body",
      res.status,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Abort must interrupt a pending read even where the body never sees the
  // signal (stalled or mocked streams): race every read against it. A real
  // fetch also rejects on abort, which lands in the same catch below.
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    const fail = () =>
      reject(new DOMException("The narration was aborted", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  let text = "";
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      // stream:true keeps a multibyte character split across chunk
      // boundaries buffered until its remaining bytes arrive.
      text += decoder.decode(value, { stream: true });
      onChunk(text);
    }
    // Flush any bytes the decoder was still holding — only a flush that
    // actually adds text needs another callback.
    const tail = decoder.decode();
    if (tail) {
      text += tail;
      onChunk(text);
    }
    return text;
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) {
      throw new NarrateError("aborted", "narration aborted");
    }
    throw new NarrateError(
      "request_failed",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    // An unfinished stream (abort, error) must not keep the response
    // connection alive; after a clean `done` the cancel is a no-op. When the
    // abort came through the signal the fetch layer already tore the
    // connection down, so a rejection here is fine too.
    try {
      await reader.cancel();
    } catch {
      // already released / already closed
    }
    reader.releaseLock();
  }
}
