import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withGitHubReadBudget: vi.fn(),
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(),
  fsListFiles: vi.fn(),
  readFileDemo: vi.fn(),
  resolveDataSource: vi.fn(),
  setDemoPersona: vi.fn(),
  getDemoPersona: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/github/client", () => ({
  withGitHubReadBudget: mocks.withGitHubReadBudget,
}));

vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: mocks.resolveDataSource,
}));

vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: mocks.readFileDemo,
  setDemoPersona: mocks.setDemoPersona,
  getDemoPersona: mocks.getDemoPersona,
}));

vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: mocks.fsReadFile,
  fsWriteFile: mocks.fsWriteFile,
  fsListFiles: mocks.fsListFiles,
}));

import { getRoomProfile } from "@/lib/game/room-profile-actions";
import { NEUTRAL_ROOM_PROFILE } from "@/lib/game/room-profile";

const SLICE = "2026-10-24-0930";
const PRIMARY = "memory/records/2026/10/24/0930/core.md";
const LEGACY = "memory/episodic/slices/2026/10/24/0930/timeline/core.md";

function core(focus = "", summary = "", turns = ""): string {
  return `---
slice_id: "${SLICE}"
focus: ${JSON.stringify(focus)}
start: "2026-10-24T09:30:00.000Z"
timezone: "UTC"
summary: ${JSON.stringify(summary)}
open_loops: []
decisions: []
tags: []
loops: []
---
${turns}`;
}

