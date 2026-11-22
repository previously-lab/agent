import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { E2E_BASE_URL as DEFAULT_BASE_URL, E2E_DIALOGUE_PROVIDER_ROOT as DEFAULT_PROVIDER_ROOT, E2E_MEMORY_ROOT as DEFAULT_MEMORY_ROOT, E2E_WORKFLOW_ROOT as DEFAULT_WORKFLOW_ROOT } from "./env";
const isolatedRoot = process.env.SCROLL_QA_FIXTURE_ROOT;
const E2E_BASE_URL = process.env.SCROLL_QA_BASE_URL ?? DEFAULT_BASE_URL;
const E2E_DIALOGUE_PROVIDER_ROOT = process.env.SCROLL_QA_PROVIDER_ROOT ?? (isolatedRoot ? path.join(isolatedRoot, "home", "dialogue-provider") : DEFAULT_PROVIDER_ROOT);
const E2E_MEMORY_ROOT = isolatedRoot ? path.join(isolatedRoot, "memory") : DEFAULT_MEMORY_ROOT;
const E2E_WORKFLOW_ROOT = isolatedRoot ? path.join(isolatedRoot, "workflow") : DEFAULT_WORKFLOW_ROOT;
import { readChatEvents } from "@/lib/chat/client-stream";

type Frame = Record<string, unknown> | "keepalive";
type Rule = {
  id: string;
  contains?: string[];
  excludes?: string[];
  thinking?: "enabled" | "disabled";
  repeat?: boolean;
  gate?: string;
  gateTimeoutMs?: number;
  finishReason?: string;
  status?: number;
  frames?: Array<Frame | { frame: Frame; gateBefore?: string; gateAfter?: string }>;
};

type AcceptedV2 = {
  version: 2;
  parentRunId: string;
  sourceInputId: string;
  workId: string;
  offersUrl: string;
  thoughtsUrl: string;
};

type OfferEvent = {
  type: "offer" | "dialogue_wake" | "done";
  status?: string;
  triggerKey?: string;
  runId?: string;
  sourceInputId?: string;
};

const gates = new Set<string>();
const rulesPath = path.join(E2E_DIALOGUE_PROVIDER_ROOT, "rules.json");
const requestsPath = path.join(E2E_DIALOGUE_PROVIDER_ROOT, "requests");

async function writeRules(rules: Rule[]): Promise<void> {
  await fs.promises.mkdir(E2E_DIALOGUE_PROVIDER_ROOT, { recursive: true });
  const temporary = path.join(E2E_DIALOGUE_PROVIDER_ROOT, `rules-v2-${process.pid}-${randomUUID()}.json`);
  await fs.promises.writeFile(temporary, JSON.stringify(rules), "utf8");
  await fs.promises.rename(temporary, rulesPath);
}

async function release(gate: string): Promise<void> {
  gates.add(gate);
  await fs.promises.writeFile(path.join(E2E_DIALOGUE_PROVIDER_ROOT, `release-${gate}`), "", "utf8");
}

function toolFrame(toolName: string, input: unknown, id: string, index = 0): Frame {
  return { tool_calls: [{ index, id, type: "function", function: { name: toolName, arguments: JSON.stringify(input) } }] };
}

function analyzerRule(token: string, id: string, gate?: string): Rule {
  if (gate) gates.add(gate);
  return {
    id: `analyzer-${id}-${token}`,
    contains: ["analyzeOutput", token],
    ...(gate ? { gate } : {}),
    finishReason: "tool_calls",
    frames: [toolFrame("analyzeOutput", {
      intent: { type: "chat", reason: "Offline server-started fixture" },
      memory_worthy: false,
      emotional_signal: { intensity: "none", register: "neutral", note: "" },
    }, `analyzer-call-${id}-${token}`)],
  };
}

function idleReflectionRule(): Rule {
  return {
    id: "reflection-idle-v2",
    contains: ["hqReport"],
    repeat: true,
    finishReason: "tool_calls",
    frames: [toolFrame("hqReport", { actions: [], note: "No writes in the offline v2 fixture." }, "reflection-idle-v2-call")],
  };
}

async function capturedRequests(ruleId: string): Promise<Array<Record<string, unknown>>> {
  const names = await fs.promises.readdir(requestsPath).catch(() => [] as string[]);
  const found: Array<Record<string, unknown>> = [];
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const entry = JSON.parse(await fs.promises.readFile(path.join(requestsPath, name), "utf8")) as {
      ruleId?: string;
      request?: Record<string, unknown>;
    };
    if (entry.ruleId === ruleId && entry.request) found.push(entry.request);
  }
  return found;
}

async function sendThroughComposer(page: Page, text: string, persona: string, submit: "enter" | "click" = "enter"): Promise<AcceptedV2> {
  await page.goto(`/en/app?persona=${encodeURIComponent(persona)}`);
  const editor = page.locator("[data-manuscript-input]");
  await expect(editor).toBeEditable();
  const acceptedResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await editor.fill(text);
  if (submit === "click") await page.locator('[data-primary-action="send"]:visible').click();
  else await editor.press("Enter");
  const response = await acceptedResponse;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({ dialogueVersion: 2 });
  const accepted = await response.json() as AcceptedV2;
  expect(accepted.version).toBe(2);
  for (const key of ["parentRunId", "sourceInputId", "workId", "offersUrl", "thoughtsUrl"] as const) {
    expect(typeof accepted[key], `v2 acceptance field ${key}`).toBe("string");
    expect(accepted[key].length, `v2 acceptance field ${key}`).toBeGreaterThan(0);
  }
  return accepted;
}

