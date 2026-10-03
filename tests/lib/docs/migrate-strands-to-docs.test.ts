import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/migrate-strands-to-docs.mjs",
);

let root: string;

async function read(p: string): Promise<string> {
  return fsp.readFile(p, "utf8");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "docs-migrate-fixture-"));
  const strands = path.join(root, "episodic", "strands");
  await fsp.mkdir(strands, { recursive: true });

  // full shape: both dates + aliases + two-paragraph description
  await fsp.writeFile(
    path.join(strands, "面试复盘.md"),
    `---
first_seen: '2026-07-14'
last_active: '2026-08-02'
aliases: ["面试总结", "interview debrief"]
---
用户最早在 2026 年 7 月中旬提起面试复盘，主要是每次模拟面试后一起回顾回答质量。

后来逐渐固定成一套复盘清单：开场自我介绍、项目深挖、反问环节。
`,
  );

  // missing first_seen → falls back to last_active with a warning
  await fsp.writeFile(
    path.join(strands, "apex.md"),
    `---
last_active: '2026-08-08'
---
"apex" is a recurring thread the user kept returning to across many separate conversations.
`,
  );

  // empty description → no entry, 截至块 seeded with （尚无描述）
  await fsp.writeFile(
    path.join(strands, "空描述.md"),
    `---
first_seen: '2026-08-01'
last_active: '2026-08-03'
---

`,
  );

  // aliases in block-list form
  await fsp.writeFile(
    path.join(strands, "响应速度.md"),
    `---
first_seen: '2026-08-02'
last_active: '2026-08-08'
aliases:
  - 响应时间
  - latency
---
「响应速度」这条线索最早出现在 2026-08-02 上午的对话中。
`,
  );
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, MEMORY_ROOT: root },
  });
}

describe("migrate-strands-to-docs.mjs", () => {
  it("requires MEMORY_ROOT", async () => {
    await expect(
      execFileP(process.execPath, [SCRIPT], { env: { ...process.env, MEMORY_ROOT: "" } }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("dry-run prints per-file summaries and writes nothing", async () => {
    const { stdout } = await run([]);
    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("[dry] 面试复盘.md");
    expect(stdout).toContain("[dry] apex.md");
    expect(stdout).toContain("⚠"); // at least the fallback / empty-description warnings
    expect(await exists(path.join(root, "docs", "topic"))).toBe(false);
  });

  it("--apply converts entities into three-field topic docs", async () => {
    const { stdout } = await run(["--apply"]);
    expect(stdout).toContain("mode: APPLY");

    const outDir = path.join(root, "docs", "topic");

    // full shape
    const full = await read(path.join(outDir, "面试复盘.md"));
    expect(full).toContain("status: active");
    expect(full).toContain("opened: '2026-07-14'");
    expect(full).toContain("updated: '2026-08-02'");
    expect(full).not.toContain("first_seen");
    expect(full).not.toContain("aliases:");
    expect(full).toContain("> 截至 2026-08-02：用户最早在 2026 年 7 月中旬提起面试复盘");
    expect(full).toContain("## 2026-08-02 — 初始描述");
    // aliases folded into the opening prose, not a field
    expect(full).toContain("（本主题也叫：面试总结、interview debrief。）");

    // missing first_seen → opened falls back to last_active
    const apex = await read(path.join(outDir, "apex.md"));
    expect(apex).toContain("opened: '2026-08-08'");
    expect(apex).toContain("updated: '2026-08-08'");

    // empty description → no entry, honest placeholder as-of
    const empty = await read(path.join(outDir, "空描述.md"));
    expect(empty).toContain("> 截至 2026-08-03：（尚无描述）");
    expect(empty).not.toContain("## 2026-08-03 — 初始描述");

    // block-list aliases also fold
    const speed = await read(path.join(outDir, "响应速度.md"));
    expect(speed).toContain("（本主题也叫：响应时间、latency。）");
  });

  it("is idempotent — a second run skips everything already migrated", async () => {
    const { stdout } = await run(["--apply"]);
    expect(stdout).toContain("SKIP 面试复盘.md");
    expect(stdout).toContain("4 skipped");
    expect(stdout).toContain("0 failed");
    expect(stdout.match(/^OK /gm)).toBeNull();
  });
});
