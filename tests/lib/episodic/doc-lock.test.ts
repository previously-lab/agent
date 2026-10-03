import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory memory root (same pattern as the other episodic tests).
const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async () => []),
}));

import {
  withDocLock,
  updateDocUnderLock,
  readDocFile,
  docFilePath,
  DOCS_ROOT,
} from "@/lib/episodic/doc-lock";
import { appendEntry, createDocSkeleton } from "@/lib/docs";

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
});

describe("withDocLock", () => {
  it("serializes calls for the same document in arrival order", async () => {
    const order: string[] = [];
    const gate = vi.hoisted(() => ({ release: () => {} }));
    const first = withDocLock("a.md", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      order.push("first:end");
    });
    const second = withDocLock("a.md", async () => {
      order.push("second");
    });
    // Let the first holder settle inside the gate before releasing.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first:start"]);
    gate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs different documents concurrently", async () => {
    const order: string[] = [];
    await Promise.all([
      withDocLock("a.md", async () => {
        order.push("a");
      }),
      withDocLock("b.md", async () => {
        order.push("b");
      }),
    ]);
    expect(order.sort()).toEqual(["a", "b"]);
  });
});

describe("updateDocUnderLock", () => {
  it("creates a document through the pure ops and queues the write", async () => {
    const result = await updateDocUnderLock(
      "research",
      "2026-08-09-手机调研.md",
      undefined,
      (current) => {
        expect(current).toBeNull();
        const base = createDocSkeleton({
          fileName: "2026-08-09-手机调研.md",
          kind: "research",
          opened: "2026-08-09",
          heading: "手机调研",
        });
        return appendEntry(base, { date: "2026-08-09", title: "开篇", body: "问题：…" });
      },
    );
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(`${DOCS_ROOT}/research/2026-08-09-手机调研.md`);
    const raw = io.files.get(result.path)!;
    expect(raw).toContain("status: active");
    expect(raw).toContain("## 2026-08-09 — 开篇");
  });

  it("reads the CURRENT doc inside the lock (read-modify-write)", async () => {
    const base = createDocSkeleton({
      fileName: "2026-08-09-x.md",
      kind: "task",
      opened: "2026-08-09",
    });
    const first = appendEntry(base, { date: "2026-08-09", title: "开篇", body: "一" });
    await updateDocUnderLock("task", "2026-08-09-x.md", undefined, () => first);

    await updateDocUnderLock("task", "2026-08-09-x.md", undefined, (current) => {
      expect(current).not.toBeNull();
      expect(current!.sections).toHaveLength(1);
      return appendEntry(current!, { date: "2026-08-10", title: "更新", body: "二" });
    });

    const doc = await readDocFile("task", "2026-08-09-x.md");
    expect(doc!.sections).toHaveLength(2);
    expect(doc!.frontmatter.updated).toBe("2026-08-10");
  });

  it("a null mutation writes nothing (empty run is legal)", async () => {
    const result = await updateDocUnderLock("task", "2026-08-09-x.md", undefined, () => null);
    expect(result.wrote).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it("rejects an illegal file name (the slice-id namespace red line)", async () => {
    await expect(
      updateDocUnderLock("research", "2026-08-09-1300.md", undefined, () => null),
    ).rejects.toThrow(/Illegal/);
    // .. and a title starting with four digits is equally refused.
    await expect(
      updateDocUnderLock("research", "2026-08-09-1234-调研.md", undefined, () => null),
    ).rejects.toThrow(/Illegal/);
  });

  it("docFilePath places the kind as the directory", () => {
    expect(docFilePath("topic", "用户手机.md")).toBe("memory/docs/topic/用户手机.md");
  });
});
