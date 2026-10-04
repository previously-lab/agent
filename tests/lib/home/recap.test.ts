/**
 * Home recap (src/lib/home/recap.ts) — live-enumeration freshness
 * (v0.19 §A.2.4, post-v0.19 review H4): the start screen's slice count and
 * "last spoke" dateline must follow the records tree, never the retired
 * `timeline/index.json` projection (which has had no writer since v0.19).
 *
 * Harness mirrors tests/lib/episodic/batch-mode.test.ts: a temp cwd +
 * STORAGE=local + vi.resetModules, real filesystem all the way down —
 * real enumeration (local walk), real dual-root slice reads, real parsers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-recap-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  process.env.STORAGE = "local";
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) {
    process.env.STORAGE = origStorage;
  } else {
    delete process.env.STORAGE;
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function importFresh() {
  return import("@/lib/home/recap");
}

function writeOnDisk(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/** A minimal core.md: frontmatter + `turns` one-line turns. */
function sliceFixture(opts: {
  id: string;
  start: string;
  end?: string;
  timezone?: string;
  turns: Array<{ ts: string; role: "user" | "agent"; text: string }>;
}): string {
  const fm = [
    "---",
    `slice_id: ${opts.id}`,
    `start: '${opts.start}'`,
    ...(opts.end ? [`end: '${opts.end}'`, "closed_by: idle_gap"] : []),
    `timezone: ${opts.timezone ?? "UTC"}`,
    "focus: test focus",
    "summary: test summary",
    "---",
  ].join("\n");
  const body = opts.turns
    .map((t, i) => `## Turn t${i} — ${t.ts} (${t.role})\n\n${t.text}`)
    .join("\n\n");
  return `${fm}\n${body}\n`;
}

const NEW_ROOT_CORE = "memory/records/2026/07/28/0658/core.md";
const NEWER_ROOT_CORE = "memory/records/2026/07/29/1015/core.md";
const LEGACY_CORE =
  "memory/episodic/slices/2026/07/30/2040/timeline/core.md";
const STALE_PROJECTION = "memory/episodic/timeline/index.json";

describe("getHomeMemoryState", () => {
  it("enumerates the live tree and ignores a stale frozen timeline projection", async () => {
    writeOnDisk(
      NEW_ROOT_CORE,
      sliceFixture({
        id: "2026-07-28-0658",
        start: "2026-07-28T06:58:22.811Z",
        end: "2026-07-28T07:24:40.991Z",
        timezone: "Asia/Shanghai",
        turns: [
          { ts: "2026-07-28T06:58:22.811Z", role: "user", text: "早" },
          { ts: "2026-07-28T07:20:00.000Z", role: "agent", text: "早！" },
        ],
      }),
    );
    writeOnDisk(
      NEWER_ROOT_CORE,
      sliceFixture({
        id: "2026-07-29-1015",
        start: "2026-07-29T10:15:00.000Z",
        timezone: "Asia/Shanghai",
        turns: [
          { ts: "2026-07-29T10:15:00.000Z", role: "user", text: "又来聊了" },
          { ts: "2026-07-29T10:16:30.000Z", role: "agent", text: "欢迎回来" },
        ],
      }),
    );
    // The retired projection, frozen pre-move: wrong count, wrong newest
    // slice. A reader of THIS file would answer wrong on both.
    writeOnDisk(
      STALE_PROJECTION,
      JSON.stringify({
        _schema: 1,
        updated_at: "2026-07-01T00:00:00.000Z",
        slice_count: 99,
        needs_marking: 0,
        slices: [
          {
            id: "2026-06-01-0001",
            date: "2026-06-01",
            start: "2026-06-01T00:01:00.000Z",
            status: "closed",
            focus: "stale",
            summary: "stale",
            tags: [],
            open_loops: [],
            decisions: [],
            strands: [],
            needs_marking: false,
          },
        ],
      }),
    );

    const { getHomeMemoryState } = await importFresh();
    const state = await getHomeMemoryState();

    expect(state.sliceCount).toBe(2);
    // The recap follows the NEWEST slice on disk (07-29), not the
    // projection's 06-01 ghost.
    expect(state.recap?.lastAt).toBe("2026-07-29T10:16:30.000Z");
    expect(state.recap?.timezone).toBe("Asia/Shanghai");
  });

  it("merges the legacy slices root — a legacy-layout newest slice still recaps", async () => {
    writeOnDisk(
      NEW_ROOT_CORE,
      sliceFixture({
        id: "2026-07-28-0658",
        start: "2026-07-28T06:58:22.811Z",
        end: "2026-07-28T07:24:40.991Z",
        turns: [
          { ts: "2026-07-28T06:58:22.811Z", role: "user", text: "旧根新根并存" },
        ],
      }),
    );
    writeOnDisk(
      LEGACY_CORE,
      sliceFixture({
        id: "2026-07-30-2040",
        start: "2026-07-30T20:40:00.000Z",
        timezone: "Europe/Berlin",
        turns: [
          { ts: "2026-07-30T20:40:00.000Z", role: "user", text: "legacy 最新片" },
          { ts: "2026-07-30T20:45:00.000Z", role: "agent", text: "收到" },
        ],
      }),
    );

    const { getHomeMemoryState } = await importFresh();
    const state = await getHomeMemoryState();

    expect(state.sliceCount).toBe(2);
    expect(state.recap?.lastAt).toBe("2026-07-30T20:45:00.000Z");
    expect(state.recap?.timezone).toBe("Europe/Berlin");
  });

  it("skips a newest slice that holds no turns and recaps the previous one", async () => {
    writeOnDisk(
      NEW_ROOT_CORE,
      sliceFixture({
        id: "2026-07-28-0658",
        start: "2026-07-28T06:58:22.811Z",
        end: "2026-07-28T07:24:40.991Z",
        turns: [
          { ts: "2026-07-28T06:58:22.811Z", role: "user", text: "有内容的片" },
        ],
      }),
    );
    // Newest slice: born but never carried a turn (frontmatter only).
    writeOnDisk(
      NEWER_ROOT_CORE,
      sliceFixture({
        id: "2026-07-29-1015",
        start: "2026-07-29T10:15:00.000Z",
        turns: [],
      }),
    );

    const { getHomeMemoryState } = await importFresh();
    const state = await getHomeMemoryState();

    expect(state.sliceCount).toBe(2);
    expect(state.recap?.lastAt).toBe("2026-07-28T06:58:22.811Z");
  });

  it("returns the empty state when only a frozen projection exists", async () => {
    // Pre-migration leftovers: the projection claims slices, the tree has
    // none. The honest answer is empty — never the projection's ghosts.
    writeOnDisk(
      STALE_PROJECTION,
      JSON.stringify({
        _schema: 1,
        updated_at: "2026-07-01T00:00:00.000Z",
        slice_count: 3,
        needs_marking: 0,
        slices: [
          {
            id: "2026-06-01-0001",
            date: "2026-06-01",
            start: "2026-06-01T00:01:00.000Z",
            status: "closed",
            focus: "stale",
            summary: "stale",
            tags: [],
            open_loops: [],
            decisions: [],
            strands: [],
            needs_marking: false,
          },
        ],
      }),
    );

    const { getHomeMemoryState } = await importFresh();
    const state = await getHomeMemoryState();

    expect(state).toEqual({ sliceCount: 0, recap: null });
  });
});
