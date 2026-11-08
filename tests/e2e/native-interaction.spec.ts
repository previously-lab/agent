import { test, expect } from "./test";
import { collapseConversation, openAllManuscripts } from "./manuscript-navigation";
import type { Locator, Page } from "@playwright/test";
import { clearCases, clearEpisodic, seedSlices } from "./memory-fixture";
import { calculatorDocument, interactiveRecord, sandboxCalculator, themedCalculator, THEME_PROBES } from "./native-interaction-fixture";

const activeFrames = (page: Page) => page.locator('[data-native-frame][sandbox~="allow-scripts"]');

async function noNativeChrome(page: Page) {
  await expect(page.locator(".native-controls, .native-source, dialog.native-dialog")).toHaveCount(0);
  await expect(page.locator("[data-native-block]").getByRole("button", { name: /^(Source|Copy|Reset|Expand|Collapse|Open interactive)$/ })).toHaveCount(0);
}

async function openRecordFromChat(page: Page) {
  await openAllManuscripts(page);
  await page.locator("[data-records-row]").first().click();
  await expect(page.locator('[data-workspace-surface="reader"]')).toBeVisible();
  await expect(page.locator('.desk-shell--top [data-native-frame][sandbox~="allow-scripts"]')).toHaveCount(1);
}

async function compareThemeClasses(block: Locator) {
  const expected = await block.evaluate((element, probes) => {
    element.querySelector("[data-theme-probes]")?.remove();
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-theme-probes", "");
    wrapper.style.display = "none";
    element.appendChild(wrapper);
    return probes.map(({ id, classes }) => {
      const probe = document.createElement("div");
      probe.className = classes;
      wrapper.appendChild(probe);
      const style = getComputedStyle(probe);
      return { id, color: style.color, background: style.backgroundColor, border: style.borderColor,
        borderWidth: style.borderTopWidth, radius: style.borderRadius, padding: style.padding,
        fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight };
    });
  }, THEME_PROBES);
  const frame = block.locator('[data-native-frame][sandbox~="allow-scripts"]').contentFrame().frameLocator("[data-native-content]");
  await expect.poll(() => frame.locator("body").evaluate((_, ids) => ids.map((id) => {
    const style = getComputedStyle(document.getElementById(id)!);
    return { id, color: style.color, background: style.backgroundColor, border: style.borderColor,
      borderWidth: style.borderTopWidth, radius: style.borderRadius, padding: style.padding,
      fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight };
  }), THEME_PROBES.map(({ id }) => id))).toEqual(expected);
}

test.afterEach(async () => { await clearCases(); await clearEpisodic(); });

test("full HTML runs head, module, inline click, slider and local submit handlers", async ({ page }, testInfo) => {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (/form|sandbox|script|Content Security Policy/i.test(message.text())) diagnostics.push(message.text());
  });
  await seedSlices([interactiveRecord(calculatorDocument())]);
  await page.goto("/en/app");
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  const iframe = page.locator("[data-native-frame]").first();
  await expect(iframe).toBeVisible();
  const frame = iframe.contentFrame().frameLocator("[data-native-content]");
  await frame.getByLabel("Left", { exact: true }).fill("9");
  await frame.getByLabel("Right", { exact: true }).fill("3");
  await frame.getByRole("button", { name: "Add with head script", exact: true }).click();
  await expect.soft(frame.locator("#result")).toHaveText("add:12");
  await frame.getByRole("button", { name: "Multiply inline", exact: true }).click();
  await expect.soft(frame.locator("#result")).toHaveText("multiply:27");
  await frame.getByRole("button", { name: "Subtract with module", exact: true }).click();
  await expect.soft(frame.locator("#result")).toHaveText("subtract:6");
  await frame.getByLabel("Fictional level", { exact: true }).press("End");
  await frame.getByLabel("Fictional level", { exact: true }).press("ArrowLeft");
  await expect.soft(frame.locator("#level")).toHaveText("198");
  await frame.getByRole("button", { name: "Submit locally", exact: true }).click();
  await expect.soft(frame.locator("#result")).toHaveText("submit:12", { timeout: 2_000 });
  await expect(iframe).toHaveCount(1);
  await testInfo.attach("script-diagnostics", { body: diagnostics.join("\n"), contentType: "text/plain" });
});

