import { describe, expect, it } from "vitest";
import {
  NarrateError,
  STREAM_FAILURE_MARKERS,
  streamNarration,
  stripFailureMarker,
} from "@/lib/companion/narrate";

/** A canned JSON error response per the contract ({ error }, status). */
function errorResponse(status: number, error: unknown, json = true): Response {
  return new Response(json ? JSON.stringify({ error }) : String(error), {
    status,
    headers: {
      "Content-Type": json ? "application/json" : "text/plain; charset=utf-8",
    },
  });
}

/** A streaming text/plain response that enqueues the given strings. */
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

describe("streamNarration", () => {
  it("posts the frozen contract body and streams the accumulated text", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenInit = init;
      return streamResponse(["那片", "下午，", "我们聊到很晚。"]);
    }) as typeof fetch;

    const received: string[] = [];
    const text = await streamNarration(
      {
        sliceId: "2026-08-11-1115",
        locale: "zh",
        timezone: "Asia/Shanghai",
        fetchImpl,
      },
      (accumulated) => received.push(accumulated),
    );

    expect(text).toBe("那片下午，我们聊到很晚。");
    // The callback reports the GROWING accumulation, chunk by chunk.
    expect(received).toEqual(["那片", "那片下午，", "那片下午，我们聊到很晚。"]);
    expect(seenInit?.method).toBe("POST");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      sliceId: "2026-08-11-1115",
      event: "narrate",
      locale: "zh",
      timezone: "Asia/Shanghai",
    });
  });

  it("omits optional fields rather than sending empty ones", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenInit = init;
      return streamResponse(["ok"]);
    }) as typeof fetch;

    await streamNarration({ sliceId: "s", fetchImpl }, () => {});
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      sliceId: "s",
      event: "narrate",
    });
  });

  it("decodes a multibyte character split across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("回想过往");
    const first = bytes.slice(0, 4); // 「回」is three bytes — cut mid-character
    const rest = bytes.slice(4);
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
            controller.enqueue(rest);
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/plain" } },
      )) as typeof fetch;

    const text = await streamNarration({ sliceId: "s", fetchImpl }, () => {});
    expect(text).toBe("回想过往");
  });

  it("maps 429 to budget_exhausted with the server's message", async () => {
    const fetchImpl = (async () =>
      errorResponse(429, "budget_exhausted")) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      () => {},
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NarrateError);
    expect(err.code).toBe("budget_exhausted");
    expect(err.status).toBe(429);
    expect(err.message).toBe("budget_exhausted");
  });

  it("maps 501 to unavailable", async () => {
    const fetchImpl = (async () =>
      errorResponse(501, "bridge mode unavailable")) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      () => {},
    ).catch((e) => e);
    expect(err.code).toBe("unavailable");
    expect(err.status).toBe(501);
  });

  it("maps 400 and 403 to their own codes", async () => {
    for (const [status, code] of [
      [400, "bad_request"],
      [403, "forbidden"],
    ] as const) {
      const fetchImpl = (async () =>
        errorResponse(status, "nope")) as typeof fetch;
      const err = await streamNarration(
        { sliceId: "s", fetchImpl },
        () => {},
      ).catch((e) => e);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  it("falls back to a status-derived message when the error body is not JSON", async () => {
    const fetchImpl = (async () =>
      errorResponse(500, "boom", false)) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      () => {},
    ).catch((e) => e);
    expect(err.code).toBe("request_failed");
    expect(err.message).toContain("500");
  });

  it("maps network failure to request_failed", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      () => {},
    ).catch((e) => e);
    expect(err.code).toBe("request_failed");
    expect(err.message).toBe("fetch failed");
  });

  it("maps an abort mid-stream to aborted and cancels the reader", async () => {
    let cancelSeen = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("讲到一"));
      },
      cancel() {
        cancelSeen = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    const controller = new AbortController();
    const chunks: string[] = [];
    const promise = streamNarration(
      { sliceId: "s", signal: controller.signal, fetchImpl },
      (accumulated) => {
        chunks.push(accumulated);
        if (chunks.length === 1) controller.abort();
      },
    );
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(NarrateError);
    expect(err.code).toBe("aborted");
    expect(cancelSeen).toBe(true);
  });

  it("rejects when a success response has no body to read", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 200 })) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      () => {},
    ).catch((e) => e);
    expect(err.code).toBe("request_failed");
  });
});

describe("stream failure marker", () => {
  const ZH_MARKER = STREAM_FAILURE_MARKERS[0];
  const EN_MARKER = STREAM_FAILURE_MARKERS[1];

  it("stripFailureMarker cuts at the marker and reports failure", () => {
    expect(stripFailureMarker(`前半段${ZH_MARKER}`)).toEqual({
      text: "前半段",
      failed: true,
    });
    // Anything after the marker is signalling, not prose.
    expect(stripFailureMarker(`前半段${EN_MARKER} trailing`)).toEqual({
      text: "前半段",
      failed: true,
    });
    expect(stripFailureMarker("clean prose, no marker")).toEqual({
      text: "clean prose, no marker",
      failed: false,
    });
  });

  it("flags a stream that ends with the zh marker, keeping the prose before it", async () => {
    const received: string[] = [];
    const fetchImpl = (async () =>
      streamResponse(["讲到一半，", "话还没说完", ZH_MARKER])) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", locale: "zh", fetchImpl },
      (accumulated) => received.push(accumulated),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NarrateError);
    expect(err.code).toBe("request_failed");
    // The last reported text is the stripped partial prose — the marker
    // never reaches the display layer.
    expect(received.at(-1)).toBe("讲到一半，话还没说完");
  });

  it("flags the en marker too", async () => {
    const fetchImpl = (async () =>
      streamResponse(["Half a tale", EN_MARKER])) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", locale: "en", fetchImpl },
      () => {},
    ).catch((e) => e);
    expect(err.code).toBe("request_failed");
  });

  it("treats a clean stream as complete even with marker-like prose", async () => {
    const near = "It wrote [ Previously 暂时走神了 and continued"; // no closing bracket
    const fetchImpl = (async () => streamResponse([near])) as typeof fetch;
    const text = await streamNarration({ sliceId: "s", fetchImpl }, () => {});
    expect(text).toBe(near);
  });

  it("detects the marker split across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode(EN_MARKER);
    const split1 = new TextDecoder().decode(bytes.slice(0, 12));
    const split2 = new TextDecoder().decode(bytes.slice(12));
    const received: string[] = [];
    const fetchImpl = (async () =>
      streamResponse(["Some prose…", split1, split2])) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      (accumulated) => received.push(accumulated),
    ).catch((e) => e);
    expect(err.code).toBe("request_failed");
    expect(received.at(-1)).toBe("Some prose…");
  });

  it("flags a stream whose only content is the marker (no prose at all)", async () => {
    const received: string[] = [];
    const fetchImpl = (async () => streamResponse([ZH_MARKER])) as typeof fetch;
    const err = await streamNarration(
      { sliceId: "s", fetchImpl },
      (accumulated) => received.push(accumulated),
    ).catch((e) => e);
    expect(err.code).toBe("request_failed");
    // The callback reported the stripped (empty) text once.
    expect(received.at(-1)).toBe("");
  });
});
