/**
 * HQ activity stream contract (src/lib/chat/hq-stream.ts) — the frame
 * normalize, the route's pass-through filter, the client SSE reader
 * (injectable fetch, real ReadableStreams) and the localStorage stash.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearStoredHQRunId,
  createHQStreamFilter,
  HQ_ACTIVITY_CHUNK,
  HQStreamError,
  normalizeHQActivity,
  readStoredHQRunId,
  streamHQActivity,
  writeStoredHQRunId,
  type HQActivityFrame,
} from "@/lib/chat/hq-stream";

const STARTED: HQActivityFrame = {
  kind: "started",
  at: "2026-10-04T01:31:00.000Z",
};

describe("normalizeHQActivity", () => {
  it("accepts every kind and keeps only the fields that fit", () => {
    expect(normalizeHQActivity(STARTED)).toEqual(STARTED);
    expect(
      normalizeHQActivity({
        kind: "reading",
        at: "2026-10-04T01:32:00.000Z",
        sliceId: "2026-10-04-0131",
      }),
    ).toEqual({
      kind: "reading",
      at: "2026-10-04T01:32:00.000Z",
      sliceId: "2026-10-04-0131",
    });
    expect(
      normalizeHQActivity({
        kind: "wrote",
        at: "t",
        paths: ["memory/research/x/index.md", 42],
        note: "核对了现场，写下一个案件。",
      }),
    ).toEqual({
      kind: "wrote",
      at: "t",
      paths: ["memory/research/x/index.md"],
      note: "核对了现场，写下一个案件。",
    });
    expect(
      normalizeHQActivity({
        kind: "finished",
        at: "t",
        status: "idle",
        handled: 3.9,
      }),
    ).toEqual({ kind: "finished", at: "t", status: "idle", handled: 3 });
  });

  it("rejects the malformed: non-objects, unknown kinds, junk statuses", () => {
    expect(normalizeHQActivity(null)).toBeNull();
    expect(normalizeHQActivity("started")).toBeNull();
    expect(normalizeHQActivity({ kind: "speaking", at: "t" })).toBeNull();
    expect(normalizeHQActivity({ kind: "finished", at: "t", status: "running" }))
      .toEqual({ kind: "finished", at: "t" });
    // a missing clock degrades to "" rather than breaking the frame
    expect(normalizeHQActivity({ kind: "idle" })).toEqual({ kind: "idle", at: "" });
  });
});

describe("createHQStreamFilter", () => {
  it("passes ONLY data-hq-activity chunks — tool-progress telemetry stays in the run", async () => {
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ type: HQ_ACTIVITY_CHUNK, id: "a", data: STARTED });
        controller.enqueue({
          type: "data-tool-progress",
          id: "t1",
          data: { line: "readSlice" },
        });
        controller.enqueue({ type: "finish-step" });
        controller.enqueue({
          type: HQ_ACTIVITY_CHUNK,
          id: "b",
          data: { kind: "idle", at: "t" },
        });
        controller.close();
      },
    });
    const out: unknown[] = [];
    await source.pipeThrough(createHQStreamFilter()).pipeTo(
      new WritableStream({ write: (c) => void out.push(c) }),
    );
    expect(out).toEqual([
      { type: HQ_ACTIVITY_CHUNK, id: "a", data: STARTED },
      { type: HQ_ACTIVITY_CHUNK, id: "b", data: { kind: "idle", at: "t" } },
    ]);
  });
});

// ─── The client reader ────────────────────────────────────────────────────

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(e));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function sseEvent(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

describe("streamHQActivity", () => {
  it("parses frames in order, skipping other chunk types, corrupt JSON and [DONE]", async () => {
    const res = sseResponse([
      sseEvent({ type: HQ_ACTIVITY_CHUNK, id: "a", data: STARTED }),
      sseEvent({ type: "data-tool-progress", id: "t", data: {} }),
      "data: {not json\n\n",
      sseEvent({
        type: HQ_ACTIVITY_CHUNK,
        id: "b",
        data: { kind: "finished", at: "t", status: "idle", handled: 1 },
      }),
      "data: [DONE]\n\n",
    ]);
    const frames: HQActivityFrame[] = [];
    await streamHQActivity(
      { runId: "run-1", fetchImpl: vi.fn(async () => res) },
      (f) => frames.push(f),
    );
    expect(frames).toEqual([
      STARTED,
      { kind: "finished", at: "t", status: "idle", handled: 1 },
    ]);
  });

  it("survives a multibyte character split across chunk boundaries", async () => {
    const event = sseEvent({
      type: HQ_ACTIVITY_CHUNK,
      id: "a",
      data: { kind: "idle", at: "t", note: "空转——没有理由要写入。" },
    });
    const bytes = new TextEncoder().encode(event);
    // cut inside the multibyte sequence of a CJK character
    const cut = event.indexOf("空") + 1;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const frames: HQActivityFrame[] = [];
    await streamHQActivity(
      { runId: "run-1", fetchImpl: vi.fn(async () => res) },
      (f) => frames.push(f),
    );
    expect(frames).toEqual([
      { kind: "idle", at: "t", note: "空转——没有理由要写入。" },
    ]);
  });

  it("asks the right URL and surfaces 404 as not_found", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request) => new Response("nope", { status: 404 }),
    );
    const err = await streamHQActivity(
      { runId: "run with spaces", fetchImpl },
      () => {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HQStreamError);
    expect((err as HQStreamError).code).toBe("not_found");
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "/api/evolution/hq/run%20with%20spaces/stream",
    );
  });

  it("maps other non-2xx and network failures to request_failed, aborts to aborted", async () => {
    const err500 = await streamHQActivity(
      { runId: "r", fetchImpl: vi.fn(async () => new Response("x", { status: 500 })) },
      () => {},
    ).catch((e: unknown) => e);
    expect((err500 as HQStreamError).code).toBe("request_failed");
    expect((err500 as HQStreamError).status).toBe(500);

    const errNet = await streamHQActivity(
      {
        runId: "r",
        fetchImpl: vi.fn(async () => {
          throw new Error("socket hangup");
        }),
      },
      () => {},
    ).catch((e: unknown) => e);
    expect((errNet as HQStreamError).code).toBe("request_failed");

    const controller = new AbortController();
    controller.abort();
    const errAbort = await streamHQActivity(
      {
        runId: "r",
        signal: controller.signal,
        fetchImpl: vi.fn(async () => {
          throw new Error("The operation was aborted");
        }),
      },
      () => {},
    ).catch((e: unknown) => e);
    expect((errAbort as HQStreamError).code).toBe("aborted");
  });
});

// ─── The stash ────────────────────────────────────────────────────────────

describe("the HQ run id stash", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("write → read → clear round-trips", () => {
    expect(readStoredHQRunId()).toBeNull();
    writeStoredHQRunId("run-1");
    expect(readStoredHQRunId()).toBe("run-1");
    clearStoredHQRunId();
    expect(readStoredHQRunId()).toBeNull();
  });

  it("a throwing localStorage degrades to no-op (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(readStoredHQRunId()).toBeNull();
    expect(() => {
      writeStoredHQRunId("run-1");
      clearStoredHQRunId();
    }).not.toThrow();
  });
});
