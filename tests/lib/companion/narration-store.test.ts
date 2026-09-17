import { describe, expect, it } from "vitest";
import { createNarrationSession } from "@/lib/companion/narration-store";

/** A canned JSON error response per the companion contract ({ error }, status). */
function errorResponse(status: number, error: unknown): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A streaming text/plain response that enqueues the given strings and closes. */
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
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/** A stream that delivers one chunk and then never closes (until aborted). */
function hangingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("开始"));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/** Let the microtask queue drain so stream reads and promise chains settle. */
async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("createNarrationSession", () => {
  it("requests once per slice and serves the done entry on re-entry", async () => {
    let calls = 0;
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++;
      seenBody = JSON.parse(String(init?.body));
      return streamResponse(["那天下午，", "我们聊到很晚。"]);
    }) as typeof fetch;

    const session = createNarrationSession({ fetchImpl });
    expect(session.request("2026-09-15-0746", { locale: "zh" })).toBe(true);
    await settle();

    expect(seenBody).toEqual({
      sliceId: "2026-09-15-0746",
      event: "narrate",
      locale: "zh",
    });
    expect(session.get("2026-09-15-0746")).toEqual({
      status: "done",
      text: "那天下午，我们聊到很晚。",
    });

    // The de-dup contract: re-entering the room starts NO new request.
    expect(session.request("2026-09-15-0746", { locale: "zh" })).toBe(false);
    await settle();
    expect(calls).toBe(1);
    session.dispose();
  });

  it("notifies subscribers of growing text, completion, and stops after unsubscribe", async () => {
    const fetchImpl = (async () =>
      streamResponse(["a", "b", "c"])) as typeof fetch;
    const session = createNarrationSession({ fetchImpl });

    const seen: string[] = [];
    const unsubscribe = session.subscribe("s1", (entry) =>
      seen.push(`${entry.status}:${entry.text}`),
    );
    session.request("s1");
    await settle();

    expect(seen).toEqual([
      "pending:",
      "pending:a",
      "pending:ab",
      "pending:abc",
      "done:abc",
    ]);

    unsubscribe();
    session.request("s2");
    await settle();
    expect(seen).toHaveLength(5);
    session.dispose();
  });

  it("records a failure with its error code and allows only a forced retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? errorResponse(429, "budget_exhausted")
        : streamResponse(["再次，", "讲完了。"]);
    }) as typeof fetch;
    const session = createNarrationSession({ fetchImpl });

    expect(session.request("s1")).toBe(true);
    await settle();
    expect(session.get("s1")).toEqual({
      status: "failed",
      text: "",
      error: "budget_exhausted",
    });

    // A failed entry is NOT silently re-requested — the retry is explicit.
    expect(session.request("s1")).toBe(false);
    expect(calls).toBe(1);

    expect(session.request("s1", { force: true })).toBe(true);
    await settle();
    expect(calls).toBe(2);
    expect(session.get("s1")).toEqual({
      status: "done",
      text: "再次，讲完了。",
    });
    session.dispose();
  });

  it("keeps the partial prose when the stream is cut by the failure marker", async () => {
    const fetchImpl = (async () =>
      streamResponse([
        "说到一半",
        "\n\n[ Previously got distracted — please try again later. ]",
      ])) as typeof fetch;
    const session = createNarrationSession({ fetchImpl });

    session.request("s1");
    await settle();
    const entry = session.get("s1");
    expect(entry?.status).toBe("failed");
    expect(entry?.text).toBe("说到一半");
    expect(entry?.error).toBe("request_failed");
    session.dispose();
  });

  it("force never restarts a pending or done entry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return streamResponse(["once"]);
    }) as typeof fetch;
    const session = createNarrationSession({ fetchImpl });

    session.request("s1");
    expect(session.request("s1", { force: true })).toBe(false);
    await settle();
    expect(session.get("s1")?.status).toBe("done");
    expect(session.request("s1", { force: true })).toBe(false);
    expect(calls).toBe(1);
    session.dispose();
  });

  it("dispose aborts in-flight streams and leaves no record behind", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return hangingResponse();
    }) as typeof fetch;
    const session = createNarrationSession({ fetchImpl });

    session.request("s1");
    await settle();
    expect(session.get("s1")?.status).toBe("pending");

    session.dispose();
    await settle();
    // Aborted mid-stream: nothing was ever shown from this run, so the slice
    // may be asked for again — the abort is not a consumed request.
    expect(session.get("s1")).toBeUndefined();

    expect(session.request("s1")).toBe(true);
    expect(calls).toBe(2);
    session.dispose();
  });
});