async function observeOffers(offersUrl: string) {
  const controller = new AbortController();
  const response = await fetch(new URL(offersUrl, E2E_BASE_URL), {
    headers: { accept: "text/event-stream" }, signal: controller.signal,
  });
  expect(response.ok).toBe(true);
  expect(response.body).not.toBeNull();
  const events: OfferEvent[] = [];
  let doneReceivedAt: number | undefined;
  let failure: unknown;
  const reading = (async () => {
    for await (const chunk of readChatEvents(response.body!, controller.signal)) {
      const event = chunk as unknown as OfferEvent;
      events.push(event);
      if (event.type === "done") doneReceivedAt = Date.now();
    }
  })().catch(error => { if (!controller.signal.aborted) failure = error; });
  return {
    events,
    get doneReceivedAt() { return doneReceivedAt; },
    get failure() { return failure; },
    async close() { controller.abort(); await reading; },
  };
}

async function observeNativeStream(runId: string) {
  const controller = new AbortController();
  const response = await fetch(new URL(`/api/chat/${encodeURIComponent(runId)}/stream?startIndex=0`, E2E_BASE_URL), {
    headers: { accept: "text/event-stream" }, signal: controller.signal,
  });
  expect(response.ok).toBe(true);
  expect(response.body).not.toBeNull();
  const events: Array<Record<string, unknown>> = [];
  let failure: unknown;
  const reading = (async () => {
    for await (const event of readChatEvents(response.body!, controller.signal)) {
      events.push(event as unknown as Record<string, unknown>);
    }
  })().catch(error => { if (!controller.signal.aborted) failure = error; });
  return {
    events,
    get failure() { return failure; },
    async close() { controller.abort(); await reading; },
  };
}

async function localRun(runId: string): Promise<{ status: string; executionContext?: { workflowCoreVersion?: string } }> {
  return JSON.parse(await fs.promises.readFile(path.join(E2E_WORKFLOW_ROOT, "runs", `${runId}.json`), "utf8"));
}

async function childRunForTurn(parentRunId: string, workflowName: "dialogueRecordWorkflow" | "reflectionRun"): Promise<{ status: string } | null> {
  const directory = path.join(E2E_WORKFLOW_ROOT, "runs");
  const runs = [] as Array<{ status: string; createdAt: string }>;
  for (const file of await fs.promises.readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    const run = JSON.parse(await fs.promises.readFile(path.join(directory, file), "utf8"));
    if (run.attributes?.$rootRunId === parentRunId && run.workflowName?.endsWith(`//${workflowName}`)) {
      runs.push({ status: run.status, createdAt: run.createdAt });
    }
  }
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return runs.at(-1) ?? null;
}
function assistantReply(page: Page, firstText: string) {
  return page.getByRole("article", { name: "Previously" }).filter({ hasText: firstText });
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === E2E_BASE_URL
    ? route.continue() : route.abort());
});

test.afterEach(async () => {
  await Promise.all([...gates].map(gate =>
    fs.promises.writeFile(path.join(E2E_DIALOGUE_PROVIDER_ROOT, `release-${gate}`), "", "utf8").catch(() => {})));
  gates.clear();
});

// Time actual clicks and rendered public prose on the browser's own clock.
// A caption, a private preview and a network event can all precede that prose.
interface PublicTiming {
  clickAt: number;
  oldRows: string[];
  sawStop?: boolean;
  firstPublicMs?: number;
  firstPublicText?: string;
  finalVisibleMs?: number;
  uiIdleMs?: number;
}

async function observePublicTiming(page: Page, finalText: string) {
  await page.addInitScript(final => {
    if (window.top !== window) return;
    const key = "e2e-public-reply-timing";
    const previous = sessionStorage.getItem(key);
    let timing: PublicTiming | undefined = previous ? JSON.parse(previous) : undefined;
    const now = () => performance.timeOrigin + performance.now();
    let pending = false;
    const measure = () => {
      pending = false;
      if (!timing || timing.uiIdleMs !== undefined) return;
      const elapsed = Math.round(now() - timing.clickAt);
      for (const row of document.querySelectorAll<HTMLElement>("[data-dialogue-work-turn]")) {
        if (timing.oldRows.includes(row.dataset.dialogueWorkTurn!)) continue;
        for (const prose of row.querySelectorAll<HTMLElement>(".dialogue-continuous-reply .conversation-prose")) {
          const text = prose.innerText.trim();
          const rect = prose.getBoundingClientRect();
          if (!text || !rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight ||
              rect.right <= 0 || rect.left >= innerWidth || getComputedStyle(prose).visibility !== "visible") continue;
          timing.firstPublicMs ??= elapsed;
          timing.firstPublicText ??= text;
          if (text.includes(final)) timing.finalVisibleMs ??= elapsed;
        }
      }
      const action = document.querySelector("[data-conversation-primary]")?.getAttribute("data-primary-action");
      if (action === "stop") timing.sawStop = true;
      if (timing.sawStop && timing.finalVisibleMs !== undefined && action === "send") timing.uiIdleMs = elapsed;
      sessionStorage.setItem(key, JSON.stringify(timing));
      if (timing.uiIdleMs !== undefined) observer.disconnect();
    };
    const observer = new MutationObserver(() => {
      if (!timing || pending || timing.uiIdleMs !== undefined) return;
      pending = true;
      requestAnimationFrame(measure);
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener("click", event => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-primary-action="send"]')) return;
      timing = { clickAt: now(), oldRows: Array.from(document.querySelectorAll<HTMLElement>("[data-dialogue-work-turn]"),
        row => row.dataset.dialogueWorkTurn!) };
      sessionStorage.setItem(key, JSON.stringify(timing));
    }, { capture: true });
  }, finalText);
}

async function publicTiming(page: Page, doneReceivedAt: number) {
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("e2e-public-reply-timing") ?? "{}").uiIdleMs !== undefined);
  return page.evaluate(receivedAt => {
    const sample: PublicTiming = JSON.parse(sessionStorage.getItem("e2e-public-reply-timing")!);
    return { firstPublicMs: sample.firstPublicMs!, finalVisibleMs: sample.finalVisibleMs!, uiIdleMs: sample.uiIdleMs!,
      deliveredMs: Math.round(receivedAt - sample.clickAt), firstPublicText: sample.firstPublicText };
  }, doneReceivedAt);
}

