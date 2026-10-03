import { describe, it, expect } from "vitest";
import {
  normalizeDocRef,
  docPathCandidates,
  DOC_KINDS,
} from "@/lib/docs";

describe("normalizeDocRef", () => {
  it("accepts a bare file name", () => {
    expect(normalizeDocRef("2026-09-05-手机购买调研.md")).toBe(
      "2026-09-05-手机购买调研.md",
    );
  });

  it("appends .md when omitted", () => {
    expect(normalizeDocRef("用户手机")).toBe("用户手机.md");
    expect(normalizeDocRef("2026-09-05-手机购买调研")).toBe(
      "2026-09-05-手机购买调研.md",
    );
  });

  it("strips book-title marks", () => {
    expect(normalizeDocRef("《用户手机》")).toBe("用户手机.md");
    expect(normalizeDocRef("《2026-09-05-手机购买调研》")).toBe(
      "2026-09-05-手机购买调研.md",
    );
  });

  it("strips any path prefix — references are file names, not paths", () => {
    expect(normalizeDocRef("memory/docs/topic/用户手机.md")).toBe("用户手机.md");
    expect(normalizeDocRef("docs/research/2026-09-05-x.md")).toBe("2026-09-05-x.md");
    expect(normalizeDocRef("C:\\mem\\docs\\topic\\用户手机.md")).toBe("用户手机.md");
    expect(normalizeDocRef("/abs/path/任意.md")).toBe("任意.md");
  });

  it("returns null when nothing usable remains", () => {
    expect(normalizeDocRef("")).toBeNull();
    expect(normalizeDocRef("   ")).toBeNull();
    expect(normalizeDocRef("《》")).toBeNull();
    expect(normalizeDocRef("/")).toBeNull();
    expect(normalizeDocRef(null as unknown as string)).toBeNull();
  });
});

describe("docPathCandidates", () => {
  it("offers every kind directory (kind is not encoded in the name)", () => {
    const c = docPathCandidates("用户手机");
    expect(c).toHaveLength(DOC_KINDS.length);
    expect(c).toContain("memory/docs/topic/用户手机.md");
    expect(c).toContain("memory/docs/research/用户手机.md");
    expect(c.every((p) => p.endsWith("用户手机.md"))).toBe(true);
  });

  it("handles refs with paths / marks / missing extension", () => {
    const c = docPathCandidates("《docs/topic/用户手机》");
    expect(c).toEqual(docPathCandidates("用户手机.md"));
  });

  it("returns [] for unusable input", () => {
    expect(docPathCandidates("")).toEqual([]);
  });
});
