import { describe, it, expect } from "vitest";
import {
  isPortablePathSegment,
  isPortableRepoPath,
  assertPortableRepoPath,
} from "@/lib/portable-path";

describe("portable-path — the Windows-checkout discipline (2026-10-12)", () => {
  it("rejects the incident path and accepts its repaired form", () => {
    expect(
      isPortableRepoPath(
        "memory/research/Taku 产品架构与从外往内路线/2026-10-12-两种情形：钱、可持续性，与 16:00 那场腾讯云.md",
      ),
    ).toBe(false);
    expect(
      isPortableRepoPath(
        "memory/research/Taku 产品架构与从外往内路线/2026-10-12-两种情形：钱、可持续性，与 16：00 那场腾讯云.md",
      ),
    ).toBe(true);
  });

  it("accepts ordinary repo paths (incl. CJK, spaces, full-width punctuation)", () => {
    expect(isPortableRepoPath("memory/records/2026/10/12/1338/agent.md")).toBe(true);
    expect(
      isPortableRepoPath("memory/tasks/合规义务/2026-10-12-十月核对结论：今晚无需处理.md"),
    ).toBe(true);
    expect(isPortableRepoPath("sessions/abc.md")).toBe(true);
    expect(isPortableRepoPath("memory/foo/")).toBe(true); // trailing slash tolerated
  });

  it("segment rules: forbidden characters and control characters", () => {
    for (const bad of ['a:b', "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\\b", "a\x07b"]) {
      expect(isPortablePathSegment(bad)).toBe(false);
    }
    expect(isPortablePathSegment("16:00")).toBe(false);
    expect(isPortablePathSegment("")).toBe(false);
  });

  it("segment rules: trailing dot/space and reserved device names", () => {
    expect(isPortablePathSegment("report.")).toBe(false);
    expect(isPortablePathSegment("report ")).toBe(false);
    expect(isPortablePathSegment(".")).toBe(false);
    expect(isPortablePathSegment("..")).toBe(false);
    for (const bad of ["con", "CON", "nul", "NUL.txt", "com1", "lpt9", "aux.md"]) {
      expect(isPortablePathSegment(bad)).toBe(false);
    }
    expect(isPortablePathSegment("console")).toBe(true);
    expect(isPortablePathSegment("null-模型")).toBe(true);
  });

  it("assertPortableRepoPath throws with the path in the message", () => {
    expect(() => assertPortableRepoPath("memory/a/b:c.md")).toThrow(/b:c\.md/);
    expect(() => assertPortableRepoPath("memory/a/bc.md")).not.toThrow();
  });
});
