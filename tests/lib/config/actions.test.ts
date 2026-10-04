import { describe, it, expect, vi, beforeEach } from "vitest";

// saveUserConfig's job after the v0.19 re-root: writes land ONLY on
// memory/config/settings.json (never the legacy memory/user/config.json),
// and the local git ledger commits the same new relative path.
const mockWriteFile = vi.fn();
const mockWriteFileLocal = vi.fn();
const mockCommitPaths = vi.fn();
const mockIsGitRepo = vi.fn();
const mockLoadUserConfig = vi.fn();
const mockInvalidate = vi.fn();
let source: "local" | "github" = "local";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tools/writeFile", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));
vi.mock("@/lib/tools/local-fs", () => ({
  writeFileLocal: (...args: unknown[]) => mockWriteFileLocal(...args),
}));
vi.mock("@/lib/capabilities", () => ({
  getRepoConfig: () => ({ owner: "o", repo: "r" }),
  isDemo: () => false,
}));
vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: () => source,
}));
vi.mock("@/lib/whitelist", () => ({ getMemoryRoot: () => "/tmp/memory" }));
vi.mock("@/lib/episodic/local-git", () => ({
  commitPaths: (...args: unknown[]) => mockCommitPaths(...args),
  isGitRepo: () => mockIsGitRepo(),
}));
vi.mock("@/lib/config/loader", () => ({
  loadUserConfig: () => mockLoadUserConfig(),
  invalidateUserConfigCache: () => mockInvalidate(),
}));

import { saveUserConfig } from "@/lib/config/actions";
import { DEFAULTS } from "@/lib/config/defaults";

describe("saveUserConfig write root (v0.19)", () => {
  beforeEach(() => {
    source = "local";
    mockLoadUserConfig.mockResolvedValue(DEFAULTS);
    mockIsGitRepo.mockReturnValue(true);
    vi.clearAllMocks();
  });

  it("writes only the new config/ root in local mode and commits it to the ledger", async () => {
    const result = await saveUserConfig({ onboarded: true });

    expect(result).toEqual({ ok: true });
    expect(mockWriteFileLocal).toHaveBeenCalledTimes(1);
    expect(mockWriteFileLocal.mock.calls[0][0]).toBe("memory/config/settings.json");
    expect(mockCommitPaths).toHaveBeenCalledWith(
      "/tmp/memory",
      ["config/settings.json"],
      "Update config/settings.json",
    );
    // The parsed-config cache is dropped so the next read sees the save.
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it("writes only the new config/ root in github mode", async () => {
    source = "github";

    const result = await saveUserConfig({ onboarded: true });

    expect(result).toEqual({ ok: true });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile.mock.calls[0][0]).toBe("memory/config/settings.json");
    expect(mockWriteFile.mock.calls[0][2]).toBe("r");
    expect(mockWriteFile.mock.calls[0][3]).toBe("o");
    expect(mockWriteFileLocal).not.toHaveBeenCalled();
    expect(mockCommitPaths).not.toHaveBeenCalled();
  });

  it("skips the ledger commit when the memory root is not a git repo", async () => {
    mockIsGitRepo.mockReturnValue(false);

    await saveUserConfig({ onboarded: true });

    expect(mockWriteFileLocal).toHaveBeenCalledTimes(1);
    expect(mockCommitPaths).not.toHaveBeenCalled();
  });
});