test("large views keep the same HTML session, image zoom, and copyable table", async ({ page, context }, info) => {
  const record = interactiveRecord(calculatorDocument());
  const reply = record.turns.find(turn => turn.role === "agent")!;
  reply.content += "\n\n| Window | Clear aisle |\n| --- | --- |\n| North | 95 cm |\n\n![Room diagram](/fixture-room.png)";
  await seedSlices([record]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/fixture-room.png", route => route.fulfill({
    contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"),
  }));
  await page.goto("/en/app");
  const iframe = activeFrames(page);
  const frame = iframe.contentFrame().frameLocator("[data-native-content]");
  await frame.getByLabel("Left", { exact: true }).fill("9");
  const sameFrame = await iframe.elementHandle();
  await page.getByRole("button", { name: "Open large view" }).click();
  await expect(page.getByRole("dialog", { name: "Interactive content" })).toBeVisible();
  expect(await iframe.evaluate((node, previous) => node === previous, sameFrame)).toBe(true);
  await expect(frame.getByLabel("Left", { exact: true })).toHaveValue("9");
  await frame.getByLabel("Right", { exact: true }).fill("3");
  await page.screenshot({ path: info.outputPath("large-html.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Close large view" }).click();
  await expect(frame.getByLabel("Right", { exact: true })).toHaveValue("3");
  await expect(page.getByRole("button", { name: "Open large view" })).toBeFocused();
  await page.getByRole("button", { name: "Expand table" }).click();
  const table = page.getByRole("dialog", { name: "Table" });
  await expect(table.getByRole("columnheader", { name: "Clear aisle" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Clear aisle" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await table.getByRole("button", { name: "Copy table" }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe("Window\tClear aisle\nNorth\t95 cm");
  await page.screenshot({ path: info.outputPath("large-table.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(table).toBeHidden();
  await page.getByRole("button", { name: "View image: Room diagram" }).click();
  const image = page.getByRole("dialog", { name: "Room diagram" });
  await image.getByRole("button", { name: "Zoom in" }).click();
  await expect(image.getByRole("button", { name: "Fit image" })).toHaveText("125%");
  await page.goBack();
  await expect(image).toBeHidden();
  await expect(page.locator('[data-panel-tier="fullscreen"]')).toBeVisible();
});

test("real dialogue mode still renders legacy native records", async ({ page }) => {
  await page.route("**/api/chat/dialogue?*", route => route.continue());
  await seedSlices([interactiveRecord(calculatorDocument())]);
  await page.goto("/en/app");
  const probe = await page.request.get("/api/chat/dialogue?persona=user&after=0");
  expect(probe.ok()).toBe(true);
  expect(await probe.json()).toMatchObject({ version: 1 });
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  const iframe = page.locator("[data-native-frame]").first();
  await expect(iframe).toBeVisible();
  const frame = iframe.contentFrame().frameLocator("[data-native-content]");
  await frame.getByLabel("Left", { exact: true }).fill("9");
  await frame.getByLabel("Right", { exact: true }).fill("3");
  await frame.getByRole("button", { name: "Add with head script", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("add:12");
});

test("DOMContentLoaded-bound calculator restores its derived output after reload", async ({ page }) => {
  await seedSlices([interactiveRecord(calculatorDocument())]);
  await page.goto("/en/app");
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  const frame = activeFrames(page).contentFrame().frameLocator("[data-native-content]");
  await frame.locator("#rsi").press("End");
  await frame.locator("#rsi").press("ArrowLeft");
  await expect(frame.locator("#level")).toHaveText("198");
  await frame.getByRole("button", { name: "Add saved step", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("previously:native-replies:v1") ?? '{"entries":[]}') as { entries: { json: string }[] };
    return store.entries.some(({ json }) => {
      const state = JSON.parse(json) as { controls?: { value: unknown }[] };
      return state.controls?.some(({ value }) => value === "99");
    });
  })).toBe(true);
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await expect(page.locator("[data-manuscript-input]")).toBeEditable();
    await expect(frame.locator("#rsi")).toHaveValue("99");
    await expect(frame.locator("#level")).toHaveText("198");
    await expect(frame.locator("#custom-count")).toHaveText("2");
    await expect(frame.locator("#custom-total")).toHaveText("14");
  }
});

test("chat and paper share live theme classes without reload and hand off one calculator state", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedSlices([interactiveRecord(themedCalculator())]);
  await page.goto("/en/app");
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  await expect(activeFrames(page)).toHaveCount(1);
  await page.evaluate(() => {
    const probe = window as unknown as { __maxNativeExecutors: number };
    const sample = () => { probe.__maxNativeExecutors = Math.max(probe.__maxNativeExecutors ?? 0,
      document.querySelectorAll('[data-native-frame][sandbox~="allow-scripts"]').length); };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["sandbox"] });
    sample();
  });
  // Do not wait for the old 180ms save debounce before hiding the frame.
  await activeFrames(page).contentFrame().frameLocator("[data-native-content]").getByRole("button", { name: "Add saved step", exact: true }).click();
  await collapseConversation(page);
  await page.getByRole("button", { name: "Expand to full screen", exact: true }).click();
  await expect(activeFrames(page).contentFrame().frameLocator("[data-native-content]").locator("#custom-count")).toHaveText("2");
  await expect(activeFrames(page).contentFrame().frameLocator("[data-native-content]").locator("#custom-total")).toHaveText("14");
  const captured = new Set<string>();
  const styleSnapshots: { stage: string; elementId: string; snapshotId: string; bytes: number; styleIds: string[] }[] = [];
  const recordStyles = async (block: Locator, stage: string) => {
    const snapshot = await block.locator('[data-native-frame][sandbox~="allow-scripts"]').contentFrame().frameLocator("[data-native-content]")
      .locator("#previously-native-styles").evaluate((element) => ({
        elementId: element.id,
        snapshotId: (element as HTMLElement).dataset.version ?? "",
        bytes: new TextEncoder().encode(element.textContent ?? "").byteLength,
        styleIds: Array.from(document.querySelectorAll("style[id]"), (style) => style.id),
      }));
    expect(snapshot.snapshotId).not.toBe("");
    expect(snapshot.bytes).toBeGreaterThan(0);
    styleSnapshots.push({ stage, ...snapshot });
  };

  for (const surface of ["chat", "paper"] as const) {
    if (surface === "paper") await openRecordFromChat(page);
    await expect(activeFrames(page)).toHaveCount(1);
    const block = surface === "paper" ? page.locator(".desk-shell--top [data-native-block]").first() : page.locator("[data-native-block]").first();
    const iframe = block.locator('[data-native-frame][sandbox~="allow-scripts"]');
    const frame = iframe.contentFrame().frameLocator("[data-native-content]");
    const node = await iframe.elementHandle();
    await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", /.+/);
    const instance = await frame.locator("html").getAttribute("data-fixture-run");
    await expect(frame.locator("#custom-count")).toHaveText(surface === "chat" ? "2" : "3");
    await expect(frame.locator("#custom-total")).toHaveText(surface === "chat" ? "14" : "21");
    expect(await frame.locator("html").evaluate(() => (window as unknown as { previously: { getState(): unknown } }).previously.getState())).toEqual({ clicks: surface === "chat" ? 2 : 3 });
    if (surface === "paper") {
      await expect(frame.locator("#rsi")).toHaveValue("99");
      await expect(frame.locator("#level")).toHaveText("198");
    }
    await frame.getByLabel("Left", { exact: true }).fill("9");
    await frame.getByLabel("Right", { exact: true }).fill("3");
    await frame.getByRole("button", { name: "Add with head script", exact: true }).click();
    await expect(frame.locator("#result")).toHaveText("add:12");
    await frame.locator("#rsi").press(surface === "chat" ? "End" : "Home");
    await frame.locator("#rsi").press(surface === "chat" ? "ArrowLeft" : "ArrowRight");
    for (const dark of [false, true, false]) {
      await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark);
      await compareThemeClasses(block);
      await recordStyles(block, `${surface}-${dark ? "dark" : "light"}`);
      expect(await iframe.evaluate((element, original) => element === original, node)).toBe(true);
      await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", instance!);
      await expect(frame.locator("#result")).toHaveText("add:12");
      await expect(frame.locator("#rsi")).toHaveValue(surface === "chat" ? "99" : "1");
      if (surface === "paper") {
        const paper = await page.locator(".desk-shell--top .desk-paper").evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color,
        }));
        await expect(frame.locator("body")).toHaveCSS("background-color", paper.background);
        await expect(frame.locator("body")).toHaveCSS("color", paper.color);
        // The actual stock remains light even when the surrounding root is dark.
        const channels = paper.background.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        expect(Math.min(...channels)).toBeGreaterThan(180);
      }
      await noNativeChrome(page);
      const shot = `native-calculator-${surface}-${dark ? "dark" : "light"}.png`;
      if (!captured.has(shot)) {
        await expect(page.locator(".pulse-delay:visible")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: testInfo.outputPath(shot), animations: "disabled", style: "nextjs-portal { display: none !important; }" });
        captured.add(shot);
      }
    }
    if (surface === "chat") {
      // Simulate a host stylesheet revision, independently of theme-token
      // changes. The island must consume the actual class rule without reload.
      await page.addStyleTag({ content: ".bg-card { border-radius: 23px !important; }" });
      await compareThemeClasses(block);
      await expect(frame.locator("#theme-card")).toHaveCSS("border-radius", "23px");
      await recordStyles(block, "chat-stylesheet-revision");
      expect(await iframe.evaluate((element, original) => element === original, node)).toBe(true);
      await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", instance!);
      await expect(frame.locator("#result")).toHaveText("add:12");
      await expect(frame.locator("#level")).toHaveText("198");
    }
    // rem-based utilities must use the host's root, including on light paper
    // whose local font size differs. Theme updates must preserve this iframe.
    const hostRootSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
      document.documentElement.style.setProperty("--text-base", "1.125rem");
    });
    await compareThemeClasses(block);
    await expect(frame.locator("html")).toHaveCSS("font-size", "20px");
    await expect(frame.locator("body")).toHaveCSS("font-size", "22.5px");
    expect(await iframe.evaluate((element, original) => element === original, node)).toBe(true);
    await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", instance!);
    await expect(frame.locator("#result")).toHaveText("add:12");
    await expect(frame.locator("#rsi")).toHaveValue(surface === "chat" ? "99" : "1");
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("font-size");
      document.documentElement.style.removeProperty("--text-base");
    });
    await compareThemeClasses(block);
    await expect(frame.locator("html")).toHaveCSS("font-size", hostRootSize);
    // The next action changes surface immediately; no snapshot wait masks a
    // debounce race. The next owner must restore custom data AND its output.
    await frame.getByRole("button", { name: "Add saved step", exact: true }).click();
  }
  await page.locator(".manuscript-nav").getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.locator('[data-workspace-surface="conversation"]')).toBeVisible();
  await expect(activeFrames(page)).toHaveCount(1);
  await expect(activeFrames(page).contentFrame().frameLocator("[data-native-content]").locator("#rsi")).toHaveValue("1");
  await expect(activeFrames(page).contentFrame().frameLocator("[data-native-content]").locator("#level")).toHaveText("2");
  await expect(activeFrames(page).contentFrame().frameLocator("[data-native-content]").locator("#custom-count")).toHaveText("4");
  await expect(activeFrames(page).contentFrame().frameLocator("[data-native-content]").locator("#custom-total")).toHaveText("28");
  // Header navigation releases the same execution lease as folding. Do not
  // await a stored snapshot between this custom edit and leaving the view.
  await activeFrames(page).contentFrame().frameLocator("[data-native-content]").getByRole("button", { name: "Add saved step", exact: true }).click();
  await page.locator("[data-manuscript-header]").getByRole("button", { name: "Manuscripts", exact: true }).click();
  await page.getByRole("button", { name: "All manuscripts", exact: true }).evaluate(button => {
    const panel = document.querySelector('[data-panel-tier="fullscreen"]')!;
    // Two intents in one task reproduce the queued fold/navigation race.
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    (button as HTMLButtonElement).click();
  });
  await expect(page.locator('[data-workspace-surface="library"]')).toBeVisible();
  await expect(activeFrames(page)).toHaveCount(0);
  await page.locator(".manuscript-nav").getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(activeFrames(page)).toHaveCount(1);
  const restored = activeFrames(page).contentFrame().frameLocator("[data-native-content]");
  await expect(restored.locator("#custom-count")).toHaveText("5");
  await expect(restored.locator("#custom-total")).toHaveText("35");
  await expect(restored.locator("#rsi")).toHaveValue("1");
  await expect(restored.locator("#level")).toHaveText("2");
  expect(await page.evaluate(() => (window as unknown as { __maxNativeExecutors: number }).__maxNativeExecutors)).toBe(1);
  console.log("Native browser style snapshots:", JSON.stringify(styleSnapshots));
  await testInfo.attach("native-browser-style-snapshots", { body: JSON.stringify(styleSnapshots, null, 2), contentType: "application/json" });
});

