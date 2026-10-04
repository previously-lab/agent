import { describe, it, expect, vi, beforeEach } from "vitest";

// The I/O seam is mocked so we can assert the WRITE SURFACE of closeSlice:
// after v0.19 §A.2.4/§B.5 the monthly `_index.json` and `strands.json`
// projections are retired — closing a slice must write ONLY its core.md.
const io = vi.hoisted(() => ({
  fsWriteFile: vi.fn(),
  fsReadFile: vi.fn(),
  fsListFiles: vi.fn(),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsWriteFile: io.fsWriteFile,
  fsReadFile: io.fsReadFile,
  fsListFiles: io.fsListFiles,
}));

import { closeSlice } from "@/lib/episodic/manager";
import type { TimeSlice } from "@/lib/episodic/types";

function aSlice(tags: string[]): TimeSlice {
  return {
    slice_id: "2026-07-10-1430",
    focus: "test",
    status: "active",
    start: "2026-07-10T14:30:00Z",
    timezone: "UTC",
    summary: "",
    open_loops: [],
    decisions: [],
    tags,
    related_slices: [],
    loops: [],
    turns: [{ role: "user", content: "hi", timestamp: "2026-07-10T14:31:00Z" }],
    estimatedTokens: 10,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.fsWriteFile.mockResolvedValue(undefined);
});

describe("closeSlice write surface (projections retired)", () => {
  it("writes only the slice's core.md — no _index.json, no strands.json", async () => {
    await closeSlice(aSlice([]), "time_silence");
    expect(io.fsWriteFile).toHaveBeenCalledTimes(1);
    const [path] = io.fsWriteFile.mock.calls[0] as [string, string];
    expect(path).toBe("memory/records/2026/07/10/1430/core.md");
  });

  it("does not revive the strands write even for a slice carrying legacy tags", async () => {
    // M4: the orphan-reclose path can hand closeSlice a slice with legacy
    // tags — that must no longer reach the retired strands.json write path.
    await closeSlice(aSlice(["legacy-topic"]), "time_silence");
    const paths = io.fsWriteFile.mock.calls.map(
      (c) => (c as [string, ...unknown[]])[0],
    );
    expect(paths.every((p) => !p.endsWith("_index.json"))).toBe(true);
    expect(paths.every((p) => !p.endsWith("strands.json"))).toBe(true);
  });
});
