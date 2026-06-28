import { test, expect } from "@playwright/test";

const ROUTES = ["/", "/chat", "/memory", "/missions", "/archive", "/settings"] as const;

test.describe("Navigation", () => {
  for (const route of ROUTES) {
    test(`GET ${route} returns 200`, async ({ page }) => {
      const res = await page.goto(`/en${route}`);
      expect(res?.status()).toBe(200);
    });
  }

  test("sidebar click navigates to Chat", async ({ page }) => {
    await page.goto("/en/");
    await page.click('a[href="/chat"]');
    await expect(page).toHaveURL(/\/chat/);
  });

  test("active nav item highlighted", async ({ page }) => {
    await page.goto("/en/memory");
    const activeLink = page.locator('a[href="/memory"]');
    await expect(activeLink).toHaveClass(/bg-accent/);
  });
});
