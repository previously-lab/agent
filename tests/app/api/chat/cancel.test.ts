import { describe, it, expect, vi, beforeEach } from "vitest";

// The workflow runtime is mocked at the api boundary — the cancel endpoint
// only ever touches getRun().status / run.cancel() / run.getReadable().
const workflowApi = vi.hoisted(() => ({
  getRun: vi.fn(),
}));
vi.mock("workflow/api", () => ({ getRun: workflowApi.getRun }));

// The origin guard is exercised in its own tests; here it always passes.
vi.mock("@/lib/security/origin-guard", () => ({ guardRequest: () => null }));

import { POST } from "@/app/api/chat/[runId]/cancel/route";

function call(runId: string) {
  return POST(new Request("http://localhost/api/chat/x/cancel", { method: "POST" }), {
    params: Promise.resolve({ runId }),
  });
}

/** A run mock whose durable stream holds exactly `chunks` (the empty default). */
function mockRun(
  status: string,
  chunks: unknown[] = [],
): {
  status: Promise<string>;
  cancel: ReturnType<typeof vi.fn>;
  getReadable: () => {
    getTailIndex: () => Promise<number>;
    getReader: () => {
      read: () => Promise<{ done: boolean; value?: unknown }>;
      cancel: () => Promise<void>;
    };
  };
} {
  return {
    status: Promise.resolve(status),
    cancel: vi.fn(async () => {}),
    getReadable: () => ({
      getTailIndex: async () => chunks.length - 1,
      getReader: () => {
        let i = 0;
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          cancel: async () => {},
        };
      },
    }),
  };
}

function bubbleChunk(
  frame: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "data-nested-bubble",
    id: `nested-bubble-${frame.turnId}`,
    transient: true,
    data: frame,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/chat/[runId]/cancel", () => {
  it("cancels a running run", async () => {
    const run = mockRun("running");
    workflowApi.getRun.mockReturnValue(run);
    const res = await call("run_1");
    expect(res.status).toBe(200);
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });

  it("cancels a pending run too", async () => {
    const run = mockRun("pending");
    workflowApi.getRun.mockReturnValue(run);
    const res = await call("run_2");
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });

  it("is a no-op on a terminal run (the stop raced the run's own completion)", async () => {
    const run = mockRun("completed");
    workflowApi.getRun.mockReturnValue(run);
    const res = await call("run_3");
    expect(run.cancel).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, cancelled: false, status: "completed" });
  });

  it("a gone run resolves as a quiet no-op, never an error", async () => {
    workflowApi.getRun.mockImplementation(() => {
      throw new Error("run not found");
    });
    const res = await call("run_4");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: false, status: "gone" });
  });

  // ── The episode cascade (v0.31): stop means stop for the children too ──

  it("cascades to every in-flight child run found on the outer stream", async () => {
    const outer = mockRun("running", [
      { type: "start" },
      bubbleChunk({ replyTo: "u1", turnId: "nu1", status: "queued" }),
      bubbleChunk({
        replyTo: "u1",
        turnId: "nu1",
        status: "running",
        runId: "child_a",
      }),
      bubbleChunk({
        replyTo: "u2",
        turnId: "nu2",
        status: "running",
        runId: "child_b",
      }),
      // A finished child: latest frame is done — its run is terminal, no cancel.
      bubbleChunk({
        replyTo: "u3",
        turnId: "nu3",
        status: "running",
        runId: "child_c",
      }),
      bubbleChunk({
        replyTo: "u3",
        turnId: "nu3",
        status: "done",
        runId: "child_c",
        text: "answer",
      }),
    ]);
    const childA = mockRun("running");
    const childB = mockRun("running");
    const childC = mockRun("completed");
    workflowApi.getRun.mockImplementation((id: string) => {
      if (id === "outer") return outer;
      if (id === "child_a") return childA;
      if (id === "child_b") return childB;
      if (id === "child_c") return childC;
      throw new Error(`unexpected run ${id}`);
    });
    const res = await call("outer");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
    expect(outer.cancel).toHaveBeenCalledOnce();
    expect(childA.cancel).toHaveBeenCalledOnce();
    expect(childB.cancel).toHaveBeenCalledOnce();
    expect(childC.cancel).not.toHaveBeenCalled();
  });

  it("a failed roster scan still cancels the outer run (the pre-cascade floor)", async () => {
    const outer = {
      status: Promise.resolve("running"),
      cancel: vi.fn(async () => {}),
      getReadable: () => {
        throw new Error("stream gone");
      },
    };
    workflowApi.getRun.mockReturnValue(outer);
    const res = await call("outer");
    expect(res.status).toBe(200);
    expect(outer.cancel).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });

  it("a child that finished mid-cancel fails its cascade quietly", async () => {
    const outer = mockRun("running", [
      bubbleChunk({
        replyTo: "u1",
        turnId: "nu1",
        status: "running",
        runId: "child_a",
      }),
    ]);
    workflowApi.getRun.mockImplementation((id: string) => {
      if (id === "outer") return outer;
      return {
        status: Promise.resolve("completed"),
        cancel: vi.fn(async () => {
          throw new Error("already terminal");
        }),
      };
    });
    const res = await call("outer");
    expect(res.status).toBe(200);
    expect(outer.cancel).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });
});
