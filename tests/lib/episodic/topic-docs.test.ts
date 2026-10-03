import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory memory root: fsReadFile serves the seeded files (throws when
// absent, like the real backends), fsListFiles lists a directory.
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
  TOPIC_DIR,
  getTopicDocPath,
  readStrandEntity,
  readTopicDoc,
  listStrandEntityNames,
  serializeStrandEntity,
  strandEntityToTopicDoc,
  topicDocToStrandEntity,
} from "@/lib/episodic/strand-files";
import { appendEntry, createDocSkeleton, serializeDoc } from "@/lib/docs";

const LEGACY_PATH = "memory/episodic/strands/面试复盘.md";
const TOPIC_PATH = `${TOPIC_DIR}/面试复盘.md`;

function seedLegacy(description = "旧描述：每次面试后的复盘。") {
  io.files.set(
    LEGACY_PATH,
    serializeStrandEntity({
      name: "面试复盘",
      first_seen: "2026-07-14",
      last_active: "2026-08-02",
      aliases: ["面试总结"],
      description,
    }),
  );
}

function seedTopic() {
  let doc = createDocSkeleton({
    fileName: "面试复盘.md",
    kind: "topic",
    opened: "2026-07-14",
    heading: "面试复盘",
  });
  doc = appendEntry(doc, {
    date: "2026-08-02",
    title: "初始描述",
    body: "新位置描述：面试后的复盘清单。",
  });
  io.files.set(TOPIC_PATH, serializeDoc(doc));
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
});

describe("topic home locations (new first, legacy fallback)", () => {
  it("readStrandEntity prefers the docs/topic location", async () => {
    seedLegacy();
    seedTopic();
    const entity = await readStrandEntity("面试复盘");
    expect(entity).not.toBeNull();
    expect(entity!.description).toContain("新位置描述");
    expect(entity!.description).not.toContain("旧描述");
    expect(entity!.first_seen).toBe("2026-07-14");
    expect(entity!.last_active).toBe("2026-08-02");
  });

  it("readStrandEntity falls back to the legacy entity file before the migration runs", async () => {
    seedLegacy();
    const entity = await readStrandEntity("面试复盘");
    expect(entity).not.toBeNull();
    expect(entity!.description).toContain("旧描述");
    expect(entity!.aliases).toEqual(["面试总结"]);
  });

  it("returns null when neither location has a home", async () => {
    expect(await readStrandEntity("不存在")).toBeNull();
  });

  it("readTopicDoc marks legacy reads so the next write lands in docs/topic", async () => {
    seedLegacy();
    const result = await readTopicDoc("面试复盘");
    expect(result).not.toBeNull();
    expect(result!.legacy).toBe(true);
    expect(result!.doc.kind).toBe("topic");
    expect(result!.doc.fileName).toBe("面试复盘.md");
    // The conversion mirrors the migration script: 初始描述 entry + seeded 截至块.
    expect(result!.doc.asOf?.text).toContain("旧描述");
    const entries = result!.doc.sections.filter((s) => s.type === "entry");
    expect(entries).toHaveLength(1);
    if (entries[0].type === "entry") {
      expect(entries[0].entry.title).toBe("初始描述");
      // aliases fold into the opening prose (no alias field in the doc system).
      expect(entries[0].entry.body).toContain("面试总结");
    }
    expect(result!.doc.frontmatter.opened).toBe("2026-07-14");
    expect(result!.doc.frontmatter.updated).toBe("2026-08-02");
  });

  it("readTopicDoc parses the new location directly", async () => {
    seedTopic();
    const result = await readTopicDoc("面试复盘");
    expect(result!.legacy).toBe(false);
    expect(result!.doc.sections).toHaveLength(1);
  });

  it("listStrandEntityNames unions both locations", async () => {
    seedLegacy();
    io.files.set(`${TOPIC_DIR}/用户手机.md`, "---\nstatus: active\n---\n");
    const names = await listStrandEntityNames();
    expect(names).toEqual(new Set(["面试复盘", "用户手机"]));
  });

  it("getTopicDocPath rejects unsafe names like the legacy path helper", () => {
    expect(getTopicDocPath("面试复盘")).toBe(TOPIC_PATH);
    for (const bad of ["../evil", "a/b", "a\\b", "..", ".", ""]) {
      expect(() => getTopicDocPath(bad)).toThrow();
    }
  });
});

describe("entity ⇄ topic-doc conversion", () => {
  it("strandEntityToTopicDoc falls back to today when no dates parse", () => {
    const doc = strandEntityToTopicDoc(
      { name: "x", first_seen: "", last_active: "", aliases: [], description: "d" },
      "2026-09-01",
    );
    expect(doc.frontmatter.opened).toBe("2026-09-01");
    expect(doc.frontmatter.updated).toBe("2026-09-01");
  });

  it("topicDocToStrandEntity flattens the entry stream for semantic matching", () => {
    let doc = createDocSkeleton({
      fileName: "x.md",
      kind: "topic",
      opened: "2026-07-14",
      heading: "x",
    });
    doc = appendEntry(doc, { date: "2026-08-01", title: "动态", body: "发生了一些事。" });
    const entity = topicDocToStrandEntity(doc);
    expect(entity.name).toBe("x");
    expect(entity.description).toContain("2026-08-01");
    expect(entity.description).toContain("发生了一些事。");
    expect(entity.aliases).toEqual([]);
  });
});