for (const useCheckpoint of [true, false]) {
  const scenario = useCheckpoint ? "a grounded partial while private work is blocked" : "only a final for a greeting";
  test(`v2 native dialogue shows ${scenario}`, async ({ page }, testInfo) => {
    const token = randomUUID();
    const ref = `research/pilot-${token}`;
    const privateMarker = `PRIVATE_NOTE_${token}`;
    const reasoningMarker = `PRIVATE_REASONING_${token}`;
    const podQuestion = `Four sessions with six seats each. Calculate total capacity. ${token}`;
    const podAnswer = "Calculated total capacity is 24.";
    const note = "The schedule confirms Tuesday. Capacity is still under review.";
    const partialText = "The pilot runs on Tuesday. I’m still checking capacity.";
    const finalText = useCheckpoint ? "There are 24 seats across the four sessions." : "Hello! Good to see you.";
    const finalFact = useCheckpoint ? "Confirmed total: 24 seats, four sessions of six." : `A friendly greeting for ${token}`;
    const gate = `capacity-${token}`;
    const checkpointActor = `checkpoint-expression-${token}`;
    const finalActor = `final-expression-${token}`;
    const rules = [idleReflectionRule(), analyzerRule(token, "native")];
    if (useCheckpoint) {
      gates.add(gate);
      const folder = path.join(E2E_MEMORY_ROOT, ...ref.split("/"));
      await fs.promises.mkdir(folder, { recursive: true });
      await fs.promises.writeFile(path.join(folder, "index.md"),
        `# Pilot schedule\n\nTuesday. Four sessions with six seats each.\n\n${privateMarker}\n`, "utf8");
      rules.push(
        { id: `read-pilot-${token}`, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
          frames: [toolFrame("recallRead", { ref }, `read-${token}`)] },
        { id: `batch-${token}`, contains: ["finishThinking", privateMarker], thinking: "enabled", finishReason: "tool_calls",
          frames: [{ reasoning_content: reasoningMarker }, toolFrame("thinkDeep", { question: podQuestion }, `capacity-${token}`),
            toolFrame("workCheckpoint", { text: note }, `partial-${token}`, 1)] },
        { id: `held-pod-${token}`, contains: [podQuestion, "THINK-ONLY"], gate, frames: [{ content: podAnswer }] },
        { id: checkpointActor, contains: [note, token], thinking: "disabled", frames: [{ content: partialText }] },
      );
    }
    rules.push(
      { id: `result-${token}`, contains: ["completeWork", token, ...(useCheckpoint ? [podAnswer] : [])],
        thinking: "enabled", finishReason: "tool_calls", frames: [toolFrame("completeWork",
          { responseMode: useCheckpoint ? "focused" : "chat", result: finalFact }, `complete-${token}`)] },
      { id: `terminal-${token}`, contains: ["finishThinking", finalFact], thinking: "enabled", finishReason: "tool_calls",
        frames: [toolFrame("finishThinking", { findings: [] }, `finish-${token}`)] },
      { id: finalActor, contains: [finalFact, token], thinking: "disabled", frames: [{ content: finalText }] },
    );
    await writeRules(rules);
    await observePublicTiming(page, finalText);
    const question = useCheckpoint ? "What day is the pilot and how many seats are there?" : "Hello!";
    const accepted = await sendThroughComposer(page, `${question} [${token}]`, `native-${token}`, "click");
    const offers = await observeOffers(accepted.offersUrl);
    const expected = useCheckpoint ? [partialText, finalText] : [finalText];
    const reply = assistantReply(page, useCheckpoint ? partialText : finalText);
    const publications = reply.locator("[data-public-utterance] .conversation-prose");
    try {
      if (useCheckpoint) {
        await expect.poll(async () => (await capturedRequests(`held-pod-${token}`)).length).toBe(1);
        await expect(reply.locator(".conversation-prose").getByText(partialText, { exact: true })).toBeVisible();
        expect((await localRun(accepted.parentRunId)).status).toBe("running");
        expect(await capturedRequests(finalActor)).toHaveLength(0);
        await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");
        await expect(reply).not.toContainText(finalText);
        await expect(reply).not.toContainText(privateMarker, { useInnerText: true });
        await expect(reply).not.toContainText(reasoningMarker, { useInnerText: true });
        await expect(reply.locator("[data-dialogue-work-caption]")).toHaveAttribute("aria-expanded", "false");
        const checkpointRequest = (await capturedRequests(checkpointActor))[0]!;
        expect(JSON.stringify(checkpointRequest)).not.toContain(privateMarker);
        expect(JSON.stringify(checkpointRequest)).not.toContain(reasoningMarker);
        expect(JSON.stringify(checkpointRequest)).not.toContain(podQuestion);
        await testInfo.attach("partial-while-private-work-is-blocked", { body: await page.screenshot(), contentType: "image/png" });
        // The original tab reconnects while the sibling is still waiting. Its
        // fresh React tree must restore only the committed partial and follow
        // the same live turn to its final delivery.
        await page.reload();
        await expect(publications).toHaveText([partialText]);
        await expect(publications).toBeVisible();
        await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");
        expect((await localRun(accepted.parentRunId)).status).toBe("running");
        await release(gate);
      }
      await expect(publications).toHaveText(expected);
      await expect.poll(() => offers.events.find(event => event.type === "done"))
        .toMatchObject({ status: "completed", deliveryStatus: "delivered" });
    } finally {
      await offers.close();
    }
    expect((await localRun(accepted.parentRunId)).status).toBe("completed");
    await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "send");
    const timing = await publicTiming(page, offers.doneReceivedAt!);
    expect(timing.firstPublicText).toBe(expected[0]);
    if (useCheckpoint) expect(timing.firstPublicMs).toBeLessThan(timing.finalVisibleMs);
    const actorRequest = (await capturedRequests(finalActor))[0]!;
    const messages = actorRequest.messages as Array<{ role: string; content: string }>;
    const prompt = JSON.parse(messages.findLast(message => message.role === "user")!.content);
    expect(prompt.alreadySaid).toEqual(useCheckpoint ? [partialText] : []);
    expect(JSON.stringify(actorRequest)).not.toContain(privateMarker);
    expect(JSON.stringify(actorRequest)).not.toContain(reasoningMarker);
    await page.reload();
    await expect(reply).toHaveCount(1);
    await expect(publications).toHaveText(expected);
    const ordinals = await reply.locator("[data-public-utterance]").evaluateAll(items =>
      items.map(item => Number(item.getAttribute("data-public-seq"))));
    expect(ordinals).toEqual(useCheckpoint ? [1, 2] : [1]);
    await expect(reply).not.toContainText(privateMarker, { useInnerText: true });
    await expect(reply).not.toContainText(reasoningMarker, { useInnerText: true });
    await testInfo.attach("public-timing", { body: JSON.stringify({ scenario, parentRunId: accepted.parentRunId,
      ...timing, reloadedDuringWork: useCheckpoint, reloadedPublicText: await publications.allInnerTexts(), ordinals }, null, 2), contentType: "application/json" });
  });
}

