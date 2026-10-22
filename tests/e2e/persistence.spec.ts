import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { clearCases, clearEpisodic, makeSlice, seedCases, seedSlices } from "./memory-fixture";
import { seedWorkflowRun } from "./workflow-fixture";
import { E2E_MEMORY_ROOT } from "./env";

async function riseConversation(page: import("@playwright/test").Page) {
  const expand = page.getByRole("button", { name: "Expand to full screen" });
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  const exit = page.getByRole("button", { name: "Exit full screen" }).first();
  await expect(expand.or(retry).or(exit).first()).toBeVisible({ timeout: 30_000 });
  // A cold Turbopack action compile can cross the product's 15s arrival
  // guard. Retry after compilation; production builds do not compile here.
  if (await retry.isVisible()) await retry.click();
  await expect(expand.or(exit).first()).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
}

test.afterEach(async () => { await clearCases(); await clearEpisodic(); });

test("a completed answer survives reload while summary is pending, then a receipt refreshes the world", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/api/chat", (route) => route.abort());
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  const summary = await seedWorkflowRun();
  const now = new Date().toISOString();
  const slice = makeSlice(now, { tag: "PERSISTED" });
  delete slice.closedBy;
  delete slice.end;
  const record = { turnId: "pending-turn", sliceId: slice.id, at: now, userText: "Pending fixture question", replyText: "Durable pending fixture answer", cognition: "", summaryRunId: summary.runId };
  const turn = await seedWorkflowRun(record);
  const registry = await (await page.request.get("/api/evolution/hq-status")).json();
  expect(registry.runs.state).toBe("live");
  expect(registry.runs.live.map((run: { runId: string }) => run.runId)).toContain(summary.runId);
  await page.addInitScript(({ runId, summaryRunId }) => {
    if (!localStorage.getItem("fixture-persistence-seeded")) {
      localStorage.setItem("previously:pending-persistence:v1", JSON.stringify({ runIds: [runId], summaryRunIds: [summaryRunId] }));
      localStorage.setItem("fixture-persistence-seeded", "yes");
    }
  }, { runId: turn.runId, summaryRunId: summary.runId });
  await page.goto("/en/app");
  await riseConversation(page);
  await expect(page.getByText(record.replyText, { exact: true })).toHaveCount(1);
  await page.reload();
  await riseConversation(page);
  await expect(page.getByText(record.replyText, { exact: true })).toHaveCount(1);

  slice.turns = [
    { role: "user", content: record.userText, at: now, turnId: record.turnId },
    { role: "agent", content: record.replyText, at: now, turnId: record.turnId },
  ];
  await seedSlices([slice]);
  await seedCases([{ category: "events", name: "receipt-created-case", opened: now.slice(0, 10), pieces: [] }]);
  execFileSync("git", ["add", "records", "events"], { cwd: E2E_MEMORY_ROOT, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "Summary fixture"], { cwd: E2E_MEMORY_ROOT, stdio: "ignore" });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: E2E_MEMORY_ROOT, encoding: "utf8" }).trim();
  await summary.complete({ kind: "committed", receipt: { version: 1, commitSha, records: [{ sliceId: slice.id, turnIds: [record.turnId] }] } });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("previously:pending-persistence:v1") ?? "{}").runIds)).toEqual([]);
  await expect(page.getByText(record.replyText, { exact: true })).toHaveCount(1);
  await page.getByRole("textbox", { name: "Send a message..." }).press("Escape");
  await expect(page.locator('[data-archive-pile="events/receipt-created-case"]')).toBeVisible();
  await page.reload();
  await riseConversation(page);
  await expect(page.getByText(record.replyText, { exact: true })).toHaveCount(1);
});

test("an acknowledged bypass remains visible when the main answer resumes after reload", async ({ page }) => {
  test.setTimeout(120_000);
  const active = await seedWorkflowRun();
  const now = new Date().toISOString();
  const slice = makeSlice(now, { tag: "SAVED-BYPASS" });
  delete slice.closedBy;
  delete slice.end;
  slice.turns = [
    { role: "user", content: "Already saved bypass fixture question", at: now, turnId: "saved-bypass" },
    { role: "agent", content: "Already saved bypass fixture answer", at: now, turnId: "saved-bypass" },
  ];
  await seedSlices([slice]);
  await page.route("**/api/chat", (route) => route.abort());
  await page.route(`**/api/chat/${active.runId}/stream**`, (route) => route.fulfill({
    contentType: "text/event-stream",
    body: [
      { type: "start", messageId: "resumed-main-answer" }, { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Resumed main fixture answer" },
      { type: "text-end", id: "text" }, { type: "finish" },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
  }));
  await page.addInitScript(({ runId }) => {
    localStorage.setItem("previously:activeRunId", runId);
    localStorage.setItem("previously:messages", JSON.stringify([{ id: "main-question", role: "user", parts: [{ type: "text", text: "Main fixture question" }] }]));
  }, { runId: active.runId });
  await page.goto("/en/app");
  await riseConversation(page);
  await expect(page.getByText("Resumed main fixture answer", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Already saved bypass fixture answer", { exact: true })).toHaveCount(1);
  await page.reload();
  await riseConversation(page);
  await expect(page.getByText("Resumed main fixture answer", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Already saved bypass fixture answer", { exact: true })).toHaveCount(1);
});
