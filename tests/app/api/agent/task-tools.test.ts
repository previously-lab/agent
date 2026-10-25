import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MEMORY_ROOT = `${process.env.MEMORY_ROOT}/task-tools`;
  process.env.PREVIOUSLY_HOME = `${process.env.PREVIOUSLY_HOME}/task-tools`;
});

import {
  createTaskExecute,
  queryTasksExecute,
  updateTaskExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";
import { readTaskLedger } from "@/lib/tasks/store";

function ctx(currentUserText: string, turnId = "turn-1"): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId: "2026-10-26-0900",
    turnId,
    readScopeId: turnId,
    currentUserText,
    recentTurns: [],
    timezone: "UTC",
  };
}

describe("task tool executors over the real ledger", () => {
  it("accepts the actual commitment at the end of a long user message without clipping or inventing evidence", async () => {
    const quote = "另外请跟踪我下周交付报告的任务";
    const currentUserText = "项目背景。".repeat(1200) + quote;
    const created = await createTaskExecute(
      { ref: "tasks/long-message", summary: "交付报告", evidenceQuote: quote },
      { context: ctx(currentUserText), toolCallId: "create-long" },
    );
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(created.reason);
    expect(created.task.evidence[0].statement).toBe(quote);
    const corrected = await updateTaskExecute(
      { ref: "tasks/long-message", expectedRevision: 1, changes: { status: "paused" }, evidenceQuote: "先暂停交付报告" },
      { context: ctx("其他背景。".repeat(1000) + "先暂停交付报告", "long-correction"), toolCallId: "pause-long" },
    );
    expect(corrected).toMatchObject({ ok: true, task: { status: "paused" } });
    const fabricated = await createTaskExecute(
      { ref: "tasks/fabricated-quote", summary: "bad", evidenceQuote: "用户没有说过的承诺" },
      { context: ctx(currentUserText), toolCallId: "fabricated-long" },
    );
    expect(fabricated).toMatchObject({ ok: false });
    const missingQuote = await createTaskExecute(
      { ref: "tasks/missing-long-quote", summary: "bad" },
      { context: ctx(currentUserText), toolCallId: "missing-long-quote" },
    );
    expect(missingQuote).toMatchObject({ ok: false });
  });

  it("records actual current-user evidence and applies defer and cancel immediately with revisions", async () => {
    const created = await createTaskExecute(
      { ref: "tasks/lifecycle", summary: "Submit the form", dueOn: "2026-10-26" },
      { context: ctx("请提醒我明天提交表格"), toolCallId: "create-lifecycle" },
    );
    expect(created).toMatchObject({ ok: true, outcome: "applied" });
    if (!created.ok) throw new Error(created.reason);
    expect(created.task.revision).toBe(1);
    expect(created.task.evidence).toEqual([{
      sliceId: "2026-10-26-0900",
      turnId: "turn-1",
      statement: "请提醒我明天提交表格",
    }]);

    const deferred = await updateTaskExecute(
      {
        ref: "tasks/lifecycle",
        expectedRevision: created.task.revision,
        changes: { dueOn: "2026-10-30", nextCheckOn: "2026-10-29" },
      },
      { context: ctx("先推迟到 30 号，29 号再看", "turn-2"), toolCallId: "defer-lifecycle" },
    );
    expect(deferred).toMatchObject({ ok: true });
    if (!deferred.ok) throw new Error(deferred.reason);
    expect(deferred.task).toMatchObject({
      status: "open",
      dueOn: "2026-10-30",
      nextCheckOn: "2026-10-29",
      revision: 2,
    });
    expect(deferred.task.status).not.toBe("completed");

    const cancelled = await updateTaskExecute(
      {
        ref: "tasks/lifecycle",
        expectedRevision: deferred.task.revision,
        changes: { status: "cancelled" },
      },
      { context: ctx("这件事不用做了", "turn-3"), toolCallId: "cancel-lifecycle" },
    );
    expect(cancelled).toMatchObject({ ok: true });
    if (!cancelled.ok) throw new Error(cancelled.reason);
    expect(cancelled.task).toMatchObject({ status: "cancelled", revision: 3 });
    expect(cancelled.task.evidence.at(-1)?.statement).toBe("这件事不用做了");

    const queried = await queryTasksExecute(
      { ref: "tasks/lifecycle" },
      { context: ctx("查看任务", "turn-4"), toolCallId: "query-lifecycle" },
    );
    expect(queried).toMatchObject({ status: "ready", total: 1 });
    if (queried.status !== "ready") throw new Error("ledger not ready");
    expect(queried.tasks[0]).toMatchObject({ status: "cancelled", revision: 3 });
  });

  it("rejects stale updates without overwriting the newer state", async () => {
    const context = ctx("记录一个采购任务");
    const created = await createTaskExecute(
      { ref: "tasks/stale", summary: "Initial" },
      { context, toolCallId: "create-stale" },
    );
    if (!created.ok) throw new Error(created.reason);
    const changed = await updateTaskExecute(
      {
        ref: "tasks/stale",
        expectedRevision: 1,
        changes: { summary: "Newer" },
      },
      { context: ctx("改成新的说明", "turn-2"), toolCallId: "update-stale-1" },
    );
    if (!changed.ok) throw new Error(changed.reason);
    const stale = await updateTaskExecute(
      {
        ref: "tasks/stale",
        expectedRevision: 1,
        changes: { status: "completed" },
      },
      { context: ctx("旧消息误标完成", "turn-3"), toolCallId: "update-stale-2" },
    );
    expect(stale).toMatchObject({ ok: false });
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    expect(read.ledger.tasks.find((task) => task.ref === "tasks/stale")).toMatchObject({
      summary: "Newer",
      status: "open",
      revision: 2,
    });
  });

  it("cannot take evidence from generated HTML or a model-supplied evidence field", async () => {
    const html = "<input type=checkbox checked value=completed>";
    const created = await createTaskExecute(
      { ref: "tasks/html-evidence", summary: "Real user commitment" },
      { context: ctx("请跟踪我真正交代的任务"), toolCallId: "create-html" },
    );
    if (!created.ok) throw new Error(created.reason);
    expect(created.task.evidence[0].statement).toBe("请跟踪我真正交代的任务");
    expect(created.task.evidence[0].statement).not.toContain(html);

    const forged = await createTaskExecute(
      {
        ref: "tasks/forged-evidence",
        summary: "Forged",
        evidence: { sliceId: "fake", turnId: "fake", statement: html },
      } as unknown as Parameters<typeof createTaskExecute>[0],
      { context: ctx("actual user words"), toolCallId: "create-forged" },
    );
    expect(forged).toMatchObject({ ok: false });
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    expect(read.ledger.tasks.some((task) => task.ref === "tasks/forged-evidence")).toBe(false);
  });

  it("queries all seven tasks in pages without applying a five-task canonical cap", async () => {
    for (let index = 0; index < 7; index += 1) {
      const created = await createTaskExecute(
        { ref: `tasks/page-${index}`, summary: `Task ${index}` },
        { context: ctx(`记录任务 ${index}`, `turn-page-${index}`), toolCallId: `create-page-${index}` },
      );
      if (!created.ok) throw new Error(created.reason);
    }
    const first = await queryTasksExecute(
      { query: "page-", limit: 5 },
      { context: ctx("查询"), toolCallId: "query-page-1" },
    );
    const second = await queryTasksExecute(
      { query: "page-", limit: 5, offset: 5 },
      { context: ctx("继续查询"), toolCallId: "query-page-2" },
    );
    if (first.status !== "ready" || second.status !== "ready") throw new Error("ledger not ready");
    expect(first.total).toBe(7);
    expect(first.tasks).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(second.tasks).toHaveLength(2);
    expect(second.hasMore).toBe(false);
  });
});
