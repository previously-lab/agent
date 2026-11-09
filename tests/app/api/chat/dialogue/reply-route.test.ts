import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRunResult } from "@/lib/chat/turn-types";

const h = vi.hoisted(() => ({
  getRun: vi.fn(),
  start: vi.fn(),
  list: vi.fn(),
  status: "completed",
}));

vi.mock("workflow/api", () => ({ getRun: h.getRun, start: h.start }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.list } }) }));
vi.mock("@/lib/security/origin-guard", () => ({ guardRequest: () => null }));
vi.mock("@/app/api/chat/dialogue-workflow", () => ({ dialogueWorkflow: vi.fn() }));
vi.mock("@/app/api/chat/mixed-stream-transform", () => ({
  createMixedStreamTransform: () => new TransformStream(),
}));
vi.mock("@/lib/chat/server-stream", () => ({
  createUIMessageStreamResponse: ({ stream, headers }: { stream: ReadableStream; headers?: HeadersInit }) =>
    new Response(stream, { headers }),
}));

import { POST } from "@/app/api/chat/dialogue/reply/route";

const thoughtRunId = "wrun_01JTESTPARENT0000000000000";
const replyRunId = "wrun_01JTESTREPLY00000000000000";
const work: NonNullable<TurnRunResult["dialogueWork"]> = {
  workId: "work-1",
  scopeKey: "scope-1",
  text: "server-owned private result",
  product: {
    version: 1,
    inputScope: { scopeKey: "scope-1", workId: "work-1", inputIds: ["input-1"] },
    sourceRevision: null, asOf: "2026-11-07T00:00:00.000Z", status: "complete",
    claims: [], readSet: [], dependencies: [], openQuestions: [],
  },
  producerRunId: thoughtRunId,
  source: {
    inputId: "input-1", clientMessageId: "message-1", userSeq: 1, eventSeq: 1,
    acceptedAt: "2026-11-07T00:00:00.000Z", text: "current question",
  },
  sourceTurnId: "input-1",
  locale: "zh",
  record: {
    useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC",
    slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 },
  },
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/chat/dialogue/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/dialogue/reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.status = "completed";
    h.list.mockResolvedValue({ data: [] });
    h.getRun.mockReturnValue({
      status: Promise.resolve(h.status),
      returnValue: Promise.resolve({ dialogueWork: work }),
    });
    h.start.mockResolvedValue({
      runId: replyRunId,
      readable: new ReadableStream({ start(controller) { controller.close(); } }),
    });
  });

  it("starts a direct final from the server result and projects only public text history", async () => {
    const response = await POST(request({
      thoughtRunId,
      workId: "work-1",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "earlier question" }] },
        { id: "a1", role: "assistant", parts: [
          { type: "reasoning", text: "private reasoning" },
          { type: "tool-search", toolCallId: "call", state: "output-available", output: "private tool output" },
          { type: "data-private", data: { text: "private data" } },
          { type: "text", text: "earlier public answer" },
        ] },
        { id: "s1", role: "system", parts: [{ type: "text", text: "private system text" }] },
        { id: "u2", role: "user", parts: [{ type: "text", text: "current question" }] },
      ],
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-workflow-run-id")).toBe(replyRunId);
    const input = h.start.mock.calls[0]![1][0];
    expect(input).toMatchObject({
      offerId: "work-1:direct",
      publicSeq: 1,
      direct: true,
      stage: "final",
      text: "server-owned private result",
      context: {
        parentRunId: thoughtRunId,
        workId: "work-1",
        sourceInputId: "input-1",
        sourceTurnId: "input-1",
        source: work.source,
        priorContext: [
          { role: "user", text: "earlier question" },
          { role: "assistant", text: "earlier public answer" },
        ],
        locale: "zh",
        record: work.record,
      },
    });
    expect(JSON.stringify(input.context.priorContext)).not.toContain("private");
    expect(h.start.mock.calls[0]![2]).toEqual({
      region: "hkg1",
      attributes: { role: "dialogue", parent: thoughtRunId, work: "work-1", offer: "work-1:direct", scope: "scope-1" },
    });
  });

  it("uses the server terminal report for a user blocker without client work text", async () => {
    const report = { needsUser: { kind: "missing_information" as const, detail: "需要确认预算上限" } };
    h.getRun.mockReturnValue({
      status: Promise.resolve("completed"),
      returnValue: Promise.resolve({ dialogueWork: { ...work, text: "", report } }),
    });
    const response = await POST(request({ thoughtRunId, workId: "work-1", messages: [] }));
    expect(response.status).toBe(200);
    expect(h.start.mock.calls[0]![1][0]).toMatchObject({
      text: "",
      event: { kind: "needs_user", needsUser: report.needsUser },
    });
  });

  it("does not start a reply before the thought run completes", async () => {
    h.getRun.mockReturnValue({ status: Promise.resolve("running") });
    const response = await POST(request({ thoughtRunId, workId: "work-1", messages: [] }));
    expect(response.status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("rejects a work id that does not belong to the thought result", async () => {
    const response = await POST(request({ thoughtRunId, workId: "other-work", messages: [] }));
    expect(response.status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("reuses an existing public run from the registry instead of starting a duplicate", async () => {
    h.list.mockResolvedValue({ data: [{ runId: replyRunId, attributes: {
      role: "dialogue", work: "work-1", offer: "work-1:direct", scope: "scope-1",
    } }] });
    h.getRun.mockImplementation((runId: string) => runId === replyRunId
      ? { runId, readable: new ReadableStream({ start(controller) { controller.close(); } }) }
      : { status: Promise.resolve("completed"), returnValue: Promise.resolve({ dialogueWork: work }) });
    const response = await POST(request({ thoughtRunId, workId: "work-1", messages: [] }));
    expect(response.headers.get("x-workflow-run-id")).toBe(replyRunId);
    expect(h.start).not.toHaveBeenCalled();
  });
});
