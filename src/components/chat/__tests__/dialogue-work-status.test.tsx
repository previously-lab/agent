import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DialogueWorkView } from "../dialogue-projection";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

let DialogueWorkStatus: typeof import("../dialogue-work-status").DialogueWorkStatus;
beforeAll(async () => {
  vi.stubGlobal("React", React);
  ({ DialogueWorkStatus } = await import("../dialogue-work-status"));
});
afterAll(() => vi.unstubAllGlobals());

const work: DialogueWorkView = {
  workId: "work-internal", inputId: "input-internal", userSeq: 1, status: "queued", connection: "connected",
};

function render(overrides: Partial<React.ComponentProps<typeof DialogueWorkStatus>> = {}) {
  return renderToStaticMarkup(React.createElement(DialogueWorkStatus, {
    works: [work], inputs: new Map(), expression: "idle", persona: "user",
    onCancel: async () => {}, onRetry: async () => {}, onResume: () => {}, ...overrides,
  }));
}

describe("dialogue work status", () => {
  it("uses specific sending, delivered and replying states", () => {
    expect(render({ works: [], submission: { phase: "submitting" } })).toContain("chat.dialogue.submitting");
    expect(render({ submission: { phase: "accepted", workId: work.workId } })).toContain("chat.dialogue.received");
    expect(render({ works: [{ ...work, status: "running" }] })).toContain("chat.dialogue.thinking");
  });

  it("distinguishes reconnecting from disconnected and only offers resume for the latter", () => {
    const reconnecting = render({ works: [{ ...work, status: "running", connection: "reconnecting" }] });
    expect(reconnecting).toContain("chat.dialogue.reconnecting");
    expect(reconnecting).toContain('data-tone="warning"');
    expect(reconnecting).not.toContain("chat.dialogue.reconnect</button>");

    const disconnected = render({ works: [{ ...work, status: "running", connection: "disconnected" }] });
    expect(disconnected).toContain("chat.dialogue.connectionDisconnected");
    expect(disconnected).toContain("chat.dialogue.reconnect</button>");
    expect(disconnected).toContain('data-tone="error"');
    expect(disconnected).not.toContain("chat.dialogue.retry</button>");
  });

  it("keeps a failed reply actionable even when no public answer or product exists", () => {
    const html = render({ works: [{ ...work, status: "failed", connection: "connected" }] });
    expect(html).toContain("chat.dialogue.workFailed");
    expect(html).toContain("chat.dialogue.workFailedHelp");
    expect(html).toContain("chat.dialogue.retry</button>");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("work-internal");
    expect(html).not.toContain("input-internal");
  });

  it("never offers a new reply POST while a failed work is disconnected", () => {
    const html = render({ works: [{ ...work, status: "failed", connection: "disconnected" }] });
    expect(html).toContain("chat.dialogue.reconnect</button>");
    expect(html).not.toContain("chat.dialogue.retry</button>");
  });

  it("disables retry only when the same input already has active work", () => {
    const failed = { ...work, status: "failed" as const };
    const sameInput = render({ works: [{ ...work, status: "running" }, failed] });
    expect(sameInput).toContain("chat.dialogue.retry</button>");
    expect(sameInput).toContain("disabled=\"\"");
    const otherInput = render({ works: [{ ...work, status: "running", inputId: "other" }, failed] });
    expect(otherInput).toContain("chat.dialogue.retry</button>");
    expect(otherInput).not.toContain("disabled=\"\"");
  });

  it("keeps a rejected submission in the editor recovery path", () => {
    const html = render({ works: [], submission: { phase: "failed" } });
    expect(html).toContain("chat.dialogue.submitFailed");
    expect(html).toContain("chat.dialogue.submitFailedHelp");
    expect(html).not.toContain("chat.dialogue.retry</button>");
    expect(html).not.toContain("chat.dialogue.reconnect</button>");
  });

  it("does not let a stale accepted submission preserve an empty completed seat", () => {
    const html = render({
      works: [{ ...work, status: "completed" }],
      submission: { phase: "accepted", workId: work.workId },
    });
    expect(html).toBe("");
  });

  it("uses a completed product row as its own single details action", () => {
    const html = render({
      works: [{ ...work, status: "completed", summary: "Internal summary" }],
      submission: { phase: "accepted", workId: work.workId },
    });
    expect(html).toContain("chat.dialogue.workProducts");
    expect(html).not.toContain("chat.dialogue.workDetails");
    expect(html).not.toContain("Internal summary");
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
  });
});
