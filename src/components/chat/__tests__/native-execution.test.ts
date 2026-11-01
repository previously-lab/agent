import { describe, expect, it, vi } from "vitest";
import { createNativeExecutionRegistry, createNativeFlushTracker } from "../native-execution";

describe("native execution ownership", () => {
  it("keeps a single writer when a chat turn is also open in a reading document", () => {
    const registry = createNativeExecutionRegistry();
    const releaseChat = registry.claim("reply", "chat", 1);
    expect(registry.owns("reply", "chat")).toBe(true);
    const releasePaper = registry.claim("reply", "top-paper", 2);
    expect(registry.owns("reply", "chat")).toBe(false);
    expect(registry.owns("reply", "top-paper")).toBe(true);
    releasePaper();
    expect(registry.owns("reply", "chat")).toBe(true);
    releaseChat();
    expect(registry.hasOwner("reply")).toBe(false);
  });

  it("does not let equal-priority duplicates steal the active copy on rerender", () => {
    const registry = createNativeExecutionRegistry();
    const releaseFirst = registry.claim("reply", "first", 2);
    const releaseSecond = registry.claim("reply", "second", 2);
    expect(registry.owns("reply", "first")).toBe(true);
    expect(registry.owns("reply", "second")).toBe(false);
    releaseFirst();
    expect(registry.owns("reply", "second")).toBe(true);
    releaseSecond();
  });

  it("lets the foreground fullscreen conversation take over a still-mounted reader", () => {
    const registry = createNativeExecutionRegistry();
    const releasePaper = registry.claim("reply", "paper", 2);
    const releaseFull = registry.claim("reply", "fullscreen", 3);
    expect(registry.owns("reply", "fullscreen")).toBe(true);
    expect(registry.owns("reply", "paper")).toBe(false);
    releaseFull();
    expect(registry.owns("reply", "paper")).toBe(true);
    releasePaper();
  });

  it("keeps identities independent and notifies only the affected identity", () => {
    const registry = createNativeExecutionRegistry();
    const other = vi.fn();
    const unsubscribe = registry.subscribe("other-persona", other);
    const releaseA = registry.claim("source-a", "a", 1);
    const releaseB = registry.claim("other-persona", "b", 1);
    expect(registry.owns("source-a", "a")).toBe(true);
    expect(registry.owns("other-persona", "b")).toBe(true);
    expect(other).toHaveBeenCalledTimes(1);
    releaseA();
    expect(other).toHaveBeenCalledTimes(1);
    releaseB();
    expect(other).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("native flush handoff", () => {
  it("does not release a page turn on an older queued snapshot", () => {
    const tracker = createNativeFlushTracker();
    const turnPage = vi.fn();
    tracker.wait("flush-2", turnPage);
    tracker.acknowledge(); // Earlier ordinary state {count: 1}.
    tracker.acknowledge("flush-1");
    expect(turnPage).not.toHaveBeenCalled();
    tracker.acknowledge("flush-2"); // Exact response after capturing {count: 2}.
    expect(turnPage).toHaveBeenCalledOnce();
    tracker.acknowledge("flush-2");
    expect(turnPage).toHaveBeenCalledOnce();
  });

  it("cleans up timed-out and unmounted frame requests", () => {
    const tracker = createNativeFlushTracker();
    const expired = vi.fn();
    const pending = vi.fn();
    tracker.wait("old", expired);
    tracker.forget("old");
    tracker.acknowledge("old");
    tracker.wait("new", pending);
    tracker.dispose();
    expect(expired).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledOnce();
    tracker.acknowledge("new");
    expect(pending).toHaveBeenCalledOnce();
  });
});
