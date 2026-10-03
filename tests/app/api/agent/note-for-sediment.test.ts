/**
 * noteForSediment (v0.15 design §3.1/§4.3) — the sediment mailbox PRODUCER.
 *
 * The executor runs against a real in-memory local fs and the REAL consumer
 * parser (librarian.ts's extractDocMarkers): every test re-verifies that the
 * appended line round-trips through the exact contract the scribe/librarian
 * passes parse. No memory/ directory is touched — all paths are map keys.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => {
  // io-helpers resolves its backend at module load; without this, the vitest
  // env (NODE_ENV=test, no STORAGE) auto-detects "demo" and writes would
  // route to the demo backend.
  process.env.STORAGE = "local";
  const files = new Map<string, string>();
  return { files };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (p: string) => {
    if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
    return io.files.get(p)!;
  },
  writeFileLocal: async (p: string, content: string) => {
    const created = !io.files.has(p);
    io.files.set(p, content);
    return { path: p, created };
  },
  listFilesLocal: vi.fn(async () => []),
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
  writeFileDemo: vi.fn(async () => {
    throw new Error("demo write should not be called");
  }),
}));

import {
  noteForSedimentExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";
import {
  extractDocMarkers,
  DOC_MARKER_PREFIX,
} from "@/lib/episodic/flash/librarian";

const SLICE = "2026-09-10-1000";
const AGENT_PATH =
  "memory/episodic/slices/2026/09/10/1000/timeline/agent.md";
const CORE_PATH =
  "memory/episodic/slices/2026/09/10/1000/timeline/core.md";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId: SLICE,
    recentTurns: [],
    ...overrides,
  };
}

function opts(ctx: ToolContext, toolCallId = "tc-1") {
  return { context: ctx, toolCallId };
}

beforeEach(() => {
  io.files.clear();
});

describe("noteForSedimentExecute", () => {
  it("appends one [doc-marker] line that the librarian parser round-trips", async () => {
    const r = await noteForSedimentExecute(
      {
        kind: "sediment",
        docType: "research",
        title: "手机购买调研",
        note: "用户比较了小屏旗舰",
        topics: ["用户手机"],
      },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const raw = io.files.get(AGENT_PATH);
    expect(raw).toBeDefined();
    // Exactly ONE marker line, and it parses through the REAL consumer.
    const lines = raw!.trimEnd().split("\n");
    expect(lines.filter((l) => l.startsWith(DOC_MARKER_PREFIX))).toHaveLength(1);
    const markers = extractDocMarkers(raw!);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      v: 1,
      id: `${SLICE}-tc-1`,
      kind: "sediment",
      docType: "research",
      title: "手机购买调研",
      note: "用户比较了小屏旗舰",
      topics: ["用户手机"],
    });

    // 记账绝不碰证据正文。
    expect(io.files.has(CORE_PATH)).toBe(false);
  });

  it("carries a task's date anchor and kind verbatim", async () => {
    const r = await noteForSedimentExecute(
      {
        kind: "task",
        title: "8 号团队 on-site",
        note: "用户口述的日期锚承诺",
        dateAnchor: "2026-09-08",
      },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(true);
    const markers = extractDocMarkers(io.files.get(AGENT_PATH)!);
    expect(markers[0]).toMatchObject({
      kind: "task",
      dateAnchor: "2026-09-08",
      title: "8 号团队 on-site",
    });
  });

  it("is idempotent: a retried step with the same toolCallId appends nothing twice", async () => {
    const ctx = makeCtx();
    const input = { kind: "question" as const, title: "充电器要不要一起买" };
    const first = await noteForSedimentExecute(input, opts(ctx, "tc-retry"));
    expect(first.ok).toBe(true);
    expect(first).not.toHaveProperty("duplicate");

    const second = await noteForSedimentExecute(input, opts(ctx, "tc-retry"));
    expect(second.ok).toBe(true);
    expect(second).toHaveProperty("duplicate", true);

    const markers = extractDocMarkers(io.files.get(AGENT_PATH)!);
    expect(markers).toHaveLength(1);
  });

  it("opens agent.md when none exists yet (single line, trailing newline)", async () => {
    const r = await noteForSedimentExecute(
      { kind: "sediment", title: "新调研" },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(true);
    const raw = io.files.get(AGENT_PATH)!;
    expect(raw.startsWith(DOC_MARKER_PREFIX)).toBe(true);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("preserves existing agent.md content and appends after it", async () => {
    io.files.set(AGENT_PATH, "# agent timeline\n\n- **recall_verify** entry\n");
    const r = await noteForSedimentExecute(
      { kind: "sediment", title: "后续条目" },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(true);
    const raw = io.files.get(AGENT_PATH)!;
    expect(raw.startsWith("# agent timeline")).toBe(true);
    const lastLine = raw.trimEnd().split("\n").pop()!;
    expect(lastLine.startsWith(DOC_MARKER_PREFIX)).toBe(true);
    const markers = extractDocMarkers(raw);
    expect(markers).toHaveLength(1);
    expect(markers[0].title).toBe("后续条目");
  });

  it("refuses demo mode without writing anything", async () => {
    const r = await noteForSedimentExecute(
      { kind: "sediment", title: "x" },
      opts(makeCtx({ useDemo: true })),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("Demo");
    expect(io.files.size).toBe(0);
  });

  it("refuses an entity sediment without entityKind (the scribe would skip it)", async () => {
    const r = await noteForSedimentExecute(
      { kind: "sediment", docType: "entity", title: "某物" },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("entityKind");
    expect(io.files.size).toBe(0);
  });

  it("refuses a malformed dateAnchor", async () => {
    const r = await noteForSedimentExecute(
      { kind: "task", title: "x", dateAnchor: "8 号" },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("YYYY-MM-DD");
    expect(io.files.size).toBe(0);
  });

  it("refuses an empty title", async () => {
    const r = await noteForSedimentExecute(
      { kind: "sediment", title: "   " },
      opts(makeCtx()),
    );
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
  });
});
