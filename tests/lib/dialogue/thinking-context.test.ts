import { describe, expect, it } from "vitest";
import { buildNativeThinkingMessages } from "@/lib/dialogue/thinking-context";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { TimeSlice, Turn } from "@/lib/episodic/types";

function input(): Pick<TurnInput, "modelMessages" | "turnId" | "lastUserMessage" | "dialogue" | "startedAtIso" | "clientTimezone"> {
  return {
    turnId: "input-B",
    startedAtIso: "2026-11-19T17:47:00.000Z", clientTimezone: "Asia/Shanghai",
    lastUserMessage: "再补充一个独立的小任务：直接计算 128 × 46，不用查资料，也不要做页面，告诉我结果。",
    dialogue: { scopeKey: "scope", workId: "input-B", transport: "workflow-v2", sourceInputId: "input-B" },
    modelMessages: [
      { role: "user", content: "查询 Node.js LTS 并制作计数器" },
      { role: "assistant", content: "我先查询并制作" },
      { role: "user", content: "再补充一个独立的小任务：直接计算 128 × 46，不用查资料，也不要做页面，告诉我结果。" },
    ],
  };
}

describe("native thinking context contract", () => {
  it("dates the current statement in the user's calendar while historical context keeps its own dates", () => {
    const turn = input();
    const acceptedTime = { utc: turn.startedAtIso, zone: turn.clientTimezone, local: "20 Nov 2026, 01:47", offset: "UTC+08:00" };
    const messages = buildNativeThinkingMessages({ ...turn, dialogue: { ...turn.dialogue!, acceptedTime } }, [
      { workId: "old", inputId: "old", status: "completed", acceptedAt: "2026-11-18T10:13:00.000Z" },
    ], { contextPrefix: [{ role: "assistant", content: "11 月 18 日晚上完成了上一轮。" }] });
    const contract = JSON.parse((messages.at(-1)!.content as string).split("\n")[1]!);
    expect(contract.acceptedAt).toEqual(acceptedTime);
    expect(contract.task).toBe(turn.lastUserMessage);
    expect(contract.timeScope).toContain("current statement");
    expect(messages[0]?.content).toContain("11 月 18 日");
    const replay = buildNativeThinkingMessages({ ...turn, regenerate: true }).at(-1)!.content as string;
    expect(replay).toContain("dates this retry");
    expect(JSON.parse(replay.split("\n")[1]!).acceptedAt).toEqual({ utc: turn.startedAtIso, zone: turn.clientTimezone });
  });

  it("focuses on the current task and exposes other work only as state", () => {
    const original = input();
    const messages = buildNativeThinkingMessages(original, [{ workId: "input-A", inputId: "input-A", status: "running", text: "百度什么时候成立的？", latestStage: "checkpoint" }]);
    expect(messages).toHaveLength(1);
    const contract = messages[0]!.content;
    expect(contract).toContain("current_task_contract");
    expect(contract).toContain("128 × 46");
    expect(contract).toContain('"workId":"input-B"');
    expect(contract).toContain('"workId":"input-A"');
    expect(contract).toContain('"status":"running"');
    expect(contract).toContain('"title":"百度什么时候成立的？"');
    expect(contract).toContain('"latestStage":"checkpoint"');
    expect(contract).toContain("readWorkSnapshot");
    expect(contract).toContain("new, related, continuation or unclear");
    expect(contract).not.toContain("查询 Node.js LTS 并制作计数器");
    expect(contract).not.toContain("我先查询并制作");
  });

  it("resolves only visible single-input publications from the active slice before acceptance", () => {
    const user: Turn = { role: "user", content: "We talked about the old flat.", timestamp: "2026-11-19T17:42:00Z",
      dialogue: { kind: "user_input", inputId: "old" } };
    const answer = (id: string, time: string, text: string, sources = ["old"]): Turn => ({
      role: "agent", timestamp: time, content: "unstructured text", recordBody: "private bytes", dialogue: {
        kind: "public_utterance", publicationId: id, publicSeq: 1, sourceResults: [], inputIds: sources,
        blocks: [{ kind: "markdown", blockId: "b", text }, { kind: "citation_ref", blockId: "c", ref: "hidden-ref" }],
      },
    });
    const prior = answer("older", "2026-11-19T17:43:00Z", "We discussed noise.");
    const latest = answer("seen", "2026-11-19T17:44:00Z", "Yes, noise from upstairs. " + "x".repeat(470));
    const slice: TimeSlice = { slice_id: "slice", status: "active", start: user.timestamp, timezone: "UTC", focus: "",
      summary: "", open_loops: [], decisions: [], tags: [], related_slices: [], loops: [], estimatedTokens: 0,
      turns: [user, latest, prior, { role: "tool", timestamp: prior.timestamp, content: "private result" },
        answer("unseen", "2026-11-19T17:45:00Z", "in another window"),
        answer("multi", "2026-11-19T17:45:30Z", "two parallel works", ["old", "other"]),
        answer("sibling", "2026-11-19T17:46:00Z", "an unrelated task", ["other"]),
        { ...answer("ambiguous", "2026-11-19T17:46:00Z", "unsupported authorship"), attribution: "ambiguous" },
        answer("future", input().startedAtIso, "after acceptance")] };
    const turn = { ...input(), lastUserMessage: "That again.", config: { slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 } },
      dialogue: { ...input().dialogue!, recentExchangeHints: { inputIds: ["old"],
        publicationIds: ["older", "seen", "sibling", "multi", "future", "ambiguous"] } } };
    const contract = (candidate = turn, edge = slice) =>
      JSON.parse((buildNativeThinkingMessages(candidate, [], { slice: edge })[0].content as string).split("\n")[1]);
    const context = contract();
    expect(context.task).toBe("That again.");
    expect(context.recentPublicExchanges).toEqual([{ user: user.content, assistant: expect.stringMatching(/^Yes, noise from upstairs\..*…$/) }]);
    expect(context.recentPublicExchanges[0].assistant).toHaveLength(400);
    expect(contract(turn, { ...slice, turns: [user] }).recentPublicExchanges).toBeUndefined();
    expect(contract(turn, { ...slice, status: "closed" }).recentPublicExchanges).toBeUndefined();
    expect(contract({ ...turn, startedAtIso: "2026-11-19T19:00:00Z" }).recentPublicExchanges).toBeUndefined();
    expect(contract({ ...turn, dialogue: { ...turn.dialogue, sourceInputId: "old" } }).recentPublicExchanges).toBeUndefined();
    expect(contract({ ...turn, dialogue: { ...turn.dialogue, recentExchangeHints: { inputIds: ["old"], publicationIds: ["made-up"] } } }).recentPublicExchanges).toBeUndefined();
    expect(buildNativeThinkingMessages({ ...turn, regenerate: true }, [], { slice })[0].content).not.toContain("recentPublicExchange");
    expect(buildNativeThinkingMessages(input(), [], { slice })[0].content).not.toContain("recentPublicExchange");

    const overlap = { ...turn, lastUserMessage: "It came through the ceiling again.",
      dialogue: { ...turn.dialogue, recentExchangeHints: { inputIds: ["other", "pending", "old"], publicationIds: ["older", "sibling"] } } };
    const resumed = contract(overlap, { ...slice, turns: [...slice.turns,
      { ...user, timestamp: "2026-11-19T17:43:30Z", content: "When is my train?", dialogue: { kind: "user_input", inputId: "other" } },
      { ...user, timestamp: "2026-11-19T17:45:40Z", content: "Independent unfinished work.", dialogue: { kind: "user_input", inputId: "pending" } },
    ] });
    expect(resumed.task).toBe(overlap.lastUserMessage);
    expect(resumed.recentPublicExchanges).toEqual([{ user: user.content, assistant: "We discussed noise." },
      { user: "When is my train?", assistant: "an unrelated task" }]);
    expect(JSON.stringify(resumed)).not.toContain("Independent unfinished work.");
  });

  it("retains the existing checkpoint continuation rather than other tasks", () => {
    const contextPrefix = input().modelMessages.slice(0, 2);
    const messages = buildNativeThinkingMessages(input(), [], { contextPrefix });
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(contextPrefix[0]);
    expect(messages.at(-1)!.content).toContain("existing checkpoint continuation");
    expect(messages.at(-1)!.content).toContain("Do not repeat or complete other inputs");
  });

  it("keeps the living recap in the existing system prompt instead of recreating it", () => {
    const contract = buildNativeThinkingMessages(input()).at(-1)!.content;
    expect(contract).toContain("system prompt already carries the living recap, user model and slice background");
    expect(contract).toContain("Choose the responseMode for the current request");
    expect(contract).toContain("A related title alone needs no lookup");
    expect(contract).toContain("The single dialogue Actor decides how to integrate");
  });

  it("preserves the verified tool mapping when image parts were extracted for a text-only turn", () => {
    const assetId = `img_${"b".repeat(32)}`;
    const inputWithImage = {
      ...input(),
      verifiedImages: [{ snapshot: { version: 1 as const, assetId, ref: `drafts/${assetId}`, ordinal: 4,
        name: "fourth.png", mediaType: "image/png" }, dataBase64: "QUJD" }],
      imageAttachments: ["data:image/png;base64,QUJD"],
    };
    const [message] = buildNativeThinkingMessages(inputWithImage);
    expect(message.content).toEqual(expect.arrayContaining([
      { type: "text", text: expect.stringMatching(/〔图4〕 = fourth.png.*source="attachment:0"/) },
    ]));
    expect(JSON.stringify(message)).not.toContain("QUJD");
  });
});
