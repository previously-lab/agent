import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatStreamItem } from "@/lib/chat/stream-items";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/workspace/navigation", () => ({ hasHistoryEntrance: () => false }));
vi.mock("@/lib/chat/field-blocks", () => ({ sliceIdOf: () => null }));
vi.mock("@/components/workspace/history-entrance", () => ({
  HistoryEntrance: () => null,
}));
vi.mock("../chat-message", () => ({
  ChatMessage: ({ message }: { message: { id: string } }) =>
    React.createElement("div", { "data-chat-message": message.id }),
}));
vi.mock("../dialogue-utterance", () => ({ DialogueUtterance: () => null }));
vi.mock("../nested-bubble", () => ({ NestedBubble: () => null }));
vi.mock("../parallel-lane", () => ({ ParallelLaneView: () => null }));
vi.mock("../history-turn", () => ({ HistoryTurn: () => null }));
vi.mock("../slice-seam", () => ({ SliceSeam: () => null }));
vi.mock("../resume-banner", () => ({ ResumeBanner: () => null }));
vi.mock("../error-banner", () => ({ ErrorBanner: () => null }));
vi.mock("../empty-briefing", () => ({ EmptyBriefing: () => null }));
vi.mock("../stream-time-indicator", () => ({ StreamTimeIndicator: () => null }));

import { DomChatList } from "../dom-chat-list";

const live = (key: string): ChatStreamItem => ({
  kind: "live",
  key,
  message: { id: key, role: key.startsWith("dialogue-work:") ? "assistant" : "user", parts: [] },
  timeIso: "2026-11-07T00:00:00.000Z",
  isStreaming: false,
});

describe("DomChatList work seats", () => {
  it("renders the complete work slot instead of the empty assistant fallback", () => {
    const renderDialogueWork = vi.fn((item: ChatStreamItem) =>
      React.createElement("article", { "data-work-slot": item.key }, "Thinking caption"),
    );
    const html = renderToStaticMarkup(
      <DomChatList
        items={[live("dialogue-input:input-1"), live("dialogue-work:work-1")]}
        error={undefined}
        renderDialogueWork={renderDialogueWork}
      />,
    );

    expect(html).toContain('data-key="dialogue-input:input-1"');
    expect(html).toContain('data-chat-message="dialogue-input:input-1"');
    expect(html).toContain('data-work-slot="dialogue-work:work-1"');
    expect(html).toContain("Thinking caption");
    expect(html).not.toContain('data-chat-message="dialogue-work:work-1"');
    expect(renderDialogueWork).toHaveBeenCalledTimes(1);
    expect(renderDialogueWork.mock.calls[0][0].key).toBe("dialogue-work:work-1");
  });

  it("keeps the existing empty assistant fallback when no slot is supplied", () => {
    const html = renderToStaticMarkup(
      <DomChatList items={[live("dialogue-work:work-1")]} error={undefined} />,
    );
    expect(html).toContain('data-chat-message="dialogue-work:work-1"');
  });
});
