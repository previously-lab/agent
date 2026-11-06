import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptDialogueArgs } from "@/app/api/chat/dialogue/accept";

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  confirm: vi.fn(async () => {}),
  release: vi.fn(),
}));

vi.mock("@/lib/dialogue/runtime", () => ({
  resolveDialogueScope: () => "scope-1",
  dialogueResponseError: (error: unknown) => Response.json({ error: String(error) }, { status: 503 }),
}));
vi.mock("@/app/api/chat/start-turn", () => ({
  prepareTurnInput: h.prepare,
  startPreparedTurn: h.start,
}));

import { acceptDialogueTurnV2 } from "@/app/api/chat/dialogue/accept";

describe("native dialogue acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prepare.mockResolvedValue({
      clientMessageId: "message-1",
      lastUserMessage: "Think now.",
      startedAtIso: "2026-11-07T00:00:00.000Z",
      modelMessages: [{ role: "user", content: "browser history" }],
      recentTurns: [{ role: "user", content: "browser history" }],
      turnId: "provisional",
      config: { slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 } },
    });
    h.start.mockImplementation(async (input) => {
      expect(input.dialogue.transport).toBe("workflow-v2");
      return { runId: "wrun_01JTESTPARENT0000000000000" };
    });
  });

  it("starts the thinking parent directly and returns only native recovery targets", async () => {
    const response = await acceptDialogueTurnV2({
      messages: [], verifiedImages: [], persona: "user", regenerate: false,
      reservation: { confirm: h.confirm, release: h.release },
    } as unknown as AcceptDialogueArgs);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      version: 2,
      parentRunId: "wrun_01JTESTPARENT0000000000000",
      sourceInputId: body.workId,
      offersUrl: "/api/chat/wrun_01JTESTPARENT0000000000000/offers",
    });
    expect(body.thoughtsUrl).toContain("/thoughts?workId=");
    const launch = h.start.mock.calls[0]![0];
    expect(launch.turnId).toBe(body.sourceInputId);
    expect(launch.modelMessages).toEqual([{ role: "user", content: "browser history" }]);
    expect(launch.recentTurns).toEqual([{ role: "user", content: "browser history" }]);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
  });
});