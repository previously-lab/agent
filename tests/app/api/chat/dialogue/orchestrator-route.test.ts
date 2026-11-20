import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  guard: vi.fn(() => null),
}));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.list } }) }));
vi.mock("@/lib/dialogue/runtime", () => ({
  guardDialogueRead: h.guard,
  resolveDialogueScope: () => "scope",
}));

import { GET } from "@/app/api/chat/dialogue/orchestrator/route";

function call() {
  return GET(new Request("http://localhost/api/chat/dialogue/orchestrator?persona=user"));
}
function run(index: number, scope = "scope") {
  return {
    runId: `run-${index}`, status: index === 5 ? "running" : "completed",
    createdAt: `2026-11-15T00:0${index}:00.000Z`,
    attributes: { role: "dialogueOrchestrator", scope, triggeredAt: `2026-11-15T00:0${index}:30.000Z` },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({ data: [] });
});

describe("dialogue orchestrator discovery", () => {
  it("returns only live Workflow runs, never terminal history", async () => {
    h.list.mockResolvedValue({ data: [5, 4, 3, 2, 1, 0].map(index => run(index, index === 0 ? "other" : "scope")) });
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: "run-5", status: "running", runs: [{ runId: "run-5", status: "running" }],
    });
  });

  it("keeps pending and running work while excluding every terminal state", async () => {
    h.list.mockResolvedValue({ data: [
      { ...run(4), status: "failed" }, { ...run(5), status: "cancelled" },
      { ...run(6), status: "completed" }, { ...run(7), status: "pending" }, run(5),
    ] });
    await expect((await call()).json()).resolves.toMatchObject({
      runId: "run-7", status: "pending",
      runs: [{ runId: "run-5", status: "running" }, { runId: "run-7", status: "pending" }],
    });
  });

  it("follows registry cursors instead of dropping older dialogue runs", async () => {
    h.list.mockImplementation(async ({ pagination }) => pagination.cursor === "next"
      ? { data: [run(2)], hasMore: false, cursor: null }
      : { data: [run(1)], hasMore: true, cursor: "next" });
    await expect((await call()).json()).resolves.toMatchObject({ runId: null, status: "absent", runs: [] });
    expect(h.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pagination: { limit: 100, cursor: "next" } }));
  });

  it("reports an empty recovery window when no conversation exists", async () => {
    await expect((await call()).json()).resolves.toEqual({ runId: null, status: "absent", runs: [] });
  });
});
