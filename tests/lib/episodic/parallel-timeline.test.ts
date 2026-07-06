import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock file I/O — parallel-timeline reads/writes via local-fs or GitHub tools
vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: vi.fn(),
  writeFileLocal: vi.fn(),
}));

vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(),
}));

vi.mock("@/lib/tools/writeFile", () => ({
  writeFile: vi.fn(),
}));

import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";
import { readTopic, scanTopics, updateTopicSources, type TopicSource } from "@/lib/episodic/parallel-timeline";
import matter from "gray-matter";

function buildTopicMD(topic: string, sources: TopicSource[], summary: string): string {
  return matter.stringify(summary, { topic, sources });
}

describe("parallel-timeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no topic file exists
    vi.mocked(readFileLocal).mockRejectedValue(new Error("File not found"));
  });

  describe("readTopic", () => {
    it("returns null when topic file does not exist", async () => {
      const result = await readTopic("nonexistent");
      expect(result).toBeNull();
    });

    it("parses topic file with sources and summary", async () => {
      const sources: TopicSource[] = [
        { slice: "2026/07/02", turns: [1, 2, 5], relevance: 0.95, open_loops: ["Send bound"], decisions: ["Use Arc"] },
      ];
      const md = buildTopicMD("rust", sources, "# Rust\n\n熟练，踩过 Arc<Mutex> 的坑。");
      vi.mocked(readFileLocal).mockResolvedValue(md);

      const result = await readTopic("rust");
      expect(result).not.toBeNull();
      expect(result!.topic).toBe("rust");
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].slice).toBe("2026/07/02");
      expect(result!.sources[0].turns).toEqual([1, 2, 5]);
      expect(result!.sources[0].open_loops).toEqual(["Send bound"]);
      expect(result!.summary).toContain("踩过 Arc<Mutex> 的坑");
    });
  });

  describe("scanTopics", () => {
    it("returns empty array when no topics match", async () => {
      const hits = await scanTopics(["python"]);
      expect(hits).toEqual([]);
    });

    it("collects sources from multiple topics, sorted by relevance", async () => {
      vi.mocked(readFileLocal)
        .mockResolvedValueOnce(buildTopicMD("rust", [
          { slice: "2026/07/02", turns: [1, 2], relevance: 0.95 },
          { slice: "2026/06/22", turns: [3], relevance: 0.82 },
        ], ""))
        .mockResolvedValueOnce(buildTopicMD("async", [
          { slice: "2026/07/02", turns: [5, 6], relevance: 0.9 },
        ], ""));

      const hits = await scanTopics(["rust", "async"]);
      expect(hits).toHaveLength(3);
      // Sorted by relevance descending
      expect(hits[0].relevance).toBe(0.95);
      expect(hits[2].relevance).toBe(0.82);
    });

    it("deduplicates identical slice+turns across topics", async () => {
      const sharedSource: TopicSource = { slice: "2026/07/02", turns: [1, 2], relevance: 0.95 };
      vi.mocked(readFileLocal)
        .mockResolvedValueOnce(buildTopicMD("rust", [sharedSource], ""))
        .mockResolvedValueOnce(buildTopicMD("borrow-checker", [sharedSource], ""));

      const hits = await scanTopics(["rust", "borrow-checker"]);
      expect(hits).toHaveLength(1); // deduplicated
    });
  });

  describe("updateTopicSources", () => {
    it("appends new source to empty topic and writes file", async () => {
      // No existing file — readFileLocal will throw "File not found"
      vi.mocked(readFileLocal).mockRejectedValue(new Error("File not found"));

      await updateTopicSources("rust", [
        { slice: "2026/07/02", turns: [1, 2], relevance: 0.9 },
      ]);

      const writeCall = vi.mocked(writeFileLocal).mock.calls[0];
      expect(writeCall).toBeDefined();
      const written = writeCall[1] as string;
      expect(written).toContain("2026/07/02");
      expect(written).toContain("rust");
    });
  });
});
