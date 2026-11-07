import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DialogueWorkView } from "../dialogue-projection";

vi.mock("next-intl", () => ({ useTranslations: (ns: string) => (key: string) => `${ns}.${key}`, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
let Caption: typeof import("../dialogue-work-caption").DialogueWorkCaption;
beforeAll(async () => {
  vi.stubGlobal("React", React);
  ({ DialogueWorkCaption: Caption } = await import("../dialogue-work-caption"));
});
const work: DialogueWorkView = { workId: "work-1", inputId: "input-1", userSeq: 1, status: "running", connection: "connected" };
const render = (changes: Partial<DialogueWorkView> = {}) => renderToStaticMarkup(React.createElement(Caption, {
  work: { ...work, ...changes }, persona: "user", onCancel: async () => {}, onRetry: async () => {}, onResume: () => {},
}));
describe("per-message work recovery controls", () => {
  it("defaults to one collapsed thinking caption, without a global work-details action", () => {
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("chat.dialogue.workDetails");
    expect(html).not.toContain("chat.dialogue.workProducts");
  });
  it("exposes retry for an actual failed work even if no public answer exists", () => {
    const html = render({ status: "failed" });
    expect(html).toContain("chat.dialogue.workFailed");
    expect(html).toContain("chat.dialogue.retry</button>");
  });
  it("uses reconnect, never a new reply POST action, for a disconnected failed work", () => {
    const html = render({ status: "failed", connection: "disconnected" });
    expect(html).toContain("chat.dialogue.connectionDisconnected");
    expect(html).toContain("chat.dialogue.reconnect</button>");
    expect(html).not.toContain("chat.dialogue.retry</button>");
  });
  it("distinguishes automatic reconnection from the manual reconnect action", () => {
    const html = render({ connection: "reconnecting" });
    expect(html).toContain("chat.dialogue.reconnecting");
    expect(html).not.toContain("chat.dialogue.reconnect</button>");
  });
  it("does not replay an old summary below a completed caption", () => {
    const html = render({ status: "completed", summary: "OLD_PHONOGRAPH_SUMMARY" });
    expect(html).toContain("chat.dialogue.tool_completed");
    expect(html).not.toContain("OLD_PHONOGRAPH_SUMMARY");
    expect(html).not.toContain("chat.dialogue.cancelWork</button>");
  });
});
