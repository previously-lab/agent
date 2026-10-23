import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@/lib/chat/protocol";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const labels: Record<string, string> = {
      "desk.recordUser": "You",
      "desk.recordAgent": "Previously",
    };
    return labels[`${namespace}.${key}`] ?? key;
  },
}));
vi.mock("../markdown", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => React.createElement("p", { "data-prose": true }, content),
}));
vi.mock("../time-display", () => ({
  TimeDisplay: ({ timestamp }: { timestamp: string }) => React.createElement("time", { dateTime: timestamp }, timestamp),
  sameDay: () => true,
}));
vi.mock("../cognition-popover", () => ({
  CognitionPopover: ({ sliceId, turnId }: { sliceId: string; turnId: string }) => React.createElement("button", { "data-slice": sliceId, "data-turn": turnId }, "Thoughts"),
}));
vi.mock("../thinking", () => ({
  ThinkingSteps: ({ text }: { text: string }) => React.createElement("div", { "data-thoughts": true }, text),
}));
vi.mock("../tool-renderer", () => ({
  ToolRenderer: ({ toolName }: { toolName: string }) => React.createElement("button", { "data-tool": toolName }, toolName),
}));
vi.mock("../housekeeping-card", () => ({ HousekeepingCard: () => null }));
vi.mock("../recall-references-bar", () => ({ RecallReferencesBar: () => React.createElement("button", {}, "Open recalled document") }));
vi.mock("../phase-indicator", () => ({
  PhaseIndicator: ({ label, summary }: { label: string; summary?: string }) => React.createElement("div", { "data-phase": true }, label, summary),
}));

let ChatMessage: typeof import("../chat-message").ChatMessage;
let HistoryTurn: typeof import("../history-turn").HistoryTurn;
beforeAll(async () => {
  // Vitest uses the classic JSX transform; Next uses its automatic transform.
  vi.stubGlobal("React", React);
  ({ ChatMessage } = await import("../chat-message"));
  ({ HistoryTurn } = await import("../history-turn"));
});
afterAll(() => vi.unstubAllGlobals());

function render(parts: UIMessage["parts"], options: { role?: UIMessage["role"]; streaming?: boolean; actions?: boolean } = {}) {
  return renderToStaticMarkup(React.createElement(ChatMessage, {
    message: { id: "turn", role: options.role ?? "assistant", parts },
    isStreaming: options.streaming,
    onRegenerate: options.actions ? () => {} : undefined,
  }));
}

describe("the shared conversation manuscript", () => {
  it("keeps a user turn, its image and file attachment under one explicit speaker", () => {
    const html = render([
      { type: "text", text: "Can we talk about this page?" },
      { type: "file", url: "data:image/png;base64,AA==", mediaType: "image/png", filename: "Page.png" },
      { type: "file", url: "https://example.test/notes.txt", mediaType: "text/plain", filename: "Notes.txt" },
    ], { role: "user" });
    expect(html).toContain('aria-label="You"');
    expect(html).toContain('data-role="user"');
    expect(html).toContain("Can we talk about this page?");
    expect(html).toContain('alt="Page.png"');
    expect(html).toContain("Notes.txt");
  });

  it("renders an attachment-only turn without losing its speaker or file", () => {
    const html = render([{ type: "file", url: "data:image/png;base64,AA==", mediaType: "image/png", filename: "Sketch.png" }], { role: "user" });
    expect(html).toContain('aria-label="You"');
    expect(html).toContain('alt="Sketch.png"');
    expect(html).not.toContain("data-prose");
  });

  it("preserves reasoning, tools and answer order within the assistant's prose", () => {
    const html = render([
      { type: "reasoning", text: "Reading the earlier page." },
      { type: "tool-readFile", toolCallId: "read", state: "output-available", input: { path: "fixture.md" }, output: "fixture" },
      { type: "text", text: "Here is what changed." },
    ]);
    expect(html).toContain('aria-label="Previously"');
    expect(html.indexOf("Reading the earlier page.")).toBeLessThan(html.indexOf('data-tool="readFile"'));
    expect(html.indexOf('data-tool="readFile"')).toBeLessThan(html.indexOf("Here is what changed."));
  });

  it("keeps a partial answer and its failure explanation in the same turn", () => {
    const html = render([
      { type: "text", text: "The part we have so far." },
      { type: "data-turn-status", data: { status: "error", error: "The connection was interrupted." } },
    ]);
    expect(html).toContain("The part we have so far.");
    expect(html).toContain("turnError");
    expect(html).toContain("The connection was interrupted.");
  });

  it("keeps live status visible and only offers settled answer actions", () => {
    const parts: UIMessage["parts"] = [{ type: "text", text: "Still writing." }];
    const live = render(parts, { streaming: true, actions: true });
    expect(live).toContain("stageComposing");
    expect(live).not.toContain("copyTooltip");
    const done = render(parts, { actions: true });
    expect(done).toContain("copyTooltip");
    expect(done).toContain("regenerateTooltip");
  });

  it("keeps history timestamps and cognition attached to the correct speaker", () => {
    const html = renderToStaticMarkup(React.createElement(HistoryTurn, {
      role: "agent", content: "An earlier understanding.", sliceId: "fixture-slice", turnId: "fixture-turn", timestamp: "2026-10-20T12:00:00Z",
    }));
    expect(html).toContain('aria-label="Previously"');
    expect(html).toContain('dateTime="2026-10-20T12:00:00Z"');
    expect(html).toContain('data-turn="fixture-turn"');
    expect(html).toContain("An earlier understanding.");
  });
});
