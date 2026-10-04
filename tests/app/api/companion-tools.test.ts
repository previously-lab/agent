import { describe, it, expect, vi, beforeEach } from "vitest";

// Standalone executor tests for the companion read-only tool set. The read
// layer is an in-memory Map on the local backend (same fixture pattern as
// tests/app/api/agent/tool-executors.test.ts); GitHub/demo reads are mocked
// to throw so a wrong data-source dispatch fails loudly. Real parsers all
// the way down (parseSliceId, parseTurns, matter, time-localize).

const files = new Map<string, string>();

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`File not found: "${p}"`);
    return v;
  },
  // Directory listing derived from the file map — the readTimeline tool
  // enumerates month/day/slice directories live (v0.19 §A.2.4) instead of
  // reading the retired `_index.json` projection.
  listFilesLocal: async (p: string) => {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const seen = new Map<string, "file" | "dir">();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const seg = rest.split("/")[0];
      seen.set(seg, rest.includes("/") ? "dir" : "file");
    }
    if (seen.size === 0) throw new Error(`Directory not found: "${p}"`);
    return [...seen].map(([name, type]) => ({
      name,
      type,
      path: `${prefix}${name}`,
    }));
  },
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
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

import {
  buildCompanionTools,
  type CompanionToolContext,
} from "@/app/api/companion/tools";

const SLICE_ID = "2026-07-28-0658";
const SLICE_CORE_PATH =
  "memory/episodic/slices/2026/07/28/0658/timeline/core.md";

const SLICE_FIXTURE = `---
slice_id: 2026-07-28-0658
status: closed
start: '2026-07-28T06:58:22.811Z'
end: '2026-07-28T10:24:40.991Z'
focus: test focus
summary: test summary
tags: [testing]
emotional_tone: calm
open_loops: []
decisions: []
---
## Turn abc123 — 2026-07-28T06:58:22.811Z (user)

你好 这应该是我们第1次见面

## Turn def456 — 2026-07-28T06:58:43.641Z (agent)

你好！很高兴见到你！
`;

const ctx: CompanionToolContext = {
  owner: "o",
  repo: "r",
  useGithub: false,
  useDemo: false,
  timezone: "Asia/Shanghai",
  locale: "zh",
};

/** The SDK always invokes execute() with an options arg; direct test calls stub it. */
const EXEC_OPTS: {
  toolCallId: string;
  messages: never[];
  context: Record<string, unknown>;
} = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

beforeEach(() => {
  files.clear();
});

describe("companion readSlice", () => {
  it("returns the slice content from the local fixture", async () => {
    files.set(SLICE_CORE_PATH, SLICE_FIXTURE);
    const tools = buildCompanionTools(ctx);
    const result = await tools.readSlice.execute({ sliceId: SLICE_ID }, EXEC_OPTS);
    expect(result).toContain("你好 这应该是我们第1次见面");
    // Local time is pre-rendered (user timezone is set).
    expect(result).toContain("Asia/Shanghai");
    expect(result).toContain("本地");
  });

  it("returns an ERROR line for an invalid slice id", async () => {
    const tools = buildCompanionTools(ctx);
    const result = await tools.readSlice.execute({ sliceId: "not-a-slice" }, EXEC_OPTS);
    expect(result).toContain("ERROR: Invalid slice ID");
  });

  it("returns an ERROR line for a missing slice", async () => {
    const tools = buildCompanionTools(ctx);
    const result = await tools.readSlice.execute({ sliceId: SLICE_ID }, EXEC_OPTS);
    expect(result).toContain("ERROR: File not found");
    expect(result).toContain("does not exist");
  });
});

describe("companion readSliceSummary", () => {
  it("returns frontmatter fields and the turn count", async () => {
    files.set(SLICE_CORE_PATH, SLICE_FIXTURE);
    const tools = buildCompanionTools(ctx);
    const result = await tools.readSliceSummary.execute({ sliceId: SLICE_ID }, EXEC_OPTS);
    expect(result).toContain(`slice ${SLICE_ID}`);
    expect(result).toContain("focus: test focus");
    expect(result).toContain("summary: test summary");
    expect(result).toContain("turns: 2");
    // tags are retired (§B.5 — stopped being written): the summary no longer
    // carries a tags line even when legacy frontmatter still has the field.
    expect(result).not.toContain("tags:");
    // Timestamps in the summary stay UTC, annotated with the user's zone.
    expect(result).toContain("本地时区 Asia/Shanghai");
  });

  it("returns an ERROR line for a missing slice", async () => {
    const tools = buildCompanionTools(ctx);
    const result = await tools.readSliceSummary.execute({ sliceId: SLICE_ID }, EXEC_OPTS);
    expect(result).toContain("ERROR: File not found");
  });
});

describe("companion readTimeline", () => {
  // M1 (read side): the month directory IS the index — slices are enumerated
  // live from the tree and their headers point-read; no `_index.json`
  // projection is consulted, so a month whose index was never written (or is
  // stale) still lists whole.
  it("enumerates the month live and pre-renders localStart (no _index.json on disk)", async () => {
    files.set(SLICE_CORE_PATH, SLICE_FIXTURE);
    const tools = buildCompanionTools(ctx);
    const result = (await tools.readTimeline.execute({
      year: 2026,
      month: 7,
    }, EXEC_OPTS)) as {
      exists: boolean;
      slices: Array<{ id: string; focus?: string; localStart?: string }>;
      timezoneNote?: string;
    };
    expect(result.exists).toBe(true);
    expect(result.slices.map((s) => s.id)).toEqual([SLICE_ID]);
    expect(result.slices[0].focus).toBe("test focus");
    expect(result.slices[0].localStart).toBeTruthy();
    expect(result.timezoneNote).toContain("localStart");
  });

  it("merges both roots so a month straddling the root move reads whole", async () => {
    // One slice still on the legacy layout, one on the new records root.
    files.set(SLICE_CORE_PATH, SLICE_FIXTURE);
    files.set(
      "memory/records/2026/07/29/1015/core.md",
      SLICE_FIXTURE.replaceAll("2026-07-28-0658", "2026-07-29-1015")
        .replaceAll("2026-07-28T", "2026-07-29T")
        .replace("focus: test focus", "focus: new root focus"),
    );
    const tools = buildCompanionTools(ctx);
    const result = (await tools.readTimeline.execute({
      year: 2026,
      month: 7,
    }, EXEC_OPTS)) as { exists: boolean; slices: Array<{ id: string }> };
    expect(result.exists).toBe(true);
    expect(result.slices.map((s) => s.id)).toEqual([
      "2026-07-28-0658",
      "2026-07-29-1015",
    ]);
  });

  it("degrades to an empty month when nothing exists", async () => {
    const tools = buildCompanionTools(ctx);
    const result = (await tools.readTimeline.execute({
      year: 2026,
      month: 1,
    }, EXEC_OPTS)) as { exists: boolean; month: string; slices: unknown[] };
    expect(result).toEqual({ exists: false, month: "2026-01", slices: [] });
  });
});
