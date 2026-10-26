import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

const mocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  sliceEntry: vi.fn(),
  setPersona: vi.fn(),
  budget: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock("@/lib/demo/demo-fs", () => ({ setDemoPersona: mocks.setPersona }));
vi.mock("@/lib/episodic/timeline/enumerate", () => ({ enumerateSliceIds: mocks.enumerate }));
vi.mock("@/lib/episodic/timeline/store", () => ({ sliceEntryFromDisk: mocks.sliceEntry }));
vi.mock("@/lib/episodic/paths", () => ({
  sliceIdToRelPath: (id: string) => id.replaceAll("-", "/"),
}));
vi.mock("@/lib/github/client", () => ({ withGitHubReadBudget: mocks.budget }));

import { getWorkspaceHistoryPage } from "@/lib/workspace/history-actions";

function idsInOneMonth(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(Math.floor(index / 24) + 1).padStart(2, "0");
    const hour = String(index % 24).padStart(2, "0");
    return `2026-10-${day}-${hour}00`;
  });
}

function entry(id: string): TimelineSliceEntry {
  return {
    id,
    date: id.slice(0, 10),
    start: `${id.slice(0, 10)}T${id.slice(11, 13)}:${id.slice(13, 15)}:00.000Z`,
    status: "closed",
    focus: `Focus ${id}`,
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
  };
}

describe("getWorkspaceHistoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.budget.mockImplementation((operation: () => Promise<unknown>) => operation());
    mocks.sliceEntry.mockImplementation((relative: string) => Promise.resolve(entry(relative.replaceAll("/", "-"))));
  });

  it("reads only the selected headers under the shared budget and passes the real persona", async () => {
    const ids = idsInOneMonth(75);
    mocks.enumerate.mockResolvedValue(ids.map((id) => id.replaceAll("/", "-")));
    const seen: string[] = [];
    let beforeId: string | null = null;
    for (;;) {
      const page = await getWorkspaceHistoryPage(beforeId, 20, "alice");
      expect(page.entries.length).toBeLessThanOrEqual(20);
      expect(page.entries[0]).not.toHaveProperty("turns");
      seen.push(...page.entries.map((item) => item.id));
      if (!page.hasMore) break;
      beforeId = page.nextBeforeId;
    }
    expect(mocks.enumerate).toHaveBeenCalledTimes(4);
    expect(mocks.sliceEntry).toHaveBeenCalledTimes(75);
    expect(mocks.setPersona).toHaveBeenCalledWith("alice");
    expect(mocks.setPersona).toHaveBeenCalledTimes(4);
    expect(mocks.budget).toHaveBeenCalledTimes(4);
    expect(new Set(seen).size).toBe(75);
    expect([...seen].sort()).toEqual(ids);
  });

  it("caps an oversized caller at 32 header reads", async () => {
    const ids = idsInOneMonth(75);
    mocks.enumerate.mockResolvedValue(ids.map((id) => id.replaceAll("/", "-")));
    const page = await getWorkspaceHistoryPage(null, 1000, "bob");
    expect(page.entries).toHaveLength(32);
    expect(mocks.sliceEntry).toHaveBeenCalledTimes(32);
    expect(mocks.setPersona).toHaveBeenCalledWith("bob");
  });
});
