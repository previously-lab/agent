/**
 * Shelf server actions — the legacy half (v0.15 §4.2: getDocShelf /
 * getDocTopicDetail / getDocContent) and the case half (v0.19 R3b:
 * getCaseShelf / getCaseDetail / getCaseDoc, §B.1/§B.2 with §D.1 dual-root
 * tolerance). The I/O layer is mocked at the module boundary (`io-helpers`);
 * the pure `@/lib/docs` parsers run for real on fixtures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fsListFiles: vi.fn(),
  fsReadFile: vi.fn(),
  setDemoPersona: vi.fn(),
}));

vi.mock("@/lib/demo/demo-fs", () => ({
  getDemoPersona: vi.fn(() => "user"),
  listDemoPersonas: vi.fn(async () => []),
  setDemoPersona: mocks.setDemoPersona,
}));

vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: vi.fn(async () => null),
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: vi.fn(async () => []),
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

import {
  getCaseShelf,
  getCaseDetail,
  getCaseDoc,
  getDocShelf,
  getDocTopicDetail,
  getDocContent,
} from "@/lib/episodic/actions";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const TOPIC_RAW = `---
status: active
opened: 2026-09-01
updated: 2026-09-12
---
# 用户手机

> 截至 2026-09-10：用户在比较两款手机，倾向尚未定。

## 2026-09-05 — 开篇
用户想换手机，预算未定。

## 2026-09-12 — 《2026-09-05-手机购买调研》开设
《2026-09-05-手机购买调研》开设，调研结论在这里跟进。
`;

const RESEARCH_RAW = `---
status: active
opened: 2026-09-05
updated: 2026-09-05
---
# 关于手机购买的调研

> 截至 2026-09-05：问题已提出，证据收集中。

## 2026-09-05 — 开篇
为什么要查、起初知道什么。
`;

const CASE_INDEX_RAW = `---
opened: 2026-09-05
---
用户在比较两款手机，倾向尚未定。
`;

const CASE_SEALED_RAW = `---
opened: 2026-08-01
closed: 2026-08-20
---
结论：已购 A 款。
`;

const PIECE_RAW = `---
opened: 2026-09-08
---
报价对比：A 款 4999，B 款 4599。
`;

/**
 * Route fsListFiles/fsReadFile by a path → content map. `ls` synthesizes BOTH
 * child files and child directories from the map (case enumeration lists
 * directories), and throws ENOENT when the directory holds nothing.
 */