for (const surface of ["chat", "paper"] as const) {
test(`${surface} local form computes while CSP blocks submission, parent, storage and network`, async ({ page }) => {
  let forbiddenRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("native-fixture.invalid") || (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat")) forbiddenRequests++;
  });
  await seedSlices([interactiveRecord(sandboxCalculator())]);
  await page.goto("/en/app");
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  if (surface === "paper") await openRecordFromChat(page);
  await expect(activeFrames(page)).toHaveCount(1);
  const iframe = activeFrames(page);
  const frame = iframe.contentFrame().frameLocator("[data-native-content]");
  await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", /.+/);
  const run = await frame.locator("html").getAttribute("data-fixture-run");
  await frame.getByRole("button", { name: "Submit locally", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("submit:10");
  for (const attribute of ["data-parent-access", "data-storage-access", "data-external-fetch", "data-host-fetch"]) {
    await expect(frame.locator("html")).toHaveAttribute(attribute, "denied");
  }
  await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", run!);
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin|allow-top-navigation|allow-popups/);
  await expect(iframe.contentFrame().locator("[data-native-content]")).not.toHaveAttribute("sandbox", /allow-same-origin|allow-top-navigation|allow-popups/);
  const url = page.url();
  await frame.getByRole("button", { name: "Attempt external submission", exact: true }).click();
  await expect(page).toHaveURL(url);
  // The trusted container blocks the destination before a request and retires
  // the attempted navigation. Local preventDefault forms above keep running.
  await expect(activeFrames(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "This content tried to navigate away" })).toBeVisible();
  expect(forbiddenRequests).toBe(0);
  await noNativeChrome(page);
});
}
