import { describe, expect, it, vi } from "vitest";
import { createNativeNavigationGuard } from "@/lib/chat/native-navigation";

function pending() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
describe("native view handoff", () => {
  it("orders panel folds and shell navigation in the same intent domain", async () => {
    const fold = pending(), library = pending(), reopen = pending();
    const intent = { generation: 0 };
    const panel = createNativeNavigationGuard(vi.fn().mockReturnValueOnce(fold.promise).mockReturnValueOnce(reopen.promise), () => "user:/app", intent);
    const shell = createNativeNavigationGuard(() => library.promise, () => "user:/app", intent);
    const collapse = vi.fn(), navigate = vi.fn(), expand = vi.fn();
    const first = panel.run(collapse), second = shell.run(navigate);
    fold.resolve(); await first; expect(collapse).not.toHaveBeenCalled();
    const third = panel.run(expand);
    library.resolve(); await second; expect(navigate).not.toHaveBeenCalled();
    reopen.resolve(); await third; expect(expand).toHaveBeenCalledOnce();
  });

  it("waits for the flush and applies only the latest requested view", async () => {
    const first = pending(), second = pending();
    const flush = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const nav = createNativeNavigationGuard(flush, () => "user:/app");
    const library = vi.fn(), conversation = vi.fn();
    const older = nav.run(library), latest = nav.run(conversation);
    expect(library).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
    second.resolve(); await latest; first.resolve(); await older;
    expect(conversation).toHaveBeenCalledOnce(); expect(library).not.toHaveBeenCalled();
  });
  it("cancels pending work on teardown or a new source/persona/location", async () => {
    const wait = pending(); let scope = "user:/app";
    const nav = createNativeNavigationGuard(() => wait.promise, () => scope);
    const action = vi.fn(); const requested = nav.run(action);
    scope = "demo:/app?persona=alice"; wait.resolve(); await requested;
    expect(action).not.toHaveBeenCalled();
    const later = nav.run(action); nav.cancel(); await later;
    expect(action).not.toHaveBeenCalled();
  });
  it("does not trap the reader when a snapshot operation rejects", async () => {
    const nav = createNativeNavigationGuard(() => Promise.reject(new Error("frame gone")), () => "user:/app");
    const action = vi.fn(); await nav.run(action); expect(action).toHaveBeenCalledOnce();
  });
});
