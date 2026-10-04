/**
 * reportToHQ — the field's one-way dispatch to HQ (v0.21 §4).
 *
 * `workflow/api` is mocked (no real hook/start); `background-steps` is
 * stubbed because tool-executors statically reaches it via question-run
 * (startLongTask, v0.21 §2) — the mock keeps its heavy graph out of this
 * test. Pins the three dispatch paths and the payload shape: prose `brief`
 * from the model, `replyToken` attached mechanically, nothing else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: h.getHookByToken,
  resumeHook: h.resumeHook,
  start: h.start,
  getRun: vi.fn(),
}));

vi.mock("@/app/api/evolution/background-steps", () => ({
  executeBoundaryRun: vi.fn(),
  executeQuestionRun: vi.fn(),
}));

import { reportToHQExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { HQ_TOKEN, hqRun } from "@/app/api/evolution/hq-run";

const ctx: ToolContext = {
  repo: "local",
  owner: "local",
  useGithub: false,
  useDemo: false,
  sliceId: "2026-10-04-0131",
  recentTurns: [],
  startedAtIso: "2026-10-04T01:31:00.000Z",
};

const BRIEF = "现场：用户问起屏幕供应商；观察：与 2026-10-04-0131 的讨论直接相关。";
const REPLY_TOKEN = "field:2026-10-04-0131:2026-10-04T01:31:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportToHQ — HQ alive", () => {
  it("advisory hit → resumeHook(HQ_TOKEN, {brief, replyToken}); start never called", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "hq-live" });
    h.resumeHook.mockResolvedValue({ runId: "hq-live" });

    const r = await reportToHQExecute({ brief: BRIEF }, { context: ctx, toolCallId: "call-1" });

    expect(r).toEqual({ ok: true, delivered: "resumed", runId: "hq-live" });
    expect(h.getHookByToken).toHaveBeenCalledWith(HQ_TOKEN);
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith(HQ_TOKEN, {
      brief: BRIEF,
      replyToken: REPLY_TOKEN,
    });
    // the model's prose is the ENTIRE model-authored content of the payload
    const payload = h.resumeHook.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["brief", "replyToken"]);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("empty brief is refused before any dispatch", async () => {
    const r = await reportToHQExecute({ brief: "   " }, { context: ctx, toolCallId: "call-1" });
    expect(r.ok).toBe(false);
    expect(h.getHookByToken).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe("reportToHQ — HQ absent (HookNotFoundError on the advisory)", () => {
  it("start(hqRun, [payload]) carries the brief; resumeHook never called", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError: no hook"));
    h.start.mockResolvedValue({ runId: "hq-fresh" });

    const r = await reportToHQExecute({ brief: BRIEF }, { context: ctx, toolCallId: "call-1" });

    expect(r).toEqual({ ok: true, delivered: "started", runId: "hq-fresh" });
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args] = h.start.mock.calls[0];
    expect(workflowFn).toBe(hqRun);
    expect(args).toHaveLength(1);
    expect(args[0]).toEqual({ brief: BRIEF, replyToken: REPLY_TOKEN });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });
});

describe("reportToHQ — resume raced with HQ exit", () => {
  it("advisory hit but resumeHook rejects → fresh start fallback", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "hq-dying" });
    h.resumeHook.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockResolvedValue({ runId: "hq-fresh" });

    const r = await reportToHQExecute({ brief: BRIEF }, { context: ctx, toolCallId: "call-1" });

    expect(r).toEqual({ ok: true, delivered: "started", runId: "hq-fresh" });
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("start itself failing → visible refusal, not a crash", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockRejectedValue(new Error("world unreachable"));

    const r = await reportToHQExecute({ brief: BRIEF }, { context: ctx, toolCallId: "call-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("HQ could not be reached");
  });
});
