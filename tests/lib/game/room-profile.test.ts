import { describe, expect, it } from "vitest";
import {
  deriveRoomProfile,
  NEUTRAL_ROOM_PROFILE,
  parseRoomProfile,
  ROOM_EVIDENCE_LABELS,
  ROOM_PRIMARY_MODULE_BY_ACTIVITY,
  ROOM_PROFILE_RULE_VERSION,
  validateRoomProfile,
  type RoomActivity,
  type RoomPrimaryModule,
  type RoomProfileInput,
} from "@/lib/game/room-profile";

const SAMPLES: {
  name: string;
  input: RoomProfileInput;
  activity: Exclude<RoomActivity, "neutral">;
  primaryModule: RoomPrimaryModule;
}[] = [
  { name: "中文写作", input: { focus: "撰写小说并润色章节" }, activity: "writing", primaryModule: "study" },
  { name: "English writing", input: { focus: "Drafting a novel chapter" }, activity: "writing", primaryModule: "study" },
  { name: "中文研究", input: { focus: "阅读和比较两篇研究文献" }, activity: "research", primaryModule: "reading-room" },
  { name: "English research", input: { focus: "Reading and comparing two research papers" }, activity: "research", primaryModule: "reading-room" },
  { name: "中文修复", input: { summary: "修复登录缺陷并调试客户端" }, activity: "making", primaryModule: "workshop" },
  { name: "English making", input: { summary: "Fix the login bug and debug the client" }, activity: "making", primaryModule: "workshop" },
  { name: "中文筹划", input: { focus: "安排下周日程并决定优先级" }, activity: "planning", primaryModule: "study" },
  { name: "English planning", input: { focus: "Planning the roadmap and deciding priorities" }, activity: "planning", primaryModule: "study" },
  { name: "中文关系", input: { focus: "和朋友聊聊相处中的分歧" }, activity: "conversation", primaryModule: "living" },
  { name: "English conversation", input: { focus: "Talking about our relationship and friendship" }, activity: "conversation", primaryModule: "living" },
  { name: "中文回顾", input: { focus: "回顾今天的经历并写日记" }, activity: "reflection", primaryModule: "sunroom" },
  { name: "English reflection", input: { focus: "Journaling and reflecting on my day" }, activity: "reflection", primaryModule: "sunroom" },
];

