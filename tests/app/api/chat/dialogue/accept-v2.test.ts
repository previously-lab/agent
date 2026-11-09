import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptDialogueArgs } from "@/app/api/chat/dialogue/accept";

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  accept: vi.fn(),
  confirm: vi.fn(async () => {}),
  release: vi.fn(),
  dispatch: vi.fn(async () => {}),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/dialogue/runtime", () => ({
  resolveDialogueScope: () => "scope-1",
  getDialogueStore: async () => ({ accept: h.accept, regenerate: vi.fn() }),
  dialogueResponseError: (error: unknown) => Response.json({ error: String(error) }, { status: 503 }),
}));
vi.mock("@/app/api/chat/start-turn", () => ({
  prepareTurnInput: h.prepare,
  startPreparedTurn: h.start,
}));
vi.mock("@/app/api/chat/dialogue/dispatch-host", () => ({
  ensureDialogueDispatch: vi.fn(),
  dispatchDialogueDueScopes: h.dispatch,
}));

import { acceptDialogueTurnV2 } from "@/app/api/chat/dialogue/accept";

function args(overrides: Partial<AcceptDialogueArgs> = {}): AcceptDialogueArgs {
  return {
    messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "Think now." }] }],
    verifiedImages: [], persona: "user", regenerate: false,
    reservation: { confirm: h.confirm, release: h.release },
    ...overrides,
  } as AcceptDialogueArgs;
}

describe("native dialogue acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prepare.mockImplementation(async (preparedArgs: AcceptDialogueArgs) => ({
      clientMessageId: "message-1",
      lastUserMessage: "Think now.",
      startedAtIso: "2026-11-07T00:00:00.000Z",
      modelMessages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "public answer" },
        { role: "user", content: "current input" },
      ],
      recentTurns: [{ role: "user", content: "current input" }],
      turnId: "provisional",
      config: { slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 } },
      ...(preparedArgs.verifiedImages?.length ? { verifiedImages: preparedArgs.verifiedImages } : {}),
    }));
    h.start.mockResolvedValue({ runId: "wrun_01JTESTPARENT0000000000000" });
  });

  it("starts the native thought run directly without the shared store", async () => {
    const response = await acceptDialogueTurnV2(args());
    expect(response.status).toBe(200);
    const accepted = await response.json();
    expect(accepted).toMatchObject({
      version: 2,
      parentRunId: "wrun_01JTESTPARENT0000000000000",
      runId: "wrun_01JTESTPARENT0000000000000",
      workId: accepted.sourceInputId,
      input: {
        inputId: accepted.sourceInputId,
        clientMessageId: "message-1",
        text: "Think now.",
      },
      offersUrl: "/api/chat/wrun_01JTESTPARENT0000000000000/offers",
      thoughtsUrl: expect.stringContaining("namespace=dialogue-thinking-v2"),
    });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      turnId: accepted.sourceInputId,
      dialogue: {
        scopeKey: "scope-1",
        workId: accepted.workId,
        sourceInputId: accepted.sourceInputId,
        transport: "workflow-v2",
      },
    }));
    const launch = h.start.mock.calls[0]![0];
    expect(launch.modelMessages).toHaveLength(3);
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("passes server-verified image bytes and the vision-tool mapping to the native run", async () => {
    const snapshot = { version: 1 as const, assetId: `img_${"a".repeat(32)}`, ref: "drafts/image", ordinal: 1, name: "sample.png", mediaType: "image/png", byteSize: 3 };
    const response = await acceptDialogueTurnV2(args({
      originalUserText: "Think now.",
      verifiedImages: [{ snapshot, dataBase64: "AQID" }],
    }));
    expect(response.status).toBe(200);
    const preparedArgs = h.prepare.mock.calls[0]![0];
    expect(preparedArgs.originalUserText).toBe("Think now.");
    expect(preparedArgs.messages[0].parts).toEqual([
      { type: "text", text: "Think now." },
      { type: "text", text: expect.stringContaining('viewImage source="attachment:0"') },
      { type: "file", mediaType: "image/png", filename: "sample.png", url: "data:image/png;base64,AQID" },
    ]);
    expect(preparedArgs.verifiedImages).toEqual([{ snapshot, dataBase64: "AQID" }]);
    const accepted = await response.json();
    expect(accepted.input.attachments).toEqual([snapshot]);
    expect(h.start.mock.calls[0]![0].verifiedImages).toEqual([{ snapshot, dataBase64: "AQID" }]);
  });

  it("keeps the original source id and creates a fresh work id on regenerate", async () => {
    const response = await acceptDialogueTurnV2(args({
      regenerate: true,
      dialogueInputId: "original-input",
    }));
    const accepted = await response.json();
    expect(accepted.sourceInputId).toBe("original-input");
    expect(accepted.workId).not.toBe("original-input");
    expect(h.start.mock.calls[0]![0].dialogue).toEqual(expect.objectContaining({
      sourceInputId: "original-input",
      workId: accepted.workId,
    }));
  });
});