function seedFiles(files: Record<string, string>) {
  mocks.fsListFiles.mockImplementation(async (path: string) => {
    const prefix = `${path}/`;
    const children = new Map<string, "file" | "dir">();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) children.set(rest, "file");
      else children.set(rest.slice(0, slash), "dir");
    }
    if (children.size === 0) throw new Error(`ENOENT ${path}`);
    return [...children].map(([name, type]) => ({
      name,
      type,
      path: `${path}/${name}`,
    }));
  });
  mocks.fsReadFile.mockImplementation(async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT ${path}`);
    return content;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getDocShelf ───────────────────────────────────────────────────────────

describe("getDocShelf", () => {
  it("parses topic homes (as-of / latest entry / catalog count) and lists kinds", async () => {
    seedFiles({
      "memory/docs/topic/用户手机.md": TOPIC_RAW,
      "memory/docs/research/2026-09-05-手机购买调研.md": RESEARCH_RAW,
    });

    const shelf = await getDocShelf();

    expect(shelf.topics).toHaveLength(1);
    const topic = shelf.topics[0];
    expect(topic.name).toBe("用户手机");
    expect(topic.status).toBe("active");
    expect(topic.updated).toBe("2026-09-12");
    expect(topic.asOf).toContain("比较两款手机");
    expect(topic.asOfDate).toBe("2026-09-10");
    expect(topic.latestEntry).toEqual({
      date: "2026-09-12",
      title: "《2026-09-05-手机购买调研》开设",
    });
    expect(topic.catalogCount).toBe(1);

    const research = shelf.kinds.find((k) => k.kind === "research");
    expect(research?.docs).toEqual([
      {
        fileName: "2026-09-05-手机购买调研.md",
        date: "2026-09-05",
        title: "手机购买调研",
      },
    ]);
    // Every dated kind is listed, even those with no directory on disk.
    expect(shelf.kinds).toHaveLength(8);
    expect(shelf.kinds.every((k) => k.kind !== "topic")).toBe(true);
  });

  it("returns empty topics and kinds when nothing exists yet", async () => {
    mocks.fsListFiles.mockRejectedValue(new Error("ENOENT"));
    const shelf = await getDocShelf();
    expect(shelf.topics).toEqual([]);
    expect(shelf.kinds).toHaveLength(8);
    expect(shelf.kinds.every((k) => k.docs.length === 0)).toBe(true);
  });

  it("skips topic files that fail to read", async () => {
    seedFiles({ "memory/docs/topic/幽灵.md": "" });
    mocks.fsReadFile.mockRejectedValue(new Error("read failure"));
    const shelf = await getDocShelf();
    expect(shelf.topics).toEqual([]);
  });
});

// ─── getDocTopicDetail ─────────────────────────────────────────────────────

describe("getDocTopicDetail", () => {
  it("extracts catalog entries with 《…》 refs and a snippet", async () => {
    seedFiles({ "memory/docs/topic/用户手机.md": TOPIC_RAW });

    const detail = await getDocTopicDetail("用户手机");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("用户手机");
    expect(detail!.heading).toBe("用户手机");
    expect(detail!.catalog).toHaveLength(1);
    expect(detail!.catalog[0]).toMatchObject({
      date: "2026-09-12",
      refs: ["2026-09-05-手机购买调研.md"],
    });
    expect(detail!.catalog[0].snippet.length).toBeGreaterThan(0);
  });

  it("rejects unsafe names without touching I/O", async () => {
    mocks.fsReadFile.mockRejectedValue(new Error("must not be called"));
    expect(await getDocTopicDetail("../evil")).toBeNull();
    expect(await getDocTopicDetail("a/b")).toBeNull();
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
  });

  it("returns null for a topic that does not exist", async () => {
    seedFiles({});
    expect(await getDocTopicDetail("不存在")).toBeNull();
  });
});

// ─── getDocContent ─────────────────────────────────────────────────────────

describe("getDocContent", () => {
  it("reads by known kind and strips the frontmatter from the body", async () => {
    seedFiles({
      "memory/docs/research/2026-09-05-手机购买调研.md": RESEARCH_RAW,
    });

    const doc = await getDocContent("2026-09-05-手机购买调研.md", "research");
    expect(doc).not.toBeNull();
    expect(doc!.kind).toBe("research");
    expect(doc!.heading).toBe("关于手机购买的调研");
    expect(doc!.status).toBe("active");
    expect(doc!.updated).toBe("2026-09-05");
    expect(doc!.markdown).toContain("## 2026-09-05 — 开篇");
    expect(doc!.markdown).not.toContain("status: active");
  });

  it("resolves the kind from the file name when omitted", async () => {
    seedFiles({
      "memory/docs/research/2026-09-05-手机购买调研.md": RESEARCH_RAW,
    });

    const doc = await getDocContent("2026-09-05-手机购买调研.md");
    expect(doc).not.toBeNull();
    expect(doc!.kind).toBe("research");
    // The dated-kind candidates before research each missed once.
    const readPaths = mocks.fsReadFile.mock.calls.map((c) => c[0]);
    expect(readPaths).toContain("memory/docs/event/2026-09-05-手机购买调研.md");
    expect(readPaths).toContain("memory/docs/research/2026-09-05-手机购买调研.md");
  });

  it("returns null for an unknown kind or an illegal file name", async () => {
    seedFiles({
      "memory/docs/research/2026-09-05-手机购买调研.md": RESEARCH_RAW,
    });
    expect(
      await getDocContent("2026-09-05-手机购买调研.md", "bogus" as never),
    ).toBeNull();
    expect(await getDocContent("../escape.md", "research")).toBeNull();
    expect(await getDocContent("2026-09-05-1234.md", "research")).toBeNull();
  });

  it("returns null when no kind directory holds the file", async () => {
    seedFiles({});
    expect(await getDocContent("2026-09-05-手机购买调研.md")).toBeNull();
  });
});

// ─── getCaseShelf (v0.19 §B.1: the nine categories, point-read index.md) ───

describe("getCaseShelf", () => {
  it("enumerates all nine categories, tolerating missing directories, and point-reads each case's index.md", async () => {
    seedFiles({
      "memory/people/手机/index.md": CASE_INDEX_RAW,
      "memory/people/旧相机/index.md": CASE_SEALED_RAW,
      "memory/research/手机调研/index.md": CASE_INDEX_RAW,
    });

    const shelf = await getCaseShelf();

    // All nine categories are listed, empty ones included.
    expect(shelf.categories).toHaveLength(9);
    const people = shelf.categories.find((c) => c.category === "people")!;
    // Newest-born first.
    expect(people.cases.map((c) => c.name)).toEqual(["手机", "旧相机"]);
    expect(people.cases[0].opened).toBe("2026-09-05");
    expect(people.cases[0].closed).toBeNull();
    expect(people.cases[0].preview).toContain("比较两款手机");
    expect(people.cases[1].closed).toBe("2026-08-20");

    const events = shelf.categories.find((c) => c.category === "events")!;
    expect(events.cases).toEqual([]);

    // Point reads: exactly the three case index.md files, nothing else.
    // (Code-unit sort: 手 U+624B < 旧 U+65E7 < 调 U+8C03.)
    const readPaths = mocks.fsReadFile.mock.calls.map((c) => c[0]).sort();
    expect(readPaths).toEqual([
      "memory/people/手机/index.md",
      "memory/people/旧相机/index.md",
      "memory/research/手机调研/index.md",
    ]);
  });

  it("lists every category empty when no case tree exists yet", async () => {
    mocks.fsListFiles.mockRejectedValue(new Error("ENOENT"));
    const shelf = await getCaseShelf();
    expect(shelf.categories).toHaveLength(9);
    expect(shelf.categories.every((c) => c.cases.length === 0)).toBe(true);
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
  });

  it("skips case directories whose index.md is unreadable", async () => {
    seedFiles({ "memory/people/手机/index.md": CASE_INDEX_RAW });
    mocks.fsReadFile.mockImplementation(async (path: string) => {
      if (path === "memory/people/手机/index.md") throw new Error("gone");
      throw new Error(`ENOENT ${path}`);
    });
    const shelf = await getCaseShelf();
    expect(
      shelf.categories.find((c) => c.category === "people")!.cases,
    ).toEqual([]);
  });
});

// ─── getCaseDetail (one case: index.md + piece list, dual-root) ───────────

describe("getCaseDetail", () => {
  it("opens a new-root case with its dated pieces, newest first", async () => {
    seedFiles({
      "memory/people/手机/index.md": CASE_INDEX_RAW,
      "memory/people/手机/2026-09-06-比价篇.md": PIECE_RAW,
      "memory/people/手机/2026-09-08-报价篇.md": PIECE_RAW,
    });

    const detail = await getCaseDetail("people", "手机");

    expect(detail).not.toBeNull();
    expect(detail!.opened).toBe("2026-09-05");
    expect(detail!.closed).toBeNull();
    expect(detail!.markdown).toContain("比较两款手机");
    expect(detail!.markdown).not.toContain("opened:");
    expect(detail!.pieces.map((p) => p.fileName)).toEqual([
      "2026-09-08-报价篇.md",
      "2026-09-06-比价篇.md",
    ]);
    expect(detail!.pieces[0]).toMatchObject({ date: "2026-09-08", title: "报价篇" });
  });

  it("falls back to the legacy root on a new-root miss (§D.1)", async () => {
    // Only a legacy strand entity carries this name.
    seedFiles({
      "memory/episodic/strands/手机.md": `---\nfoo: bar\n---\n旧 strand 实体正文。\n`,
    });

    const detail = await getCaseDetail("people", "手机");

    expect(detail).not.toBeNull();
    expect(detail!.markdown).toContain("旧 strand 实体正文。");
    expect(detail!.markdown).not.toContain("foo: bar");
    expect(detail!.pieces).toEqual([]);
  });

  it("lists the case's attachments with image flags (§C.1); legacy hits carry none", async () => {
    seedFiles({
      "memory/people/手机/index.md": CASE_INDEX_RAW,
      "memory/people/手机/attachments/2026-09-05-photo.jpg": "binary-bytes",
      "memory/people/手机/attachments/2026-09-06-报价单.pdf": "binary-bytes",
    });

    const detail = await getCaseDetail("people", "手机");

    expect(detail).not.toBeNull();
    expect(detail!.attachments).toEqual([
      { name: "2026-09-05-photo.jpg", image: true },
      { name: "2026-09-06-报价单.pdf", image: false },
    ]);

    // A legacy-root hit has no case dir — no attachments surface.
    mocks.fsListFiles.mockClear();
    seedFiles({
      "memory/episodic/strands/旧手机.md": `---\nfoo: bar\n---\n旧实体。\n`,
    });
    const legacy = await getCaseDetail("things", "旧手机");
    expect(legacy).not.toBeNull();
    expect(legacy!.attachments).toEqual([]);
  });

  it("rejects an illegal category or case name without touching I/O", async () => {
    expect(await getCaseDetail("bogus", "手机")).toBeNull();
    expect(await getCaseDetail("people", "../evil")).toBeNull();
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
    expect(mocks.fsListFiles).not.toHaveBeenCalled();
  });

  it("returns null for a dead reference", async () => {
    seedFiles({});
    expect(await getCaseDetail("people", "不存在")).toBeNull();
  });
});

// ─── getCaseDoc (two-segment references, dual-root) ───────────────────────

describe("getCaseDoc", () => {
  it("reads a case's index.md by 分类/case名", async () => {
    seedFiles({ "memory/people/手机/index.md": CASE_SEALED_RAW });

    const doc = await getCaseDoc("people/手机");

    expect(doc).not.toBeNull();
    expect(doc!.opened).toBe("2026-08-01");
    expect(doc!.closed).toBe("2026-08-20");
    expect(doc!.markdown).toContain("已购 A 款。");
  });

  it("reads a piece by 分类/case名/篇名 (with or without .md)", async () => {
    seedFiles({
      "memory/people/手机/index.md": CASE_INDEX_RAW,
      "memory/people/手机/2026-09-08-报价篇.md": PIECE_RAW,
    });

    const doc = await getCaseDoc("people/手机/2026-09-08-报价篇");
    expect(doc).not.toBeNull();
    expect(doc!.opened).toBe("2026-09-08");
    expect(doc!.markdown).toContain("报价对比");

    const withSuffix = await getCaseDoc("people/手机/2026-09-08-报价篇.md");
    expect(withSuffix).not.toBeNull();
  });

  it("resolves a bare legacy name against the old roots (§D.1)", async () => {
    seedFiles({ "memory/docs/topic/用户手机.md": TOPIC_RAW });

    const doc = await getCaseDoc("用户手机");

    expect(doc).not.toBeNull();
    expect(doc!.opened).toBe("2026-09-01");
    // A legacy active doc reads as 还在写 (closed null).
    expect(doc!.closed).toBeNull();
    expect(doc!.markdown).toContain("## 2026-09-05 — 开篇");
  });

  it("returns null for a dead link and for an illegal reference", async () => {
    seedFiles({});
    expect(await getCaseDoc("people/不存在")).toBeNull();

    expect(await getCaseDoc("../evil")).toBeNull();
    expect(await getCaseDoc("a/b/c/d")).toBeNull();
  });
});
