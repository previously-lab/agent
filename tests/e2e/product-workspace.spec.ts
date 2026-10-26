import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
  type FixtureSlice,
} from "./memory-fixture";

const DAY = 24 * 3600_000;

interface DocumentContextReferencePayload {
  ref: string;
  title?: string;
}

interface DocumentContextPayload {
  version: 1;
  references: DocumentContextReferencePayload[];
}

interface PostedMessage {
  role: string;
  metadata?: {
    documentContext?: DocumentContextPayload;
  };
}

interface PostedChatBody {
  documentContext?: DocumentContextPayload;
  messages: PostedMessage[];
}

function dailySlices(count: number, tagPrefix: string): FixtureSlice[] {
  const base = Date.UTC(2026, 1, 1, 9, 0, 0);
  return Array.from({ length: count }, (_, index) =>
    makeSlice(new Date(base + index * DAY).toISOString(), {
      tag: `${tagPrefix}${String(index).padStart(2, "0")}`,
    }),
  );
}

async function expectReader(page: Page, ref: string): Promise<void> {
  await expect(page.locator('[data-workspace-surface="reader"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("doc")).toBe(ref);
}

async function selectReferences(page: Page, titles: readonly string[]): Promise<void> {
  await page.locator("[data-document-mention]:visible").click();
  const search = page.getByRole("combobox", { name: "Search documents" });
  await expect(search).toBeVisible();
  for (const title of titles) {
    await search.fill(title);
    const option = page.getByRole("option").filter({ hasText: title });
    await expect(option).toHaveCount(1, { timeout: 30_000 });
    await option.click();
    await expect(page.locator(".document-reference-chip").filter({ hasText: title })).toHaveCount(1);
  }
  await page.getByRole("button", { name: "Close document picker" }).click();
  await expect(page.locator(".document-reference-chip")).toHaveCount(titles.length);
}

function offlineSse(answer: string): string {
  const chunks = [
    { type: "start", messageId: `fixture-${answer.replaceAll(" ", "-")}` },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: answer },
    { type: "text-end", id: "text" },
    { type: "finish" },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function expectedContext(references: readonly (readonly [string, string])[]): DocumentContextPayload {
  return {
    version: 1,
    references: references.map(([ref, title]) => ({ ref, title })),
  };
}

test.describe("Product workspace routes", () => {
  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
  });

  test("cold /app opens bounded full chat with no WebGL and an explicit earlier-history entrance", async ({ page }) => {
    const slices = dailySlices(12, "C");
    await seedSlices(slices);
    await page.goto("/en/app");
    const panel = page.locator("#conversation-panel");
    await expect(page.locator('[data-panel-tier="fullscreen"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Exit full screen" }).first()).toBeVisible();
    const scroller = page.locator("[data-conversation-field]");
    await expect(scroller).toBeVisible();
    await expect(panel.getByText(slices[11].turns[0].content)).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.locator("[data-workspace-game-host]")).toHaveCount(0);

    await scroller.evaluate((element) => {
      (element as HTMLElement).scrollTop = 0;
    });
    await expect(panel.getByText(slices[2].turns[0].content)).toBeVisible();
    await expect(panel.getByText(slices[0].turns[0].content)).toHaveCount(0);
    const entrance = page.locator(".workspace-history-entrance button");
    await expect(entrance).toBeVisible();
    await entrance.click();
    await expect(page).toHaveURL(/\/en\/app\?view=field&history=1$/);
    const browser = page.locator(".workspace-history-browser");
    await expect(browser).toBeVisible();
    await expect(browser).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    await expect(page.locator(".workspace-record-list li")).toHaveCount(12);
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("semantic records open exact turns, restore Back coordinates and refocus without duplicate history", async ({ page }) => {
    const slices = dailySlices(12, "R");
    const oldest = slices[0];
    const related = slices[1];
    const latest = slices[11];
    oldest.turns[1].turnId = "oldest-assistant";
    related.turns[1].turnId = "related-assistant";
    latest.turns[1].content = `Source: [first discussion](previously:records/${oldest.id}?turn=oldest-assistant&role=assistant)`;
    oldest.turns[1].content = `${"A long fictional source passage that keeps the exact assistant turn on a later paper page. ".repeat(420)}\n\nRelated: [second discussion](previously:records/${related.id}?turn=related-assistant&role=assistant)`;
    await seedSlices(slices);
    await page.goto("/en/app");

    const source = page.locator(`a[data-document-ref="records/${oldest.id}"][data-document-turn="oldest-assistant"]`);
    await expect(source).toBeVisible();
    await source.click();
    await expectReader(page, `records/${oldest.id}`);
    await expect(page.locator(".desk-shell--top").locator('[data-turn-id="oldest-assistant"][data-reading-focus]')).toBeVisible();
    const initialZoom = await page.locator("[data-zoom-readout]").innerText();
    await page.locator("[data-zoom-in]").click();
    const beforePage = await page.locator(".desk-page-position").innerText();
    const beforeZoom = await page.locator("[data-zoom-readout]").innerText();
    expect(beforeZoom).not.toBe(initialZoom);

    const nested = page.locator(".desk-shell--top").locator(`a[data-document-ref="records/${related.id}"][data-document-turn="related-assistant"]`);
    await expect(nested).toBeVisible();
    await nested.click();
    await expectReader(page, `records/${related.id}`);
    await expect(page.locator(".desk-shell--top").locator('[data-turn-id="related-assistant"][data-reading-focus]')).toBeVisible();
    const historyBeforeRepeat = await page.evaluate(() => history.length);

    await page.goBack();
    await expectReader(page, `records/${oldest.id}`);
    await expect(page.locator(".desk-page-position")).toHaveText(beforePage);
    await expect(page.locator("[data-zoom-readout]")).toHaveText(beforeZoom);
    await expect(page.locator(".desk-shell--top .document-record-turn").first()).toBeVisible();

    await nested.click();
    await expectReader(page, `records/${related.id}`);
    await expect(page.locator(".desk-shell--top").locator('[data-turn-id="related-assistant"][data-reading-focus]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.length)).toBe(historyBeforeRepeat);

    await page.goBack();
    await expectReader(page, `records/${oldest.id}`);
    await expect(page.locator(".desk-page-position")).toHaveText(beforePage);
    await expect(page.locator("[data-zoom-readout]")).toHaveText(beforeZoom);
    await page.goForward();
    await expectReader(page, `records/${related.id}`);
    await expect(page.locator(".desk-shell--top .document-record-turn").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.length)).toBe(historyBeforeRepeat);
  });

  test("multi-document references stay independent across in-flight and later mocked sends", async ({ page }) => {
    const posts: PostedChatBody[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts.push(route.request().postDataJSON() as PostedChatBody);
      if (posts.length === 1) await firstGate;
      await route.fulfill({
        contentType: "text/event-stream",
        body: offlineSse(`Offline answer ${posts.length}`),
      });
    });
    await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "MENTIONS" })]);
    await seedCases([
      { category: "research", name: "alpha-source", opened: "2026-02-01", pieces: [] },
      { category: "things", name: "beta-evidence", opened: "2026-02-01", pieces: [] },
      { category: "events", name: "gamma-context", opened: "2026-02-01", pieces: [] },
    ]);

    try {
      await page.goto("/en/app");
      const input = page.getByRole("combobox", { name: "Send a message..." });
      await expect(input).toBeVisible();
      await selectReferences(page, ["alpha-source", "beta-evidence"]);
      await input.fill("First mocked question");
      await input.press("Enter");
      await expect.poll(() => posts.length).toBe(1);

      await selectReferences(page, ["gamma-context"]);
      releaseFirst();
      await expect(page.getByText("Offline answer 1", { exact: true })).toBeVisible();
      await input.fill("Second mocked question");
      await input.press("Enter");
      await expect(page.getByText("Offline answer 2", { exact: true })).toBeVisible();
    } finally {
      releaseFirst();
    }

    expect(posts).toHaveLength(2);
    const firstContext = expectedContext([
      ["research/alpha-source", "alpha-source"],
      ["things/beta-evidence", "beta-evidence"],
    ]);
    const secondContext = expectedContext([["events/gamma-context", "gamma-context"]]);
    expect(posts[0].documentContext).toEqual(firstContext);
    expect(posts[0].messages.at(-1)?.role).toBe("user");
    expect(posts[0].messages.at(-1)?.metadata?.documentContext).toEqual(firstContext);
    expect(posts[1].documentContext).toEqual(secondContext);
    expect(posts[1].messages.at(-1)?.role).toBe("user");
    expect(posts[1].messages.at(-1)?.metadata?.documentContext).toEqual(secondContext);
  });

  test("game mini chat, explicit expansion and route return preserve one draft", async ({ page }) => {
    test.setTimeout(120_000);
    await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "GAME-DRAFT" })]);
    await page.goto("/en/game");
    const host = page.locator("[data-workspace-game-host]");
    await expect(host).toBeVisible({ timeout: 60_000 });
    await expect(host).toHaveAttribute("data-game-active", "true");
    const input = page.getByRole("combobox", { name: "Send a message..." });
    await expect(input).toBeVisible();
    await input.fill("draft across workspace routes");

    await page.locator("[data-pill-expand]").click();
    await expect(page.locator('[data-panel-tier="fullscreen"]')).toBeVisible();
    await expect(input).toHaveValue("draft across workspace routes");
    await page.locator(".conversation-panel-heading .workspace-route-nav").getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/app$/);
    await expect(page.locator('[data-workspace-surface="conversation"]')).toBeVisible();
    await expect(host).toBeHidden();
    await expect(host).toHaveAttribute("inert", "");
    await expect(input).toHaveValue("draft across workspace routes");

    await page.locator(".conversation-panel-heading .workspace-route-nav").getByRole("button", { name: "Hotel", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/game$/);
    await expect(host).toBeVisible();
    await expect(host).toHaveAttribute("data-game-active", "true");
    await expect(input).toHaveValue("draft across workspace routes");
  });
});
