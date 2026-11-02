import { describe, expect, it } from "vitest";
import { isSameCaseCurrent, parseCaseCurrent, reviseCaseCurrent, serializeCaseCurrent } from "@/lib/docs/case-doc";

const input = {
  asOf: "2026-10-01",
  body: "暂用方案甲；方案乙还没有得到用户确认。",
  evidence: ["records/2026-10-01-1200"],
  basis: { indexRevision: "index-a", pieces: [{ path: "memory/research/示例/2026-10-01-对比.md", revision: "piece-a" }] },
};

describe("current understanding revisions", () => {
  it("refreshes the date and evidence basis without copying unchanged prose into history", () => {
    const old = { ...reviseCaseCurrent(null, input), history: "原有历史。\n\n    保留缩进。" };
    const refresh = { ...input, asOf: "2026-10-02", evidence: [...input.evidence, "research/示例"], basis: { ...input.basis, indexRevision: "index-b" } };
    expect(isSameCaseCurrent(old, refresh)).toBe(false);
    const next = reviseCaseCurrent(old, refresh);
    expect(next).toEqual({ ...old, asOf: refresh.asOf, evidence: refresh.evidence, basis: refresh.basis });
    expect(next.history).toBe(old.history);
    expect(old.asOf).toBe(input.asOf);
    expect(parseCaseCurrent(serializeCaseCurrent(next))).toEqual(next);
    expect(isSameCaseCurrent(next, refresh)).toBe(true);
    expect(reviseCaseCurrent(next, refresh)).toBe(next);
  });

  it("does not grow an archive after repeated metadata-only refreshes", () => {
    let doc = reviseCaseCurrent(null, input);
    for (let day = 2; day <= 20; day++) {
      doc = reviseCaseCurrent(doc, { ...input, asOf: `2026-10-${String(day).padStart(2, "0")}` });
    }
    expect(doc.history).toBe("");
    expect(doc.body).toBe(input.body);
    expect(doc.asOf).toBe("2026-10-20");
  });

  it("archives a real body change with the previous date, evidence and basis", () => {
    const previous = { ...reviseCaseCurrent(null, input), history: "更早的认识。" };
    const next = reviseCaseCurrent(previous, { ...input, asOf: "2026-10-03", body: "用户明确选择方案乙；方案甲退出。", evidence: ["records/2026-10-03-1200"] });
    expect(next.history).toContain(previous.body);
    expect(next.history).toContain(`as-of: ${previous.asOf}`);
    expect(next.history).toContain(`evidence: ${previous.evidence[0]}`);
    expect(next.history).toContain("basis-index: index-a");
    expect(next.history).toContain("@piece-a");
    expect(next.history.endsWith(previous.history)).toBe(true);
    expect(previous.body).toBe(input.body);
  });
});
