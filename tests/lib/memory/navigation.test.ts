import { describe, expect, it } from "vitest";
import { CASE_CATEGORIES } from "@/lib/docs/paths";
import { findMemoryPaths, listMemoryDirectory } from "@/lib/memory/navigation";

const paths = [
  "memory/people/林然/index.md",
  "memory/people/林然/_current.md",
  "memory/people/林然/2026-11-02-第一次见面.md",
  "memory/people/林然/2026-11-02-history-v1-index-0123456789abcdef-0001.md",
  "memory/people/林然/attachments/private-note.md",
  "memory/people/林然/unknown.md",
  "memory/people/林然/child/index.md",
  "memory/people/user/profile.md",
  "memory/orgs/AirJelly/index.md",
  "memory/research/AirJelly 的互动/index.md",
  "memory/research/AirJelly 的互动/2026-11-13-水母交互.md",
  "memory/tasks/AirJelly 原型/index.md",
  "memory/hypotheses/AirJelly/index.md",
  "memory/self/agenda.md",
  "memory/config/private.json",
  "memory/records/2026/11/13/0845/core.md",
  "sessions/example/index.md",
];

describe("listMemoryDirectory", () => {
  it("lists one semantic level at a time, keeping reserved data out", () => {
    expect(listMemoryDirectory(paths, {})).toMatchObject({
      kind: "entries",
      entries: [...CASE_CATEGORIES].sort().map((path) => ({ kind: "directory", path, name: path })),
    });
    expect(listMemoryDirectory(paths, { path: "people/" })).toEqual({
      kind: "entries",
      total: 2,
      entries: [
        { kind: "directory", path: "people/user", name: "user" },
        { kind: "directory", path: "people/林然", name: "林然", ref: "people/林然" },
      ],
    });
    expect(listMemoryDirectory(paths, { path: "people/林然" })).toEqual({
      kind: "entries",
      total: 3,
      entries: [
        { kind: "document", path: "people/林然/2026-11-02-第一次见面.md", ref: "people/林然/2026-11-02-第一次见面", name: "2026-11-02-第一次见面.md" },
        { kind: "document", path: "people/林然/_current.md", ref: "people/林然", name: "_current.md" },
        { kind: "document", path: "people/林然/index.md", ref: "people/林然", name: "index.md" },
      ],
    });
    expect(listMemoryDirectory(paths, { path: "people/user" })).toMatchObject({
      kind: "entries", total: 1, entries: [{ ref: "people/user/profile" }],
    });
    expect(listMemoryDirectory(paths, { path: "self" })).toMatchObject({
      kind: "entries", total: 1, entries: [{ ref: "self/agenda" }],
    });
  });

  it("paginates deterministically and distinguishes an empty category from a missing case", () => {
    expect(listMemoryDirectory(paths, { path: "people", limit: 1 })).toMatchObject({
      kind: "entries", total: 2, entries: [{ path: "people/user" }], nextOffset: 1,
    });
    expect(listMemoryDirectory([...paths].reverse(), { path: "people", offset: 1, limit: 1 })).toMatchObject({
      kind: "entries", total: 2, entries: [{ path: "people/林然" }],
    });
    expect(listMemoryDirectory(paths, { path: "places" })).toEqual({ kind: "entries", total: 0, entries: [] });
    expect(listMemoryDirectory(paths, { path: "places/Missing" })).toMatchObject({ kind: "not_found" });
  });

  it.each(["/", "/people", "memory/people", "config", "records", "people//", "people/..", "people/%2e%2e", "people\\user", "people/user/profile", "people/／hidden"])(
    "rejects an unsupported scope spelling: %s",
    (path) => expect(listMemoryDirectory(paths, { path })).toMatchObject({ kind: "invalid_scope" }),
  );
});

describe("findMemoryPaths", () => {
  it("ranks multiple candidates across physical categories from names alone", () => {
    const result = findMemoryPaths(paths, { name: "ａｉｒｊｅｌｌｙ" });
    expect(result).toMatchObject({
      kind: "entries",
      entries: [
        { kind: "directory", path: "hypotheses/AirJelly", ref: "hypotheses/AirJelly", score: 1 },
        { kind: "directory", path: "orgs/AirJelly", ref: "orgs/AirJelly", score: 1 },
        { kind: "directory", path: "tasks/AirJelly 原型" },
        { kind: "directory", path: "research/AirJelly 的互动" },
      ],
    });
    expect(findMemoryPaths(paths, { name: "AirJelly", category: "research" })).toMatchObject({
      kind: "entries", total: 1, entries: [{ path: "research/AirJelly 的互动" }],
    });
    expect(findMemoryPaths(paths, { name: "AirJelly", category: "hypotheses" })).toMatchObject({
      kind: "entries", total: 1, entries: [{ path: "hypotheses/AirJelly", score: 1 }],
    });
  });

  it("matches piece titles and exact semantic paths without returning duplicate document refs", () => {
    expect(findMemoryPaths(paths, { name: "水母交互", under: "research/AirJelly 的互动" })).toMatchObject({
      kind: "entries", total: 1,
      entries: [{ kind: "document", ref: "research/AirJelly 的互动/2026-11-13-水母交互", score: 1 }],
    });
    expect(findMemoryPaths(paths, { name: "people/林然" })).toMatchObject({
      kind: "entries", total: 1, entries: [{ kind: "directory", path: "people/林然" }],
    });
    expect(findMemoryPaths(paths, { name: "people/林然/_current.md" })).toMatchObject({
      kind: "entries", total: 1, entries: [{ kind: "document", path: "people/林然/_current.md", ref: "people/林然" }],
    });
  });

  it("reports an empty match instead of selecting an unrelated name or the category prefix", () => {
    expect(findMemoryPaths(paths, { name: "灯塔" })).toEqual({ kind: "entries", total: 0, entries: [] });
    expect(findMemoryPaths(paths, { name: "research/灯塔" })).toEqual({ kind: "entries", total: 0, entries: [] });
    expect(findMemoryPaths(paths, { name: "AirJelly", under: "research/../orgs" })).toMatchObject({ kind: "invalid_scope" });
    expect(findMemoryPaths(paths, { name: "config/private.json" })).toMatchObject({ kind: "invalid_scope" });
  });
});
