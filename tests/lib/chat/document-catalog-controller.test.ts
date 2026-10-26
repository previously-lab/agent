import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentCatalogController } from "@/lib/chat/document-catalog-controller";
import type { DocumentCatalogItem, DocumentCatalogPage } from "@/lib/chat/document-catalog-actions";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function item(ref: string): DocumentCatalogItem {
  return { ref, title: ref, kind: "case" };
}

function page(items: DocumentCatalogItem[], nextCursor: string | null = null): DocumentCatalogPage {
  return { items, nextCursor };
}

describe("document catalog controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops old items immediately and ignores delayed query A after query B", async () => {
    const a = deferred<DocumentCatalogPage>();
    const b = deferred<DocumentCatalogPage>();
    const lookup = vi.fn()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const controller = createDocumentCatalogController(lookup, 250);
    controller.setSearch(true, "A", "user");
    await vi.advanceTimersByTimeAsync(250);
    expect(lookup).toHaveBeenCalledWith({ query: "A", persona: "user", limit: 12 });
    controller.setSearch(true, "B", "user");
    expect(controller.getSnapshot(true, "B", "user").items).toEqual([]);
    expect(controller.getSnapshot(true, "B", "user").status).toBe("loading");
    expect(controller.getSnapshot(true, "B", "user").nextCursor).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    b.resolve(page([item("research/B")]));
    await Promise.resolve();
    expect(controller.getSnapshot(true, "B", "user").items.map((entry) => entry.ref)).toEqual(["research/B"]);
    a.resolve(page([item("research/A")]));
    await Promise.resolve();
    expect(controller.getSnapshot(true, "B", "user").items.map((entry) => entry.ref)).toEqual(["research/B"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("resets a delayed load-more when query or persona changes and never applies its old page", async () => {
    const initial = deferred<DocumentCatalogPage>();
    const more = deferred<DocumentCatalogPage>();
    const next = deferred<DocumentCatalogPage>();
    const lookup = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(more.promise)
      .mockReturnValueOnce(next.promise);
    const controller = createDocumentCatalogController(lookup, 250);
    controller.setSearch(true, "A", "one");
    await vi.advanceTimersByTimeAsync(250);
    initial.resolve(page([item("research/A1")], "12"));
    await Promise.resolve();
    controller.loadMore(true, "A", "one");
    expect(controller.getSnapshot(true, "A", "one").loadingMore).toBe(true);
    controller.setSearch(true, "B", "two");
    const pending = controller.getSnapshot(true, "B", "two");
    expect(pending.items).toEqual([]);
    expect(pending.nextCursor).toBeNull();
    expect(pending.loadingMore).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    next.resolve(page([item("research/B1")]));
    await Promise.resolve();
    more.resolve(page([item("research/A2")], "24"));
    await Promise.resolve();
    const current = controller.getSnapshot(true, "B", "two");
    expect(current.items.map((entry) => entry.ref)).toEqual(["research/B1"]);
    expect(current.loadingMore).toBe(false);
    expect(current.nextCursor).toBeNull();
    expect(lookup).toHaveBeenNthCalledWith(2, { query: "A", persona: "one", cursor: "12", limit: 12 });
    expect(lookup).toHaveBeenNthCalledWith(3, { query: "B", persona: "two", limit: 12 });
    controller.dispose();
  });

  it("debounces fresh lookups and makes pagination explicit", async () => {
    const lookup = vi.fn(async (input: { query?: string; cursor?: string }): Promise<DocumentCatalogPage> =>
      input.cursor ? page([item("research/page2")]) : page([item("research/page1")], "12"));
    const controller = createDocumentCatalogController(lookup, 250);
    controller.setSearch(true, "same", "user");
    controller.setSearch(true, "same", "user");
    await vi.advanceTimersByTimeAsync(249);
    expect(lookup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(1);
    controller.loadMore(true, "same", "user");
    await Promise.resolve();
    expect(controller.getSnapshot(true, "same", "user").items.map((entry) => entry.ref)).toEqual(["research/page1", "research/page2"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
