import { test, expect } from "./test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_HOME } from "./env";

test("DeepSeek key saves explicitly, stays redacted on reload, and can be removed", async ({ page }) => {
  await page.goto("/en/settings");
  const section = page.locator('[data-slot="settings-client"]');
  await expect(section).toBeVisible();
  await expect(section.getByText("DeepSeek Flash", { exact: true })).toBeVisible();
  await expect(section.getByRole("combobox")).toHaveCount(0);
  await expect(section.getByRole("status")).toHaveText("No API key configured");

  const secret = "sk-offline-e2e-not-a-real-api-key";
  const input = section.locator('input[type="password"]');
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/client/config") && request.method() === "POST") saves.push(request.postData() ?? "");
  });
  await input.fill(secret);
  await expect(section.getByRole("button", { name: "Save key", exact: true })).toBeEnabled();
  expect(saves).toEqual([]);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/client/config") && response.request().method() === "POST");
  await section.getByRole("button", { name: "Save key", exact: true }).click();
  const saveResponse = await saved;
  expect(saveResponse.ok()).toBe(true);
  expect(await saveResponse.text()).not.toContain(secret);
  await expect(section.getByRole("status")).toHaveText("API key configured");
  await expect(input).toHaveValue("");
  const raw = JSON.parse(await readFile(path.join(E2E_HOME, "config.json"), "utf8"));
  expect(raw.byok).toEqual({ provider: "deepseek", model: "deepseek-flash", apiKey: secret });
  expect(raw).not.toHaveProperty("brain");
  expect(raw).not.toHaveProperty("agents");

  await page.reload();
  await expect(section.getByRole("status")).toHaveText("API key configured");
  await expect(input).toHaveValue("");
  const configResponse = await page.request.get("/api/client/config");
  expect(await configResponse.text()).not.toContain(secret);
  const cleared = page.waitForResponse((response) => response.url().endsWith("/api/client/config") && response.request().method() === "POST");
  await section.getByRole("button", { name: "Remove key", exact: true }).click();
  expect((await cleared).ok()).toBe(true);
  await expect(section.getByRole("status")).toHaveText("No API key configured");
  const after = JSON.parse(await readFile(path.join(E2E_HOME, "config.json"), "utf8"));
  expect(after.byok).toBeNull();
  expect(JSON.stringify(after)).not.toContain(secret);
  expect(saves).toHaveLength(2);
});
