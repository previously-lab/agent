import { describe, expect, it } from "vitest";
import type { DialogueInput } from "@/lib/chat/dialogue-contract";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { UIMessage } from "@/lib/chat/protocol";
import { buildDialogueRegenerationRequest } from "@/lib/chat/dialogue-regenerate";
import { parseDocumentContext } from "@/lib/chat/document-context";
import { DEFAULTS } from "@/lib/config/defaults";
import { FIXED_MODEL } from "@/lib/models/registry";
import { createDialogueStore } from "@/lib/dialogue/store";
import { createLocalDialogueStorage } from "@/lib/dialogue/local";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const launch = (text: string): TurnInput => ({
  modelMessages: [], recentTurns: [], lastUserMessage: text, model: FIXED_MODEL.id, modelConfig: FIXED_MODEL,
  thinking: true, reasoningEffort: "low", clientTimezone: "UTC", locale: "en",
  config: DEFAULTS, owner: "local", repo: "local", useGithub: false, useDemo: false,
  startedAtIso: "2026-11-06T00:00:00.000Z", turnId: "provisional", imageAttachments: [],
});

describe("dialogue regenerate request", () => {
  it("replays the accepted input through the shared route contract with a new work identity", () => {
    const input: DialogueInput = {
      inputId: "original-input",
      clientMessageId: "original-http-message",
      userSeq: 1,
      eventSeq: 1,
      acceptedAt: "2026-11-06T00:00:00.000Z",
      text: "Keep this exact original question.",
      documentContext: [{ ref: "research/existing", title: "Existing research" }],
    };
    const body = buildDialogueRegenerationRequest(input, "new-regenerate-request", {
      locale: "en",
      timezone: "Asia/Shanghai",
    });

    expect(body).toMatchObject({
      regenerate: true,
      inputId: "original-input",
      dialogueInputId: "original-input",
      dialogueRequestId: "new-regenerate-request",
      messages: [{
        id: "new-regenerate-request",
        role: "user",
        parts: [{ type: "text", text: input.text }],
      }],
    });
    expect(body.messages).toHaveLength(1);
    expect(parseDocumentContext(body.documentContext)).toEqual(input.documentContext);
    expect(body).not.toHaveProperty("stagedAttachments");
  });

  it("creates a replayable new work for the original input without appending another user", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-regenerate-test-"));
    try {
      const store = createDialogueStore(createLocalDialogueStorage(root));
      const original = await store.accept("fixture", {
        clientMessageId: "original-http-message",
        launch: launch("Keep this exact original question."),
      });
      const input = original.input;
      const body = buildDialogueRegenerationRequest(input, "new-regenerate-request", {
        locale: "en", timezone: "Asia/Shanghai",
      });
      const message = (body.messages as UIMessage[])[0];
      const regenerated = await store.regenerate("fixture", body.dialogueInputId as string, message.id);
      const replayed = await store.regenerate("fixture", body.dialogueInputId as string, message.id);

      expect(regenerated.input.inputId).toBe(original.input.inputId);
      expect(regenerated.workId).not.toBe(original.workId);
      expect(replayed.workId).toBe(regenerated.workId);
      const page = await store.page("fixture");
      expect(page.events.filter(event => event.type === "input.accepted")).toHaveLength(1);
      expect(page.events.filter(event => event.type === "work.status" && event.work.workId === regenerated.workId)).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
