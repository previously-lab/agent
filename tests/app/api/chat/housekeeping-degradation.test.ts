import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TurnInput, TurnOutcome } from "@/lib/chat/turn-types";

/**
 * D 批 degradation path: when the housekeeping step fails (after its own
 * bounded flush retries — covered in steps.test.ts), the workflow must end
 * the turn WITH a visible error terminal frame (closeTurnStream's shape) and
 * still record the run as failed — not die on a bare finish.
 *
 * The steps module is mocked at its boundary: housekeeping rejects, and
 * closeTurnStream is a recording spy. Everything else in the module graph is
 * real (the same import-without-mocks pattern as timeout-continuation.test.ts).
 */
const stepsMock = vi.hoisted(() => ({
  housekeeping: vi.fn(),
  closeTurnStream: vi.fn(
    async (_outcome: TurnOutcome, _turnId: string): Promise<void> => {},
  ),
}));

vi.mock("@/app/api/chat/steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/chat/steps")>()),
  housekeeping: stepsMock.housekeeping,
  closeTurnStream: stepsMock.closeTurnStream,
}));

import { turnWorkflow } from "@/app/api/chat/turn-workflow";

function makeInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    modelMessages: [],
    recentTurns: [],
    lastUserMessage: "hi",
    model: "deepseek-v4-flash",
    modelConfig: {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
      sdk: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      capabilities: { thinking: true, vision: false, maxTokens: 393216 },
      defaultThinking: false,
      defaultEffort: "low",
    },
    thinking: true,
    reasoningEffort: "low",
    clientTimezone: "UTC",
    locale: "en",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 40, idleGapMinutes: 15 },
      model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "low" },
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-07-14T10:00:00.000Z",
    turnId: "test-id",
    imageAttachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("turnWorkflow — housekeeping failure degradation (D)", () => {
  it("a housekeeping failure (conflict-shaped, its retries exhausted) ends the turn with an error frame, then fails the run", async () => {
    const hkError = Object.assign(new Error("Update is not a fast forward"), {
      status: 422,
    });
    stepsMock.housekeeping.mockRejectedValue(hkError);

    await expect(turnWorkflow(makeInput())).rejects.toThrow(
      "not a fast forward",
    );

    expect(stepsMock.closeTurnStream).toHaveBeenCalledOnce();
    const [outcome, turnId] = stepsMock.closeTurnStream.mock.calls[0];
    expect(turnId).toBe("test-id");
    expect(outcome.finishReason).toBe("error");
    expect(outcome.text).toBe("");
    expect(outcome.error).toContain("Your message was not saved");
    expect(outcome.error).toContain("not a fast forward");
  });

  it("a NON-conflict housekeeping failure takes the same degradation path", async () => {
    stepsMock.housekeeping.mockRejectedValue(
      new Error("GitHub read timed out after 15000ms"),
    );

    await expect(turnWorkflow(makeInput())).rejects.toThrow(
      "GitHub read timed out",
    );

    expect(stepsMock.closeTurnStream).toHaveBeenCalledOnce();
    const [outcome] = stepsMock.closeTurnStream.mock.calls[0];
    expect(outcome.finishReason).toBe("error");
    expect(outcome.error).toContain("Your message was not saved");
  });

  it("the frame write is best-effort: a broken stream does not mask the original failure", async () => {
    const hkError = new Error("housekeeping boom");
    stepsMock.housekeeping.mockRejectedValue(hkError);
    stepsMock.closeTurnStream.mockRejectedValueOnce(new Error("stream gone"));

    await expect(turnWorkflow(makeInput())).rejects.toThrow(
      "housekeeping boom",
    );
    expect(stepsMock.closeTurnStream).toHaveBeenCalledOnce();
  });
});
