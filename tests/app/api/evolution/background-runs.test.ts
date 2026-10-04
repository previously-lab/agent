import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The background stream's question run (v0.19 §A.2.3-b, v0.21 §5) — the
 * boundary run is retired (v0.21 P4: HQ's only trigger is the field's
 * report). The doc-research pass is mocked at its module boundary — what is
 * under test here is the RUN's own contract: trigger discipline, empty-pass
 * legality, results-only storage (no run ledger — dedup is writer-is-reader
 * inside the passes), and the §A.3.3 completion notice.
 */

// In-memory memory root (same pattern as tests/lib/episodic/*).
const io = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async (path: string) => {
    const prefix = `${path}/`;
    return [...io.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => {
        const rest = p.slice(prefix.length);
        return {
          name: rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest,
          type: (rest.includes("/") ? "dir" : "file") as "dir" | "file",
          path: p,
        };
      });
  }),
}));

vi.mock("@/lib/episodic/slice-mutex", () => ({
  withSliceLock: vi.fn(async (_key: string, fn: () => unknown) => fn()),
}));

const episodic = vi.hoisted(() => ({
  loadSlice: vi.fn(),
  readSlicePart: vi.fn(async (sliceId: string, part: string) => {
    const v = io.files.get(`${sliceId}:${part}`);
    if (v === undefined) throw new Error(`missing ${sliceId}:${part}`);
    return v;
  }),
  slicePartPathCandidates: vi.fn(
    (sliceId: string, part: string) =>
      [`memory/records/${sliceId}/${part}.md`, `legacy/${sliceId}/${part}.md`] as [
        string,
        string,
      ],
  ),
}));
vi.mock("@/lib/episodic", () => episodic);

// The doc-research pass is mocked at its boundary; everything in the
// librarian module (marker parsing, applyCaseWriteIntent, buildSliceExcerpt)
// stays real.
const passes = vi.hoisted(() => ({
  runDocResearchPass: vi.fn(),
  calls: [] as string[],
}));
vi.mock("@/lib/episodic/flash/doc-research", () => ({
  runDocResearchPass: passes.runDocResearchPass,
}));

vi.mock("@/lib/models/registry", () => ({
  getModel: vi.fn(() => ({ id: "test-model" })),
  getDefaultModelId: vi.fn(() => "test-model"),
}));

import { executeQuestionRun } from "@/app/api/evolution/background-steps";
import { parseCaseDoc } from "@/lib/docs";

const DATE = "2026-08-09";
const SLICE_ID = "2026-08-09-1300";

function seedSlice(overrides: Record<string, unknown> = {}) {
  episodic.loadSlice.mockResolvedValue({
    slice_id: SLICE_ID,
    focus: "手机话题",
    summary: "聊了换手机",
    status: "closed",
    tags: [],
    turns: [
      { timestamp: "t0", role: "user", content: "想换手机" },
      { timestamp: "t1", role: "agent", content: "预算多少" },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  passes.calls.length = 0;
  passes.runDocResearchPass.mockImplementation(async () => {
    passes.calls.push("research");
    return { ran: true, written: [], skipped: [] };
  });
  seedSlice();
});

describe("executeQuestionRun (§A.2.3-b)", () => {
  const QUESTION_MAILBOX =
    '[doc-marker] {"v":1,"id":"q-1","kind":"question","title":"手机话题这一年的演变","note":""}\n';

  it("no unanswered question markers → idle, no pass, no notice", async () => {
    io.files.set(`${SLICE_ID}:agent`, "");
    episodic.readSlicePart.mockResolvedValue("");
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.ran).toBe(false);
    expect(passes.runDocResearchPass).not.toHaveBeenCalled();
    expect([...io.files.keys()].some((k) => k.startsWith("memory/tasks/"))).toBe(false);
  });

  it("research that lands posts a §A.3.3 completion notice (real task case, closed, declarative statement)", async () => {
    episodic.readSlicePart.mockResolvedValue(QUESTION_MAILBOX);
    passes.runDocResearchPass.mockImplementation(async () => {
      passes.calls.push("research");
      return {
        ran: true,
        written: ["research/手机话题演变/index.md"],
        skipped: [],
      };
    });

    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });

    expect(outcome.ran).toBe(true);
    expect(outcome.noticePath).toBe("memory/tasks/后台回复/index.md");
    const raw = io.files.get("memory/tasks/后台回复/index.md");
    expect(raw).toBeDefined();
    const doc = parseCaseDoc(raw!, {
      category: "tasks",
      caseName: "后台回复",
      fileName: "index.md",
    });
    // The completion credential: closed, with the closing line dated today.
    expect(doc.closed).toBe(DATE);
    const closing = doc.tail.find((l) => l.date === DATE);
    expect(closing).toBeDefined();
    expect(closing!.text).toContain("手机话题这一年的演变");
    expect(closing!.text).toContain("research/手机话题演变/index.md");
  });

  it("a pass that wrote nothing posts no notice (conservative agenda)", async () => {
    episodic.readSlicePart.mockResolvedValue(QUESTION_MAILBOX);
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.ran).toBe(true);
    expect(outcome.noticePath).toBeUndefined();
    expect([...io.files.keys()].some((k) => k.startsWith("memory/tasks/"))).toBe(false);
  });

  it("a second notice on the same day appends a tail line instead of failing", async () => {
    episodic.readSlicePart.mockResolvedValue(QUESTION_MAILBOX);
    passes.runDocResearchPass.mockImplementation(async () => ({
      ran: true,
      written: ["research/手机话题演变/index.md"],
      skipped: [],
    }));
    await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    // Second run, another landing — the case is sealed now.
    passes.runDocResearchPass.mockImplementation(async () => ({
      ran: true,
      written: ["research/另一问题/index.md"],
      skipped: [],
    }));
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });

    expect(outcome.noticePath).toBe("memory/tasks/后台回复/index.md");
    const doc = parseCaseDoc(io.files.get("memory/tasks/后台回复/index.md")!, {
      category: "tasks",
      caseName: "后台回复",
      fileName: "index.md",
    });
    const todayLines = doc.tail.filter((l) => l.date === DATE);
    expect(todayLines).toHaveLength(2);
    expect(todayLines[1].text).toContain("research/另一问题/index.md");
  });
});
