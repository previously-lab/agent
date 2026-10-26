import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskLedgerReadResult } from "@/lib/tasks/contracts";

const mocks = vi.hoisted(() => ({
  readTaskLedger: vi.fn(),
  sourceScope: vi.fn(),
  resolveDataSource: vi.fn(),
}));
vi.mock("@/lib/tasks/store", () => ({ readTaskLedger: mocks.readTaskLedger }));
vi.mock("@/lib/chat/native-source-scope.server", () => ({
  nativeSourceScopeForDeployment: mocks.sourceScope,
}));
vi.mock("@/lib/data-source/resolve", () => ({ resolveDataSource: mocks.resolveDataSource }));

import { getTaskPanelPage } from "@/lib/tasks/panel-action";

function readFor(refs: string[]): TaskLedgerReadResult {
  return {
    status: "ready",
    ledger: {
      version: 1,
      tasks: refs.map((ref) => ({
        ref, summary: ref, status: "open" as const, revision: 1,
        evidence: [], updatedAt: "2026-10-26T12:00:00.000Z",
      })),
      results: [], operations: [],
    },
    basisHeadSha: null,
  };
}

let sourceGeneration = 0;

describe("task panel read action", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
    sourceGeneration += 1;
    mocks.readTaskLedger.mockReset();
    mocks.readTaskLedger.mockResolvedValue(readFor([]));
    mocks.sourceScope.mockReset();
    mocks.sourceScope.mockReturnValue(`local:/root-${sourceGeneration}`);
    mocks.resolveDataSource.mockReset();
    mocks.resolveDataSource.mockReturnValue("local");
  });

  afterEach(() => vi.useRealTimers());

  it("reuses one source snapshot and refreshes only on explicit request", async () => {
    await getTaskPanelPage({ filter: "active", offset: 0 });
    await getTaskPanelPage({ filter: "all", offset: 0 });
    expect(mocks.readTaskLedger).toHaveBeenCalledTimes(1);
    await getTaskPanelPage({ filter: "all", offset: 0, refresh: true });
    expect(mocks.readTaskLedger).toHaveBeenCalledTimes(2);
    expect(mocks.readTaskLedger).toHaveBeenLastCalledWith({ fresh: true });
  });

  it("partitions cached ledgers by the real server source scope", async () => {
    mocks.readTaskLedger.mockResolvedValueOnce(readFor(["tasks/source-a"]));
    mocks.sourceScope.mockReturnValue("github:owner/a");
    const a = await getTaskPanelPage({ filter: "all", offset: 0 });
    mocks.readTaskLedger.mockResolvedValueOnce(readFor(["tasks/source-b"]));
    mocks.sourceScope.mockReturnValue("github:owner/b");
    const b = await getTaskPanelPage({ filter: "all", offset: 0 });
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status === "ready" && b.status === "ready") {
      expect(a.items[0].ref).toBe("tasks/source-a");
      expect(b.items[0].ref).toBe("tasks/source-b");
    }
    expect(mocks.readTaskLedger).toHaveBeenCalledTimes(2);

    mocks.sourceScope.mockReturnValue("github:owner/a");
    const cachedA = await getTaskPanelPage({ filter: "all", offset: 0 });
    expect(cachedA.status).toBe("ready");
    if (cachedA.status === "ready") expect(cachedA.items[0].ref).toBe("tasks/source-a");
    expect(mocks.readTaskLedger).toHaveBeenCalledTimes(2);
  });

  it("rejects a load-more across a TTL snapshot change instead of mixing pages", async () => {
    mocks.readTaskLedger.mockResolvedValueOnce(readFor(["tasks/a-1", "tasks/a-2"]));
    const first = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1 });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    mocks.readTaskLedger.mockResolvedValueOnce(readFor(["tasks/b-1", "tasks/b-2"]));
    vi.advanceTimersByTime(20_001);

    const stale = await getTaskPanelPage({
      filter: "all", offset: 1, limit: 1, snapshot: first.snapshot,
    });
    expect(stale).toEqual({ status: "stale" });
    const restarted = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1 });
    expect(restarted.status).toBe("ready");
    if (restarted.status === "ready") {
      expect(restarted.items[0].ref).toBe("tasks/b-1");
      expect(restarted.snapshot).not.toBe(first.snapshot);
    }
  });

  it("rejects changed content after a cold start even with identical task refs and dates", async () => {
    mocks.readTaskLedger.mockResolvedValueOnce(readFor(["tasks/a-1", "tasks/a-2"]));
    const first = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1 });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("Expected the first canonical page");
    const changed = readFor(["tasks/a-1", "tasks/a-2"]);
    if (changed.status !== "ready") throw new Error("Expected ready fixture");
    changed.ledger.tasks[1].summary = "The same task now has a different next step";
    mocks.readTaskLedger.mockResolvedValueOnce(changed);
    vi.resetModules();
    const cold = await import("@/lib/tasks/panel-action");
    expect(await cold.getTaskPanelPage({
      filter: "all", offset: 1, limit: 1, snapshot: first.snapshot,
    })).toEqual({ status: "stale" });
  });

  it("continues identical canonical state across independent cold instances", async () => {
    mocks.readTaskLedger.mockResolvedValue(readFor(["tasks/a-1", "tasks/a-2"]));
    const first = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1 });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("Expected the first canonical page");
    vi.resetModules();
    const cold = await import("@/lib/tasks/panel-action");
    const second = await cold.getTaskPanelPage({
      filter: "all", offset: 1, limit: 1, snapshot: first.snapshot,
    });
    expect(second.status).toBe("ready");
    if (second.status !== "ready") throw new Error("Unchanged state should allow continuation");
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.items.map((item) => item.ref)).toEqual(["tasks/a-2"]);
  });

  it("binds identical content to its server source and fingerprints pending results", async () => {
    const data = readFor(["tasks/a-1", "tasks/a-2"]);
    if (data.status !== "ready") throw new Error("Expected ready fixture");
    mocks.readTaskLedger.mockResolvedValue(data);
    const first = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1 });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("Expected first page");
    mocks.sourceScope.mockReturnValue("github:another-owner/another-source");
    const otherSource = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1 });
    expect(otherSource.status).toBe("ready");
    if (otherSource.status !== "ready") throw new Error("Expected source page");
    expect(otherSource.snapshot).not.toBe(first.snapshot);
    const changed = structuredClone(data);
    changed.ledger.results.push({
      id: "new-pending-result", taskRef: "tasks/a-1", revision: 1,
      evidence: { producerRunId: "fixture-run", statement: "New undelivered result" },
      createdAt: "2026-10-26T12:00:00.000Z", updatedAt: "2026-10-26T12:00:00.000Z",
      delivery: { state: "pending" },
    });
    mocks.readTaskLedger.mockResolvedValue(changed);
    const refreshed = await getTaskPanelPage({ filter: "all", offset: 0, limit: 1, refresh: true });
    expect(refreshed.status).toBe("ready");
    if (refreshed.status !== "ready") throw new Error("Expected refreshed page");
    expect(refreshed.snapshot).not.toBe(otherSource.snapshot);
  });
});
