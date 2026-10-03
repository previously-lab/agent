/**
 * Document-shelf server actions (v0.15 §4.2) — getDocShelf / getDocTopicDetail
 * / getDocContent. The I/O layer is mocked at the module boundary
 * (`io-helpers`); the pure `@/lib/docs` parsers run for real on fixtures.
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
  readTimelineIndex: vi.fn(),
}));

vi.mock("@/lib/episodic/manager", () => ({
  readSliceIndex: vi.fn(),
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

/** Route fsListFiles/fsReadFile by a path → content/rejection map. */
function seedFiles(files: Record<string, string>) {
  mocks.fsListFiles.mockImplementation(async (path: string) => {
    const prefix = `${path}/`;
    const names = Object.keys(files)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .filter((rest) => !rest.includes("/"));
    if (names.length === 0) throw new Error(`ENOENT ${path}`);
    return names.map((name) => ({ name, type: "file" as const, path: `${path}/${name}` }));
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
