import { describe, expect, it } from "vitest";
import { nativeMessageTurnId, nativeMessageTurnIdentity, visibleAssistantText } from "@/lib/chat/assistant-text";
import { appendNativeDraft } from "@/lib/chat/native-draft";
import type { UIMessage } from "@/lib/chat/protocol";

describe("visible assistant text identity", () => {
  it("preserves exact text inside a step and blank lines only between steps", () => {
    const message: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "  first\r\n" },
        { type: "text", text: "second  " },
        { type: "data-deepseek-step", data: { messages: [] } },
        { type: "text", text: "third\n" },
        { type: "step-start" },
        { type: "text", text: "fourth" },
      ],
    };
    expect(visibleAssistantText(message)).toBe("  first\r\nsecond  \n\nthird\n\n\nfourth");
  });

  it("uses recovery then terminal turn ids before the provisional message id", () => {
    const terminal: UIMessage = {
      id: "random-per-execute",
      role: "assistant",
      parts: [{ type: "data-turn-status", data: { status: "done", turnId: "terminal-turn" } }],
    };
    expect(nativeMessageTurnId(terminal)).toBe("terminal-turn");
    expect(nativeMessageTurnId({ ...terminal, metadata: { recoveryTurnId: "recovered-turn" } })).toBe("recovered-turn");
    expect(nativeMessageTurnId({ id: "fallback", role: "assistant", parts: [] })).toBe("fallback");
  });

  it("creates a provisional alias only from the same message's terminal chunk", () => {
    const active: UIMessage = {
      id: "assistant-run-run-1",
      role: "assistant",
      parts: [{ type: "data-turn-status", data: { status: "active", turnId: "unrelated-turn" } }],
    };
    expect(nativeMessageTurnIdentity(active)).toEqual({ turnId: "assistant-run-run-1" });
    const terminal: UIMessage = {
      ...active,
      parts: [{ type: "data-turn-status", data: { status: "done", turnId: "canonical-turn" } }],
    };
    expect(nativeMessageTurnIdentity(terminal)).toEqual({
      turnId: "canonical-turn",
      provisionalTurnId: "assistant-run-run-1",
    });
    expect(nativeMessageTurnIdentity({ ...terminal, metadata: { recoveryTurnId: "saved-turn" } })).toEqual({ turnId: "saved-turn" });
    expect(nativeMessageTurnIdentity({
      id: "same-turn",
      role: "assistant",
      parts: [{ type: "data-turn-status", data: { status: "done", turnId: "same-turn" } }],
    })).toEqual({ turnId: "same-turn" });
  });
});

describe("native composer draft append", () => {
  it("preserves existing bytes and never submits or replaces the draft", () => {
    expect(appendNativeDraft("existing", "next step")).toBe("existing\n\nnext step");
    expect(appendNativeDraft("existing\n", "next")).toBe("existing\n\nnext");
    expect(appendNativeDraft("existing\n\n", "next")).toBe("existing\n\nnext");
    expect(appendNativeDraft("", "next")).toBe("next");
    expect(appendNativeDraft("existing", " ")).toBe("existing");
  });
});
