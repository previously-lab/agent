import type { Page } from "@playwright/test";

export async function openAllManuscripts(page: Page) {
  if (new URL(page.url()).pathname.endsWith("/game")) {
    await page.locator(".conversation-panel-heading").getByRole("button", { name: "Manuscripts", exact: true }).click();
  } else {
    await page.locator("[data-manuscript-header]").getByRole("button", { name: "Manuscripts", exact: true }).click();
    await page.getByRole("button", { name: "All manuscripts", exact: true }).click();
  }
}

export async function collapseConversation(page: Page) {
  if (new URL(page.url()).pathname.endsWith("/game")) {
    await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  } else {
    await page.getByTestId("nav-overflow-trigger").click();
    await page.getByRole("menuitem", { name: "Exit full screen", exact: true }).click();
  }
}
