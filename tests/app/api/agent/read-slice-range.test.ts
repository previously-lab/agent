/**
 * recallRead range matrix (acceptance X-08, migrated with v0.36): the five
 * range types (turns / last / date / search / lines), the unknown-range ERROR
 * contract, and the dual-root fallback — executor level, over an in-memory
 * local fs (the docs-tools.test.ts harness pattern). No memory/ directory is
 * touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => {
  const files = new Map<string, string>();
  return { files };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (p: string) => {
    if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
    return io.files.get(p)!;
  },
  listFilesLocal: vi.fn(async () => []),
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
  deleteFileLocal: vi.fn(async () => {}),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  readFileFresh: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  invalidateReadCache: vi.fn(),
}));
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: vi.fn(async () => {
    throw new Error("demo read should not be called in local mode");
  }),
  listFilesDemo: vi.fn(async () => []),
}));

// rework-signal's two sinks — the probe stays real, its writes are captured
// (same pattern as docs-tools.test.ts).
const sinks = vi.hoisted(() => ({
  appendSignal: vi.fn(async (_signal?: unknown) => {}),
  writeAgentTimeline: vi.fn(async (_sliceId: string, _line: string) => {}),
}));
vi.mock("@/lib/evolution/store", () => ({
  appendSignal: sinks.appendSignal,
  readPlaybook: vi.fn(async () => null),
  capPlaybook: (s: string) => s,
}));
vi.mock("@/lib/episodic/manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/episodic/manager")>();
  return { ...actual, writeAgentTimeline: sinks.writeAgentTimeline };
});

import {
  recallReadExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";
import type { RecallReadRange } from "@/lib/memory/facade";

function makeCtx(sliceId: string): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId,
    recentTurns: [],
    // No timezone: the local-time annotation pass is skipped, so assertions
    // run against the raw slice text.
  };
}

function opts(ctx: ToolContext) {
  return { context: ctx, toolCallId: "tc-range" };
}

const SLICE_ID = "2026-09-04-2130";
const REF = `records/${SLICE_ID}`;
const NEW_CORE = "memory/records/2026/09/04/2130/core.md";
const LEGACY_CORE = "memory/episodic/slices/2026/09/04/2130/timeline/core.md";

const CORE_RAW = `---
slice_id: 2026-09-04-2130
start: 2026-09-04T21:30:00.000Z
timezone: Asia/Shanghai
---

## Turn u1 — 2026-09-04T21:30:00.000Z (user)

我想换手机，预算 5000。

## Turn a1 — 2026-09-04T21:31:00.000Z (agent)

推荐看看小屏旗舰。

## Turn u2 — 2026-09-04T21:35:00.000Z (user)

续航优先。
`;

beforeEach(() => {
  io.files.clear();
  io.files.set(NEW_CORE, CORE_RAW);
});

describe("recallReadExecute range matrix (X-08)", () => {
  it("no range returns the full slice", async () => {
    const out = await recallReadExecute({ ref: REF }, opts(makeCtx(SLICE_ID)));
    expect(out).toContain("我想换手机");
    expect(out).toContain("小屏旗舰");
    expect(out).toContain("续航优先");
  });

  it("range turns: only the requested 0-based turn indices come back", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "turns", indices: [0, 2] } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toContain("我想换手机");
    expect(out).toContain("续航优先");
    expect(out).not.toContain("小屏旗舰");
  });

  it("range last: only the most recent N turns come back", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "last", count: 1 } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toContain("续航优先");
    expect(out).not.toContain("我想换手机");
    expect(out).not.toContain("小屏旗舰");
  });

  it("range date: only turns at/after the given timestamp come back", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "date", after: "2026-09-04T21:33:00.000Z" } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toContain("续航优先");
    expect(out).not.toContain("我想换手机");
    expect(out).not.toContain("小屏旗舰");
  });

  it("range search: a keyword hit returns the matching turn with context", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "search", keywords: ["续航"], context: 0 } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toContain("Matched");
    expect(out).toContain("续航优先");
    expect(out).not.toContain("我想换手机");
  });

  it("range search: a miss degrades to the full slice with an explanatory note", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "search", keywords: ["不存在的关键词"] } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toContain("No segments matched");
    expect(out).toContain("full content returned");
    expect(out).toContain("我想换手机");
  });

  it("range lines: a 1-indexed inclusive line range of the raw file", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "lines", start: 1, end: 2 } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toContain(`Lines 1-2 of ${SLICE_ID}:`);
    expect(out).toContain("---\nslice_id: 2026-09-04-2130");
    expect(out).not.toContain("我想换手机");
  });

  it("range lines: an inverted range returns a visible ERROR", async () => {
    const out = await recallReadExecute(
      { ref: REF, range: { type: "lines", start: 5, end: 2 } },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toBe(`ERROR: Invalid line range 5-2 in ${SLICE_ID}.`);
  });

  // Executor guard (X-08): any range type outside the known set must surface
  // a visible ERROR instead of silently serving the full slice via the
  // classic-filter fallback. The zod enum in tools.ts guards the LLM-facing
  // boundary; this covers direct/legacy callers that bypass it.
  it("an unknown range type returns a visible ERROR instead of silently serving the full slice", async () => {
    const out = await recallReadExecute(
      {
        ref: REF,
        range: { type: "bogus" } as unknown as RecallReadRange,
      },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toBe(`ERROR: Unknown range type "bogus" in ${SLICE_ID}.`);
  });

  it("dual-root fallback: a slice that exists only under the legacy root still reads", async () => {
    io.files.delete(NEW_CORE);
    io.files.set(LEGACY_CORE, CORE_RAW);
    const out = await recallReadExecute({ ref: REF }, opts(makeCtx(SLICE_ID)));
    expect(out).toContain("我想换手机");
  });

  it("a slice under neither root returns the fixed not-found sentence (not a throw)", async () => {
    io.files.delete(NEW_CORE);
    const out = await recallReadExecute({ ref: REF }, opts(makeCtx(SLICE_ID)));
    expect(out).toBe(
      `Nothing named "${REF}" exists in memory — and nothing similar.`,
    );
  });

  it("a malformed slice id returns the fixed not-found sentence", async () => {
    const out = await recallReadExecute(
      { ref: "records/not-a-slice" },
      opts(makeCtx(SLICE_ID)),
    );
    expect(out).toBe(
      'Nothing named "records/not-a-slice" exists in memory — and nothing similar.',
    );
  });
});
