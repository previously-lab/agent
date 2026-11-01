import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearCases, clearEpisodic, makeSlice, seedSlices } from "./memory-fixture";
import { E2E_MEMORY_ROOT } from "./env";

const PENDING_KEY = "previously:pending-persistence:v1";
const RUN_ID = "offline-arrival-old-run";
const pending = {
  runIds: [RUN_ID, "offline-arrival-old-run-2", "offline-arrival-old-run-3"],
  summaryRunIds: ["offline-arrival-old-summary", "offline-arrival-old-summary-2", "offline-arrival-old-summary-3"],
};
const cachedMessages = [{ id: "old-pending-question", role: "user", parts: [{ type: "text", text: "Unconfirmed old local question" }] }];

function fixturePath(...parts: string[]) {
  const root = path.resolve(E2E_MEMORY_ROOT);
  expect(root).toBe(path.resolve(os.tmpdir(), "previously-e2e", "memory"));
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe fixture path: ${target}`);
  return target;
}

async function expectPending(page: Page) {
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PENDING_KEY)).toEqual(pending);
}

async function expectMissingCleared(page: Page) {
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PENDING_KEY)).toEqual({ runIds: [], summaryRunIds: [] });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("previously:activeRunId"))).toBeNull();
  await expect(page.locator("[data-chat-recovery-warning]")).toHaveCount(0);
  await expect(page.locator("[data-chat-arrival-error]")).toHaveCount(0);
}

async function reloadWithoutDeadQueries(page: Page, observed: { recoveryRequests: string[][] }) {
  const previous = observed.recoveryRequests.length;
  await page.reload();
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  await expect(page.locator("[data-manuscript-input]")).toHaveValue("");
  await expectMissingCleared(page);
  const queried = observed.recoveryRequests.slice(previous).flat();
  for (const id of [...pending.runIds, ...pending.summaryRunIds]) expect(queried).not.toContain(id);
}

async function seedLocalHistory() {
  const slice = makeSlice(new Date().toISOString(), { tag: "LOCAL-ARRIVAL" });
  delete slice.closedBy;
  delete slice.end;
  await seedSlices([slice]);
  return slice;
}

async function seedPending(page: Page) {
  await page.addInitScript(({ key, value, messages, runId }) => {
    if (localStorage.getItem("fixture-local-arrival-seeded")) return;
    localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem("previously:activeRunId", runId);
    localStorage.setItem("previously:chatId", "offline-arrival-old-chat");
    localStorage.setItem("previously:messages", JSON.stringify(messages));
    localStorage.setItem("fixture-local-arrival-seeded", "yes");
  }, { key: PENDING_KEY, value: pending, messages: cachedMessages, runId: RUN_ID });
}

/** Only the read-only recovery action is mocked; arrival/history read real
 * files under the Playwright server's isolated MEMORY_ROOT. */
async function observeLocalArrival(page: Page, options: { recovery?: "missing" | "unavailable"; holdArrival?: Promise<void> } = {}) {
  const observed = {
    recoveryCalls: 0, recoveryDelivered: 0, arrivalRead: false, arrivalHeld: false,
    arrivalDelivered: false, ioErrors: 0, briefingReads: 0,
    recoveryRequests: [] as string[][],
    holdRecovery: null as Promise<void> | null,
  };
  await page.route("**/en/app**", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) {
      await route.fallback();
      return;
    }
    const args = JSON.parse(request.postData() ?? "null") as unknown;
    if (Array.isArray(args) && args.length === 2 && args.every(Array.isArray)) {
      observed.recoveryCalls += 1;
      observed.recoveryRequests.push((args as string[][]).flat());
      const missing = options.recovery === "missing";
      const result = {
        records: [], activeRunIds: [],
        savedRunIds: [], savedSummaryRunIds: [], receipts: [],
        missingRunIds: missing ? args[0] : [],
        missingSummaryRunIds: missing ? args[1] : [],
        unavailableRunIds: missing ? [] : args[0],
        failures: [],
      };
      if (observed.holdRecovery) await observed.holdRecovery;
      await route.fulfill({
        contentType: "text/x-component",
        body: `0:{"a":"$@1","f":"","b":"development"}\n1:${JSON.stringify(result)}\n`,
      });
      observed.recoveryDelivered += 1;
      return;
    }
    const response = await route.fetch();
    const body = await response.text();
    const isArrival = /"mode":"(?:resume|briefing)"/.test(body);
    if (body.includes('"mode":"briefing"')) observed.briefingReads += 1;
    if (body.includes("ENOTDIR")) observed.ioErrors += 1;
    if (body.includes('"mode":"resume"') && body.includes("TURN LOCAL-ARRIVAL")) observed.arrivalRead = true;
    if (isArrival && options.holdArrival && !observed.arrivalHeld) {
      observed.arrivalHeld = true;
      await options.holdArrival;
    }
    await route.fulfill({ response });
    if (isArrival) observed.arrivalDelivered = true;
  });
  return observed;
}

test.beforeEach(async () => {
  await clearCases();
  await clearEpisodic();
  // prepare-env normally initializes a throwaway Git repository. These cases
  // prove local arrival needs no Git metadata; this exact temp path is guarded.
  await rm(fixturePath(".git"), { recursive: true, force: true });
  await expect(access(fixturePath(".git"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  await clearCases();
  await clearEpisodic();
});

test("empty local memory discards three missing runs and summaries and opens input without Git", async ({ page }) => {
  await seedPending(page);
  const observed = await observeLocalArrival(page, { recovery: "missing" });
  await page.goto("/en/app");
  await expect.poll(() => observed.briefingReads).toBeGreaterThan(0);
  const input = page.locator("[data-manuscript-input]");
  await expect(input).toBeEditable();
  await input.fill("Unsent empty local memory draft");
  await expect(input).toHaveValue("Unsent empty local memory draft");
  await expect(page.locator("[data-chat-arrival-error]")).toHaveCount(0);
  await expect(page.locator("[data-conversation-turn]")).toHaveCount(0);
  await expectMissingCleared(page);
  await reloadWithoutDeadQueries(page, observed);
});

for (const layout of ["records", "legacy"] as const) {
test(`existing ${layout} local history loads through the configured root without Git`, async ({ page }) => {
  const slice = await seedLocalHistory();
  if (layout === "legacy") {
    const parts = slice.id.split("-");
    const source = fixturePath("records", ...parts, "core.md");
    const destination = fixturePath("episodic", "slices", ...parts, "timeline", "core.md");
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
  }
  const observed = await observeLocalArrival(page);
  await page.goto("/en/app");
  await expect.poll(() => observed.arrivalRead).toBe(true);
  await expect(page.getByText(slice.turns[0].content, { exact: true })).toBeVisible();
  await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  await expect(page.locator("[data-chat-arrival-error]")).toHaveCount(0);
});
}

test("three missing runs and summaries are discarded without warning or repeated dead queries", async ({ page }) => {
  const slice = await seedLocalHistory();
  await seedPending(page);
  const observed = await observeLocalArrival(page, { recovery: "missing" });
  await page.goto("/en/app");
  await expect.poll(() => observed.arrivalRead).toBe(true);
  expect(observed.recoveryCalls).toBeGreaterThan(0);
  await expect(page.locator("[data-manuscript-input]")).toBeVisible();
  await expect(page.locator("[data-manuscript-input]")).toHaveValue("");
  await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
  await expectMissingCleared(page);
  await reloadWithoutDeadQueries(page, observed);
  await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
});

test("temporary unavailable or slow recovery retains pointers without blocking local history or input", async ({ page }) => {
  const slice = await seedLocalHistory();
  await seedPending(page);
  const observed = await observeLocalArrival(page);
  await page.goto("/en/app");
  const input = page.locator("[data-manuscript-input]");
  await expect(input).toBeEditable();
  await expectPending(page);
  await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
  await expect(page.locator("[data-chat-arrival-error]")).toHaveCount(0);

  let releaseRecovery!: () => void;
  observed.holdRecovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const calls = observed.recoveryCalls;
  try {
    await page.reload();
    await expect.poll(() => observed.recoveryCalls).toBeGreaterThan(calls);
    // The unresolved recovery response cannot consume the history gate's 15s.
    await expect(input).toBeEditable({ timeout: 8_000 });
    await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
    await expectPending(page);
    await input.fill("New draft while optional recovery is slow");
    const editor = await input.elementHandle();
    const delivered = observed.recoveryDelivered;
    releaseRecovery();
    observed.holdRecovery = null;
    await expect.poll(() => observed.recoveryDelivered).toBeGreaterThan(delivered);
    await expect(input).toHaveValue("New draft while optional recovery is slow");
    expect(await input.evaluate((node, original) => node === original, editor)).toBe(true);
    await expectPending(page);
    await expect(page.locator("[data-chat-arrival-error]")).toHaveCount(0);
  } finally {
    releaseRecovery();
    observed.holdRecovery = null;
  }
});

test("a real local arrival read error is explicit and Retry reads the repaired files", async ({ page }) => {
  // A regular file at a required directory produces a real ENOTDIR. No action
  // error, arrival response, or empty-memory result is manufactured by the test.
  await writeFile(fixturePath("records"), "not a directory: isolated arrival IO failure", "utf8");
  const observed = await observeLocalArrival(page);
  await page.goto("/en/app");
  await expect.poll(() => observed.ioErrors).toBeGreaterThan(0);
  const error = page.locator("[data-chat-arrival-error]");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("data-arrival-failure", "failed");
  await expect(error).not.toContainText(/timed out|took too long/i);
  await expect(page.locator("[data-manuscript-input]")).toHaveCount(0);
  expect(observed.briefingReads).toBe(0);

  await rm(fixturePath("records"));
  const slice = await seedLocalHistory();
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("[data-manuscript-input]")).toBeEditable();
  await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("a genuine arrival timeout retains pending data and cannot become a saved or empty arrival", async ({ page }) => {
  test.setTimeout(60_000);
  const slice = await seedLocalHistory();
  await seedPending(page);
  let releaseArrival!: () => void;
  const holdArrival = new Promise<void>((resolve) => { releaseArrival = resolve; });
  const observed = await observeLocalArrival(page, { holdArrival });
  try {
    await page.goto("/en/app");
    await expect.poll(() => observed.arrivalHeld).toBe(true);
    const error = page.locator("[data-chat-arrival-error]");
    await expect(error).toBeVisible({ timeout: 25_000 });
    await expect(error).toHaveAttribute("data-arrival-failure", "timeout");
    await expect(error).toContainText(/timed out|took too long/i);
    await expectPending(page);
    await expect(page.locator("[data-manuscript-input]")).toHaveCount(0);
    expect(observed.briefingReads).toBe(0);

    // A late response must not dismiss a timed-out gate or acknowledge pending
    // persistence. Retry is the explicit new attempt that opens local history.
    releaseArrival();
    await expect.poll(() => observed.arrivalDelivered).toBe(true);
    await expect(error).toBeVisible();
    await expectPending(page);
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("[data-manuscript-input]")).toBeEditable();
    await expect(page.getByText(slice.turns[1].content, { exact: true })).toBeVisible();
    await expectPending(page);
  } finally {
    releaseArrival();
  }
});