test("v2 automatically publishes a verified answer while the thinker continues researching", async ({ page }, testInfo) => {
  const token = randomUUID();
  const schedule = `research/workshop-schedule-${token}`;
  const capacity = `research/workshop-capacity-${token}`;
  const dayQuestion = "When does the workshop start?";
  const seatsQuestion = "How many seats are available?";
  const sourceFact = "The workshop starts on Tuesday.";
  const seatFact = "Four independent sessions have six seats each.";
  const unrelated = `Receipt label: violet-${token}.`;
  for (const [ref, content] of [[schedule, `# Schedule\n\n${sourceFact}\n\n${unrelated}`],
    [capacity, `# Capacity\n\n${seatFact}`]]) {
    const dir = path.join(E2E_MEMORY_ROOT, ...ref.split("/"));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "index.md"), `${content}\n`, "utf8");
  }
  const privateQuestion = `How should capacities of independent sessions be combined? ${token}`;
  const privateResult = "Add the seat counts for the individual sessions.";
  const partialText = "The workshop begins on Tuesday.";
  const finalFact = "The available capacity is 24 seats in total.";
  const finalText = "There are 24 seats.";
  const gate = `ongoing-research-${token}`;
  gates.add(gate);
  const extraction = `extract-${token}`;
  const checkpointActor = `automatic-checkpoint-${token}`;
  const completion = `complete-automatic-${token}`;
  const finalActor = `automatic-final-${token}`;
  await writeRules([
    idleReflectionRule(), analyzerRule(token, "automatic"),
    { id: `read-schedule-${token}`, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("recallRead", { ref: schedule }, `schedule-${token}`)] },
    { id: `read-capacity-${token}`, contains: ["finishThinking", unrelated], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("recallRead", { ref: capacity }, `capacity-${token}`),
        toolFrame("thinkDeep", { question: privateQuestion }, `combine-${token}`, 1)] },
    { id: `held-research-${token}`, contains: [privateQuestion, "THINK-ONLY"], gate, frames: [{ content: privateResult }] },
    { id: extraction, contains: ["verbatimEvidence", sourceFact, token], thinking: "disabled",
      frames: [{ content: JSON.stringify([
        { question: dayQuestion, directAnswer: "Tuesday", verbatimEvidence: sourceFact },
        { question: seatsQuestion, directAnswer: null, verbatimEvidence: null },
      ]) }] },
    { id: checkpointActor, contains: [sourceFact, token], excludes: ["verbatimEvidence", finalFact], thinking: "disabled",
      frames: [{ content: partialText }] },
    { id: completion, contains: ["completeWork", token, seatFact, privateResult], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("completeWork", { responseMode: "focused", result: finalFact }, `final-${token}`)] },
    { id: `finish-automatic-${token}`, contains: ["finishThinking", finalFact], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("finishThinking", { findings: [] }, `finish-${token}`)] },
    { id: finalActor, contains: [finalFact, token], thinking: "disabled", frames: [{ content: finalText }] },
  ]);
  await observePublicTiming(page, finalText);
  const accepted = await sendThroughComposer(page, `${dayQuestion} ${seatsQuestion} [${token}]`, `auto-${token}`, "click");
  const offers = await observeOffers(accepted.offersUrl);
  const reply = assistantReply(page, partialText);
  const publications = reply.locator("[data-public-utterance]");
  try {
    await expect.poll(async () => (await capturedRequests(`held-research-${token}`)).length).toBe(1);
    await expect(publications).toHaveText([partialText]);
    await expect(publications).toBeVisible();
    await expect(publications).toHaveAttribute("data-public-utterance", `${accepted.workId}:host-partial-evidence`);
    expect((await localRun(accepted.parentRunId)).status).toBe("running");
    expect(await capturedRequests(completion)).toHaveLength(0);
    const extractorCalls = await capturedRequests(extraction);
    expect(extractorCalls).toHaveLength(1);
    const actorCalls = await capturedRequests(checkpointActor);
    expect(actorCalls).toHaveLength(1);
    const messages = actorCalls[0]!.messages as Array<{ role: string; content: string }>;
    const handoff = JSON.parse(messages.findLast(message => message.role === "user")!.content);
    expect(handoff).toMatchObject({ stage: "checkpoint", event: { kind: "work_update", notes: sourceFact } });
    expect(JSON.stringify(actorCalls[0])).not.toContain(unrelated);
    expect(JSON.stringify(actorCalls[0])).not.toContain(privateQuestion);
    await testInfo.attach("automatic-partial-while-private-work-is-blocked", { body: await page.screenshot(), contentType: "image/png" });
    await release(gate);
    await expect(publications).toHaveText([partialText, finalText]);
    await expect.poll(() => offers.events.find(event => event.type === "done"))
      .toMatchObject({ status: "completed", deliveryStatus: "delivered" });
  } finally {
    await offers.close();
  }
  const thinking = (await capturedRequests(completion))[0]!.messages as Array<{
    role: string; tool_calls?: Array<{ function: { name: string } }>;
  }>;
  expect(thinking.filter(message => message.role === "assistant")
    .flatMap(message => message.tool_calls?.map(call => call.function.name) ?? [])).toEqual(["recallRead", "recallRead", "thinkDeep"]);
  const timing = await publicTiming(page, offers.doneReceivedAt!);
  expect(timing.firstPublicText).toBe(partialText);
  expect(timing.firstPublicMs).toBeLessThan(timing.finalVisibleMs);
  await page.reload();
  await expect(reply).toHaveCount(1);
  await expect(publications).toHaveText([partialText, finalText]);
  await testInfo.attach("public-timing", { body: JSON.stringify({ scenario: "automatic verified partial during further research",
    parentRunId: accepted.parentRunId, ...timing, checkpointSource: "host-partial-evidence",
    reloadedDuringWork: false, reloadedPublicText: await publications.allInnerTexts() }, null, 2), contentType: "application/json" });
});