describe("deriveRoomProfile", () => {
  it.each(SAMPLES)("maps $name to a bounded functional profile", ({ input, activity, primaryModule }) => {
    const profile = deriveRoomProfile(input);
    expect(profile.activity).toBe(activity);
    expect(profile.primaryModule).toBe(primaryModule);
    expect(profile.primaryModule).toBe(ROOM_PRIMARY_MODULE_BY_ACTIVITY[activity]);
    expect(profile.ruleVersion).toBe(ROOM_PROFILE_RULE_VERSION);
    expect(profile.evidence.length).toBeGreaterThan(0);
    expect(profile.evidence.length).toBeLessThanOrEqual(6);
    for (const label of profile.evidence) {
      expect(ROOM_EVIDENCE_LABELS).toContain(label);
      expect(label.endsWith(`:${activity}`)).toBe(true);
    }
    expect(parseRoomProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it("ignores punctuation, casing and whitespace without changing the semantic revision", () => {
    const a = deriveRoomProfile({ focus: " 写 作： 创 作！ ", tags: [" 撰 写 "] });
    const b = deriveRoomProfile({ focus: "写作 创作", tags: ["撰写"] });
    expect(a).toEqual(b);
    expect(a.revision).toBe(b.revision);

    const enA = deriveRoomProfile({ summary: "  Drafting   a NOVEL!!! " });
    const enB = deriveRoomProfile({ summary: "drafting a novel" });
    expect(enA).toEqual(enB);
  });

  it("reuses the neutral constant when evidence is missing, weak or tied", () => {
    expect(deriveRoomProfile({})).toBe(NEUTRAL_ROOM_PROFILE);
    expect(deriveRoomProfile({ focus: "" })).toBe(NEUTRAL_ROOM_PROFILE);
    expect(deriveRoomProfile({ focus: "写作与开发" })).toBe(NEUTRAL_ROOM_PROFILE);
    expect(NEUTRAL_ROOM_PROFILE.evidence).toEqual([]);
  });

  it("does not infer a swimming pool, research from a room noun, or making from negated work", () => {
    expect(deriveRoomProfile({ focus: "pool database" })).toBe(NEUTRAL_ROOM_PROFILE);
    expect(deriveRoomProfile({ focus: "书房" })).toBe(NEUTRAL_ROOM_PROFILE);
    const chat = deriveRoomProfile({
      summary: "",
      turns: [
        { role: "agent", content: "开发并修复代码" },
        { role: "system", content: "写作" },
        { role: "tool", content: "研究" },
        { role: "user", content: "我不想工作，只想聊天" },
      ],
    });
    expect(chat.activity).toBe("conversation");
    expect(chat.primaryModule).toBe("living");
  });

  it("uses bounded user turns only when structured evidence needs fallback", () => {
    const fallback = deriveRoomProfile({ summary: "", userTurns: ["我想修复这个 bug"] });
    expect(fallback.activity).toBe("making");
    expect(fallback.evidence).toEqual(["user_turns:making"]);

    const marked = deriveRoomProfile({
      summary: "撰写一篇文章",
      userTurns: ["我想修复这个 bug"],
    });
    expect(marked.activity).toBe("writing");
    expect(marked.evidence).toEqual(["summary:writing"]);
  });

  it("treats ordinary negation as neutral while preserving not-only affirmatives", () => {
    for (const focus of [
      "我不写代码。",
      "Do not implement anything.",
      "Do not debug the application.",
    ]) {
      expect(deriveRoomProfile({ focus })).toBe(NEUTRAL_ROOM_PROFILE);
    }
    expect(deriveRoomProfile({ focus: "不只是写作" }).activity).toBe("writing");
    expect(deriveRoomProfile({ focus: "Not only writing" }).activity).toBe("writing");
  });

  it("applies negation per clause instead of suppressing later affirmative work", () => {
    const semicolon = deriveRoomProfile({ focus: "不要修复旧版本；请实现新版接口。" });
    const comma = deriveRoomProfile({ focus: "不要修复旧版本，请实现新版接口" });
    expect(semicolon.activity).toBe("making");
    expect(comma).toEqual(semicolon);
  });

  it("masks file paths and code identifiers before matching activity words", () => {
    expect(
      deriveRoomProfile({ focus: "房间编号12；文件路径 /library/workshop/plan.txt。" }),
    ).toBe(NEUTRAL_ROOM_PROFILE);
    expect(
      deriveRoomProfile({ focus: "文件路径 C:\\library\\workshop\\plan.txt" }),
    ).toBe(NEUTRAL_ROOM_PROFILE);
    expect(deriveRoomProfile({ focus: "research_cache" })).toBe(NEUTRAL_ROOM_PROFILE);

    const implementation = deriveRoomProfile({ focus: "Implement research_cache." });
    expect(implementation.activity).toBe("making");
    expect(implementation.evidence).toEqual(["focus:making"]);
  });

  it("covers bounded rewrite, revise and edit manuscript phrases", () => {
    for (const focus of [
      "Rewrite my manuscript.",
      "Revise the manuscript.",
      "Edit this manuscript.",
      "Do not research the history. Rewrite the ending of my short story.",
    ]) {
      expect(deriveRoomProfile({ focus }).activity).toBe("writing");
    }
  });

  it("does not scan or read any turns when structured evidence is sufficient", () => {
    let roleReads = 0;
    let contentReads = 0;
    const turns = Array.from({ length: 1000 }, () => ({
      get role(): string {
        roleReads++;
        return "user";
      },
      get content(): string {
        contentReads++;
        return "写作";
      },
    }));
    expect(deriveRoomProfile({ summary: "阅读文献", turns }).activity).toBe("research");
    expect(roleReads).toBe(0);
    expect(contentReads).toBe(0);
  });

  it("bounds fallback to four user contents and a twelve-role reverse scan", () => {
    let roleReads = 0;
    let contentReads = 0;
    const turns = Array.from({ length: 1000 }, () => ({
      get role(): string {
        roleReads++;
        return "user";
      },
      get content(): string {
        contentReads++;
        return "修复代码";
      },
    }));
    expect(deriveRoomProfile({ summary: "", turns }).activity).toBe("making");
    expect(roleReads).toBe(4);
    expect(contentReads).toBe(4);

    let agentRoleReads = 0;
    let agentContentReads = 0;
    const mostlyAgent = Array.from({ length: 1000 }, (_, index) => ({
      get role(): string {
        agentRoleReads++;
        return index === 0 ? "user" : "agent";
      },
      get content(): string {
        agentContentReads++;
        return "修复代码";
      },
    }));
    expect(deriveRoomProfile({ summary: "", turns: mostlyAgent })).toBe(
      NEUTRAL_ROOM_PROFILE,
    );
    expect(agentRoleReads).toBe(12);
    expect(agentContentReads).toBe(0);
  });

  it("allows fallback when a nonempty summary has no activity cues", () => {
    const profile = deriveRoomProfile({
      summary: "普通寒暄",
      userTurns: ["修复代码"],
    });
    expect(profile.activity).toBe("making");
    expect(profile.evidence).toEqual(["user_turns:making"]);
  });

  it("uses bounded tags, decisions and open loops as independent evidence", () => {
    expect(deriveRoomProfile({ tags: ["写作"] })).toMatchObject({
      activity: "writing",
      evidence: ["tags:writing"],
    });
    expect(deriveRoomProfile({ decisions: ["决定采用方案 B"] })).toMatchObject({
      activity: "planning",
      evidence: ["decisions:planning"],
    });
    expect(deriveRoomProfile({ open_loops: ["继续阅读文献"] })).toMatchObject({
      activity: "research",
      evidence: ["open_loops:research"],
    });
  });

  it("keeps original text out of the serializable profile", () => {
    const profile = deriveRoomProfile({ focus: "撰写一本关于虚构森林的小说" });
    const json = JSON.stringify(profile);
    expect(json).not.toContain("虚构森林");
    expect(json).not.toContain("小说");
    expect(json.length).toBeLessThan(500);
  });
});

describe("RoomProfile snapshot validation", () => {
  it("strictly rejects unknown enums, versions, modules, revisions and arbitrary payloads", () => {
    const valid = deriveRoomProfile({ focus: "撰写小说" });
    const invalid: unknown[] = [
      null,
      {},
      { ...valid, version: 999 },
      { ...valid, ruleVersion: "unknown-rules" },
      { ...valid, activity: "pool" },
      { ...valid, activity: "x".repeat(10_000) },
      { ...valid, primaryModule: "pool-deck" },
      { ...valid, primaryModule: "workshop" },
      { ...valid, revision: "forged" },
      { ...valid, evidence: ["focus:making"] },
      { ...valid, evidence: ["focus:writing", "focus:writing"] },
      { ...valid, evidence: Array(7).fill("focus:writing") },
      { ...valid, evidence: "focus:writing" },
      { ...valid, payload: "x".repeat(10_000) },
    ];
    for (const candidate of invalid) {
      expect(validateRoomProfile(candidate)).toBe(false);
      expect(() => parseRoomProfile(candidate)).toThrow("Invalid RoomProfile snapshot");
    }
  });

  it("returns bounded fresh values for valid snapshots and the shared neutral constant", () => {
    const profile = deriveRoomProfile({ focus: "阅读文献" });
    const parsed = parseRoomProfile(profile);
    expect(parsed).toEqual(profile);
    expect(parsed).not.toBe(profile);
    expect(parsed.evidence).not.toBe(profile.evidence);
    expect(parseRoomProfile(NEUTRAL_ROOM_PROFILE)).toBe(NEUTRAL_ROOM_PROFILE);
  });
});
