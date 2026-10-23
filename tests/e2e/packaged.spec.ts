import { test, expect } from "./test";

// Read-only packaging checks against an explicitly selected local kernel.
// Model turns use mock SSE in the ordinary suite; no paid smoke calls here.
test.skip(!process.env.E2E_EXTERNAL_BASE_URL, "Set E2E_EXTERNAL_BASE_URL to an isolated packaged kernel");

test("standalone kernel serves assets, fixed-model metadata and redacted settings", async ({ page }) => {
  const badAssets: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/_next/")) badAssets.push(response.url());
  });
  await page.goto("/en/app");
  await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
  await page.goto("/en/settings");
  const section = page.locator('[data-slot="settings-client"]');
  await expect(section).toBeVisible();
  await expect(section.getByText("DeepSeek Flash", { exact: true })).toBeVisible();
  await expect(section.getByRole("combobox")).toHaveCount(0);
  await expect(section.locator('input[type="password"]')).toHaveValue("");
  const config = await (await page.request.get("/api/client/config")).json();
  if (config.byok) expect(config.byok).not.toHaveProperty("apiKey");
  const catalog = await (await page.request.get("/api/models")).json();
  expect(catalog.models.map((model: { id: string }) => model.id)).toEqual(["deepseek-flash"]);
  expect(badAssets).toEqual([]);
});
