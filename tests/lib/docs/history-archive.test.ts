import { describe, expect, it } from "vitest";
import { historyDigest, parseHistoryArchive, planHistoryArchive, isHistoryArchiveFileName } from "@/lib/docs/history-archive";
import { documentSize, exceededSize } from "@/lib/docs/write-limits";
const options = { category: "things" as const, caseName: "synthetic", source: "_current.md" as const,
  date: "2026-11-03", updated: "2026-11-03T00:00:00Z", kind: "source-snapshot" as const };
describe("lossless history archive v1", () => {
  it.each(["without final newline", "\r\n中😀\r\n".repeat(3000), "😀".repeat(25_000)])("reconstructs exact bytes with bounded final shards", (sourceRaw) => {
    const plan = planHistoryArchive({ ...options, sourceRaw, previousHead: "things/synthetic/older" });
    let offset = 0;
    const payloads = plan.entries.map((entry, index) => {
      expect(isHistoryArchiveFileName(entry.path)).toBe(true);
      expect(exceededSize(documentSize(entry.content))).toEqual([]);
      const parsed = parseHistoryArchive(entry.content)!;
      expect(parsed.metadata.byte_start).toBe(offset);
      offset = parsed.metadata.byte_end;
      expect(parsed.metadata.part).toBe(index + 1);
      expect(parsed.metadata.source_revision).toBe(historyDigest(sourceRaw));
      return parsed.payload;
    });
    expect(Buffer.from(payloads.join(""))).toEqual(Buffer.from(sourceRaw));
    expect(parseHistoryArchive(plan.entries.at(-1)!.content)!.metadata.next).toBe("things/synthetic/older");
    expect(planHistoryArchive({ ...options, sourceRaw, previousHead: "things/synthetic/older" })).toEqual(plan);
  });
  it("rejects altered payload and malformed metadata", () => {
    const entry = planHistoryArchive({ ...options, sourceRaw: "source" }).entries[0];
    expect(parseHistoryArchive(entry.content + "\n")).toBeNull();
    expect(parseHistoryArchive(entry.content.replace('"part":1', '"part":0'))).toBeNull();
  });
});
