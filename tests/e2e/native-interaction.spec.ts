import { test, expect } from "./test";
import type { Locator, Page } from "@playwright/test";
import { clearCases, clearEpisodic, seedSlices } from "./memory-fixture";
import { calculatorDocument, interactiveRecord, sandboxCalculator, themedCalculator, THEME_PROBES } from "./native-interaction-fixture";

const activeFrames = (page: Page) => page.locator('[data-native-frame][sandbox~="allow-scripts"]');

async function noNativeChrome(page: Page) {
  await expect(page.locator(".native-controls, .native-source, dialog.native-dialog")).toHaveCount(0);
  await expect(page.locator("[data-native-block]").getByRole("button", { name: /^(Source|Copy|Reset|Expand|Collapse|Open interactive)$/ })).toHaveCount(0);
}

async function openRecordFromChat(page: Page) {
  await page.locator(".conversation-panel-heading .workspace-route-nav").getByRole("button", { name: "Library", exact: true }).click();
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
  const frame = block.locator('[data-native-frame][sandbox~="allow-scripts"]').contentFrame();
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
  const frame = iframe.contentFrame();
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

test("DOMContentLoaded-bound calculator restores its derived output after reload", async ({ page }) => {
  await seedSlices([interactiveRecord(calculatorDocument())]);
  await page.goto("/en/app");
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  const frame = activeFrames(page).contentFrame();
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
  await activeFrames(page).contentFrame().getByRole("button", { name: "Add saved step", exact: true }).click();
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await page.getByRole("button", { name: "Expand to full screen", exact: true }).click();
  await expect(activeFrames(page).contentFrame().locator("#custom-count")).toHaveText("2");
  await expect(activeFrames(page).contentFrame().locator("#custom-total")).toHaveText("14");
  const captured = new Set<string>();
  const styleSnapshots: { stage: string; elementId: string; snapshotId: string; bytes: number; styleIds: string[] }[] = [];
  const recordStyles = async (block: Locator, stage: string) => {
    const snapshot = await block.locator('[data-native-frame][sandbox~="allow-scripts"]').contentFrame()
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
    const frame = iframe.contentFrame();
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
        await page.screenshot({ path: testInfo.outputPath(shot), style: "nextjs-portal { display: none !important; }" });
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
    // The next action changes surface immediately; no snapshot wait masks a
    // debounce race. The next owner must restore custom data AND its output.
    await frame.getByRole("button", { name: "Add saved step", exact: true }).click();
  }
  await page.locator(".workspace-reader-nav .workspace-route-nav").getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.locator('[data-workspace-surface="conversation"]')).toBeVisible();
  await expect(activeFrames(page)).toHaveCount(1);
  await expect(activeFrames(page).contentFrame().locator("#rsi")).toHaveValue("1");
  await expect(activeFrames(page).contentFrame().locator("#level")).toHaveText("2");
  await expect(activeFrames(page).contentFrame().locator("#custom-count")).toHaveText("4");
  await expect(activeFrames(page).contentFrame().locator("#custom-total")).toHaveText("28");
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
  const frame = iframe.contentFrame();
  await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", /.+/);
  const run = await frame.locator("html").getAttribute("data-fixture-run");
  await frame.getByRole("button", { name: "Submit locally", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("submit:10");
  for (const attribute of ["data-parent-access", "data-storage-access", "data-external-fetch", "data-host-fetch"]) {
    await expect(frame.locator("html")).toHaveAttribute(attribute, "denied");
  }
  const url = page.url();
  await frame.getByRole("button", { name: "Attempt external submission", exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(frame.locator("html")).toHaveAttribute("data-fixture-run", run!);
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin|allow-top-navigation|allow-popups/);
  expect(forbiddenRequests).toBe(0);
  await noNativeChrome(page);
});
}
