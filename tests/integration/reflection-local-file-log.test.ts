import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReflectionRoundMessage } from "@/lib/chat/commit-contract";

const sliceId = "2026-11-06-0900";
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-plain-files-"));
  vi.stubEnv("STORAGE", "local");
  vi.stubEnv("MEMORY_ROOT", root);
  vi.stubEnv("TASKS_ROOT", path.join(root, "tasks"));
  vi.stubEnv("SESSIONS_ROOT", path.join(root, "sessions"));
  vi.stubEnv("PREVIOUSLY_HOME", path.join(root, "home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("reflection-plain-files-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("plain local reflection ledger", () => {
  it("settles an empty round once and never acknowledges uncompleted material", async () => {
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    const { createBatch, commitReflectionRound, flushBatch, fsWriteFile } = await import("@/lib/episodic/io-helpers");
    const { readReflectionCursor, readReflectionLog, readSummaryLog } = await import("@/lib/chat/hq-log");
    const { readReflectionHistoryChunk } = await import("@/lib/chat/hq-history");

    const initial = await readReflectionHistoryChunk();
    expect(initial).toMatchObject({ available: true, complete: true, history: { pending: [] } });

    const summaryBatch = createBatch();
    await fsWriteFile("memory/config/fixture.json", "{}\n", summaryBatch);
    await flushBatch(summaryBatch, `Summary — ${sliceId}\n\n- reply turn-1`);
    const summary = (await readSummaryLog()).entries[0];
    expect(summary).toBeDefined();
    expect((await readReflectionHistoryChunk())).toMatchObject({
      available: true,
      complete: true,
      history: { pending: [{ sha: summary.sha, sliceId, turnIds: ["turn-1"] }] },
    });

    const message = buildReflectionRoundMessage({ date: "2026-11-06", trailer: {
      seen: [{ sliceId, turnIds: ["turn-1"] }],
      observed: [{ sha: summary.sha, sliceId, turnIds: ["turn-1"] }],
    } });
    await commitReflectionRound(createBatch(), message);
    await commitReflectionRound(createBatch(), message);

    const rounds = await readReflectionLog();
    expect(rounds.available).toBe(true);
    expect(rounds.entries).toHaveLength(1);
    expect((await readReflectionCursor()).sliceId).toBe(sliceId);
    expect((await readReflectionHistoryChunk())).toMatchObject({
      available: true,
      complete: true,
      history: { cursor: sliceId, pending: [] },
    });

    const nextSummary = createBatch();
    await fsWriteFile("memory/config/next.json", "{}\n", nextSummary);
    await flushBatch(nextSummary, `Summary — ${sliceId}\n\n- reply turn-2`);
    const failedRound = createBatch();
    await fsWriteFile("memory/config/degraded.json", "{}\n", failedRound);
    await commitReflectionRound(failedRound, "Reflection round — 2026-11-06\n\n- degraded commit");

    expect((await readReflectionHistoryChunk())).toMatchObject({
      available: true,
      complete: true,
      history: { pending: [{ sliceId, turnIds: ["turn-2"] }] },
    });
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(root, "config", "local-commit-log.json"))).toBe(true);
  });
});
