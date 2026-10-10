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
});

describe("verifyRefs", () => {
  it("a case ref is alive when its index.md reads, dead when nothing does", async () => {
    mocks.fsReadFile.mockImplementation(async (path: string) => {
      if (path === "memory/research/手机调研/index.md") return INDEX_RAW("2026-09-01");
      throw new Error("ENOENT");
    });
    const [alive, dead] = await verifyRefs(["research/手机调研", "research/没有这个"]);
    expect(alive).toMatchObject({ kind: "case", alive: true });
    expect(dead).toMatchObject({ kind: "case", alive: false });
  });

  it("a piece ref probes the piece path, and a legacy name the old roots", async () => {
    mocks.fsReadFile.mockImplementation(async (path: string) => {
      if (path === "memory/research/手机调研/2026-09-08-报价篇.md") return "x";
      if (path === "memory/docs/topic/用户手机.md") return "x";
      throw new Error("ENOENT");
    });
    const [piece, legacy] = await verifyRefs([
      "research/手机调研/2026-09-08-报价篇",
      "用户手机",
    ]);
    expect(piece).toMatchObject({ kind: "piece", alive: true });
    expect(legacy).toMatchObject({ kind: "legacy", alive: true });
  });

  it("a record ref reads the slice store and carries the door facts", async () => {
    mocks.sliceEntryFromDisk.mockImplementation(async (rel: string) =>
      rel === "2026/10/05/1430"
        ? { id: "2026-10-05-1430", date: "2026-10-05", turn_count: 2 }
        : null,
    );
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

  it("a slice on disk but past the window is alive without a door", async () => {
    mocks.sliceEntryFromDisk.mockResolvedValue({
      id: "2020-01-01-0000",
      date: "2020-01-01",
      turn_count: 1,
    });
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
    mocks.fsReadFile.mockImplementation(async (path: string) => {
      if (path === "memory/episodic/current-previously.md") return "card";
      throw new Error("ENOENT");
    });
    const [alive, dead] = await verifyRefs(["dossier/previously", "dossier/direction"]);
    expect(alive.alive).toBe(true);
    expect(dead.alive).toBe(false);
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
