/**
 * Tests for the first-byte timeout fetch wrapper — the bounded-hang
 * mechanism behind fix (c): agent.stream() cannot carry a timeout (the
 * workflow VM has no AbortSignal global), so the deadline lives at the
 * provider fetch boundary, INSIDE the step, where real timers are safe.
 */
import { describe, it, expect } from "vitest";
import {
  withFirstByteTimeout,
  MODEL_FIRST_BYTE_TIMEOUT_MS,
  ModelFirstByteTimeoutError,
} from "@/lib/models/fetch-timeout";
import { classifyWorkflowError } from "@/lib/chat/workflow-errors";

/** A fetch that never settles unless its signal aborts (hung-connect shape). */
const hungFetch: typeof fetch = (input, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(init.signal?.reason),
      { once: true },
    );
  });

/** A fetch that resolves headers immediately, then stalls the body forever —
 * emulating spec-compliant fetch: aborting the signal errors the body with
 * the abort reason (verified against real undici). */
const stalledBodyFetch: typeof fetch = (input, init) =>
  Promise.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason),
            { once: true },
          );
        },
      }),
    ),
  );

function streamResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
  );
}

describe("withFirstByteTimeout", () => {
  it("exports a 120s production deadline (well inside the 300s platform wall)", () => {
    expect(MODEL_FIRST_BYTE_TIMEOUT_MS).toBe(120_000);
  });

  it("passes the response through when the body arrives in time", async () => {
    const wrapped = withFirstByteTimeout(
      async () => streamResponse(["hello ", "world"]),
      5_000,
    );
    const res = await wrapped("https://api.example.com/v1/chat");
    expect(await res.text()).toBe("hello world");
    expect(res.status).toBe(200);
  });

  it("aborts a hung request at the deadline with an error that classifies as timeout", async () => {
    const wrapped = withFirstByteTimeout(hungFetch, 50);
    const err = await wrapped("https://api.example.com/v1/chat").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ModelFirstByteTimeoutError);
    expect((err as Error).name).toBe("TimeoutError");
    // The production contract: the thrown error lands in the EXISTING timeout
    // continuation path of the chat turn.
    expect(classifyWorkflowError(err).kind).toBe("timeout");
  });

  it("aborts a headers-then-stalled-body response at the deadline (classifies as timeout)", async () => {
    const wrapped = withFirstByteTimeout(stalledBodyFetch, 50);
    const res = await wrapped("https://api.example.com/v1/chat");
    const err = await res.text().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ModelFirstByteTimeoutError);
    expect(classifyWorkflowError(err).kind).toBe("timeout");
  });

  it("disarms the deadline once the first chunk has arrived", async () => {
    // First chunk arrives immediately; the rest of the stream stays open far
    // past the (short) deadline — reading must succeed, not time out.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        // Deliberately never closes within the test window.
      },
    });
    const wrapped = withFirstByteTimeout(async () => new Response(body), 50);
    const res = await wrapped("https://api.example.com/v1/chat");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("first");
  });

  it("forwards an upstream abort signal to the underlying fetch", async () => {
    const seen: AbortSignal[] = [];
    const wrapped = withFirstByteTimeout(
      ((input, init) => {
        seen.push(init!.signal!);
        return hungFetch(input, init);
      }) as typeof fetch,
      5_000,
    );
    const controller = new AbortController();
    const reason = new Error("client cancelled");
    const promise = wrapped("https://api.example.com/v1/chat", {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(seen[0].aborted).toBe(true);
  });

  it("rethrows underlying fetch errors unchanged (non-timeout failures untouched)", async () => {
    const boom = Object.assign(new Error("ECONNRESET socket hang up"), {
      code: "ECONNRESET",
    });
    const wrapped = withFirstByteTimeout(
      (async () => {
        throw boom;
      }) as typeof fetch,
      5_000,
    );
    await expect(wrapped("https://x.example")).rejects.toBe(boom);
  });

  it("error message carries the literal word 'timeout' for the regex fallback", () => {
    const e = new ModelFirstByteTimeoutError(120_000);
    expect(e.message).toContain("timeout");
    // Even a name-stripped copy classifies as timeout via TIMEOUT_RE.
    const dehydrated = new Error(e.message);
    expect(classifyWorkflowError(dehydrated).kind).toBe("timeout");
  });
});
