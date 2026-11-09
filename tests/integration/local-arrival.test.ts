/** Real arrival → enumeration → local filesystem, using only temporary fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const remote = vi.hoisted(() => ({ github: vi.fn(), demo: vi.fn(), deniedDirectory: "" }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (String(args[0]) === remote.deniedDirectory) {
        throw Object.assign(new Error("Fixture permission denied"), { code: "EACCES" });
      }
      return actual.readdirSync(...args);
    },
  };
});
vi.mock("@/lib/tools/readFile", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tools/readFile")>(),
  getRepoTree: remote.github,
  readFile: remote.github,
  readFileViaTree: remote.github,
}));
vi.mock("@/lib/demo/demo-fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/demo/demo-fs")>(),
  readFileDemo: remote.demo,
  listFilesDemo: remote.demo,
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }));

let fixtureRoot: string;
let originalCwd: string;
const sliceId = "2026-11-01-0900";
const newCore = "records/2026/11/01/0900/core.md";
const legacyCore = "episodic/slices/2026/11/01/0900/timeline/core.md";

function seed(root: string, relative: string, body = "Local fixture conversation") {
  const file = join(root, relative);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nslice_id: ${sliceId}\nstart: '2026-11-01T09:00:00.000Z'\n---\n\n## Turn fixture-turn — 2026-11-01T09:00:00.000Z (user)\n\n${body}\n`, "utf8");
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(join(tmpdir(), "aftrbrez-local-arrival-"));
  originalCwd = process.cwd();
  process.chdir(fixtureRoot);
  for (const name of ["MEMORY_ROOT", "PREVIOUSLY_HOME", "PREVIOUSLY_MODE", "TASKS_ROOT", "SESSIONS_ROOT", "PREVIOUSLY_LOCAL_LATENCY_MS", "PREVIOUSLY_LOCAL_LATENCY_LOG"]) vi.stubEnv(name, "");
  vi.stubEnv("STORAGE", "local");
  vi.stubEnv("GITHUB_TOKEN", "fixture-not-a-real-token");
  remote.github.mockReset().mockRejectedValue(new Error("Local arrival must not read GitHub"));
  remote.demo.mockReset().mockRejectedValue(new Error("Local arrival must not read a demo persona"));
  remote.deniedDirectory = "";
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T09:05:00.000Z"));
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // This test owns only the directory returned by mkdtemp above.
  if (resolve(fixtureRoot).startsWith(resolve(tmpdir()) + "\\") || resolve(fixtureRoot).startsWith(resolve(tmpdir()) + "/")) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

async function arrival(persona = "user") {
  const { getArrivalState } = await import("@/lib/episodic/actions");
  const state = await getArrivalState(persona);
  expect(remote.github).not.toHaveBeenCalled();
  expect(remote.demo).not.toHaveBeenCalled();
  return state;
}

describe("local arrival without a Git repository", () => {
  it.each([false, true])("briefs when the memory root is absent or empty (exists=%s)", async (exists) => {
    if (exists) fs.mkdirSync(join(fixtureRoot, "memory"));
    expect(await arrival()).toEqual({ mode: "briefing" });
    expect(fs.existsSync(join(fixtureRoot, "memory", ".git"))).toBe(false);
  });

  it("resumes the legacy repo-local directory without migration or git", async () => {
    seed(join(fixtureRoot, "memory"), legacyCore, "Legacy local fixture");
    const state = await arrival();
    expect(state).toMatchObject({ mode: "resume", sliceId, turns: [{ content: "Legacy local fixture" }] });
    expect(fs.existsSync(join(fixtureRoot, "memory", newCore))).toBe(false);
  });

  it("prefers the new record when both layouts contain the same slice", async () => {
    seed(join(fixtureRoot, "memory"), legacyCore, "Legacy duplicate");
    seed(join(fixtureRoot, "memory"), newCore, "New record fixture");
    expect(await arrival()).toMatchObject({ mode: "resume", turns: [{ content: "New record fixture" }] });
  });

  it("honors MEMORY_ROOT independently of cwd, client home, and demo persona", async () => {
    const selected = join(fixtureRoot, "selected-memory");
    const clientHome = join(fixtureRoot, "client-home");
    seed(join(fixtureRoot, "memory"), newCore, "Wrong checkout memory");
    seed(join(clientHome, "memory"), newCore, "Wrong client home memory");
    seed(selected, legacyCore, "Explicit legacy memory");
    vi.stubEnv("MEMORY_ROOT", selected);
    vi.stubEnv("PREVIOUSLY_HOME", clientHome);
    vi.stubEnv("PREVIOUSLY_MODE", "client");
    expect(await arrival("alice")).toMatchObject({ mode: "resume", turns: [{ content: "Explicit legacy memory" }] });
    expect(await arrival("bob")).toMatchObject({ mode: "resume", turns: [{ content: "Explicit legacy memory" }] });
  });

  it("does not fall back from an empty configured root to checkout, home, or GitHub", async () => {
    seed(join(fixtureRoot, "memory"), newCore, "Wrong checkout memory");
    vi.stubEnv("MEMORY_ROOT", join(fixtureRoot, "missing-memory"));
    vi.stubEnv("PREVIOUSLY_HOME", join(fixtureRoot, "client-home"));
    expect(await arrival()).toEqual({ mode: "briefing" });
  });

  it("rejects an invalid relative MEMORY_ROOT instead of treating it as empty", async () => {
    vi.stubEnv("MEMORY_ROOT", "relative-memory");
    await expect(arrival()).rejects.toThrow("MEMORY_ROOT must be an absolute path");
    expect(remote.github).not.toHaveBeenCalled();
    expect(remote.demo).not.toHaveBeenCalled();
  });

  it.each(["records", "episodic/slices"])("does not hide an invalid %s directory as empty memory", async (relative) => {
    const file = join(fixtureRoot, "memory", relative);
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(file, "Fixture: a file where a directory is required", "utf8");
    await expect(arrival()).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(remote.github).not.toHaveBeenCalled();
    expect(remote.demo).not.toHaveBeenCalled();
  });

  it("propagates access failures instead of reporting an empty root", async () => {
    remote.deniedDirectory = join(process.cwd(), "memory", "records");
    await expect(arrival()).rejects.toMatchObject({ code: "EACCES" });
    expect(remote.github).not.toHaveBeenCalled();
    expect(remote.demo).not.toHaveBeenCalled();
  });
});