test("v2 keeps verified reads out of the chat and publishes the structured final", async ({ page }) => {
  const token = randomUUID();
  const ref = `research/dialogue-fixture-${token}`;
  const folder = path.join(E2E_MEMORY_ROOT, ...ref.split("/"));
  const privateDocumentMarker = `RAW_PRIVATE_DOCUMENT_${token}`;
  const fact = `The pilot trial starts on Tuesday (${token}).`;
  await fs.promises.mkdir(folder, { recursive: true });
  await fs.promises.writeFile(path.join(folder, "index.md"),
    `# Reading room\n\n${fact}\n\n${privateDocumentMarker}\n`, "utf8");
  const firstReadId = `tool-first-read-${token}`;
  const finalPublic = `The pilot trial starts on Tuesday. ${token}`;
  const finalGate = `structured-final-${token}`;
  gates.add(finalGate);
  const terminalThinking = `terminal-thinking-${token}`;
  const completeRule = `complete-work-${token}`;
  const finalDialogue = `structured-final-dialogue-${token}`;
  await writeRules([
    idleReflectionRule(),
    analyzerRule(token, "structured"),
    { id: `first-read-${token}`, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("recallRead", { ref }, firstReadId)] },
    { id: completeRule, contains: ["completeWork", privateDocumentMarker], thinking: "enabled", gate: finalGate, finishReason: "tool_calls",
      frames: [toolFrame("completeWork", { responseMode: "focused", result: fact }, `complete-${token}`)] },
    { id: terminalThinking, contains: ["finishThinking", fact], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("finishThinking", { findings: [] }, `finish-structured-${token}`)] },
    { id: finalDialogue, contains: [fact], thinking: "disabled", frames: [{ content: finalPublic }] },
  ]);
  const accepted = await sendThroughComposer(page, `Check the schedule in my reading-room note ${token}`, `tool-event-${token}`);
  let offers: Awaited<ReturnType<typeof observeOffers>> | undefined;
  try {
    await expect.poll(async () => (await capturedRequests(completeRule)).length).toBe(1);
    const firstThinkingRequest = (await capturedRequests(`first-read-${token}`))[0]!;
    const thinkingSystem = (firstThinkingRequest.messages as Array<{ role: string; content: string }>)
      .find(message => message.role === "system")?.content;
    expect(thinkingSystem?.includes("finishThinking") && thinkingSystem.includes("needsUser"),
      "native handoff instructions survive the assembled system prompt").toBe(true);
    expect(thinkingSystem?.includes("yours is the only mouth"),
      "the private thinker does not receive the old speaking role").toBe(false);
    const offeredTool = (firstThinkingRequest.tools as Array<{ function: { name: string; parameters: { required?: string[] } } }>)
      .find(entry => entry.function.name === "completeWork");
    expect(offeredTool?.function.parameters.required).toContain("result");
    await expect(assistantReply(page, finalPublic)).toHaveCount(0);
    await release(finalGate);
    // The endpoint can wait to send headers until the first offer. With no
    // read-only checkpoint, start observing after we release the final.
    const observed = await observeOffers(accepted.offersUrl);
    offers = observed;
    await expect(assistantReply(page, finalPublic)).toHaveCount(1);
    await expect.poll(() => observed.events.find(event => event.type === "done")?.status).toBe("completed");
    const closing = (await capturedRequests(terminalThinking))[0]!;
    expect((closing.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toEqual(["finishThinking"]);
    await expect(page.locator(`[data-dialogue-work="${accepted.workId}"] [data-dialogue-work-caption]`))
      .toHaveAttribute("title", "Completed");
    const finalCall = (await capturedRequests(finalDialogue))[0]!;
    const dialogueSystem = (finalCall.messages as Array<{ role: string; content: string }>)
      .find(message => message.role === "system")?.content;
    expect(dialogueSystem).toContain("If the user explicitly asks to inspect, test or debug Previously itself");
    expect(dialogueSystem).toContain("not proof that a browser displayed it or the user saw it");
    const finalRequest = JSON.stringify(finalCall);
    expect(finalRequest).toContain(fact);
    expect(finalRequest).not.toContain(privateDocumentMarker);
  } finally {
    await offers?.close();
  }
});

