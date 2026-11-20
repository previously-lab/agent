import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

let root = "";
let memory = "";
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "aftrbrez-archive-case-"));
  memory = join(root, "memory");
  for (const directory of [memory, join(root, "tasks"), join(root, "sessions")]) fs.mkdirSync(directory, { recursive: true });
  vi.stubEnv("STORAGE", "local");
  vi.stubEnv("PREVIOUSLY_MODE", "cloud");
  vi.stubEnv("MEMORY_ROOT", memory);
  vi.stubEnv("TASKS_ROOT", join(root, "tasks"));
  vi.stubEnv("SESSIONS_ROOT", join(root, "sessions"));
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const target = fs.realpathSync(root);
  if (dirname(target) !== fs.realpathSync(tmpdir()) || !basename(target).startsWith("aftrbrez-archive-case-")) throw new Error("Unexpected fixture path");
  fs.rmSync(target, { recursive: true, force: true });
});

function seed(path: string, content: string | Buffer) {
  const absolute = join(memory, path);
  fs.mkdirSync(dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

describe("case archival", () => {
  const request = { category: "research" as const, caseName: "retired", reason: "superseded", date: "2026-11-18" };

  it("enumerates only the case's file blobs on a GitHub tree with directories", async () => {
    const source = await import("@/lib/data-source/resolve");
    const github = await import("@/lib/tools/readFile");
    const { enumerateTreeFiles } = await import("@/lib/episodic/timeline/enumerate");
    vi.spyOn(source, "resolveDataSource").mockReturnValue("github");
    const base = "memory/research/retired";
    vi.spyOn(github, "getRepoTree").mockResolvedValue({ treeSha: "tree", truncated: false, entries: [
      { path: base, type: "tree", sha: "1" },
      { path: base + "/index.md", type: "blob", sha: "2" },
      { path: base + "/attachments", type: "tree", sha: "3" },
      { path: base + "/attachments/file", type: "blob", sha: "4" },
      { path: base + "2/index.md", type: "blob", sha: "5" },
    ] });
    expect(await enumerateTreeFiles(base)).toEqual([base + "/index.md", base + "/attachments/file"]);
  });

  it("keeps immutable history links readable at their old addresses and in the archived case", async () => {
    const { planHistoryArchive } = await import("@/lib/docs/history-archive");
    const { archiveCaseDocument } = await import("@/lib/docs/archive-case");
    const history = planHistoryArchive({ ...request, source: "index.md", sourceRaw: "earlier text\n", updated: request.date, kind: "source-snapshot" });
    seed("research/retired/index.md", "current\n");
    const shard = history.entries[0]!;
    const path = shard.path.slice("memory/".length);
    seed(path, shard.content);
    await archiveCaseDocument(request);
    expect(fs.readFileSync(join(memory, path), "utf8")).toBe(shard.content);
    expect(fs.readFileSync(join(memory, path.replace("/retired/", "/retired-archived/")), "utf8")).toBe(shard.content);
    expect(fs.existsSync(join(memory, "research/retired/index.md"))).toBe(false);
  });

  it("rolls back the archive's staged operations if a later file fails to copy", async () => {
    const { archiveCaseDocument } = await import("@/lib/docs/archive-case");
    const { createBatch } = await import("@/lib/episodic/io-helpers");
    const batch = createBatch();
    batch.entries.set("memory/other.txt", "keep me");
    seed("research/retired/index.md", "current\n");
    seed("research/retired/oversized.bin", Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(archiveCaseDocument(request, { batch })).rejects.toThrow(/too large/i);
    expect([...batch.entries]).toEqual([["memory/other.txt", "keep me"]]);
    expect(batch.documentBases).toBeUndefined();
  });

  it("requires HQ to reread a changed current view even when the index is identical", async () => {
    const { archiveCaseDocument } = await import("@/lib/docs/archive-case");
    const { createCaseReadScope, readCaseIndexForScope } = await import("@/lib/episodic/flash/librarian");
    const scope = createCaseReadScope();
    seed("research/retired/index.md", "current\n");
    seed("research/retired/_current.md", "first understanding\n");
    await readCaseIndexForScope({ ...request, scope, fresh: true });
    seed("research/retired/_current.md", "new understanding\n");
    await expect(archiveCaseDocument(request, { readScope: scope })).rejects.toThrow(/changed/);
    expect(fs.existsSync(join(memory, "research/retired-archived/index.md"))).toBe(false);
  });

  it("refuses a partial destination or a change to attachment bytes after staging", async () => {
    const { archiveCaseDocument } = await import("@/lib/docs/archive-case");
    const { createBatch, flushBatch } = await import("@/lib/episodic/io-helpers");
    seed("research/retired/index.md", "current\n");
    seed("research/retired/attachments/sample.bin", Buffer.from([255]));
    seed("research/retired-archived/unrelated.bin", Buffer.from([1]));
    await expect(archiveCaseDocument(request)).rejects.toThrow(/collision/);
    fs.unlinkSync(join(memory, "research/retired-archived/unrelated.bin"));
    const batch = createBatch();
    await archiveCaseDocument(request, { batch });
    seed("research/retired/attachments/sample.bin", Buffer.from([254]));
    await expect(flushBatch(batch, "archive")).rejects.toThrow(/changed before publication/);
    expect(fs.existsSync(join(memory, "research/retired/index.md"))).toBe(true);
    expect(fs.existsSync(join(memory, "research/retired-archived/index.md"))).toBe(false);
  });

  it("preserves every file, leaves default discovery and reports old refs as archived", async () => {
    seed("research/旧主题/index.md", "主题概览\n");
    seed("research/旧主题/2026-11-01-原报告.md", "完整报告\n");
    seed("research/旧主题/attachments/evidence.bin", Buffer.from([0, 1, 2, 255]));
    const { archiveCaseDocument } = await import("@/lib/docs/archive-case");
    const result = await archiveCaseDocument({ category: "research", caseName: "旧主题", reason: "已被新研究取代", date: "2026-11-18" });
    expect(result).toMatchObject({ ok: true, files: 3, path: "memory/research/旧主题-archived" });
    // Git tracks files, not empty directories; local empty shells are harmless.
    for (const path of ["index.md", "2026-11-01-原报告.md", "attachments/evidence.bin"]) {
      expect(fs.existsSync(join(memory, "research/旧主题", path))).toBe(false);
    }
    expect(fs.readFileSync(join(memory, "research/旧主题-archived/index.md"), "utf8")).toBe("主题概览\n");
    expect(fs.readFileSync(join(memory, "research/旧主题-archived/2026-11-01-原报告.md"), "utf8")).toBe("完整报告\n");
    expect(fs.readFileSync(join(memory, "research/旧主题-archived/attachments/evidence.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(fs.readFileSync(join(memory, "research/旧主题-archived/_ARCHIVED.md"), "utf8")).toContain("已被新研究取代");
    expect((await archiveCaseDocument({ category: "research", caseName: "旧主题", reason: "重复归档", date: "2026-11-18" })).noop).toBe(true);

    // A migrated legacy document of the same name must not resurrect this
    // retired identity, including an identically named legacy piece.
    seed("docs/旧主题.md", "unrelated legacy document");
    seed("docs/research/2026-11-01-原报告.md", "unrelated legacy piece");
    const { recallRead, recallRecent } = await import("@/lib/memory/facade");
    const { readFileLocal, walkPathsLocal } = await import("@/lib/tools/local-fs");
    const backend = { readFile: readFileLocal, listMemoryFiles: () => walkPathsLocal("memory") };
    expect(await recallRead(backend, { ref: "research/旧主题" })).toMatchObject({ kind: "archived" });
    expect(await recallRecent(backend, { category: "research" })).toEqual({ kind: "empty" });
    expect(await recallRead(backend, { ref: "research/旧主题/2026-11-01-原报告" })).toMatchObject({ kind: "archived" });

    const { makeCaseReadTool } = await import("@/lib/episodic/flash/librarian");
    const read = await makeCaseReadTool().execute!({ ref: "research/旧主题" }, { toolCallId: "archived", messages: [], context: undefined });
    expect(read).toContain("archived: research/旧主题");
  });

  it("refuses to overwrite an existing archive or archive the live user model", async () => {
    seed("research/旧主题/index.md", "current\n");
    seed("research/旧主题-archived/index.md", "earlier archive\n");
    const { archiveCaseDocument } = await import("@/lib/docs/archive-case");
    await expect(archiveCaseDocument({ category: "research", caseName: "旧主题", reason: "冲突", date: "2026-11-18" })).rejects.toThrow(/collision/);
    expect(fs.readFileSync(join(memory, "research/旧主题/index.md"), "utf8")).toBe("current\n");
    expect(fs.readFileSync(join(memory, "research/旧主题-archived/index.md"), "utf8")).toBe("earlier archive\n");
    await expect(archiveCaseDocument({ category: "people", caseName: "user", reason: "不允许", date: "2026-11-18" })).rejects.toThrow(/cannot be archived/);
  });
});
