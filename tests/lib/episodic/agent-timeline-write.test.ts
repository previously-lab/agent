/**
 * writeAgentTimeline (manager.ts) — the agent.md append path after the T-09
 * fix: the read that feeds the write is FRESH, and the read-modify-write is
 * serialized per slice via withSliceLock. A caller that passes a batch is
 * already inside the turn's slice lock (persistAgentTurn), so the lock must
 * NOT be re-taken there (same-key self-deadlock).
 *
 * io-helpers and slice-mutex are mocked; paths.ts stays real so the dual-root
 * probe order and the write target are exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => ({
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(async (path: string, _content: string) => ({
    path,
    created: true,
  })),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: io.fsReadFile,
  fsWriteFile: io.fsWriteFile,
  fsListFiles: vi.fn(async () => []),
}));

const mutex = vi.hoisted(() => ({
  withSliceLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/episodic/slice-mutex", () => ({
  withSliceLock: mutex.withSliceLock,
}));

import { writeAgentTimeline } from "@/lib/episodic/manager";

const SLICE = "2026-08-09-1300";
const AGENT_PATH = "memory/records/2026/08/09/1300/agent.md";
const LEGACY_AGENT_PATH =
  "memory/episodic/slices/2026/08/09/1300/timeline/agent.md";

beforeEach(() => {
  io.fsReadFile.mockReset();
  io.fsWriteFile.mockClear();
  mutex.withSliceLock.mockClear();
});

describe("writeAgentTimeline — locked fresh read-modify-write", () => {
  it("batch-less call takes the per-slice lock and reads fresh before writing", async () => {
    io.fsReadFile.mockRejectedValue(new Error("not found"));

    await writeAgentTimeline(SLICE, "NEW ENTRY");

    expect(mutex.withSliceLock).toHaveBeenCalledTimes(1);
    expect(mutex.withSliceLock).toHaveBeenCalledWith(SLICE, expect.any(Function));
    // Both probe reads are fresh; the write target is the new root.
    expect(io.fsReadFile).toHaveBeenNthCalledWith(1, AGENT_PATH, undefined, {
      fresh: true,
    });
    expect(io.fsReadFile).toHaveBeenNthCalledWith(2, LEGACY_AGENT_PATH, undefined, {
      fresh: true,
    });
    expect(io.fsWriteFile).toHaveBeenCalledWith(AGENT_PATH, "NEW ENTRY", undefined);
    // The I/O ran INSIDE the lock, not before it.
    expect(mutex.withSliceLock.mock.invocationCallOrder[0]).toBeLessThan(
      io.fsReadFile.mock.invocationCallOrder[0],
    );
    expect(io.fsReadFile.mock.invocationCallOrder[0]).toBeLessThan(
      io.fsWriteFile.mock.invocationCallOrder[0],
    );
  });

  it("appends onto the existing content (seeded by the legacy root on a new-root miss)", async () => {
    io.fsReadFile.mockImplementation(async (path: string) => {
      if (path === LEGACY_AGENT_PATH) return "old line\n";
      throw new Error("not found");
    });

    await writeAgentTimeline(SLICE, "NEW ENTRY");

    expect(io.fsWriteFile).toHaveBeenCalledWith(
      AGENT_PATH,
      "old line\n\nNEW ENTRY",
      undefined,
    );
  });

  it("batched call does NOT re-take the lock — the caller (persistAgentTurn) already holds it", async () => {
    io.fsReadFile.mockResolvedValue("existing body");
    const batch = { entries: new Map<string, string | null>() };

    await writeAgentTimeline(SLICE, "NEW ENTRY", batch);

    expect(mutex.withSliceLock).not.toHaveBeenCalled();
    expect(io.fsReadFile).toHaveBeenCalledWith(AGENT_PATH, batch, {
      fresh: true,
    });
    expect(io.fsWriteFile).toHaveBeenCalledWith(
      AGENT_PATH,
      "existing body\n\nNEW ENTRY",
      batch,
    );
  });
});
