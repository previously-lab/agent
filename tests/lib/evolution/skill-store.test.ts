import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SkillDraft } from "@/lib/evolution/skill-policy";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;
let origMemoryRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-skill-store-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  origMemoryRoot = process.env.MEMORY_ROOT;
  process.env.STORAGE = "local";
  process.env.MEMORY_ROOT = path.join(tmpDir, "memory");
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) process.env.STORAGE = origStorage;
  else delete process.env.STORAGE;
  if (origMemoryRoot !== undefined) process.env.MEMORY_ROOT = origMemoryRoot;
  else delete process.env.MEMORY_ROOT;
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function importFresh() {
  return import("@/lib/evolution/skill-store");
}

function writeOnDisk(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function readOnDisk(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

function draft(id: string): SkillDraft {
  return {
    id,
    ref: "self/main/index.md",
    role: "main",
    scope: { kind: "general" },
    applicability: "When reviewing prior conversations",
    instruction: `Whole rule for ${id}`,
    summary: `Summary for ${id}`,
    sourceRevision: `source-${id}-v1`,
    evidence: ["2026-08-20-1430"],
    expectedBenefit: "Observed behavior can be reviewed later",
    reviewDue: "2026-11-30",
  };
}

const PROPOSE = {
  kind: "propose",
  operationId: "proposal-1",
  expectedRevision: 0,
  draft: draft("context-rule"),
} as const;

const ADOPT = {
  kind: "adopt",
  operationId: "adoption-1",
  id: "context-rule",
  expectedRevision: 1,
  reviewDue: "2026-11-30",
} as const;

describe("skill ledger storage", () => {
  it("stamps adoption on the server clock and requires an observed later scenario for positive review", async () => {
    const store = await importFresh();
    await store.mutateSkillLedger(PROPOSE);
    const adopted = await store.mutateSkillLedger(ADOPT, undefined, {
      now: new Date("2026-10-26T10:00:59Z"),
    });
    expect(adopted).toMatchObject({ status: "applied", entry: { adoptionBoundary: "2026-10-26-1000" } });
    const replay = await store.mutateSkillLedger(ADOPT, undefined, {
      now: new Date("2026-10-27T10:00:00Z"),
    });
    expect(replay).toMatchObject({ status: "replayed", entry: { adoptionBoundary: "2026-10-26-1000" } });
    const review = {
      kind: "review", operationId: "positive-review", id: "context-rule", expectedRevision: 2,
      reviewEvidence: PROPOSE.draft.evidence, reviewOutcome: "positive",
      reviewedAt: "2026-10-26", reviewDue: "2026-11-30",
    };
    const host = { now: new Date("2026-10-26T12:00:00Z") };
    expect(await store.mutateSkillLedger(review, undefined, host))
      .toMatchObject({ status: "rejected", code: "evidence" });
    expect(await store.mutateSkillLedger({
      ...review, reviewEvidence: ["2027-01-01-1000"],
    }, undefined, host)).toMatchObject({ status: "rejected", code: "evidence" });
    expect(await store.mutateSkillLedger({
      ...review, reviewEvidence: ["2026-10-26-1100-Mf_TwQ"],
    }, undefined, host)).toMatchObject({ status: "applied", entry: { reviewOutcome: "positive" } });
  });

  it("refuses a model-supplied adoption boundary instead of treating it as host data", async () => {
    const store = await importFresh();
    await store.mutateSkillLedger(PROPOSE);
    expect(await store.mutateSkillLedger({ ...ADOPT, adoptionBoundary: "2026-01-01-0000" }))
      .toMatchObject({ status: "rejected", code: "invalid" });
    const state = await store.readSkillLedger();
    expect(state).toMatchObject({ status: "ok", ledger: { entries: [{ state: "candidate", revision: 1 }] } });
  });
  it("distinguishes missing from corrupt and never resets corrupt state", async () => {
    const store = await importFresh();
    expect(await store.readSkillLedger()).toMatchObject({ status: "missing" });

    writeOnDisk(store.SKILL_STATE_PATH, "{not-json\n");
    const corrupt = await store.readSkillLedger();
    expect(corrupt).toMatchObject({ status: "corrupt", ledger: null });
    const mutation = await store.mutateSkillLedger(PROPOSE);
    expect(mutation).toMatchObject({ status: "corrupt", ledger: null });
    expect(readOnDisk(store.SKILL_STATE_PATH)).toBe("{not-json\n");
  });

  it("persists explicit proposal/adoption and replays operation ids without another write", async () => {
    const store = await importFresh();
    const proposed = await store.mutateSkillLedger(PROPOSE);
    expect(proposed).toMatchObject({ status: "applied", entry: { state: "candidate", revision: 1 } });
    const adopted = await store.mutateSkillLedger(ADOPT);
    expect(adopted).toMatchObject({ status: "applied", entry: { state: "adopted", revision: 2 } });
    const beforeReplay = readOnDisk(store.SKILL_STATE_PATH);

    const replay = await store.mutateSkillLedger(ADOPT);
    expect(replay.status).toBe("replayed");
    expect(readOnDisk(store.SKILL_STATE_PATH)).toBe(beforeReplay);

    const current = await store.readSkillLedger();
    expect(current).toMatchObject({ status: "ok" });
    if (current.status !== "ok") throw new Error("expected a readable ledger");
    expect(current.ledger.entries).toHaveLength(1);
    expect(current.ledger.operations.map((operation) => operation.operationId))
      .toEqual(["proposal-1", "adoption-1"]);
  });

  it("rejects a stale entry revision without changing unrelated entries", async () => {
    const store = await importFresh();
    await store.mutateSkillLedger(PROPOSE);
    await store.mutateSkillLedger(ADOPT);
    const beforeStale = readOnDisk(store.SKILL_STATE_PATH);
    const stale = await store.mutateSkillLedger({
      kind: "retire",
      operationId: "stale-retirement",
      id: "context-rule",
      expectedRevision: 1,
    });
    expect(stale).toMatchObject({ status: "rejected", code: "stale" });
    expect(readOnDisk(store.SKILL_STATE_PATH)).toBe(beforeStale);
  });

  it("uses the existing batch read-your-writes path and preserves sibling entries", async () => {
    const store = await importFresh();
    const { createBatch, flushBatch } = await import("@/lib/episodic/io-helpers");
    const batch = createBatch();
    await store.mutateSkillLedger(PROPOSE, batch);
    expect(readOnDisk(store.SKILL_STATE_PATH)).toBeNull();

    const replay = await store.mutateSkillLedger(PROPOSE, batch);
    expect(replay.status).toBe("replayed");
    expect(batch.entries.size).toBe(1);

    await store.mutateSkillLedger({
      kind: "propose",
      operationId: "proposal-2",
      expectedRevision: 0,
      draft: draft("second-rule"),
    }, batch);
    expect(batch.entries.size).toBe(1);
    await flushBatch(batch, "test skill ledger batch");

    const current = await store.readSkillLedger();
    if (current.status !== "ok") throw new Error("expected a readable ledger");
    expect(current.ledger.entries.map((entry) => entry.id)).toEqual([
      "context-rule",
      "second-rule",
    ]);
  });

  it("reads source content/revisions without auto-adopting a self document", async () => {
    const store = await importFresh();
    expect(await store.readSkillSource("self/main/index.md"))
      .toMatchObject({ status: "missing", content: null });
    writeOnDisk("memory/self/main/index.md", "# Existing notes\n\nNot an adopted instruction.");
    const source = await store.readSkillSource("self/main/index.md");
    expect(source).toMatchObject({ status: "ok", content: "# Existing notes\n\nNot an adopted instruction." });
    expect(await store.readSkillLedger()).toMatchObject({ status: "missing" });
  });

  it("rejects encoded traversal and illegal case names before opening a source", async () => {
    const store = await importFresh();
    for (const ref of ["self/%2e%2e%2fpeople%2fuser/index.md", "self/CON/index.md", "self/ leading/index.md"]) {
      expect(await store.readSkillSource(ref)).toMatchObject({ status: "unavailable", revision: null, diagnostic: expect.stringContaining("invalid skill source") });
    }
    writeOnDisk("memory/self/100%/index.md", "Literal percentage source.");
    expect(await store.readSkillSource("self/100%/index.md"))
      .toMatchObject({ status: "ok", content: "Literal percentage source." });
  });
});
