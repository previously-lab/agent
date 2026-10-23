import { test, expect } from "./test";
import { clearEpisodic, makeSlice, seedSlices } from "./memory-fixture";

test.afterEach(async () => { await clearEpisodic(); });

test("chat uses the fixed model and carries verified native steps into the next request after reload", async ({ page }) => {
  test.setTimeout(120_000);
  const posts: Array<{ messages: Array<{ id: string; role: string; parts: unknown[] }>; model?: unknown; effort?: unknown }> = [];
  const native = { messages: [{ role: "assistant", content: "Native fixture answer", deepseek: { role: "assistant", content: "Native fixture answer", reasoning_content: "Original fixture reasoning" } }] };
  await page.route("**/api/chat", async (route) => {
    posts.push(route.request().postDataJSON());
    const chunks = [
      { type: "start", messageId: `fixture-answer-${posts.length}` },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: posts.length === 1 ? "Native fixture answer" : "Second fixture answer" },
      { type: "text-end", id: "text" },
      { type: "data-deepseek-step", id: `fixture-step-${posts.length}`, data: native },
      { type: "finish" },
    ];
    await route.fulfill({ contentType: "text/event-stream", body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });
  await page.goto("/en/app");
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  const input = page.getByRole("textbox", { name: "Send a message..." });
  await expect(input.or(retry).first()).toBeVisible({ timeout: 30_000 });
  if (await retry.isVisible()) await retry.click();
  await expect(input).toBeVisible();
  const composer = page.locator(".composer-bar", { has: input });
  await expect(composer.getByRole("combobox")).toHaveCount(0);
  await expect(composer.getByRole("button", { name: /DeepSeek|Claude|Kimi|Codex|model|effort|thinking/i })).toHaveCount(0);
  await input.fill("First offline fixture question");
  await input.press("Enter");
  await expect(page.getByText("Native fixture answer", { exact: true })).toHaveCount(1);
  // Simulate the summary's authoritative saved record, then reload with no
  // active run. The old live stash alone must never decide what to restore.
  const at = new Date().toISOString();
  const saved = makeSlice(at, { tag: "NATIVE-REPLAY" });
  delete saved.closedBy;
  delete saved.end;
  saved.turns = [
    { role: "user", at, content: "First offline fixture question", turnId: "native-turn", clientMessageId: posts[0].messages.at(-1)!.id },
    { role: "agent", at, content: "Native fixture answer", turnId: "native-turn" },
  ];
  await seedSlices([saved]);
  await page.reload();
  await expect(input).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Native fixture answer", { exact: true })).toHaveCount(1);
  await input.fill("Second offline fixture question");
  await input.press("Enter");
  await expect(page.getByText("Second fixture answer", { exact: true })).toHaveCount(1);
  expect(posts).toHaveLength(2);
  expect(posts.every((body) => body.model === undefined && body.effort === undefined)).toBe(true);
  expect(posts[1].messages.find((message) => message.role === "assistant")?.parts).toContainEqual({ type: "data-deepseek-step", id: "fixture-step-1", data: native });
});
