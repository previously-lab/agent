import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  paths: vi.fn(),
  dossier: vi.fn(),
  persona: vi.fn(),
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({ enumerateTreePaths: mocks.paths }));
vi.mock("@/lib/archive/actions", () => ({ getDossierList: mocks.dossier }));
vi.mock("@/lib/demo/demo-fs", () => ({ setDemoPersona: mocks.persona }));

import { searchDocumentCatalog } from "@/lib/chat/document-catalog-actions";

describe("document catalog action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paths.mockResolvedValue([
      "memory/research/phone/index.md",
      "memory/research/phone/2026-10-01-price.md",
      "memory/research/phone/attachments/image.png",
      "memory/records/2026/10/02/1234/timeline/core.md",
      "memory/records/9999/99/99/9999/timeline/core.md",
    ]);
    mocks.dossier.mockResolvedValue([]);
  });

  it("includes validated case pieces from path metadata without content reads", async () => {
    const result = await searchDocumentCatalog({ query: "price", persona: "persona-one" });
    expect(result.items).toEqual([{
      ref: "research/phone/2026-10-01-price",
      title: "price",
      kind: "piece",
      category: "research",
    }]);
    expect(result.nextCursor).toBeNull();
    expect(mocks.paths).toHaveBeenCalledWith("memory");
    expect(mocks.persona).toHaveBeenCalledWith("persona-one");
    expect(mocks.dossier).toHaveBeenCalledWith("persona-one");
  });

  it("bounds cursor pages and omits impossible record dates", async () => {
    const first = await searchDocumentCatalog({ limit: 2 });
    expect(first.items.map((item) => item.ref)).toEqual(["records/2026-10-02-1234", "research/phone"]);
    expect(first.nextCursor).toBe("2");
    const second = await searchDocumentCatalog({ cursor: first.nextCursor ?? undefined, limit: 2 });
    expect(second.items.map((item) => item.ref)).toEqual(["research/phone/2026-10-01-price"]);
    expect(second.nextCursor).toBeNull();
    expect(second.items.some((item) => item.ref.includes("9999"))).toBe(false);
  });
});
