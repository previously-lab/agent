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
