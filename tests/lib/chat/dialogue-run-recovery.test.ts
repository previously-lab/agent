import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), getRun: vi.fn() }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.list } }) }));
vi.mock("workflow/api", () => ({ getRun: h.getRun }));
vi.mock("@/lib/dialogue/runtime", () => ({ resolveDialogueScope: () => "scope-user" }));

import { findDialogueThoughtRuns } from "@/lib/chat/dialogue-run-recovery";

describe("dialogue Workflow registry recovery", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns only thought runs in the current scope and reads completed work sources", async () => {
    const source = {
      inputId: "input-1", clientMessageId: "message-1", userSeq: 1, eventSeq: 1,
      acceptedAt: "2026-11-09T00:00:00.000Z", text: "Recovered question",
    };
    h.list.mockResolvedValue({ data: [
      { runId: "thought-active", status: "running", attributes: { role: "thinking", scope: "scope-user", work: "work-a", turn: "input-a" } },
      { runId: "thought-complete", status: "completed", createdAt: "2026-11-09T00:00:00.000Z",
        attributes: { role: "thinking", scope: "scope-user", work: "work-b", turn: "input-b" } },
      { runId: "other-scope", status: "running", attributes: { role: "thinking", scope: "other", work: "work-c", turn: "input-c" } },
      { runId: "public", status: "running", attributes: { role: "dialogue", scope: "scope-user", work: "work-a", turn: "input-a" } },
    ] });
    h.getRun.mockReturnValue({ returnValue: Promise.resolve({ dialogueWork: { source } }) });
    const result = await findDialogueThoughtRuns("user");
    expect(result).toEqual([
      { runId: "thought-active", workId: "work-a", sourceInputId: "input-a", status: "running" },
      { runId: "thought-complete", workId: "work-b", sourceInputId: "input-b", status: "completed",
        createdAt: "2026-11-09T00:00:00.000Z", input: source },
    ]);
    expect(h.getRun).toHaveBeenCalledOnce();
    expect(h.getRun).toHaveBeenCalledWith("thought-complete");
  });
});
