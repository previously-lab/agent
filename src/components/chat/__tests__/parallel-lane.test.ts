/**
 * The batch's closing bubble (v0.40 §2.1) — the merge line seats as an
 * INDEPENDENT summary lane; 可空 = no chunk, no lane, no bubble, no
 * placeholder. Pins both states: the chunk-carrying stream seats exactly
 * one settled summary lane (replay-deduped), and a chunk-less stream
 * leaves the lanes untouched.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { upsertMergeLane, readLaneStream, type ParallelLane } from "../parallel-lane";

function laneStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function mockStreamResponse(chunks: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      body: laneStream([...chunks, { type: "finish" }]),
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upsertMergeLane — the 收合句独立泡 (v0.40 §2.1)", () => {
  it("非空: seats ONE settled summary lane carrying the merge text", () => {
    const lanes = upsertMergeLane([], "2026-10-19-1751", "更正：以饺子为准。");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({
      summary: true,
      text: "更正：以饺子为准。",
      settled: true, // the text arrives whole — the bubble never "streams"
    });
    expect(lanes[0]).not.toHaveProperty("runId"); // no run to read — it IS the text
    expect(lanes[0]!.laneId).toBe("merge-2026-10-19-1751");
  });

  it("a reconnect replay re-delivering the chunk never double-seats", () => {
    const once = upsertMergeLane([], "s1", "更正。");
    const twice = upsertMergeLane(once, "s1", "更正。");
    expect(twice).toHaveLength(1);
  });

  it("空 (可空): the lanes stay untouched when no merge was needed — no placeholder, no empty bubble", () => {
    // The chunk NEVER ARRIVES → upsertMergeLane is never called. Pin the
    // invariant its callers rely on: an untouched lane list has no summary
    // lane, and readLaneStream never invokes the merge handler on a
    // chunk-less stream (below).
    const lanes: ParallelLane[] = [
      { laneId: "main", userText: "", text: "", settled: true },
    ];
    expect(lanes.some((l) => l.summary)).toBe(false);
  });
});

describe("readLaneStream — the merge chunk on the wire", () => {
  it("a stream carrying {sliceId, text} delivers the merge line exactly once", async () => {
    mockStreamResponse([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "答案。" },
      {
        type: "data-parallel-summary",
        data: { sliceId: "2026-10-19-1751", text: "更正：以饺子为准。" },
      },
    ]);
    const onMergeLine = vi.fn();
    const text = await readLaneStream("wrun-1", {
      signal: new AbortController().signal,
      onText: vi.fn(),
      onMergeLine,
    });
    expect(text).toBe("答案。");
    expect(onMergeLine).toHaveBeenCalledTimes(1);
    expect(onMergeLine).toHaveBeenCalledWith(
      "2026-10-19-1751",
      "更正：以饺子为准。",
    );
  });

  it("a chunk-less stream (no closing needed) never invokes the merge handler", async () => {
    mockStreamResponse([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "答案。" },
    ]);
    const onMergeLine = vi.fn();
    await readLaneStream("wrun-1", {
      signal: new AbortController().signal,
      onText: vi.fn(),
      onMergeLine,
    });
    expect(onMergeLine).not.toHaveBeenCalled();
  });

  it("an EMPTY merge text is ignored (never seats an empty bubble)", async () => {
    mockStreamResponse([
      {
        type: "data-parallel-summary",
        data: { sliceId: "s1", text: "   " },
      },
    ]);
    const onMergeLine = vi.fn();
    await readLaneStream("wrun-1", {
      signal: new AbortController().signal,
      onText: vi.fn(),
      onMergeLine,
    });
    expect(onMergeLine).not.toHaveBeenCalled();
  });
});
