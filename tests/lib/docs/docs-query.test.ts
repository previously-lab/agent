/**
 * Document query layer (v0.15 §4.2 reader side) — pure functions over an
 * injected in-memory DocsFs. No real filesystem, no memory/ directory.
 */
import { describe, it, expect } from "vitest";
import {
  listDocsQuery,
  readDocQuery,
  extractSliceIds,
  DOCS_ROOT,
  type DocsFs,
} from "@/lib/docs/docs-query";

/** Build a DocsFs over a plain map; unlisted paths throw like the real fs. */
function makeFs(files: Record<string, string>, dirs: Record<string, string[]>): DocsFs {
  return {
    readText: async (path) => {
      if (!(path in files)) throw new Error(`File not found: "${path}"`);
      return files[path];
    },
    listDir: async (path) => {
      if (!(path in dirs)) throw new Error(`Directory not found: "${path}"`);
      return dirs[path].map((name) => ({
        name,
        type: name.includes(".") ? ("file" as const) : ("dir" as const),
        path: `${path}/${name}`,
      }));
    },
  };
}

const RESEARCH_A = `---
status: active
opened: 2026-09-05
updated: 2026-09-12
---
# 手机购买调研

> 截至 2026-09-12：倾向小屏旗舰。

## 2026-09-05 — 开篇
缘起。证据见切片 2026-09-04-2130 与 2026-09-05-1030。
`;

describe("listDocsQuery", () => {
  it("lists .md files ascending — birth order for dated kinds", async () => {
    const fs = makeFs({}, {
      [`${DOCS_ROOT}/research`]: [
        "2026-09-20-充电器调研.md",
        "2026-09-05-手机购买调研.md",
        "notes.txt", // not a document — filtered out
      ],
    });
    const r = await listDocsQuery(fs, "research");
    expect(r.kind).toBe("research");
    expect(r.files).toEqual([
      "2026-09-05-手机购买调研.md",
      "2026-09-20-充电器调研.md",
    ]);
  });

  it("applies the filter as a case-insensitive substring match", async () => {
    const fs = makeFs({}, {
      [`${DOCS_ROOT}/research`]: [
        "2026-09-05-手机购买调研.md",
        "2026-09-20-充电器调研.md",
      ],
    });
    const r = await listDocsQuery(fs, "research", "手机");
    expect(r.files).toEqual(["2026-09-05-手机购买调研.md"]);
  });

  it("treats a missing directory as empty with a note — never an error", async () => {
    const fs = makeFs({}, {});
    const r = await listDocsQuery(fs, "hypothesis");
    expect(r.files).toEqual([]);
    expect(r.note).toContain("hypothesis");
  });
});

describe("readDocQuery", () => {
  it("resolves by file name alone, learning the kind from the directory", async () => {
    const fs = makeFs(
      { [`${DOCS_ROOT}/research/2026-09-05-手机购买调研.md`]: RESEARCH_A },
      {},
    );
    const r = await readDocQuery(fs, "《2026-09-05-手机购买调研》");
    expect(r).not.toHaveProperty("error");
    if ("error" in r) return;
    expect(r.fileName).toBe("2026-09-05-手机购买调研.md");
    expect(r.kind).toBe("research");
    expect(r.path).toBe(`${DOCS_ROOT}/research/2026-09-05-手机购买调研.md`);
    expect(r.status).toBe("active");
    expect(r.opened).toBe("2026-09-05");
    expect(r.updated).toBe("2026-09-12");
    expect(r.content).toBe(RESEARCH_A);
    expect(r.warnings).toEqual([]);
  });

  it("accepts the name without .md and with path junk, normalizing to identity", async () => {
    const fs = makeFs(
      { [`${DOCS_ROOT}/topic/用户手机.md`]: "# 用户手机\n" },
      {},
    );
    const r = await readDocQuery(fs, "docs/topic/用户手机");
    if ("error" in r) throw new Error(r.error);
    expect(r.fileName).toBe("用户手机.md");
    expect(r.kind).toBe("topic");
  });

  it("returns a visible dead-link error when nothing resolves — never throws", async () => {
    const fs = makeFs({}, {});
    const r = await readDocQuery(fs, "2026-01-01-不存在的文档");
    expect(r).toHaveProperty("error");
    if ("error" in r) {
      expect(r.error).toContain("死链");
      expect(r.error).toContain("listDocs");
    }
  });

  it("rejects an un-normalizable reference as a visible error", async () => {
    const fs = makeFs({}, {});
    const r = await readDocQuery(fs, "   ");
    expect(r).toHaveProperty("error");
  });

  it("surfaces tolerant-parse warnings without failing the read", async () => {
    const broken = `---
status: active
opened: 2026-09-05
updated: 2026-09-05
type: research
---
# x
`;
    const fs = makeFs({ [`${DOCS_ROOT}/research/2026-09-05-x.md`]: broken }, {});
    const r = await readDocQuery(fs, "2026-09-05-x");
    if ("error" in r) throw new Error(r.error);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.content).toBe(broken); // raw text returned verbatim
  });
});

describe("extractSliceIds", () => {
  it("finds slice ids embedded in prose, deduplicated", () => {
    const text =
      "证据见 2026-09-04-2130，又见 2026-09-05-1030；重申 2026-09-04-2130。";
    expect(extractSliceIds(text)).toEqual(["2026-09-04-2130", "2026-09-05-1030"]);
  });

  it("returns an empty array when the document cites no slices", () => {
    expect(extractSliceIds("没有任何引用。")).toEqual([]);
  });
});
