/**
 * Tests for the evolution data layer store (src/lib/evolution/store.ts),
 * v0.19 R4/R5 surface: the folded people/user/index.md user model
 * (compose/split seam, dual-root reads, half-preserving writes), profile.md
 * dual-root reads, the legacy direction doc tolerance, and self/ SOP I/O
 * (full-document reads, new-root-only writes).
 *
 * Same harness as tests/lib/episodic/batch-mode.test.ts: a temp cwd +
 * STORAGE=local so all I/O lands on the local filesystem backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-evolution-test-"));
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
  return import("@/lib/evolution/store");
}

function readOnDisk(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

function writeOnDisk(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

// ── compose / split seam ─────────────────────────────────────────────────

describe("composeUserModel / splitUserModel", () => {
  it("round-trips card + direction through the separator seam", async () => {
    const store = await importFresh();
    const full = store.composeUserModel("# Card\n\nDoing things.", "# Direction\n\nHypotheses.");
    expect(full).toBe(
      `# Card\n\nDoing things.${store.USER_MODEL_DIRECTION_SEPARATOR}# Direction\n\nHypotheses.`,
    );
    expect(store.splitUserModel(full)).toEqual({
      card: "# Card\n\nDoing things.",
      direction: "# Direction\n\nHypotheses.",
    });
  });

  it("degenerates cleanly when one half is empty", async () => {
    const store = await importFresh();
    expect(store.composeUserModel("# Card only", null)).toBe("# Card only");
    expect(store.composeUserModel("", "# Direction only")).toBe("# Direction only");
    expect(store.splitUserModel("# Card only")).toEqual({
      card: "# Card only",
      direction: null,
    });
  });
});

// ── readUserModel — dual-root tolerance ──────────────────────────────────

describe("readUserModel", () => {
  it("returns null on a fresh deployment (neither root holds anything)", async () => {
    const store = await importFresh();
    expect(await store.readUserModel()).toBeNull();
  });

  it("reads the folded index.md from the new root and splits the halves", async () => {
    writeOnDisk(
      "memory/people/user/index.md",
      "# Card\n\nNew root card.\n\n---\n\n# Direction\n\nNew root direction.\n",
    );
    const store = await importFresh();
    const model = await store.readUserModel();
    expect(model?.card).toBe("# Card\n\nNew root card.");
    expect(model?.direction).toBe("# Direction\n\nNew root direction.");
    expect(model?.full).toContain("---");
  });

  it("composes from the legacy roots on a new-root miss WITHOUT writing back", async () => {
    writeOnDisk("memory/episodic/current-previously.md", "# Legacy card\n\nOld card.");
    writeOnDisk("memory/evolution/direction.md", "# Legacy direction\n\nOld direction.");
    const store = await importFresh();
    const model = await store.readUserModel();
    expect(model?.card).toBe("# Legacy card\n\nOld card.");
    expect(model?.direction).toBe("# Legacy direction\n\nOld direction.");
    expect(model?.full).toBe(
      `# Legacy card\n\nOld card.${store.USER_MODEL_DIRECTION_SEPARATOR}# Legacy direction\n\nOld direction.`,
    );
    // No backfill: the new root must NOT have been created by a read.
    expect(readOnDisk("memory/people/user/index.md")).toBeNull();
  });

  it("prefers the new root when both roots exist", async () => {
    writeOnDisk("memory/people/user/index.md", "# New card");
    writeOnDisk("memory/episodic/current-previously.md", "# Legacy card");
    const store = await importFresh();
    expect((await store.readUserModel())?.card).toBe("# New card");
  });
});

// ── Half-preserving writes ───────────────────────────────────────────────

describe("writeUserModelCard / writeUserModelDirection", () => {
  it("writeUserModelCard preserves the existing direction half", async () => {
    writeOnDisk(
      "memory/people/user/index.md",
      "# Old card\n\n---\n\n# Direction\n\nKeep me.",
    );
    const store = await importFresh();
    await store.writeUserModelCard("# New card\n\nUpdated.");
    const written = readOnDisk("memory/people/user/index.md")!;
    const { card, direction } = store.splitUserModel(written);
    expect(card).toBe("# New card\n\nUpdated.");
    expect(direction).toBe("# Direction\n\nKeep me.");
  });

  it("writeUserModelDirection preserves the existing card half", async () => {
    writeOnDisk("memory/people/user/index.md", "# Card\n\nKeep me.\n\n---\n\n# Old direction");
    const store = await importFresh();
    await store.writeUserModelDirection("# Direction\n\nUpdated.");
    const written = readOnDisk("memory/people/user/index.md")!;
    const { card, direction } = store.splitUserModel(written);
    expect(card).toBe("# Card\n\nKeep me.");
    expect(direction).toBe("# Direction\n\nUpdated.");
  });

  it("a card write on a legacy-only deployment carries the legacy direction into the new root", async () => {
    writeOnDisk("memory/episodic/current-previously.md", "# Legacy card");
    writeOnDisk("memory/evolution/direction.md", "# Legacy direction");
    const store = await importFresh();
    await store.writeUserModelCard("# New card");
    const written = readOnDisk("memory/people/user/index.md")!;
    expect(written).toBe(
      `# New card${store.USER_MODEL_DIRECTION_SEPARATOR}# Legacy direction`,
    );
    // Legacy roots are left untouched (read tolerance, not migration).
    expect(readOnDisk("memory/evolution/direction.md")).toBe("# Legacy direction");
  });
});

// ── profile.md — dual-root read, never written by the agent ──────────────

describe("readUserProfile", () => {
  it("returns null when neither root has a profile", async () => {
    const store = await importFresh();
    expect(await store.readUserProfile()).toBeNull();
  });

  it("reads the new root first, then the legacy memory/user/profile.md", async () => {
    writeOnDisk("memory/user/profile.md", "Legacy self-description.");
    const store = await importFresh();
    expect(await store.readUserProfile()).toBe("Legacy self-description.");

    writeOnDisk("memory/people/user/profile.md", "New self-description.");
    expect(await store.readUserProfile()).toBe("New self-description.");
  });
});

// ── Legacy direction doc tolerance ───────────────────────────────────────

describe("readDirection / isDirectionTemplate", () => {
  it("returns null when direction.md does not exist", async () => {
    const store = await importFresh();
    expect(await store.readDirection()).toBeNull();
  });

  it("reads the legacy direction doc", async () => {
    writeOnDisk("memory/evolution/direction.md", "# Direction\n\nBody.");
    const store = await importFresh();
    expect(await store.readDirection()).toBe("# Direction\n\nBody.");
  });

  it("treats missing content and untouched templates as the bootstrap state", async () => {
    const store = await importFresh();
    expect(store.isDirectionTemplate(null)).toBe(true);
    expect(store.isDirectionTemplate("## Current focus\n\n(Not set yet — fill in.)")).toBe(true);
    expect(store.isDirectionTemplate("# Direction\n\nReal content.")).toBe(false);
  });
});

// ── self/ SOPs ───────────────────────────────────────────────────────────

describe("self/ SOP I/O", () => {
  it("readSelfSop returns null when neither root has the SOP", async () => {
    const store = await importFresh();
    expect(await store.readSelfSop("search")).toBeNull();
  });

  it("reads the FULL legacy playbook on a new-root miss — no length cap", async () => {
    const long = `# Search playbook\n\n${"line of guidance\n".repeat(500)}`;
    writeOnDisk("memory/agent-playbooks/search.md", long);
    const store = await importFresh();
    expect(await store.readSelfSop("search")).toBe(long);
  });

  it("writeSelfSop lands on the new root only and readSelfSop prefers it", async () => {
    writeOnDisk("memory/agent-playbooks/recall.md", "# Legacy recall playbook");
    const store = await importFresh();
    await store.writeSelfSop("recall", "# Recall SOP\n\nNew overview. Evidence: slice abc.");
    expect(readOnDisk("memory/self/recall/index.md")).toBe(
      "# Recall SOP\n\nNew overview. Evidence: slice abc.",
    );
    expect(await store.readSelfSop("recall")).toContain("New overview");
    // Legacy playbook untouched.
    expect(readOnDisk("memory/agent-playbooks/recall.md")).toBe("# Legacy recall playbook");
  });
});
