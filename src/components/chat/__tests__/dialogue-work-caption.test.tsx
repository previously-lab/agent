import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import en from "../../../../messages/en.json";
import zh from "../../../../messages/zh.json";
import type { DialogueWorkView } from "../dialogue-projection";
import {
  applyDialogueWorkStreamEvent,
  dialogueWorkStreamIdentity,
  emptyDialogueWorkStream,
  parseDialogueWorkStreamEvent,
  selectDialogueWorkStream,
  streamDialogueWork,
  type DialogueWorkStreamEvent,
  type DialogueWorkStreamView,
} from "../dialogue-work-stream";

const stream = vi.hoisted(() => ({
  current: undefined as DialogueWorkStreamView | undefined,
  translations: undefined as Record<string, string> | undefined,
}));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const messages = namespace === "chat.dialogue" ? stream.translations : undefined;
    return Object.assign((key: string) => messages?.[key] ?? `${namespace}.${key}`, {
      has: (key: string) => !messages || Object.hasOwn(messages, key),
    });
  },
}));
vi.mock("../markdown", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => content,
}));
vi.mock("../dialogue-work-stream", async importOriginal => {
  const actual = await importOriginal<typeof import("../dialogue-work-stream")>();
  return { ...actual, useDialogueWorkStream: () => stream.current ?? actual.emptyDialogueWorkStream };
});

let DialogueWorkCaption: typeof import("../dialogue-work-caption").DialogueWorkCaption;
let dialogueWorkCaptionStatus: typeof import("../dialogue-work-caption").dialogueWorkCaptionStatus;
beforeAll(async () => {
  ({ DialogueWorkCaption, dialogueWorkCaptionStatus } = await import("../dialogue-work-caption"));
});
afterEach(() => {
  stream.current = undefined;
  stream.translations = undefined;
});

const work: DialogueWorkView = {
  workId: "work-1", inputId: "input-1", userSeq: 1, status: "running", runId: "run-1",
};
const event = (value: Record<string, unknown>) => ({ workId: "work-1", runId: "run-1", ...value });
const response = (events: Record<string, unknown>[]) => {
  const bytes = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of events) {
        const text = JSON.stringify(value);
        controller.enqueue(bytes.encode(`id: ${value.cursor}\ndata: ${text.slice(0, 9)}`));
        controller.enqueue(bytes.encode(`${text.slice(9)}\n\n`));
      }
      controller.enqueue(bytes.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

describe("dialogue work caption stream", () => {
  it("accepts only explicit reasoning deltas and keeps reasoning separate from work text", () => {
    const parsed = parseDialogueWorkStreamEvent(event({
      type: "reasoning", cursor: 1, delta: "safe reasoning",
      reasoning_content: "wrong channel", input: { token: "not retained" },
    }));
    expect(parsed).toEqual({ type: "reasoning", cursor: 1, delta: "safe reasoning" });
    expect(JSON.stringify(parsed)).not.toContain("not retained");
    expect(() => parseDialogueWorkStreamEvent(event({ type: "reasoning", cursor: 2, reasoning_content: "wrong channel" }))).toThrow("Invalid");

    let state = applyDialogueWorkStreamEvent(emptyDialogueWorkStream, parsed);
    state = applyDialogueWorkStreamEvent(state, { type: "text", cursor: 2, delta: "work body" });
    expect(state).toMatchObject({ reasoning: "safe reasoning", text: "work body", activity: { type: "text" } });
  });

  it("replays both channels at the raw cursor without gaps or duplicates", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response([
        event({ type: "reasoning", cursor: 1, delta: "think" }),
        event({ type: "text", cursor: 2, delta: "body" }),
        event({ type: "status", cursor: 2, status: "live", retryAfterMs: 10 }),
      ]))
      .mockResolvedValueOnce(response([
        event({ type: "reasoning", cursor: 2, delta: "duplicate" }),
        event({ type: "reasoning", cursor: 3, delta: " more" }),
        event({ type: "text", cursor: 4, delta: " output" }),
        event({ type: "status", cursor: 4, status: "completed" }),
      ]));
    const events: DialogueWorkStreamEvent[] = [];
    const controller = new AbortController();
    await streamDialogueWork({ workId: "work-1", runId: "run-1", persona: "user", signal: controller.signal,
      onEvent: value => events.push(value), request, wait: async () => {} });
    const state = events.reduce(applyDialogueWorkStreamEvent, emptyDialogueWorkStream);
    expect(request.mock.calls[1]?.[0]).toContain("startIndex=2");
    expect(state.reasoning).toBe("think more");
    expect(state.text).toBe("body output");
    expect(state.cursor).toBe(4);
  });

  it("isolates a previous work/run immediately, including persona and preview retry identity", () => {
    const first = dialogueWorkStreamIdentity(work, "user");
    const changedRun = dialogueWorkStreamIdentity({ ...work, runId: "run-2" }, "user");
    const changedPersona = dialogueWorkStreamIdentity(work, "other");
    const snapshot = { identity: first, view: { ...emptyDialogueWorkStream, reasoning: "private old work" } };
    expect(selectDialogueWorkStream(snapshot, first).reasoning).toBe("private old work");
    expect(selectDialogueWorkStream(snapshot, changedRun)).toBe(emptyDialogueWorkStream);
    expect(selectDialogueWorkStream(snapshot, changedPersona)).toBe(emptyDialogueWorkStream);
    expect(dialogueWorkStreamIdentity(work, "user", 1)).not.toBe(first);
  });
});

