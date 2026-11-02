import { describe, it, expect, beforeEach, vi } from "vitest";

// The route is now a thin durable-turn launcher: parse + validate, hand off to
// startTurn (which starts the Workflow run), and stream the run back with the
// reconnect header. We mock at that seam — startTurn — so this unit test covers
// exactly the route's own responsibility, not the step/workflow machinery
// (which is exercised by steps.test.ts and, end to end, by the running app).

const mockStartTurn = vi.fn();

vi.mock("@/app/api/chat/start-turn", () => ({
  startTurn: (args: unknown) => mockStartTurn(args),
}));

vi.mock("@/lib/deepseek/generate", () => ({
  createUIMessageStreamResponse: vi.fn(
    ({ headers }: { stream: unknown; headers?: Record<string, string> }) =>
      new Response("mocked-ui-stream", {
        headers: { "Content-Type": "text/event-stream", ...(headers ?? {}) },
      })
  ),
}));

import { POST } from "@/app/api/chat/route";
import { convertToModelMessages } from "@/lib/chat/server-stream";

function createRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", Host: "localhost:3000" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartTurn.mockResolvedValue({
    runId: "wrun_test123",
    readable: new ReadableStream(),
  });
});

describe("POST /api/chat validation", () => {
  it("rejects empty messages array", async () => {
    const res = await POST(createRequest({ messages: [] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("must not be empty");
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it("rejects missing messages field", async () => {
    const res = await POST(createRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("required");
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", Host: "localhost:3000" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat durable turn", () => {
  it("normalizes the legacy content-only request before real model-message conversion", async () => {
    const response = await POST(createRequest({ messages: [{ role: "user", content: "legacy hi" }] }));
    expect(response.status).toBe(200);
    const input = mockStartTurn.mock.calls.at(-1)![0];
    expect(input.originalUserText).toBe("legacy hi");
    expect(input.messages[0].id).toBeUndefined();
    expect(await convertToModelMessages(input.messages)).toEqual([{ role: "user", content: [{ type: "text", text: "legacy hi" }] }]);
  });
  it("does not invent a message ID for a legacy request claiming staged images", async () => {
    vi.stubEnv("STORAGE", "local");
    try {
      const response = await POST(createRequest({
        messages: [{ role: "user", content: "legacy hi" }],
        stagedAttachments: [{ assetId: `img_${"a".repeat(32)}`, ordinal: 2 }],
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "message_identity" });
      expect(mockStartTurn).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("returns 200 streaming with the workflow run-id header", async () => {
    const res = await POST(
      createRequest({ messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "hello" }] }] })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("x-workflow-run-id")).toBe("wrun_test123");
    expect(mockStartTurn).toHaveBeenCalledTimes(1);
  });

  it("forwards model and timezone to startTurn (thinking/effort are pinned server-side)", async () => {
    await POST(
      createRequest({
        messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "hi" }] }],
        model: "deepseek-v4-pro",
        // thinking/effort in the body are deliberately ignored — startTurn
        // pins thinking ON at low effort regardless of the client.
        thinking: false,
        effort: "high",
        timezone: "Asia/Shanghai",
      })
    );
    const call = mockStartTurn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      model: "deepseek-v4-pro",
      timezone: "Asia/Shanghai",
    });
    expect(call.thinking).toBeUndefined();
    expect(call.effort).toBeUndefined();
  });

  it("omits optional overrides when not provided (config defaults apply downstream)", async () => {
    await POST(
      createRequest({ messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "hi" }] }] })
    );
    expect(mockStartTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        timezone: undefined,
      })
    );
  });

  it("forwards an optional machineContext block to startTurn (v0.11 §13)", async () => {
    await POST(
      createRequest({
        messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "hi" }] }],
        machineContext: "[visit-log]\n池厅(09:41)\n[/visit-log]",
      })
    );
    const call = mockStartTurn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.machineContext).toBe("[visit-log]\n池厅(09:41)\n[/visit-log]");
  });

  it("passes machineContext as undefined when absent or not a string — the default turn is unchanged", async () => {
    // Two POSTs in one test: each needs a FRESH readable (a resolved-value
    // mock would hand the second call the first call's locked stream).
    mockStartTurn.mockImplementation(() =>
      Promise.resolve({ runId: "wrun_test123", readable: new ReadableStream() })
    );
    await POST(createRequest({ messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "hi" }] }] }));
    let call = mockStartTurn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.machineContext).toBeUndefined();

    await POST(
      createRequest({
        messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "hi" }] }],
        machineContext: 42,
      })
    );
    call = mockStartTurn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.machineContext).toBeUndefined();
  });
});
