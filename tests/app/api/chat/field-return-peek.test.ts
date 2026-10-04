/**
 * The end-of-turn HQ-return peek (v0.21 §4 回程) — the race helper and the
 * agent.md line writer, over an in-memory memory root.
 *
 * `raceFieldPeek` covers the two acceptance states (caught → the caller
 * appends the line; missed → nothing is written) plus iterator-closed. The
 * full `createHook + race` composition lives inline in turnWorkflow and is
 * only exercisable inside a real durable run (main agent's live check).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/io-helpers")>();
  return {
    ...actual,
    fsReadFile: vi.fn(async (path: string) => {
      const content = io.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    fsWriteFile: vi.fn(async (path: string, content: string) => {
      io.files.set(path, content);
      return { path, created: true };
    }),
  };
});

import { raceFieldPeek } from "@/app/api/chat/turn-workflow";
import { appendFieldReturnLine } from "@/app/api/chat/steps";
import { slicePartPath } from "@/lib/episodic/paths";

const NEVER = () => new Promise<never>(() => {});
const FAST = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("raceFieldPeek — the two acceptance states", () => {
  it("caught: the iterator yields before the timeout → the reply text", async () => {
    const iterator: AsyncIterator<string> = {
      next: () => Promise.resolve({ value: "HQ 已把供应商案归档。", done: false }),
    };
    const outcome = await raceFieldPeek(iterator, NEVER);
    expect(outcome).toEqual({ kind: "reply", text: "HQ 已把供应商案归档。" });
  });

  it("missed: the iterator pends past the timeout → timeout, no reply", async () => {
    const iterator: AsyncIterator<string> = { next: NEVER };
    const outcome = await raceFieldPeek(iterator, FAST, 1);
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("iterator already closed → closed (not a reply, not a timeout)", async () => {
    const iterator: AsyncIterator<string> = {
      next: () => Promise.resolve({ value: undefined, done: true }),
    };
    expect(await raceFieldPeek(iterator, NEVER)).toEqual({ kind: "closed" });
  });
});

describe("appendFieldReturnLine — 赶上就带上", () => {
  beforeEach(() => {
    io.files.clear();
    vi.clearAllMocks();
  });

  it("appends ONE dated prose line to the slice's agent.md", async () => {
    const agentPath = slicePartPath("2026-10-04-0131", "agent");
    io.files.set(agentPath, "既有 mailbox 内容。\n");

    await appendFieldReturnLine("2026-10-04-0131", "供应商案已归档，见 research/屏幕供应商。");

    const next = io.files.get(agentPath)!;
    expect(next.startsWith("既有 mailbox 内容。")).toBe(true);
    expect(next).toContain("HQ 回程（");
    expect(next).toContain("供应商案已归档，见 research/屏幕供应商。");
    // prose line, not a JSON marker (R4: new channels are prose)
    expect(next).not.toContain("[doc-");
  });

  it("creates agent.md when the slice has none yet", async () => {
    await appendFieldReturnLine("2026-10-04-0131", "回程内容。");
    const agentPath = slicePartPath("2026-10-04-0131", "agent");
    expect(io.files.get(agentPath)).toContain("HQ 回程（");
  });

  it("a write failure is swallowed — never throws into the turn", async () => {
    io.files.set(slicePartPath("2026-10-04-0131", "agent"), "x");
    // fsWriteFile mock replaced with a rejecting one for this call
    const { fsWriteFile } = await import("@/lib/episodic/io-helpers");
    vi.mocked(fsWriteFile).mockRejectedValueOnce(new Error("disk gone"));
    await expect(
      appendFieldReturnLine("2026-10-04-0131", "回程内容。"),
    ).resolves.toBeUndefined();
  });
});
