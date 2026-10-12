/**
 * The archive's reference-liveness and room-papers reads (v0.22 §7 / v0.25a
 * §五). The I/O layer is mocked at the module boundary (io-helpers, the
 * slice store, the enumeration) — the doc-shelf test's own pattern; the
 * parsers and the tokenizer run for real on fixtures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fsListFiles: vi.fn(),
  fsReadFile: vi.fn(),
  sliceEntryFromDisk: vi.fn(),
  enumerateSliceIds: vi.fn(),
  enumerateTreePaths: vi.fn(),
}));

vi.mock("@/lib/demo/demo-fs", () => ({
  getDemoPersona: vi.fn(() => "user"),
  listDemoPersonas: vi.fn(async () => []),
  setDemoPersona: vi.fn(),
}));

vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: mocks.sliceEntryFromDisk,
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: mocks.enumerateSliceIds,
  enumerateTreePaths: mocks.enumerateTreePaths,
}));

vi.mock("@/lib/episodic/manager", () => ({
  readSliceBody: vi.fn(),
  parseSlice: vi.fn(),
  sliceIdToFilePath: vi.fn(),
  readPreviously: vi.fn(),
  readAgentTimeline: vi.fn(),
  loadSlice: vi.fn(),
  readStrands: vi.fn(),
}));

vi.mock("@/lib/config/loader", () => ({
  loadUserConfig: vi.fn(),
  invalidateUserConfigCache: vi.fn(),
}));

vi.mock("@/lib/episodic/io-helpers", () => ({
  fsListFiles: mocks.fsListFiles,
  fsReadFile: mocks.fsReadFile,
  fsWriteFile: vi.fn(),
  createBatch: vi.fn(),
  flushBatch: vi.fn(),
}));

import { getRoomPapers, verifyRefs } from "@/lib/archive/actions";

const INDEX_RAW = (opened: string, body = ""): string =>
  `---\nopened: ${JSON.stringify(opened)}\n---\n\n# 案\n\n${body}\n`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fsListFiles.mockRejectedValue(new Error("ENOENT"));
  mocks.fsReadFile.mockRejectedValue(new Error("ENOENT"));
  mocks.sliceEntryFromDisk.mockResolvedValue(null);
  mocks.enumerateSliceIds.mockResolvedValue([]);
  mocks.enumerateTreePaths.mockResolvedValue([]);
});

describe("verifyRefs", () => {
  it("a case ref is alive when its index.md is in the tree, dead when absent", async () => {
    // Wave B: existence is membership in the enumerated path set (the cached
    // tree on GitHub) — no per-candidate probe reads anymore.
    mocks.enumerateTreePaths.mockResolvedValue([
      "memory",
      "memory/research",
      "memory/research/手机调研",
      "memory/research/手机调研/index.md",
    ]);
    const [alive, dead] = await verifyRefs(["research/手机调研", "research/没有这个"]);
    expect(alive).toMatchObject({ kind: "case", alive: true });
    expect(dead).toMatchObject({ kind: "case", alive: false });
  });

  it("a piece ref resolves on its piece path, and a legacy name on the old roots", async () => {
    mocks.enumerateTreePaths.mockResolvedValue([
      "memory/research/手机调研/2026-09-08-报价篇.md",
      "memory/docs/topic/用户手机.md",
    ]);
    const [piece, legacy] = await verifyRefs([
      "research/手机调研/2026-09-08-报价篇",
      "用户手机",
    ]);
    expect(piece).toMatchObject({ kind: "piece", alive: true });
    expect(legacy).toMatchObject({ kind: "legacy", alive: true });
  });

  it("a record ref is alive on core.md membership — on EITHER root — and its door date is the id's own", async () => {
    // The legacy root's core.md lives under timeline/ (paths.ts) — membership
    // there must answer alive exactly as the new root does.
    mocks.enumerateTreePaths.mockResolvedValue([
      "memory/episodic/slices/2026/10/05/1430/timeline/core.md",
    ]);
    mocks.enumerateSliceIds.mockResolvedValue([
      "2026/10/06/0900",
      "2026/10/05/1430",
    ]);
    const [inWindow, gone] = await verifyRefs([
      "records/2026-10-05-1430",
      "records/2020-01-01-0000",
    ]);
    expect(inWindow).toMatchObject({
      kind: "record",
      alive: true,
      door: { date: "2026-10-05", inHotelWindow: true },
    });
    expect(gone).toMatchObject({ kind: "record", alive: false });
    expect(gone.door).toBeUndefined();
  });

  it("dead case/piece/record refs cost ZERO point reads", async () => {
    // The audit's core promise: a document rich in dead refs re-pays nothing
    // — the path set (one tree slice) answers every existence question.
    mocks.enumerateTreePaths.mockResolvedValue(["memory"]);
    const out = await verifyRefs([
      "research/没有这个",
      "research/手机调研/2026-09-08-报价篇",
      "records/2020-01-01-0000",
    ]);
    expect(out.map((r) => r.alive)).toEqual([false, false, false]);
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
    expect(mocks.sliceEntryFromDisk).not.toHaveBeenCalled();
  });

  it("a slice on disk but past the window is alive without a door", async () => {
    mocks.enumerateTreePaths.mockResolvedValue([
      "memory/records/2020/01/01/0000/core.md",
    ]);
    // The enumeration's newest-first rank past 200: 201 newer slices.
    mocks.enumerateSliceIds.mockResolvedValue([
      ...Array.from(
        { length: 201 },
        (_, i) => `2026/10/07/${String(i).padStart(4, "0")}`,
      ),
      "2020/01/01/0000",
    ]);
    const [r] = await verifyRefs(["records/2020-01-01-0000"]);
    expect(r).toMatchObject({ alive: true, door: { inHotelWindow: false } });
  });

  it("a dossier ref is alive when its document reads non-empty", async () => {
    // The dossier's rule is a non-empty BODY, not mere existence — the one
    // kind that still reads (blob-cached by sha on GitHub).
    mocks.fsReadFile.mockImplementation(async (path: string) => {
      if (path === "memory/episodic/current-previously.md") return "card";
      throw new Error("ENOENT");
    });
    const [alive, dead] = await verifyRefs(["dossier/previously", "dossier/direction"]);
    expect(alive.alive).toBe(true);
    expect(dead.alive).toBe(false);
  });

  it("a failed path-set enumeration fails dead, never throws", async () => {
    mocks.enumerateTreePaths.mockRejectedValue(new Error("boom"));
    const [r] = await verifyRefs(["research/手机调研"]);
    expect(r).toMatchObject({ kind: "case", alive: false });
  });

  it("dedupes and never throws on unparseable input", async () => {
    const out = await verifyRefs(["research/手机调研", "research/手机调研", "research/"]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: "case", alive: false });
  });
});

describe("getRoomPapers", () => {
  const SLICE = "2026-10-05-1430";

  function seedCasesTree(): void {
    mocks.fsListFiles.mockImplementation(async (path: string) => {
      if (path === "memory/research") {
        return [
          { name: "手机调研", type: "dir" },
          { name: "无关案例", type: "dir" },
        ];
      }
      if (path === "memory/research/手机调研") {
        return [
          { name: "index.md", type: "file" },
          { name: "2026-10-05-报价篇.md", type: "file" },
        ];
      }
      if (path === "memory/research/无关案例") {
        return [{ name: "index.md", type: "file" }];
      }
      throw new Error("ENOENT");
    });
    mocks.fsReadFile.mockImplementation(async (path: string) => {
      if (path === "memory/research/手机调研/index.md") {
        return INDEX_RAW("2026-09-01", `正文。\n\n(refs: ${SLICE})`);
      }
      if (path === "memory/research/手机调研/2026-10-05-报价篇.md") {
        return `---\nopened: "2026-10-05"\n---\n\n篇。(refs: ${SLICE})\n`;
      }
      if (path === "memory/research/无关案例/index.md") {
        return INDEX_RAW("2026-09-02", "与这个切片无关。");
      }
      throw new Error("ENOENT");
    });
  }

  it("the room's own record leads, then the stamped documents newest first", async () => {
    seedCasesTree();
    const papers = await getRoomPapers(SLICE);
    expect(papers.map((p) => p.ref)).toEqual([
      `records/${SLICE}`,
      "research/手机调研/2026-10-05-报价篇",
      "research/手机调研",
    ]);
    expect(papers[0]).toMatchObject({ kind: "record", date: "2026-10-05" });
    expect(papers[1]).toMatchObject({
      kind: "piece",
      title: "报价篇",
      date: "2026-10-05",
    });
    expect(papers[2]).toMatchObject({ kind: "case", title: "手机调研" });
  });

  it("a slice nothing stamps still has its own transcript paper", async () => {
    mocks.fsListFiles.mockRejectedValue(new Error("ENOENT"));
    const papers = await getRoomPapers(SLICE);
    expect(papers.map((p) => p.kind)).toEqual(["record"]);
  });

  it("an illegal slice id earns nothing", async () => {
    expect(await getRoomPapers("../etc")).toEqual([]);
    expect(await getRoomPapers("2026-10-5-143")).toEqual([]);
  });
});
