import { describe, it, expect, vi, beforeEach } from "vitest";

// The workflow runtime is mocked at the api boundary — the reconnect stream
// route only ever touches getRun().status / run.returnValue / run.getReadable().
const workflowApi = vi.hoisted(() => ({
  getRun: vi.fn(),
}));
vi.mock("workflow/api", () => ({ getRun: workflowApi.getRun }));

import { GET } from "@/app/api/chat/[runId]/stream/route";

function call(runId: string) {
  return GET(new Request(`http://localhost/api/chat/${runId}/stream`), {
    params: Promise.resolve({ runId }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/chat/[runId]/stream — terminal runs", () => {
  it("a failed run emits an error turn-status frame BEFORE the finish chunk", async () => {
    workflowApi.getRun.mockReturnValue({
      status: Promise.resolve("failed"),
      returnValue: Promise.reject(
        new Error("run failed: Update is not a fast forward"),
      ),
    });
    const res = await call("r1");
    const text = await res.text();
    expect(text).toContain("data-turn-status");
    expect(text).toContain('"status":"error"');
    expect(text).toContain("please send it again");
    expect(text).toContain("Update is not a fast forward");
    expect(text.indexOf("data-turn-status")).toBeLessThan(
      text.indexOf('"type":"finish"'),
    );
  });

  it("a failed run unwraps error.cause — the client sees the rate-limit detail, not the wrapper", async () => {
    workflowApi.getRun.mockReturnValue({
      status: Promise.resolve("failed"),
      // turn-workflow's degraded path rethrows with the typed guardrail error
      // (GitHubRateLimitError) as the cause — the frame must surface THAT.
      returnValue: Promise.reject(
        new Error("run failed: flushTurnBatch exhausted", {
          cause: new Error(
            "GitHub rate limit (secondary): You have exceeded a secondary rate limit",
          ),
        }),
      ),
    });
    const res = await call("r1c");
    const text = await res.text();
    expect(text).toContain('"status":"error"');
    expect(text).toContain("secondary rate limit");
    expect(text).not.toContain("flushTurnBatch exhausted");
    expect(text.indexOf("data-turn-status")).toBeLessThan(
      text.indexOf('"type":"finish"'),
    );
  });

  it("a cancelled run says the turn was cancelled", async () => {
    workflowApi.getRun.mockReturnValue({
      status: Promise.resolve("cancelled"),
      returnValue: Promise.reject(new Error("cancelled")),
    });
    const res = await call("r2");
    const text = await res.text();
    expect(text).toContain("cancelled before it could finish");
    expect(text.indexOf("data-turn-status")).toBeLessThan(
      text.indexOf('"type":"finish"'),
    );
  });

  it.each(["dialogue-workflow//dialogueWorkflow", "dialogue-orchestrator-workflow//dialogueOrchestratorWorkflow"])(
    "follows %s when the first GET opens before the writer and the live reader stalls", async workflow => {
    vi.useFakeTimers();
    try {
      let attachments = 0;
      let tail = -1;
      let initial!: ReadableStreamDefaultController<unknown>;
      const pendingReadable = new ReadableStream<unknown>({ start(controller) { initial = controller; } });
      Object.assign(pendingReadable, { getTailIndex: async () => tail });
      const readyReadable = new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue({ type: "start", messageId: "candidate" });
          controller.enqueue({ type: "data-dialogue-source", data: { phase: "final_answer" } });
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({ type: "text-delta", id: "text", delta: "first" });
          controller.enqueue({ type: "finish" });
          controller.close();
        },
      });
      Object.assign(readyReadable, { getTailIndex: async () => tail });
      const getReadable = vi.fn(() => ++attachments === 1 ? pendingReadable : readyReadable);
      workflowApi.getRun.mockReturnValue({
        status: Promise.resolve("running"),
        workflowName: Promise.resolve(`workflow//./src/app/api/chat/${workflow}`),
        getReadable,
      });
      const res = await call("native-child");
      expect(res.headers.get("x-workflow-stream-tail-index")).toBe("-1");
      initial.enqueue({ type: "data-dialogue-lease_acquired", data: { at: "2026-11-22T13:29:23.561Z" } });
      tail = 5;
      await vi.advanceTimersByTimeAsync(1_100);
      const output = await res.text();
      expect(output).toContain("data-dialogue-source");
      expect(output).toContain("first");
      expect(getReadable).toHaveBeenNthCalledWith(2, { startIndex: 1 });
      expect(attachments).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it("suspends Actor tail checks on exit intent and resumes after native activity", async () => {
    vi.useFakeTimers();
    try {
      let wire!: ReadableStreamDefaultController<unknown>;
      const getTailIndex = vi.fn(async () => -1);
      const stream = Object.assign(new ReadableStream<unknown>({ start(controller) { wire = controller; } }), { getTailIndex });
      workflowApi.getRun.mockReturnValue({ status: Promise.resolve("running"),
        workflowName: Promise.resolve("workflow//./src/app/api/chat/dialogue-orchestrator-workflow//dialogueOrchestratorWorkflow"),
        getReadable: () => stream });
      const res = await call("actor");
      wire.enqueue({ type: "data-dialogue-exit_intent", data: { at: "2026-11-22T13:29:23.561Z" } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTailIndex).toHaveBeenCalledTimes(1);
      wire.enqueue({ type: "data-dialogue-heartbeat", data: {} });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(getTailIndex).toHaveBeenCalledTimes(2);
      wire.close();
      expect(await res.text()).toContain("data-dialogue-heartbeat");
    } finally { vi.useRealTimers(); }
  });
  it("a completed run still returns its durable stream (no terminal frame)", async () => {
    const chunks: unknown[] = [
      { type: "text-delta", id: "t1", delta: "hello" },
      { type: "finish" },
    ];
    // The workflow's readable is a real ReadableStream with a getTailIndex
    // method on it — the route pipes it through the mixed-stream transform.
    const readable = new ReadableStream<unknown>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    Object.assign(readable, {
      getTailIndex: async () => chunks.length - 1,
    });
    workflowApi.getRun.mockReturnValue({
      status: Promise.resolve("completed"),
      getReadable: () => readable,
    });
    const res = await call("r3");
    const text = await res.text();
    expect(text).toContain("hello");
    expect(text).not.toContain("data-turn-status");
    expect(res.headers.get("x-workflow-stream-tail-index")).toBe("1");
  });
});
