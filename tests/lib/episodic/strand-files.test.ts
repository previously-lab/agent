import { describe, it, expect } from "vitest";
import {
  STRANDS_DIR,
  getStrandFilePath,
  serializeStrandEntity,
  parseStrandEntity,
  resolveStrandEntityName,
  type StrandEntity,
} from "@/lib/episodic/strand-files";

const full: StrandEntity = {
  name: "面试复盘",
  first_seen: "2026-07-14",
  last_active: "2026-08-02",
  aliases: ["面试总结", "interview debrief"],
  description:
    "用户最早在 2026 年 7 月中旬提起面试复盘，主要是每次模拟面试后一起回顾回答质量、梳理改进点。后来逐渐固定成一套复盘清单：开场自我介绍、项目深挖、反问环节。",
};

describe("serializeStrandEntity / parseStrandEntity round-trip", () => {
  it("round-trips a full entity byte-for-byte in substance", () => {
    const raw = serializeStrandEntity(full);
    expect(raw.startsWith("---")).toBe(true);
    const parsed = parseStrandEntity(raw, full.name);
    expect(parsed).toEqual(full);
  });

  it("keeps multi-paragraph descriptions intact", () => {
    const entity: StrandEntity = {
      ...full,
      description: "第一段。\n\n第二段。",
    };
    expect(parseStrandEntity(serializeStrandEntity(entity), entity.name)).toEqual(
      entity,
    );
  });

  it("omits empty optional frontmatter fields", () => {
    const raw = serializeStrandEntity({
      name: "rust",
      first_seen: "",
      last_active: "",
      aliases: [],
      description: "关于 rust 的讨论。",
    });
    expect(raw).not.toContain("first_seen");
    expect(raw).not.toContain("last_active");
    expect(raw).not.toContain("aliases");
    const parsed = parseStrandEntity(raw, "rust");
    expect(parsed.first_seen).toBe("");
    expect(parsed.aliases).toEqual([]);
    expect(parsed.description).toBe("关于 rust 的讨论。");
  });

  it("parses a frontmatter-only file (no body) with an empty description", () => {
    const parsed = parseStrandEntity(
      "---\nfirst_seen: 2026-07-14\nlast_active: 2026-08-02\n---\n",
      "x",
    );
    expect(parsed.description).toBe("");
    expect(parsed.first_seen).toBe("2026-07-14");
  });

  it("tolerates gray-matter's object-coercion of unquoted YAML values", () => {
    // Unquoted values containing ": " parse as objects — normalizeString
    // coerces them back (same guard as manager.ts slice parsing).
    const raw = "---\nfirst_seen: 2026-07-14\naliases:\n  - a: b\n---\nbody";
    const parsed = parseStrandEntity(raw, "x");
    expect(parsed.first_seen).toBe("2026-07-14");
    expect(parsed.aliases).toEqual(["a"]);
    expect(parsed.description).toBe("body");
  });
});

describe("getStrandFilePath", () => {
  it("builds the path under the strands dir", () => {
    expect(getStrandFilePath("面试复盘")).toBe(
      `${STRANDS_DIR}/面试复盘.md`,
    );
  });

  it("rejects path-traversal names", () => {
    for (const bad of ["../evil", "a/b", "a\\b", "..", ".", ""]) {
      expect(() => getStrandFilePath(bad)).toThrow();
    }
  });
});

describe("resolveStrandEntityName", () => {
  const available = new Set(["Apex", "面试复盘"]);

  it("returns the exact name when present", () => {
    expect(resolveStrandEntityName("Apex", available)).toBe("Apex");
  });

  it("resolves casing variants via index normalization", () => {
    expect(resolveStrandEntityName("apex", available)).toBe("Apex");
    expect(resolveStrandEntityName("ＡＰＥＸ", available)).toBe("Apex");
  });

  it("returns null when no entity file exists", () => {
    expect(resolveStrandEntityName("rust", available)).toBeNull();
  });
});