test("v2 keeps a plan silent and publishes progress and final while discarding stale drafts", async ({ page }, testInfo) => {
  const token = randomUUID();
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { copied = text; },
      readText: async () => copied,
    } });
  });
  const firstNote = `Opening | Plan: check the original record ${token}`;
  const secondNote = `NEW_FINDING_${token}`;
  const staleNote = `SUPERSEDED_FINDING_${token}`;
  const openingDialogue = `opening-dialogue-${token}`;
  const partialReply = `PUBLIC_CHECKPOINT_${token}`;
  const staleDraft = `SUPERSEDED_DRAFT_${token}`;
  const finalReply = `PUBLIC_CONCLUSION_${token}`;
  const nextGate = `next-checkpoint-${token}`;
  const thirdGate = `third-checkpoint-${token}`;
  const staleGate = `stale-checkpoint-${token}`;
  const finalGate = `final-checkpoint-${token}`;
  gates.add(nextGate).add(thirdGate).add(staleGate).add(finalGate);
  const finalThinking = `final-thinking-${token}`;
  const finalDialogue = `final-dialogue-${token}`;
  const staleDialogue = `stale-dialogue-${token}`;
  await writeRules([
    idleReflectionRule(),
    analyzerRule(token, "checkpoint"),
    { id: `opening-thinking-${token}`, contains: ["finishThinking", token], thinking: "enabled",
      finishReason: "tool_calls",
      frames: [toolFrame("workCheckpoint", { text: firstNote }, `opening-${token}`)] },
    { id: `speak-thinking-${token}`, contains: ["finishThinking", token], thinking: "enabled", gate: nextGate,
      finishReason: "tool_calls",
      frames: [toolFrame("workCheckpoint", { text: secondNote }, `speak-${token}`)] },
    { id: `stale-thinking-${token}`, contains: ["finishThinking", token], thinking: "enabled", gate: thirdGate,
      finishReason: "tool_calls",
      frames: [toolFrame("workCheckpoint", { text: staleNote }, `stale-${token}`)] },
    { id: finalThinking, contains: ["finishThinking", token], thinking: "enabled", gate: finalGate,
      finishReason: "tool_calls", frames: [toolFrame("completeWork", { responseMode: "focused",
        result: `Final finding for ${token}` }, `final-offer-${token}`)] },
    { id: `finish-checkpoints-${token}`, contains: ["finishThinking", token], thinking: "enabled",
      finishReason: "tool_calls", frames: [toolFrame("finishThinking", { findings: [] }, `finish-checkpoints-${token}`)] },
    { id: openingDialogue, contains: [firstNote], thinking: "disabled",
      frames: [] },
    { id: `speak-dialogue-${token}`, contains: [secondNote], thinking: "disabled",
      frames: [{ content: partialReply }] },
    { id: staleDialogue, contains: [staleNote], thinking: "disabled", gate: staleGate,
      frames: [{ content: staleDraft }] },
    { id: finalDialogue, contains: ["Final finding for", token, "This is the final reply"], thinking: "disabled",
      frames: [{ content: finalReply }] },
  ]);

  const accepted = await sendThroughComposer(page, `Investigate step by step ${token}`, `checkpoint-${token}`);
  const offers = await observeOffers(accepted.offersUrl);
  try {
    await expect.poll(async () => (await capturedRequests(openingDialogue)).length).toBe(1);
    const openingCall = (await capturedRequests(openingDialogue))[0]!;
    expect(openingCall).not.toHaveProperty("tools");
    const row = page.locator(`[data-dialogue-work-turn="${accepted.workId}"]`);
    await expect(row.locator("[data-public-utterance]")).toHaveCount(0);

    await release(nextGate);
    await expect(assistantReply(page, partialReply)).toHaveCount(1);
    await expect(assistantReply(page, finalReply)).toHaveCount(0);
    await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");

    await release(thirdGate);
    await expect.poll(async () => (await capturedRequests(staleDialogue)).length).toBe(1);
    await expect.poll(async () => (await capturedRequests(finalThinking)).length).toBe(1);
    await release(finalGate);
    // The single dialogue Actor still holds the stale draft. Let the thinker
    // commit the newer final before the Actor can attempt publication.
    await expect.poll(async () => (await capturedRequests(`finish-checkpoints-${token}`)).length).toBe(1);
    await release(staleGate);
    const reply = assistantReply(page, finalReply);
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(partialReply);
    await expect(reply.locator("[data-public-utterance]")).toHaveCount(2);
    await expect(reply.locator(".conversation-speaker")).toHaveCount(1);
    await expect(reply.locator(".conversation-message-actions")).toHaveCount(1);
    await expect.poll(() => offers.events.some(event => event.type === "done")).toBe(true);
    await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "send");
    const copy = reply.getByRole("button", { name: "Copy reply", exact: true });
    await expect(copy).toHaveCount(1);
    if (testInfo.project.name === "desktop") await reply.hover();
    await expect(copy).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`continuous-reply-${testInfo.project.name}.png`), animations: "disabled", fullPage: true });
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${partialReply}\n\n${finalReply}`);
    const request = (await capturedRequests(finalDialogue))[0]!;
    const messages = request.messages as Array<{ role: string; content: string }>;
    const prompt = JSON.parse(messages.findLast(message => message.role === "user")!.content);
    expect(prompt).toMatchObject({ stage: "final", alreadySaid: [partialReply] });
    expect(prompt.otherOffers.map((offer: { text: string }) => offer.text)).toEqual([firstNote, secondNote, staleNote]);
    const wakes = offers.events.filter(event => event.type === "dialogue_wake").map(event => event.triggerKey);
    for (const step of ["opening", "speak", "stale", "final-offer"]) {
      expect(wakes.filter(key => key === `${accepted.workId}:${step}-${token}`)).toHaveLength(1);
    }
    await expect(assistantReply(page, staleDraft)).toHaveCount(0);
    await page.reload();
    await expect(reply.locator("[data-public-utterance] .conversation-prose")).toHaveText([partialReply, finalReply]);
    await expect(assistantReply(page, staleDraft)).toHaveCount(0);
    const files = (await fs.promises.readdir(E2E_MEMORY_ROOT, { recursive: true })).filter(name => name.endsWith("core.md"));
    const saved = (await Promise.all(files.map(name => fs.promises.readFile(path.join(E2E_MEMORY_ROOT, name), "utf8")))).join("\n");
    expect(saved).toContain(partialReply);
    expect(saved).toContain(finalReply);
    expect(saved).not.toContain(staleDraft);
  } finally {
    await offers.close();
  }
});

test("v2 completed work streams prose before parent finish and publishes typed HTML once", async ({ page }) => {
  const token = randomUUID();
  const persona = `e2e-v2-${token}`;
  const userText = `Server-started offline dialogue ${token}`;
  const privateReasoning = `PRIVATE_REASONING_${token}`;
  const rawToolPayload = `RAW_TOOL_PAYLOAD_${token}`;
  const safeThinking = `SAFE_THINKING_${token}: a useful reply is ready.`;
  const safeOffer = `SAFE_OFFER_${token}: delivery can continue.`;
  const firstPublic = `PUBLIC_FIRST_${token}`;
  const secondPublic = `PUBLIC_SECOND_${token}`;
  const parentGate = `v2-parent-${token}`;
  const publicGate = `v2-public-${token}`;
  gates.add(parentGate).add(publicGate);
  const rawHtml = `<!doctype html><html><body><button id="v2-fixture">Attachment ${token}</button></body></html>`;
  const parentToolId = `thinking-${token}-tool`;
  const parentOfferId = `thinking-${token}-offer`;
  const parentFinalId = `thinking-${token}-final`;
  const offerText = `A concise result for ${token} is complete.\n\n\`\`\`html live\n${rawHtml}\n\`\`\``;
  const publicId = `public-${token}`;
  const rules: Rule[] = [
    idleReflectionRule(),
    analyzerRule(token, "parent"),
    {
      id: parentToolId, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
      frames: [
        { reasoning_content: privateReasoning },
        { content: safeThinking },
        toolFrame("currentTime", { secret: rawToolPayload }, `v2-time-${token}`),
      ],
    },
    {
      id: parentOfferId, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
      frames: [{ content: safeOffer }, toolFrame("completeWork", { responseMode: "focused", result: offerText }, `v2-offer-${token}`)],
    },
    {
      id: parentFinalId, contains: ["finishThinking", token], thinking: "enabled", gate: parentGate,
      finishReason: "tool_calls",
      frames: [toolFrame("finishThinking", { findings: [] }, `v2-finish-${token}`)],
    },
    {
      id: publicId, contains: [token], thinking: "disabled",
      frames: [
        { frame: { content: firstPublic }, gateAfter: publicGate },
        { content: secondPublic },
      ],
    },
  ];
  await writeRules(rules);
  const oldDispatchRequests: string[] = [];
  const gitHotPathRequests: string[] = [];
  const stopRequests: string[] = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/chat/dialogue/dispatch") oldDispatchRequests.push(request.url());
    if (pathname === "/api/chat/dialogue") gitHotPathRequests.push(request.url());
    if (request.method() === "POST" && /(?:stop|cancel)/.test(pathname)) stopRequests.push(request.url());
  });

  const accepted = await sendThroughComposer(page, userText, persona);
  const historyReadsAtAcceptance = gitHotPathRequests.length;
  const disclosure = page.locator(`[data-dialogue-work="${accepted.workId}"] [data-dialogue-work-caption]`);
  await expect(disclosure).toBeVisible();
  await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");
  await expect.poll(async () => (await capturedRequests(parentFinalId)).length).toBe(1);

  const offers = await observeOffers(accepted.offersUrl);
  let native: Awaited<ReturnType<typeof observeNativeStream>> | undefined;
  try {
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const output = page.locator(`[data-dialogue-work="${accepted.workId}"] [data-dialogue-thought-content]`);
    await expect(output).toContainText(safeThinking);
    await expect(output).toContainText(safeOffer);
    await expect(output).not.toContainText("completeWork");
    await expect(output).toContainText(privateReasoning);
    await expect(output).not.toContainText(rawToolPayload);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(output).not.toBeVisible();
    expect(stopRequests).toEqual([]);

    const candidateId = `${accepted.workId}:v2-offer-${token}`;
    const findWake = () => offers.events.find(event => event.type === "dialogue_wake" && event.triggerKey === candidateId);
    await expect.poll(() => findWake()?.runId).toBeTruthy();
    const wake = findWake()!;
    expect(wake.sourceInputId).toBe(accepted.sourceInputId);
    expect(wake.runId).not.toBe(accepted.parentRunId);
    native = await observeNativeStream(wake.runId!);

    await expect.poll(async () => (await capturedRequests(publicId)).length).toBe(1);
    const publicRequest = (await capturedRequests(publicId))[0]!;
    expect(publicRequest.model).toBe("deepseek-flash");
    expect(publicRequest.thinking).toEqual({ type: "disabled" });
    expect(publicRequest).not.toHaveProperty("reasoning_effort");
    const publicPayload = JSON.stringify(publicRequest);
    for (const htmlFragment of ["<!doctype html>", "<html>", "<button id=", "</html>"]) {
      expect(publicPayload).not.toContain(htmlFragment);
    }
    expect(publicPayload).not.toContain("```html");

    await expect.poll(() => native?.events.some(event => event.type === "text-delta" && event.delta === firstPublic)).toBe(true);
    const reply = assistantReply(page, firstPublic);
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(firstPublic);
    await expect(reply).not.toContainText(secondPublic);
    await expect(reply.locator(".conversation-prose")).not.toContainText(privateReasoning);
    await expect(reply).not.toContainText(rawToolPayload);
    await expect(reply).not.toContainText("```html");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");
    expect(offers.failure).toBeUndefined();

    await release(publicGate);
    await expect(reply).toContainText(secondPublic);
    await expect(reply.locator("[data-native-frame]")).toHaveCount(1);
    await expect(reply.locator("[data-artifact-ref]")).toHaveCount(1);
    await expect.poll(() => native?.events.some(event => event.type === "data-dialogue-publication")).toBe(true);
    expect(native.failure).toBeUndefined();
    expect(native.events.filter(event => event.type === "text-delta").map(event => event.delta))
      .toEqual([firstPublic, secondPublic]);
    const artifacts = native.events.filter(event => event.type === "data-dialogue-artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ data: { artifact: { kind: "native_html" }, body: `${rawHtml}\n` } });
    const publications = native.events.filter(event => event.type === "data-dialogue-publication");
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ data: { blocks: [
      { kind: "markdown", text: `${firstPublic}${secondPublic}` },
      { kind: "artifact_ref" },
    ] } });

    // The separate parent continuation remains blocked through child final.
    await release(parentGate);
    const widget = reply.locator("[data-native-frame]").contentFrame().frameLocator("[data-native-content]");
    await expect(widget.locator("#v2-fixture")).toHaveText(`Attachment ${token}`);
    await expect.poll(async () => (await localRun(accepted.parentRunId)).status).toBe("completed");
    await expect.poll(() => offers.events.some(event => event.type === "done")).toBe(true);
    await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "send");

    await expect.poll(() => childRunForTurn(accepted.parentRunId, "dialogueRecordWorkflow")).toMatchObject({ status: "completed" });
    await expect.poll(() => childRunForTurn(accepted.parentRunId, "reflectionRun")).toMatchObject({ status: "completed" });
    const recordFiles = (await fs.promises.readdir(E2E_MEMORY_ROOT, { recursive: true }))
      .filter(file => /(?:core|agent)\.md$/.test(file));
    const recordContents = await Promise.all(recordFiles.map(file => fs.promises.readFile(path.join(E2E_MEMORY_ROOT, file), "utf8")));
    const saved = recordContents.join("\n");
    const coreIndex = recordFiles.findIndex((file, i) => /core\.md$/.test(file) && recordContents[i]?.includes(secondPublic));
    expect(coreIndex).toBeGreaterThanOrEqual(0);
    const core = recordContents[coreIndex]!;
    const sliceId = recordFiles[coreIndex]!.split(/[\\/]/).slice(-5, -1).join("-");
    expect(sliceId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(core).toContain(rawHtml);
    const artifact = artifacts[0] as { data?: { artifact?: { artifactId?: string } } };
    const artifactId = artifact.data?.artifact?.artifactId;
    expect(artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, "dialogue-artifacts", artifactId!))).toBe(false);
    expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, "dialogue-artifacts", `${artifactId}.json`))).toBe(false);
    expect(saved).toContain(secondPublic);
    expect(saved).not.toContain(privateReasoning);
    expect(saved).not.toContain(safeThinking);
    expect(saved).not.toContain(rawToolPayload);
    await expect(page.getByText("This work could not finish", { exact: true })).toHaveCount(0);
    await expect(reply).toContainText(secondPublic);
    await expect.poll(() => page.evaluate(parentRunId => Object.entries(localStorage)
      .some(([key, value]) => key.includes(parentRunId) || value.includes(parentRunId)), accepted.parentRunId)).toBe(true);

    expect(gitHotPathRequests.length).toBe(historyReadsAtAcceptance);
    await page.reload();
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(firstPublic);
    await expect(reply).toContainText(secondPublic);
    await expect(reply.locator("[data-native-frame]")).toHaveCount(1);
    await expect(reply.locator("[data-artifact-ref]")).toHaveCount(1);
    await expect(widget.locator("#v2-fixture")).toHaveText(`Attachment ${token}`);
    expect(offers.events.filter(event => event.triggerKey === candidateId)).toHaveLength(1);
    expect(publications[0]).toMatchObject({ data: { utteranceId: candidateId, inputIds: [accepted.sourceInputId] } });
    expect(oldDispatchRequests).toEqual([]);
    expect(stopRequests).toEqual([]);
    expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, ".git"))).toBe(false);

    // Read the actual saved record with both live and legacy artifact endpoints unavailable.
    await page.route(/\/api\/chat\/.*\/artifacts\//, route => route.fulfill({ status: 404 }));
    const recordUrl = new URL("/en/app", E2E_BASE_URL);
    recordUrl.searchParams.set("doc", `records/${sliceId}`);
    recordUrl.searchParams.set("persona", persona);
    await page.goto(recordUrl.toString());
    const archived = page.locator(`.desk-shell--top [data-artifact-ref="${artifactId}"]`);
    await expect(archived).toHaveAttribute("data-artifact-state", "ready", { timeout: 30_000 });
    await expect(archived.locator("[data-native-frame]").contentFrame().frameLocator("[data-native-content]")
      .locator("#v2-fixture")).toHaveText(`Attachment ${token}`);
  } finally {
    await native?.close();
    await offers.close();
  }
});

test("v2 provider failure is distinct from background summary state", async ({ page }) => {
  const token = randomUUID();
  const persona = `e2e-v2-failure-${token}`;
  const userText = `Server-started failure ${token}`;
  const failureRule = `thinking-failure-${token}`;
  await writeRules([
    idleReflectionRule(),
    analyzerRule(token, "failure"),
    {
      id: failureRule, contains: ["finishThinking", token], thinking: "enabled",
      status: 400, frames: [],
    },
  ]);
  const accepted = await sendThroughComposer(page, userText, persona);
  expect(accepted.version).toBe(2);
  const disclosure = page.locator(`[data-dialogue-work="${accepted.workId}"] [data-dialogue-work-caption]`);
  await expect(disclosure).toContainText("Reply incomplete");
  await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "send");
  await expect(assistantReply(page, token)).toHaveCount(0);
  expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, ".git"))).toBe(false);
});


