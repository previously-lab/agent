import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptDialogueArgs } from "@/app/api/chat/dialogue/accept";

const callbacks = vi.hoisted(() => [] as Array<() => unknown>);
const events = vi.hoisted(() => [] as string[]);
const afterMock = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn());
const accept = vi.hoisted(() => vi.fn());
const regenerate = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/app/api/chat/dialogue/dispatch-host", () => ({ dispatchDialogueDueScopes: dispatch }));
vi.mock("@/lib/dialogue/runtime", () => ({
  getDialogueStore: () => ({ accept, regenerate }),
  resolveDialogueScope: () => "scope-1",
  dialogueResponseError: (error: unknown) => Response.json({ error: String(error) }, { status: 503 }),
}));
vi.mock("@/lib/dialogue/store", () => ({ DialogueConflict: class DialogueConflict extends Error {} }));
vi.mock("@/lib/tools/chat-image-input", () => ({ withVerifiedImages: (messages: unknown) => messages }));
vi.mock("@/app/api/chat/start-turn", () => ({ prepareTurnInput: prepare }));

import { acceptDialogueTurn } from "@/app/api/chat/dialogue/accept";

describe("dialogue acceptance dispatch hook", () => {
  beforeEach(() => {
    callbacks.length = 0;
    events.length = 0;
    vi.clearAllMocks();
    const accepted = { version: 1, input: { inputId: "input-1" }, workId: "work-1" };
    accept.mockImplementation(() => { events.push("persisted"); return Promise.resolve(accepted); });
    regenerate.mockResolvedValue(accepted);
    prepare.mockResolvedValue({ clientMessageId: "message-1", lastUserMessage: "Think now." });
    afterMock.mockImplementation((callback: () => unknown) => {
      events.push("scheduled");
      callbacks.push(callback);
    });
    dispatch.mockImplementation(() => {
      events.push("dispatched");
      return Promise.resolve({ scopes: 1, ran: 2, failed: 0 });
    });
  });

  it("registers a non-blocking request after callback only after persistence", async () => {
    const confirm = vi.fn(() => { events.push("confirmed"); return Promise.resolve(); });
    const response = await acceptDialogueTurn({
      messages: [], verifiedImages: [], persona: "user", regenerate: false,
      reservation: { confirm, release: vi.fn() },
    } as unknown as AcceptDialogueArgs);

    expect(response.status).toBe(200);
    expect(events).toEqual(["persisted", "confirmed", "scheduled"]);
    expect(dispatch).not.toHaveBeenCalled();

    await callbacks[0]!();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(events).toEqual(["persisted", "confirmed", "scheduled", "dispatched"]);
  });
});
