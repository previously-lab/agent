import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/io-helpers")>();
  return { ...actual, fsReadFile: vi.fn(), fsWriteFile: vi.fn(), fsListFiles: vi.fn() };
});

import { parseSlice, serializeSlice } from "@/lib/episodic/manager";
import type { TimeSlice } from "@/lib/episodic/types";
import type { TurnRunResult } from "@/lib/chat/turn-types";
import type { UIMessage } from "@/lib/chat/protocol";
import { mergeSavedTurns, recoveryMessages } from "@/lib/chat/reconnect";
import { documentContextFromMetadata, parseDocumentContext } from "@/lib/chat/document-context";
import { rememberNativeReplay, restoreNativeReplay } from "@/lib/chat/native-replay";

const documentContext = parseDocumentContext([{
  ref: "research/手机",
  title: "手机研究",
  quote: "用户选择的原文，尚未核验",
  observedRevision: "abc123",
}]);

const slice: TimeSlice = {
  slice_id: "2026-10-27-1200",
  focus: "focus",
  status: "active",
  start: "2026-10-27T12:00:00.000Z",
  end: "",
  timezone: "UTC",
  summary: "",
  open_loops: [],
  decisions: [],
  tags: [],
  related_slices: [],
  loops: [],
  turns: [
    { timestamp: "2026-10-27T12:00:00.000Z", role: "user", content: "original question", turnId: "turn1", clientMessageId: "u1", documentContext },
    { timestamp: "2026-10-27T12:00:01.000Z", role: "agent", content: "answer", turnId: "turn1" },
  ],
  estimatedTokens: 1,
};

describe("durable document reference replay", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips bounded metadata without putting selected source text in the user's voice", () => {
    const raw = serializeSlice(slice);
    expect(raw).toContain("[documents ");
    expect(raw).toContain("original question");
    expect(raw).not.toContain("用户选择的原文，尚未核验");
    const restored = parseSlice(raw);
    expect(restored.turns[0].content).toBe("original question");
    expect(restored.turns[0].documentContext).toEqual(documentContext);
    expect(restored.turns[1].documentContext).toBeUndefined();
  });

  it("keeps legacy and malformed-suffix turns readable while dropping only invalid context", () => {
    const legacy = parseSlice(`---\nslice_id: 2026-10-27-1200\nstart: 2026-10-27T12:00:00.000Z\ntimezone: UTC\n---\n\n## Turn turn1 — 2026-10-27T12:00:00.000Z (user) [documents not-json]\n\nstill the user's text`);
    expect(legacy.turns).toHaveLength(1);
    expect(legacy.turns[0].content).toBe("still the user's text");
    expect(legacy.turns[0].documentContext).toBeUndefined();
  });

  it("restores the same references through run recovery and saved current-slice turns", () => {
    const record: TurnRunResult = {
      turnId: "turn1",
      clientMessageId: "u1",
      sliceId: slice.slice_id,
      at: slice.start,
      userText: "original question",
      replyText: "answer",
      cognition: "",
      documentContext,
    };
    const recovered = recoveryMessages([record]);
    expect(documentContextFromMetadata(recovered[0].metadata)).toEqual(documentContext);
    expect(recovered[0].parts).toEqual([{ type: "text", text: "original question" }]);
    const saved = mergeSavedTurns([], slice.turns);
    expect(documentContextFromMetadata(saved[0].metadata)).toEqual(documentContext);
  });

  it("preserves metadata and original image attachments through native replay", () => {
    const nativePart = { type: "data-deepseek-step" as const, id: "native", data: { messages: [{ role: "assistant" as const, content: "answer" }] } };
    const user: UIMessage = {
      id: "u1",
      role: "user",
      metadata: { documentContext: { version: 1, references: documentContext } },
      parts: [{ type: "file", mediaType: "image/png", filename: "original.png", url: "data:image/png;base64,ORIGINAL" }, { type: "text", text: "original question" }],
    };
    const answer: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }, nativePart] };
    rememberNativeReplay([user, answer]);
    const restored = restoreNativeReplay([user, { ...answer, parts: [{ type: "text", text: "answer" }] }]);
    expect(documentContextFromMetadata(restored[0].metadata)).toEqual(documentContext);
    expect(restored[0].parts[0]).toEqual(user.parts[0]);
    expect(restored[1].parts).toContainEqual(nativePart);
  });
});
