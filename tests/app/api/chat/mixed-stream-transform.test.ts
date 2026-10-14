import { describe, it, expect } from "vitest";
import { createMixedStreamTransform } from "@/app/api/chat/mixed-stream-transform";

// The transform guards a subtle boundary: raw model parts written by
// WorkflowAgent SHARE type strings with UIMessageChunks but use different
// fields (text vs delta, id vs toolCallId). Only chunks our own steps write
// may pass through untouched; everything else must be converted.

async function through(chunks: unknown[]): Promise<unknown[]> {
  const t = createMixedStreamTransform();
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const out: unknown[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for (const c of chunks) await writer.write(c);
  await writer.close();
  await pump;
  return out;
}

describe("createMixedStreamTransform", () => {
  it("converts raw reasoning-delta parts (text → delta)", async () => {
    const out = await through([
      { type: "reasoning-delta", id: "reasoning-0", text: "The" },
    ]);
    expect(out).toEqual([
      { type: "reasoning-delta", id: "reasoning-0", delta: "The" },
    ]);
  });

  it("converts raw text-delta parts (text → delta)", async () => {
    const out = await through([{ type: "text-delta", id: "1", text: "Hi" }]);
    expect(out).toEqual([{ type: "text-delta", id: "1", delta: "Hi" }]);
  });

  it("converts raw tool-input-start parts (id → toolCallId)", async () => {
    const out = await through([
      { type: "tool-input-start", id: "call_1", toolName: "readSlice" },
    ]);
    expect(out).toEqual([
      {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "readSlice",
      },
    ]);
  });

  it("converts raw tool-result parts to tool-output-available", async () => {
    const out = await through([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "readSlice",
        input: { path: "memory/x.md" },
        output: "contents",
      },
    ]);
    expect(out).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "contents",
      },
    ]);
  });

  it("passes our lifecycle and data chunks through unchanged", async () => {
    const chunks = [
      { type: "start" },
      { type: "start-step" },
      { type: "data-belief", data: { summaries: ["+ 注意到…"] } },
      { type: "finish-step" },
      { type: "finish" },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("passes data-tool-progress chunks through unchanged", async () => {
    const chunks = [
      {
        type: "data-tool-progress",
        id: "tool-call_1",
        data: {
          toolCallId: "call_1",
          toolName: "thinkDeep",
          text: "Conclusion: the claim holds…",
        },
      },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("passes data-recall-references chunks through unchanged (v0.10 §4.1)", async () => {
    const chunks = [
      {
        type: "data-recall-references",
        id: "recall-refs-call_1",
        data: { references: [{ slice_id: "2026-08-01-1000", note: "backs it" }] },
      },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("passes data-nested-bubble frames through unchanged, transient flag intact (v0.30 §4.2)", async () => {
    // The episode's side-channel frames: the transient flag is what keeps them
    // out of UIMessage parts downstream (onData only), so the pass-through
    // must preserve it verbatim.
    const chunks = [
      {
        type: "data-nested-bubble",
        id: "nested-bubble-nu2",
        transient: true,
        data: { replyTo: "u2", turnId: "nu2", status: "queued" },
      },
      {
        type: "data-nested-bubble",
        id: "nested-bubble-nu2",
        transient: true,
        data: {
          replyTo: "u2",
          turnId: "nu2",
          status: "done",
          text: "answer",
          doneAt: "2026-08-11T12:01:00.000Z",
        },
      },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("passes the batch-summary spawn chunk through unchanged (v0.33 §3)", async () => {
    // Regression: the chunk shipped WITHOUT this allowlist entry and was
    // silently dropped on both the POST and reconnect paths — the summary
    // lane could never mount. It rides the last finisher's stream to the
    // client's onData / lane readers only, never UIMessage parts.
    const chunks = [
      {
        type: "data-parallel-summary",
        id: "parallel-summary-2026-10-14-1913",
        transient: true,
        data: { runId: "wrun_summary", sliceId: "2026-10-14-1913" },
      },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("passes step-written text-delta chunks (delta field) through unchanged (v0.33 §4)", async () => {
    // The batch summary's step writes UIMessageChunk-shaped deltas straight
    // into its run stream. The converter only understands the RAW model-part
    // shape (text field) and would re-map these to `delta: undefined` — an
    // empty lane. Shape discrimination mirrors the `finish` rule.
    const chunks = [
      { type: "text-start", id: "summary" },
      { type: "text-delta", id: "summary", delta: "这一轮连发" },
      { type: "text-end", id: "summary" },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("still converts RAW text-delta parts (text field) — the discrimination does not misfire", async () => {
    const out = await through([{ type: "text-delta", id: "1", text: "Hi" }]);
    expect(out).toEqual([{ type: "text-delta", id: "1", delta: "Hi" }]);
  });

  it("drops a raw model finish part (our steps own the finish chunk)", async () => {
    const out = await through([
      { type: "finish", finishReason: "stop", usage: { totalTokens: 3 } },
    ]);
    expect(out).toEqual([]);
  });

  it("drops model-call envelope parts", async () => {
    const out = await through([
      { type: "model-call-start", warnings: [] },
      {
        type: "model-call-end",
        finishReason: "stop",
        usage: { totalTokens: 3 },
      },
      { type: "model-call-response-metadata", id: "x" },
    ]);
    expect(out).toEqual([]);
  });
});
