import { test, expect } from "@playwright/test";

test.describe("Responsive - Mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("sidebar hidden on mobile by default", async ({ page }) => {
    await page.goto("/en/");
    // Sidebar should not be visible in the viewport
    const sidebar = page.locator(".w-60");
    await expect(sidebar).not.toBeVisible();
  });

  test("hamburger menu opens sidebar overlay", async ({ page }) => {
    await page.goto("/en/");
    await page.click('[title="Open menu"]');
    // Sidebar should now be visible
    await expect(page.locator(".w-60").first()).toBeVisible();
  });

  test("no horizontal scroll on mobile", async ({ page }) => {
    await page.goto("/en/chat");
    const body = page.locator("body");
    const scrollWidth = await body.evaluate((el) => el.scrollWidth);
    const clientWidth = await body.evaluate((el) => el.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });
});
