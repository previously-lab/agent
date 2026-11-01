/**
 * Internal recallRead range matrix. The public main-agent executor mediates
 * records; this suite pins the raw backend used by the recall agent and human
 * reader, over an in-memory fs. No memory/ directory is touched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recallRead,
  renderRecallReadResult,
  type RecallBackend,
  type RecallReadRange,
} from "@/lib/memory/facade";

const files = new Map<string, string>();
const backend: RecallBackend = {
  listMemoryFiles: async () => [...files.keys()],
  readFile: async (path: string) => {
    if (!files.has(path)) throw new Error(`File not found: "${path}"`);
    return files.get(path)!;
  },
};

async function read(ref: string, range?: RecallReadRange): Promise<string> {
  return renderRecallReadResult(await recallRead(backend, { ref, ...(range ? { range } : {}) }), ref);
}

const SLICE_ID = "2026-09-04-2130";
const REF = `records/${SLICE_ID}`;
const NEW_CORE = "memory/records/2026/09/04/2130/core.md";
const LEGACY_CORE = "memory/episodic/slices/2026/09/04/2130/timeline/core.md";
const CORE_RAW = `---
slice_id: 2026-09-04-2130
start: 2026-09-04T21:30:00.000Z
timezone: Asia/Shanghai
---

## Turn u1 — 2026-09-04T21:30:00.000Z (user)

我想换手机，预算 5000。

## Turn a1 — 2026-09-04T21:31:00.000Z (agent)

推荐看看小屏旗舰。

## Turn u2 — 2026-09-04T21:35:00.000Z (user)

续航优先。
`;

beforeEach(() => {
  files.clear();
  files.set(NEW_CORE, CORE_RAW);
});

describe("internal recallRead range matrix", () => {
  it("no range returns the full slice", async () => {
    const out = await read(REF);
    expect(out).toContain("我想换手机");
    expect(out).toContain("小屏旗舰");
    expect(out).toContain("续航优先");
  });

  it("range turns returns only the requested 0-based indices", async () => {
    const out = await read(REF, { type: "turns", indices: [0, 2] });
    expect(out).toContain("我想换手机");
    expect(out).toContain("续航优先");
    expect(out).not.toContain("小屏旗舰");
  });

  it("range last returns only the most recent N turns", async () => {
    const out = await read(REF, { type: "last", count: 1 });
    expect(out).toContain("续航优先");
    expect(out).not.toContain("我想换手机");
    expect(out).not.toContain("小屏旗舰");
  });

  it("range date returns only turns at/after the timestamp", async () => {
    const out = await read(REF, { type: "date", after: "2026-09-04T21:33:00.000Z" });
    expect(out).toContain("续航优先");
    expect(out).not.toContain("我想换手机");
    expect(out).not.toContain("小屏旗舰");
  });

  it("range search returns a matching turn with the requested context", async () => {
    const out = await read(REF, { type: "search", keywords: ["续航"], context: 0 });
    expect(out).toContain("Matched");
    expect(out).toContain("续航优先");
    expect(out).not.toContain("我想换手机");
  });

  it("range search misses degrade to the full slice with a note", async () => {
    const out = await read(REF, { type: "search", keywords: ["不存在的关键词"] });
    expect(out).toContain("No segments matched");
    expect(out).toContain("full content returned");
    expect(out).toContain("我想换手机");
  });

  it("range lines reads a 1-indexed inclusive raw-file span", async () => {
    const out = await read(REF, { type: "lines", start: 1, end: 2 });
    expect(out).toContain(`Lines 1-2 of ${SLICE_ID}:`);
    expect(out).toContain(`---
slice_id: 2026-09-04-2130`);
    expect(out).not.toContain("我想换手机");
  });

  it("an inverted line range returns a visible ERROR", async () => {
    expect(await read(REF, { type: "lines", start: 5, end: 2 }))
      .toBe(`ERROR: Invalid line range 5-2 in ${SLICE_ID}.`);
  });

  it("an unknown range type returns a visible ERROR", async () => {
    expect(await read(REF, { type: "bogus" } as unknown as RecallReadRange))
      .toBe(`ERROR: Unknown range type "bogus" in ${SLICE_ID}.`);
  });

  it("dual-root fallback reads a slice that exists only under the legacy root", async () => {
    files.delete(NEW_CORE);
    files.set(LEGACY_CORE, CORE_RAW);
    expect(await read(REF)).toContain("我想换手机");
  });

  it("a slice under neither root returns the fixed not-found sentence", async () => {
    files.delete(NEW_CORE);
    expect(await read(REF)).toBe(`Nothing named "${REF}" exists in memory — and nothing similar.`);
  });

  it("a malformed slice id returns the fixed not-found sentence", async () => {
    expect(await read("records/not-a-slice"))
      .toBe('Nothing named "records/not-a-slice" exists in memory — and nothing similar.');
  });
});
