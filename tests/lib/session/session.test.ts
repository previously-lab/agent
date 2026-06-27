import { describe, it, expect, beforeEach } from "vitest";
import { getSession, updateTurn, setIntent, endSession, clearAllSessions } from "@/lib/session/manager";

describe("Session Manager", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it("creates a new session with defaults", () => {
    const session = getSession("test-session");
    expect(session.sessionId).toBe("test-session");
    expect(session.currentIntent).toBe("clarify");
    expect(session.recentTurns).toHaveLength(0);
    expect(session.status).toBe("running");
  });

  it("returns the same session on repeated calls", () => {
    const a = getSession("same-id");
    const b = getSession("same-id");
    expect(a).toBe(b);
  });

  it("maintains sliding window of 5 turns", () => {
    for (let i = 0; i < 10; i++) {
      updateTurn("test", { role: "user", content: `Message ${i}` });
    }
    const session = getSession("test");
    expect(session.recentTurns).toHaveLength(5);
    expect(session.recentTurns[0].content).toBe("Message 5");
    expect(session.recentTurns[4].content).toBe("Message 9");
  });

  it("extracts summary from analyzed action", () => {
    updateTurn("test", {
      role: "assistant",
      content: "I found the issue in auth.ts — the redirect path is wrong",
      action: "analyzed",
    });
    const session = getSession("test");
    expect(session.accumulatedSummary.attempted).toHaveLength(1);
    expect(session.accumulatedSummary.attempted[0]).toContain("auth.ts");
  });

  it("tracks linked memories from user messages with [[node]] syntax", () => {
    updateTurn("test", {
      role: "user",
      content: "See [[rust-ownership]] and [[github-file-state]] for reference",
    });
    const session = getSession("test");
    expect(session.linkedMemories).toContain("rust-ownership");
    expect(session.linkedMemories).toContain("github-file-state");
  });

  it("ends session and marks as done", () => {
    updateTurn("test", { role: "user", content: "Hello" });
    const session = endSession("test");
    expect(session.status).toBe("done");
  });
});
