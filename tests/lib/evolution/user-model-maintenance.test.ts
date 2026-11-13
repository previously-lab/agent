import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const api = vi.hoisted(() => ({ get: vi.fn(), getRef: vi.fn() }));
vi.mock("@/lib/github/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/github/client")>(),
  getOctokit: () => ({ rest: { repos: api, git: api } }),
}));
vi.mock("@/lib/episodic/timeline/enumerate", () => ({ enumerateSliceIds: vi.fn() }));

const MODEL_PATH = "memory/people/user/index.md";
const DIRECTION = [
  "# Portrait",
  "",
  "# Hypotheses",
  "",
  "- [proposed 2026-11-01-0900] The user may prefer terse plans — falsify if: the user asks for detail",
].join("\n");
const ORIGINAL = `current card\n\n---\n\n${DIRECTION}`;
let tmpDir: string;
let originalStorage: string | undefined;
let originalMemoryRoot: string | undefined;
let maintain: typeof import("@/lib/evolution/user-model-maintenance").maintainUserModelHypothesisTtl;
let enumerate: ReturnType<typeof vi.mocked<typeof import("@/lib/episodic/timeline/enumerate").enumerateSliceIds>>;

function writeModel(content: string): void {
  const target = path.join(tmpDir, MODEL_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readModel(): string {
  return fs.readFileSync(path.join(tmpDir, MODEL_PATH), "utf8");
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "previously-ttl-test-"));
  originalStorage = process.env.STORAGE;
  originalMemoryRoot = process.env.MEMORY_ROOT;
  process.env.STORAGE = "local";
  process.env.MEMORY_ROOT = path.join(tmpDir, "memory");
  writeModel(ORIGINAL);
  maintain = (await import("@/lib/evolution/user-model-maintenance")).maintainUserModelHypothesisTtl;
  enumerate = vi.mocked((await import("@/lib/episodic/timeline/enumerate")).enumerateSliceIds);
  enumerate.mockReset();
  enumerate.mockResolvedValue([
    "2026/11/10/0900",
    "2026/11/11/0900",
    "2026/11/12/0900",
    "2026/11/13/0900",
  ]);
  api.get.mockResolvedValue({ data: { default_branch: "main" } });
  api.getRef.mockResolvedValue({ data: { object: { sha: "live-head" } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStorage === undefined) delete process.env.STORAGE;
  else process.env.STORAGE = originalStorage;
  if (originalMemoryRoot === undefined) delete process.env.MEMORY_ROOT;
  else process.env.MEMORY_ROOT = originalMemoryRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("maintainUserModelHypothesisTtl", () => {
  it("persists expired-hypothesis retirement without requiring an agent pass", async () => {
    const result = await maintain("2026-11-13-1200");
    expect(result.retired).toHaveLength(1);
    expect(readModel()).not.toContain("terse plans");
    expect(readModel()).toContain("current card");
  });

  it("does not rewrite the document when nothing expired", async () => {
    enumerate.mockResolvedValue(["2026/11/02/0900"]);
    const io = await import("@/lib/episodic/io-helpers");
    const flush = vi.spyOn(io, "flushBatch");
    expect(await maintain("2026-11-13-1200")).toEqual({ retired: [] });
    expect(readModel()).toBe(ORIGINAL);
    expect(flush).not.toHaveBeenCalled();
  });

  it("preserves every hypothesis with a diagnostic when enumeration fails", async () => {
    enumerate.mockRejectedValue(new Error("tree unavailable"));
    const result = await maintain("2026-11-13-1200");
    expect(result.retired).toEqual([]);
    expect(result.diagnostic).toContain("tree unavailable");
    expect(readModel()).toBe(ORIGINAL);
  });

  it("does not turn a current-model read failure into an empty direction", async () => {
    fs.rmSync(path.join(tmpDir, MODEL_PATH));
    fs.mkdirSync(path.join(tmpDir, MODEL_PATH));
    await expect(maintain("2026-11-13-1200")).rejects.toThrow("is a directory");
    expect(enumerate).not.toHaveBeenCalled();
  });

  it("rejects a model changed after the TTL read instead of overwriting its new direction", async () => {
    const concurrent = ORIGINAL.replace("current card", "new card")
      .replace("terse plans", "longer explanations");
    enumerate.mockImplementationOnce(async () => {
      writeModel(concurrent);
      return ["2026/11/10/0900", "2026/11/11/0900", "2026/11/12/0900", "2026/11/13/0900"];
    });
    await expect(maintain("2026-11-13-1200")).rejects.toThrow("changed after the fresh write basis");
    expect(readModel()).toBe(concurrent);
  });

  it("stages into the caller's batch and preserves its pending card without publishing early", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const store = await import("@/lib/evolution/store");
    const batch = io.createBatch();
    await store.writeUserModelCard("pending card", batch);
    expect((await maintain("2026-11-13-1200", batch)).retired).toHaveLength(1);
    expect(readModel()).toBe(ORIGINAL);
    expect(batch.entries.get(MODEL_PATH)).toContain("pending card");
    expect(batch.entries.get(MODEL_PATH)).not.toContain("terse plans");
    await io.flushBatch(batch, "Test TTL maintenance");
    expect(readModel()).toContain("pending card");
    expect(readModel()).not.toContain("terse plans");
  });

  it("keeps a caller's batch unchanged when retirement cannot enumerate records", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const batch = io.createBatch();
    enumerate.mockRejectedValue(new Error("tree unavailable"));
    await maintain("2026-11-13-1200", batch);
    expect(batch.entries.size).toBe(0);
    expect(batch.documentBases).toBeUndefined();
  });

  it("enumerates under a fresh view even when reflection pinned an old history head", async () => {
    const views = await import("@/lib/github/read-view");
    enumerate.mockImplementationOnce(async () => {
      expect((await views.getGitHubReadHead("repo", "owner")).headSha).toBe("live-head");
      return [];
    });
    await views.withGitHubReadView(async () => {
      views.seedGitHubReadHead("repo", "owner", { headSha: "historical-head" });
      await maintain("2026-11-13-1200");
      expect((await views.getGitHubReadHead("repo", "owner")).headSha).toBe("historical-head");
    });
    expect(api.getRef).toHaveBeenCalledTimes(1);
  });
});
