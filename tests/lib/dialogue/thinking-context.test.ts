import { describe, expect, it } from "vitest";
import { buildNativeThinkingMessages } from "@/lib/dialogue/thinking-context";
import type { TurnInput } from "@/lib/chat/turn-types";

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
});
