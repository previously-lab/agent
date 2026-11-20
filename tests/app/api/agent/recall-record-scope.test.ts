import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { readdirSync } from "fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

import { recallRecentExecute, type ToolContext } from "@/app/api/agent/tool-executors";

const context: ToolContext = { repo: "local", owner: "local", useDemo: false, useGithub: false,
  sliceId: "2026-11-01-0900", turnId: "fixture", readScopeId: "fixture", currentUserText: "", recentTurns: [] };
let memory: string;
const prefix = "previously-scoped-records-";

function write(path: string, body = "---\nfocus: Fixture\n---\n"): void {
  const target = join(memory, path);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

beforeEach(() => {
  memory = fs.mkdtempSync(join(tmpdir(), prefix));
  vi.stubEnv("MEMORY_ROOT", memory);
  vi.mocked(readdirSync).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  const target = fs.realpathSync(memory);
  if (dirname(target) !== fs.realpathSync(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error("Unexpected fixture path");
  fs.rmSync(target, { recursive: true, force: true });
});

describe("local record inventory", () => {
  it("visits only canonical in-window directories across a month boundary", async () => {
    for (const path of ["records/2025/12/01/0800", "records/2026/10/30/0800", "records/2026/10/31/2300",
      "records/2026/11/01/0900", "records/2026/11/02/0800", "records/2026/11/extra/0900",
      "episodic/slices/2026/11/01/0900/timeline", "config/unused"]) write(path + "/core.md");
    write("records/2026/11/01/0900/attachments/photo");
    const result = await recallRecentExecute({ category: "records", after: "2026-10-31", before: "2026-11-01" },
      { context, toolCallId: "recent" });
    expect(result).toContain("records/2026-10-31-2300");
    expect(result).toContain("records/2026-11-01-0900");
    expect(result).not.toContain("records/2026-11-02");
    const visited = vi.mocked(readdirSync).mock.calls.map(([dir]) => relative(memory, String(dir)).replaceAll("\\", "/"));
    expect(visited.sort()).toEqual(["records", "records/2026", "records/2026/10", "records/2026/10/31",
      "records/2026/10/31/2300", "records/2026/11", "records/2026/11/01", "records/2026/11/01/0900"]);
  });

  it("treats an empty root as empty and propagates directory failures", async () => {
    const input = { category: "records" };
    const options = { context, toolCallId: "recent" };
    expect(await recallRecentExecute(input, options)).toContain("There is nothing here yet");
    write("records/2026/11/01/0900/core.md");
    vi.mocked(readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("unreadable root"), { code: "EACCES" }); });
    await expect(recallRecentExecute(input, options)).rejects.toThrow("unreadable root");
  });
});
