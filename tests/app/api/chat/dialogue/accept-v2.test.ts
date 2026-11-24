import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptDialogueArgs } from "@/app/api/chat/dialogue/accept";
import { digest } from "@/lib/dialogue/artifacts";

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  accept: vi.fn(),
  confirm: vi.fn(async () => {}),
  release: vi.fn(),
  dispatch: vi.fn(async () => {}),
  restore: vi.fn(),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/dialogue/regeneration-images", () => ({ restoreDialogueImages: h.restore }));
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
      startedAtIso: "2026-11-19T17:47:00.000Z", clientTimezone: "Asia/Shanghai",
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
        acceptedTime: { utc: accepted.input.acceptedAt, local: "20 Nov 2026, 01:47", zone: "Asia/Shanghai", offset: "UTC+08:00" },
      },
    }));
    const launch = h.start.mock.calls[0]![0];
    expect(launch.modelMessages).toHaveLength(3);
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("captures scoped pointers to recent visible rows without accepting browser text or a sibling after the current input", async () => {
    type Row = AcceptDialogueArgs["messages"][number];
    const publication = (id: string): Row => ({ role: "assistant", id, parts: [
      { type: "data-dialogue-publication", data: { utteranceId: id, blocks: [{ text: "client claims" }] } },
    ] });
    const messages: Row[] = [
      publication("before-previous"),
      { role: "user", id: "previous", parts: [], metadata: { sourceInputId: "other-scope" } },
      publication("visible"), publication("visible"),
      { role: "assistant", id: "pending", parts: [{ type: "reasoning", text: "private" }] },
      args().messages[0], publication("after-current"),
    ];
    await acceptDialogueTurnV2(args({ messages }));
    expect(h.start.mock.calls[0][0].dialogue.recentExchangeHints).toEqual({
      inputIds: [digest(JSON.stringify(["scope-1", "previous"])).slice(0, 24)], publicationIds: ["visible", "before-previous"],
    });
    await acceptDialogueTurnV2(args({ messages, regenerate: true, dialogueInputId: "original" }));
    expect(h.start.mock.calls[1][0].dialogue.recentExchangeHints).toBeUndefined();
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

  it("replays the server-owned original pictures and source identity when the new request has only metadata", async () => {
    const assetId = `img_${"c".repeat(32)}`;
    const snapshot = { version: 1, assetId, ref: `drafts/${assetId}`, ordinal: 5, name: "original.png", mediaType: "image/png" };
    const images = [{ snapshot, dataBase64: "AQID" }];
    const identity = { acceptedAt: "2026-11-01T00:00:00.000Z", clientMessageId: "first-http-request" };
    h.restore.mockResolvedValue({ ...identity, text: "Original question.", images });
    const result = await acceptDialogueTurnV2(args({ regenerate: true, dialogueInputId: "original-input", dialogueSourceRunId: "wrun_ORIGINAL",
      messages: [{ id: "retry", role: "user", parts: [{ type: "text", text: "client supplied text" }], metadata: { attachments: [snapshot] } }] }));
    expect(result.status).toBe(200);
    expect(h.prepare.mock.calls[0][0]).toMatchObject({ originalUserText: "Original question.", verifiedImages: images });
    expect(h.prepare.mock.calls[0][0].messages[0].parts).toContainEqual({ type: "file", mediaType: "image/png",
      filename: "original.png", url: "data:image/png;base64,AQID" });
    expect(h.start.mock.calls[0][0].dialogue).toMatchObject({ sourceInputId: "original-input", originalInput: identity });
    expect((await result.json()).input).toMatchObject({ inputId: "original-input", ...identity, attachments: [snapshot] });
  });
});
