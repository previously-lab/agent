import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve("scripts/migrate-records.mjs");
const roots: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "previously-record-migration-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function run(root: string, apply = false) {
  const result = spawnSync(process.execPath, [script, "--root", root, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, report: JSON.parse(result.stdout) as {
    dryRun: boolean;
    summary: { legacyOnly: number; overlapIdentical: number; overlapConflict: number };
    slices: Array<{ id: string; status: string; blocked: boolean; files: Array<{ file: string; action: string; reason?: string }> }>;
  } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("retired record migration fixture", () => {
  it("reports legacy-only, identical overlap and conflict without writing in dry-run", () => {
    const root = fixtureRoot();
    write(root, "memory/episodic/slices/2026/01/01/0100/timeline/core.md", "legacy only core");
    write(root, "memory/episodic/slices/2026/01/02/0200/timeline/core.md", "same core");
    write(root, "memory/records/2026/01/02/0200/core.md", "same core");
    write(root, "memory/episodic/slices/2026/01/03/0300/timeline/core.md", "original core");
    write(root, "memory/records/2026/01/03/0300/core.md", "core with later metadata");

    const { status, report } = run(root);
    expect(status).toBe(2);
    expect(report).toMatchObject({
      dryRun: true,
      summary: { legacyOnly: 1, overlapIdentical: 1, overlapConflict: 1 },
    });
    expect(report.slices.find((slice) => slice.id === "2026-01-03-0300")?.files[0]).toMatchObject({
      file: "core.md", action: "conflict", reason: expect.stringContaining("core metadata"),
    });
    expect(fs.existsSync(path.join(root, "memory/records/2026/01/01/0100/core.md"))).toBe(false);
  });

  it("copies safe legacy-only files and blocks a conflicting slice without overwriting markers or metadata", () => {
    const root = fixtureRoot();
    write(root, "memory/episodic/slices/2026/01/01/0100/timeline/core.md", "legacy core");
    write(root, "memory/episodic/slices/2026/01/01/0100/timeline/agent.md", "legacy agent");
    write(root, "memory/episodic/slices/2026/01/01/0100/previously.md", "legacy card");
    write(root, "memory/episodic/slices/2026/01/03/0300/timeline/core.md", "original core");
    write(root, "memory/records/2026/01/03/0300/core.md", "core with later metadata");
    write(root, "memory/episodic/slices/2026/01/03/0300/timeline/agent.md", "unprocessed marker");
    write(root, "memory/records/2026/01/03/0300/agent.md", "processed marker");
    write(root, "memory/episodic/slices/2026/01/03/0300/timeline/works/unique.json", "must not copy from a blocked slice");

    const { status, report } = run(root, true);
    expect(status).toBe(2);
    expect(report.dryRun).toBe(false);
    expect(report.slices.find((slice) => slice.id === "2026-01-01-0100")?.status).toBe("legacy-only");
    expect(fs.readFileSync(path.join(root, "memory/records/2026/01/01/0100/core.md"), "utf8")).toBe("legacy core");
    expect(fs.readFileSync(path.join(root, "memory/records/2026/01/01/0100/agent.md"), "utf8")).toBe("legacy agent");
    expect(fs.readFileSync(path.join(root, "memory/records/2026/01/01/0100/previously.md"), "utf8")).toBe("legacy card");
    expect(fs.readFileSync(path.join(root, "memory/records/2026/01/03/0300/core.md"), "utf8")).toBe("core with later metadata");
    expect(fs.readFileSync(path.join(root, "memory/records/2026/01/03/0300/agent.md"), "utf8")).toBe("processed marker");
    expect(fs.existsSync(path.join(root, "memory/records/2026/01/03/0300/works/unique.json"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "memory/episodic/slices/2026/01/01/0100/timeline/core.md"), "utf8")).toBe("legacy core");
  });
});
