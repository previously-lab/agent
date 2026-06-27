import { describe, it, expect, vi } from "vitest";
import { archiveSession } from "@/lib/archive/sync";
import type { SessionState } from "@/lib/session/manager";

function makeSession(): SessionState {
  return {
    sessionId: "test-session",
    currentIntent: "code_debug",
    recentTurns: [{ role: "user", content: "Help" }],
    accumulatedSummary: { goal: "Fix bug", attempted: ["analyzed auth"], current_blocker: "" },
    linkedMemories: ["rust-ownership"],
    startTime: "2026-06-27T20:00:00Z",
    status: "done",
  };
}

describe("Archive Sync", () => {
  it("calls writeFn with correct path for session", async () => {
    const writeFn = vi.fn().mockResolvedValue({});
    const session = makeSession();

    await archiveSession("sess-001", session, writeFn);

    expect(writeFn).toHaveBeenCalledTimes(1);
    const [path, content] = writeFn.mock.calls[0];
    expect(path).toBe("sessions/sess-001.json");
    const parsed = JSON.parse(content);
    expect(parsed.session_id).toBe("sess-001");
    expect(parsed.summary.goal).toBe("Fix bug");
  });

  it("retries on failure and succeeds on second attempt", async () => {
    const writeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({});

    const session = makeSession();
    await archiveSession("sess-002", session, writeFn);

    expect(writeFn).toHaveBeenCalledTimes(2);
  });

  it("throws after all retries exhausted", async () => {
    const writeFn = vi.fn().mockRejectedValue(new Error("Always fails"));

    await expect(
      archiveSession("sess-003", makeSession(), writeFn)
    ).rejects.toThrow("Always fails");

    expect(writeFn).toHaveBeenCalledTimes(3);
  });
});