function missing(path: string): Error {
  return new Error(`File not found: "${path}"`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.resolveDataSource.mockReturnValue("local");
  mocks.withGitHubReadBudget.mockImplementation((fn: () => Promise<unknown>) => fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRoomProfile", () => {
  it("derives from one bounded logical core read with no enumeration, writes, model or network", async () => {
    mocks.fsReadFile.mockResolvedValue(core("撰写小说"));
    const result = await getRoomProfile(SLICE);
    expect(result.status).toBe("ready");
    expect(result.profile.activity).toBe("writing");
    expect(result.profile.primaryModule).toBe("study");
    expect(mocks.withGitHubReadBudget).toHaveBeenCalledTimes(1);
    expect(mocks.fsReadFile).toHaveBeenCalledTimes(1);
    expect(mocks.fsReadFile).toHaveBeenCalledWith(PRIMARY);
    expect(mocks.fsListFiles).not.toHaveBeenCalled();
    expect(mocks.fsWriteFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses only bounded user turns for an unmarked new record", async () => {
    const turns = `## Turn a1 — 2026-10-24T09:30:00.000Z (agent)
写作与制定计划

## Turn a2 — 2026-10-24T09:31:00.000Z (system)
研究资料

## Turn a3 — 2026-10-24T09:32:00.000Z (tool)
开发代码

## Turn a4 — 2026-10-24T09:33:00.000Z (user)
我想修复这个 bug`;
    mocks.fsReadFile.mockResolvedValue(core("", "", turns));
    const result = await getRoomProfile(SLICE);
    expect(result.status).toBe("ready");
    expect(result.profile.activity).toBe("making");
    expect(result.profile.evidence).toEqual(["user_turns:making"]);
  });

  it("distinguishes a real neutral result from both roots being missing", async () => {
    mocks.fsReadFile.mockResolvedValueOnce(core());
    expect(await getRoomProfile(SLICE)).toEqual({
      status: "ready",
      profile: NEUTRAL_ROOM_PROFILE,
    });

    mocks.fsReadFile
      .mockRejectedValueOnce(missing(PRIMARY))
      .mockRejectedValueOnce(missing(LEGACY));
    expect(await getRoomProfile(SLICE)).toEqual({
      status: "missing",
      profile: NEUTRAL_ROOM_PROFILE,
    });
    expect(mocks.fsReadFile).toHaveBeenCalledTimes(3);
    expect(mocks.fsReadFile).toHaveBeenNthCalledWith(2, PRIMARY);
    expect(mocks.fsReadFile).toHaveBeenNthCalledWith(3, LEGACY);
  });

  it("reads legacy only after an explicit primary miss and accepts its content", async () => {
    mocks.fsReadFile
      .mockRejectedValueOnce(missing(PRIMARY))
      .mockResolvedValueOnce(core("回顾今天并写日记"));
    expect(await getRoomProfile(SLICE)).toMatchObject({
      status: "ready",
      profile: { activity: "reflection" },
    });
    expect(mocks.fsReadFile).toHaveBeenCalledTimes(2);
    expect(mocks.fsReadFile).toHaveBeenNthCalledWith(1, PRIMARY);
    expect(mocks.fsReadFile).toHaveBeenNthCalledWith(2, LEGACY);
    expect(mocks.withGitHubReadBudget).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["429", Object.assign(new Error("rate limited"), { status: 429 })],
    ["timeout", new Error("GitHub read timed out")],
  ])(
    "keeps a primary %s unavailable instead of swallowing it with a legacy 404",
    async (_name, error) => {
      mocks.fsReadFile
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(missing(LEGACY));
      expect(await getRoomProfile(SLICE)).toEqual({
        status: "unavailable",
        profile: NEUTRAL_ROOM_PROFILE,
      });
      expect(mocks.fsReadFile).toHaveBeenCalledTimes(1);
      expect(mocks.fsReadFile).toHaveBeenCalledWith(PRIMARY);
    },
  );

  it("allows a later retry after a transient primary failure", async () => {
    mocks.fsReadFile.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await getRoomProfile(SLICE)).toEqual({
      status: "unavailable",
      profile: NEUTRAL_ROOM_PROFILE,
    });

    mocks.fsReadFile.mockResolvedValueOnce(core("回顾今天并写日记"));
    const retried = await getRoomProfile(SLICE);
    expect(retried.status).toBe("ready");
    expect(retried.profile.activity).toBe("reflection");
    expect(mocks.fsReadFile).toHaveBeenCalledTimes(2);
    expect(mocks.fsReadFile).toHaveBeenNthCalledWith(2, PRIMARY);
  });

  it("rejects invalid IDs before any read or budget scope", async () => {
    for (const invalid of [
      "../2026-10-24-0930",
      "2026-10-24",
      "2026-13-24-0930",
      "2026-10-24-2560",
      " 2026-10-24-0930 ",
      "not-a-record",
    ]) {
      expect(await getRoomProfile(invalid)).toEqual({
        status: "missing",
        profile: NEUTRAL_ROOM_PROFILE,
      });
    }
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
    expect(mocks.withGitHubReadBudget).not.toHaveBeenCalled();
    expect(mocks.fsListFiles).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails unavailable rather than inventing semantics from malformed core data", async () => {
    mocks.fsReadFile.mockResolvedValue('---\nfocus: "unterminated\n---');
    expect(await getRoomProfile(SLICE)).toEqual({
      status: "unavailable",
      profile: NEUTRAL_ROOM_PROFILE,
    });
    expect(mocks.fsReadFile).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit demo personas isolated across two concurrent reads", async () => {
    mocks.resolveDataSource.mockReturnValue("demo");
    const pending = new Map<string, { path: string; resolve: (raw: string) => void }>();
    mocks.readFileDemo.mockImplementation(
      (path: string, persona: string) =>
        new Promise<string>((resolve) => {
          pending.set(persona, { path, resolve });
        }),
    );

    const aliceRequest = getRoomProfile(SLICE, "alice");
    const bobRequest = getRoomProfile(SLICE, "bob");
    expect(pending.size).toBe(2);
    expect(pending.get("alice")?.path).toBe(PRIMARY);
    expect(pending.get("bob")?.path).toBe(PRIMARY);

    pending.get("bob")!.resolve(core("阅读文献"));
    expect((await bobRequest).profile.activity).toBe("research");
    pending.get("alice")!.resolve(core("撰写小说"));
    expect((await aliceRequest).profile.activity).toBe("writing");

    expect(mocks.readFileDemo).toHaveBeenCalledTimes(2);
    expect(mocks.readFileDemo).toHaveBeenNthCalledWith(1, PRIMARY, "alice");
    expect(mocks.readFileDemo).toHaveBeenNthCalledWith(2, PRIMARY, "bob");
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
    expect(mocks.getDemoPersona).not.toHaveBeenCalled();
  });

  it("uses the explicit user default without reading process-global persona", async () => {
    mocks.resolveDataSource.mockReturnValue("demo");
    mocks.readFileDemo.mockResolvedValue(core("写作"));
    expect(await getRoomProfile(SLICE)).toMatchObject({
      status: "ready",
      profile: { activity: "writing" },
    });
    expect(mocks.readFileDemo).toHaveBeenCalledWith(PRIMARY, "user");
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
    expect(mocks.getDemoPersona).not.toHaveBeenCalled();
  });

  it("rejects unsafe persona shapes before any source read", async () => {
    mocks.resolveDataSource.mockReturnValue("demo");
    for (const persona of [
      "",
      ".",
      "..",
      "../alice",
      "alice/other",
      "alice\\other",
      "alice smith",
      "a".repeat(65),
    ]) {
      expect(await getRoomProfile(SLICE, persona)).toEqual({
        status: "missing",
        profile: NEUTRAL_ROOM_PROFILE,
      });
    }
    expect(mocks.readFileDemo).not.toHaveBeenCalled();
    expect(mocks.fsReadFile).not.toHaveBeenCalled();
    expect(mocks.withGitHubReadBudget).not.toHaveBeenCalled();
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
    expect(mocks.getDemoPersona).not.toHaveBeenCalled();
  });
});
