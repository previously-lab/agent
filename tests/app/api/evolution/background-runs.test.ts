import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The background stream's two durable runs (v0.19 §A.2.3). The writer passes
 * (librarian / doc-research / card evolution) are mocked at their module
 * boundaries — what is under test here is the RUN's own contract: trigger
 * discipline, the ①→② order and its seam, empty-pass legality, re-run
 * idempotency via the self/evolution reflection line, and the §A.3.3
 * completion notice.
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

// The passes are mocked at their boundaries; everything ELSE in the librarian
// module (marker parsing, applyCaseWriteIntent, buildSliceExcerpt) stays real.
const passes = vi.hoisted(() => ({
  runLibrarianPass: vi.fn(),
  runDocResearchPass: vi.fn(),
  runCardEvolution: vi.fn(),
  calls: [] as string[],
}));
vi.mock("@/lib/episodic/flash/librarian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/flash/librarian")>();
  return {
    ...actual,
    runLibrarianPass: passes.runLibrarianPass,
  };
});
vi.mock("@/lib/episodic/flash/doc-research", () => ({
  runDocResearchPass: passes.runDocResearchPass,
}));
vi.mock("@/app/api/evolution/run-card-evolution", () => ({
  runCardEvolution: passes.runCardEvolution,
}));

vi.mock("@/lib/models/registry", () => ({
  getModel: vi.fn(() => ({ id: "test-model" })),
  getDefaultModelId: vi.fn(() => "test-model"),
}));

vi.mock("@/lib/evolution/store", () => ({
  readUserModel: vi.fn(async (): Promise<null> => null),
  // detectDirectionMode (kept real) needs this from the store module.
  isDirectionTemplate: (current: string | null): boolean =>
    !current || !current.trim(),
}));

import {
  executeBoundaryRun,
  executeQuestionRun,
} from "@/app/api/evolution/background-steps";
import { parseCaseDoc } from "@/lib/docs";

const DATE = "2026-08-09";
const SLICE_ID = "2026-08-09-1300";
const REFLECTION_PATH = "memory/self/evolution/index.md";

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
  passes.runLibrarianPass.mockImplementation(async () => {
    passes.calls.push("librarian");
    return { voided: [], llmRan: true, written: [], skipped: [] };
  });
  passes.runCardEvolution.mockImplementation(async () => {
    passes.calls.push("card");
    return { ran: true, changed: false, droppedRecent: 0, note: "reviewed" };
  });
  passes.runDocResearchPass.mockImplementation(async () => {
    passes.calls.push("research");
    return { ran: true, written: [], skipped: [] };
  });
  seedSlice();
});

describe("executeBoundaryRun (§A.2.3-a)", () => {
  it("an empty pass is a legal outcome — and still records its reflection line", async () => {
    const outcome = await executeBoundaryRun({ sliceId: SLICE_ID, date: DATE });

    expect(outcome).toEqual({ ran: true, written: [], cardChanged: false });
    // ① ran (and went idle by itself), ② ran — no "worth it" gate anywhere.
    expect(passes.calls).toEqual(["librarian", "card"]);
    // ③ — the reflection line lands even on an idle pass (it IS the dedup basis).
    const reflection = io.files.get(REFLECTION_PATH) ?? "";
    expect(reflection).toContain(SLICE_ID.replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{4})$/, "$1/$2/$3/$4"));
    expect(reflection).toContain("（无——这一片没有值得写的东西）");
    expect(reflection).toContain(DATE);
  });

  it("② runs after ① and cites ①'s products (the focus seam)", async () => {
    passes.runLibrarianPass.mockImplementation(async () => {
      passes.calls.push("librarian");
      return {
        voided: [],
        llmRan: true,
        written: ["research/手机购买调研/index.md"],
        skipped: [],
      };
    });

    await executeBoundaryRun({ sliceId: SLICE_ID, date: DATE });

    expect(passes.calls).toEqual(["librarian", "card"]);
    const cardInput = passes.runCardEvolution.mock.calls[0][0] as {
      signal: string;
      closedSliceId?: string;
      focus?: string;
      allowedSopWrites?: string[];
    };
    expect(cardInput.signal).toBe("slice_closed");
    expect(cardInput.closedSliceId).toBe(SLICE_ID);
    expect(cardInput.focus).toContain("research/手机购买调研/index.md");
    // ③'s craft half — SOP writes ride the merged run.
    expect(cardInput.allowedSopWrites).toEqual(["recall", "search", "thinkdeep"]);
    // The reflection line names what was updated.
    expect(io.files.get(REFLECTION_PATH)).toContain("research/手机购买调研/index.md");
  });

  it("a re-run goes idle on the reflection line and overwrites nothing", async () => {
    const first = await executeBoundaryRun({ sliceId: SLICE_ID, date: DATE });
    expect(first.ran).toBe(true);
    const reflectionAfterFirst = io.files.get(REFLECTION_PATH);
    expect(reflectionAfterFirst).toBeDefined();
    vi.clearAllMocks();

    const second = await executeBoundaryRun({ sliceId: SLICE_ID, date: DATE });

    expect(second).toEqual({ ran: false, written: [], cardChanged: false });
    expect(passes.runLibrarianPass).not.toHaveBeenCalled();
    expect(passes.runCardEvolution).not.toHaveBeenCalled();
    // Nothing was rewritten — the existing content stands.
    expect(io.files.get(REFLECTION_PATH)).toBe(reflectionAfterFirst);
  });

  it("an unreadable slice logs and idles without writing anything", async () => {
    episodic.loadSlice.mockResolvedValue(null);
    const outcome = await executeBoundaryRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.ran).toBe(false);
    expect(passes.runLibrarianPass).not.toHaveBeenCalled();
    expect(io.files.has(REFLECTION_PATH)).toBe(false);
  });
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
