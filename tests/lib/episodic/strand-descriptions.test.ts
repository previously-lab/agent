import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory memory root: fsReadFile serves the seeded files (throws when
// absent, like the real backends), fsListFiles lists the strands dir.
const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async (path: string) => {
    const prefix = `${path}/`;
    return [...io.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => {
        const rest = p.slice(prefix.length);
        return {
          name: rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest,
          type: (rest.includes("/") ? "dir" : "file") as "dir" | "file",
          path: p,
        };
      });
  }),
}));

import {
  readStrandImpl,
  listStrandsImpl,
} from "@/lib/episodic/flash/recall";
import { serializeStrandEntity } from "@/lib/episodic/strand-files";

const STRANDS_JSON = "memory/episodic/strands.json";

function seedIndex(strands: Record<string, string[]>) {
  io.files.set(STRANDS_JSON, JSON.stringify(strands));
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
});

describe("readStrandImpl with entity descriptions", () => {
  it("prepends the FULL description plus the activity span to the slice listing", async () => {
    seedIndex({ "面试复盘": ["2026/08/01/0900", "2026/08/09/1300"] });
    io.files.set(
      "memory/episodic/strands/面试复盘.md",
      serializeStrandEntity({
        name: "面试复盘",
        first_seen: "2026-08-01",
        last_active: "2026-08-09",
        aliases: ["面试总结"],
        description:
          "用户每次模拟面试后一起回顾回答质量。逐渐固定成一套复盘清单：自我介绍、项目深挖、反问环节。",
      }),
    );

    const out = await readStrandImpl("面试复盘");
    expect(out).toContain("用户每次模拟面试后一起回顾回答质量");
    // Full text: both paragraphs, not a truncation.
    expect(out).toContain("逐渐固定成一套复盘清单");
    expect(out).toContain("first seen 2026-08-01, last active 2026-08-09");
    expect(out).toContain("also known as: 面试总结");
    // The slice listing is still there, after the description.
    expect(out).toContain("appears in: 2026/08/01/0900, 2026/08/09/1300");
  });

  it("resolves a differently-cased strand request to its entity file", async () => {
    seedIndex({ Apex: ["2026/08/01/0900"] });
    io.files.set(
      "memory/episodic/strands/Apex.md",
      serializeStrandEntity({
        name: "Apex",
        first_seen: "2026-08-01",
        last_active: "2026-08-01",
        aliases: [],
        description: "关于 Apex 笔记工具的策略讨论。",
      }),
    );

    const out = await readStrandImpl("apex");
    expect(out).toContain("关于 Apex 笔记工具的策略讨论。");
  });

  it("degrades to the bare listing when the strand has no entity file", async () => {
    seedIndex({ rust: ["2026/08/01/0900", "2026/08/02/0900"] });
    // No strands/ directory at all → fsListFiles serves nothing.
    const out = await readStrandImpl("rust");
    expect(out).toBe(
      'Strand "rust" appears in: 2026/08/01/0900, 2026/08/02/0900',
    );
  });

  it("degrades to the bare listing when the entity file has no description body", async () => {
    seedIndex({ rust: ["2026/08/01/0900"] });
    io.files.set(
      "memory/episodic/strands/rust.md",
      "---\nfirst_seen: 2026-08-01\nlast_active: 2026-08-01\n---\n",
    );
    const out = await readStrandImpl("rust");
    expect(out).toBe('Strand "rust" appears in: 2026/08/01/0900');
  });

  it("still reports unknown strands", async () => {
    seedIndex({ rust: ["2026/08/01/0900"] });
    const out = await readStrandImpl("nonexistent");
    expect(out).toContain("not found");
  });
});

describe("listStrandsImpl with entity descriptions", () => {
  it("carries a truncated one-line summary per described strand", async () => {
    seedIndex({ described: ["2026/08/01/0900"], bare: ["2026/08/02/0900"] });
    io.files.set(
      "memory/episodic/strands/described.md",
      serializeStrandEntity({
        name: "described",
        first_seen: "2026-08-01",
        last_active: "2026-08-01",
        aliases: [],
        description: "一个被描述的线索。",
      }),
    );

    const out = await listStrandsImpl();
    expect(out).toContain("Known strands (2)");
    expect(out).toContain("- described — 一个被描述的线索。");
    expect(out).toContain("- bare");
    // Summary lines stay single-line even for multi-paragraph descriptions.
    io.files.set(
      "memory/episodic/strands/described.md",
      serializeStrandEntity({
        name: "described",
        first_seen: "2026-08-01",
        last_active: "2026-08-01",
        aliases: [],
        description: `第一段很\n\n第二段也很${"长".repeat(200)}`,
      }),
    );
    const out2 = await listStrandsImpl();
    const line = out2.split("\n").find((l) => l.startsWith("- described"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual("- described — ".length + 141);
  });

  it("keeps the legacy bare-name format when no strands/ directory exists", async () => {
    seedIndex({ rust: ["2026/08/01/0900"], async_: ["2026/08/01/0900"] });
    const out = await listStrandsImpl();
    expect(out).toBe("Known strands (2): rust, async_");
  });

  it("reports an empty index without touching the entity layer", async () => {
    seedIndex({});
    const out = await listStrandsImpl();
    expect(out).toBe("(no strands yet — no topic tags woven)");
  });
});