describe("dialogue work caption status and rendering", () => {
  it.each([
    ["running", "live", "running"],
    ["queued", "waiting", "running"],
    ["completed", "live", "ended"],
    ["failed", "live", "ended"],
    ["cancelled", "live", "stopped"],
    ["running", "completed", "ended"],
    ["running", "failed", "ended"],
    ["running", "cancelled", "stopped"],
  ] as const)("renders unfinished tools for work=%s / stream=%s as %s", (workStatus, streamStatus, expected) => {
    stream.current = {
      ...emptyDialogueWorkStream,
      status: streamStatus,
      tools: [
        { id: "finish", name: "finishThinking", status: "running" },
        { id: "offer", name: "offerReply", status: "running" },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(DialogueWorkCaption, {
      work: { ...work, status: workStatus }, persona: "user", replying: true,
    }));
    const list = html.match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/)?.[1];
    expect(list).toBeDefined();
    expect(list?.match(new RegExp(`chat.dialogue.tool_${expected}`, "g"))).toHaveLength(2);
    expect(list).not.toContain("chat.dialogue.tool_completed");
    expect(list).not.toContain("chat.dialogue.tool_failed");
    if (expected !== "running") expect(list).not.toContain("chat.dialogue.tool_running");
    if (workStatus === "running" && streamStatus === "completed") {
      expect(html).toContain("chat.dialogue.expressing");
    }
    expect(stream.current.tools.every(tool => tool.status === "running")).toBe(true);
  });

  it.each([en.chat.dialogue, zh.chat.dialogue])("localizes terminal tool names and preserves explicit results", messages => {
    stream.translations = messages;
    stream.current = {
      ...emptyDialogueWorkStream,
      status: "cancelled",
      tools: [
        { id: "finish", name: "finishThinking", status: "running" },
        { id: "offer", name: "offerReply", status: "completed" },
        { id: "unknown", name: "untranslatedInternalTool", status: "failed" },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(DialogueWorkCaption, {
      work: { ...work, status: "cancelled" }, persona: "user",
    }));
    expect(html).toContain(`<span>${messages.tool_finishThinking}</span><span>${messages.tool_stopped}</span>`);
    expect(html).toContain(`<span>${messages.tool_offerReply}</span><span>${messages.tool_completed}</span>`);
    expect(html).toContain(`<span>${messages.tool_unknown}</span><span>${messages.tool_failed}</span>`);
    expect(html).not.toMatch(/finishThinking|offerReply|untranslatedInternalTool/);
    expect(html).not.toContain(messages.tool_running);
  });

  it("maps real tool names and lets only the public replying prop mean replying", () => {
    const reasoning = applyDialogueWorkStreamEvent(emptyDialogueWorkStream, { type: "reasoning", cursor: 1, delta: "think" });
    const text = applyDialogueWorkStreamEvent(reasoning, { type: "text", cursor: 2, delta: "private output" });
    expect(dialogueWorkCaptionStatus(work, text)).toBe("thinking");
    expect(dialogueWorkCaptionStatus(work, text, true)).toBe("replying");
    expect(dialogueWorkCaptionStatus(work, { ...text, status: "completed" }, true)).toBe("replying");
    expect(dialogueWorkCaptionStatus({ ...work, status: "completed" }, text, true)).toBe("completed");
    expect(dialogueWorkCaptionStatus({ ...work, status: "completed" }, { ...text, unavailable: true })).toBe("unavailable");

    const tools = ["recallRead", "webSearch", "webFetch", "viewImage", "currentTime"].map((name, index) =>
      applyDialogueWorkStreamEvent(text, { type: "tool", cursor: index + 3, toolCallId: name, toolName: name, state: "running" }));
    expect(dialogueWorkCaptionStatus(work, tools[0])).toBe("recalling");
    expect(dialogueWorkCaptionStatus(work, tools[1])).toBe("searching");
    expect(dialogueWorkCaptionStatus(work, tools[2])).toBe("searching");
    expect(dialogueWorkCaptionStatus(work, tools[3])).toBe("reading");
    expect(dialogueWorkCaptionStatus(work, tools[4])).toBe("working");
  });

  it("keeps full reasoning and work Markdown replay available in a fixed-height output", () => {
    stream.current = {
      ...emptyDialogueWorkStream,
      reasoning: "Complete **reasoning** without truncation",
      text: "Complete *work output* without truncation",
      tools: [{ id: "time", name: "currentTime", status: "completed" }],
      status: "completed",
    };
    const html = renderToStaticMarkup(React.createElement(DialogueWorkCaption, {
      work: { ...work, status: "completed" }, persona: "user",
    }));
    expect(html).toContain("data-dialogue-work=\"work-1\"");
    expect(html).toContain("data-dialogue-work-caption");
    expect(html).toContain("data-dialogue-thought-content");
    expect(html).toContain("Complete **reasoning** without truncation");
    expect(html).toContain("Complete *work output* without truncation");
    expect(html).toContain("h-48 max-h-48");
    expect(html).toContain("chat.dialogue.tool_currentTime");
    expect(html).toContain("chat.dialogue.thoughtOutput");
    expect(html).toContain("chat.dialogue.showThoughts");
    expect(html).not.toContain("chat.dialogue.workDetails");
    stream.current = undefined;
  });
});
