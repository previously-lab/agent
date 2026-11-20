import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.list } }) }));
vi.mock("@/lib/dialogue/runtime", () => ({ resolveDialogueScope: () => "scope" }));

import { findDialogueThoughtRuns } from "@/lib/chat/dialogue-run-recovery";

function thought(status: string, suffix = status) {
  return {
    runId: `run-${suffix}`, status,
    createdAt: "2026-11-17T00:00:00.000Z",
    attributes: { role: "thinking", scope: "scope", work: `work-${suffix}`, turn: `input-${suffix}` },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Workflow thought recovery eligibility", () => {
  it("recovers only pending or running work and never terminal history", async () => {
    h.list.mockResolvedValue({ data: [
      thought("completed"), thought("failed"), thought("cancelled"),
      thought("pending"), thought("running"), { ...thought("running", "other"), attributes: { role: "thinking", scope: "other" } },
    ] });
    await expect(findDialogueThoughtRuns("user")).resolves.toMatchObject([
      { runId: "run-pending", status: "pending" },
      { runId: "run-running", status: "running" },
    ]);
  });
});
