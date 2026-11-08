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
  type: "offer" | "done";
  offerId?: string;
  runId?: string;
  sourceInputId?: string;
  stage?: "checkpoint" | "final";
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

function toolFrame(toolName: string, input: unknown, id: string): Frame {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name: toolName, arguments: JSON.stringify(input) } }] };
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

async function sendThroughComposer(page: Page, text: string, persona: string): Promise<AcceptedV2> {
  await page.goto(`/en/app?persona=${encodeURIComponent(persona)}`);
  const editor = page.locator("[data-manuscript-input]");
  await expect(editor).toBeEditable();
  const acceptedResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await editor.fill(text);
  await editor.press("Enter");
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
  let failure: unknown;
  const reading = (async () => {
    for await (const event of readChatEvents(response.body!, controller.signal)) {
      events.push(event as unknown as OfferEvent);
    }
  })().catch(error => { if (!controller.signal.aborted) failure = error; });
  return {
    events,
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

async function latestReflectionRun(): Promise<{ status: string } | null> {
  const directory = path.join(E2E_WORKFLOW_ROOT, "runs");
  const runs = [] as Array<{ status: string; createdAt: string }>;
  for (const file of await fs.promises.readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    const run = JSON.parse(await fs.promises.readFile(path.join(directory, file), "utf8"));
    if (run.workflowName?.includes("/reflection-run//reflectionRun")) runs.push({ status: run.status, createdAt: run.createdAt });
  }
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return runs.at(-1) ?? null;
}
async function backgroundRecordRun(offerId: string): Promise<{ status: string } | null> {
  const directory = path.join(E2E_WORKFLOW_ROOT, "runs");
  const files = await fs.promises.readdir(directory);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const run = JSON.parse(await fs.promises.readFile(path.join(directory, file), "utf8"));
    if (run.attributes?.role === "summary" && run.attributes?.offer === offerId) return { status: run.status };
  }
  return null;
}

function assistantReply(page: Page, firstText: string) {
  return page.getByRole("article", { name: "Previously" }).filter({ hasText: firstText });
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await Promise.all([...gates].map(gate =>
    fs.promises.writeFile(path.join(E2E_DIALOGUE_PROVIDER_ROOT, `release-${gate}`), "", "utf8").catch(() => {})));
  gates.clear();
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
  const finalDialogue = `structured-final-dialogue-${token}`;
  await writeRules([
    idleReflectionRule(),
    analyzerRule(token, "structured"),
    { id: `first-read-${token}`, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("recallRead", { ref }, firstReadId)] },
    { id: `second-read-${token}`, contains: ["finishThinking", token], thinking: "enabled", finishReason: "tool_calls",
      frames: [toolFrame("recallRead", { ref }, `tool-second-read-${token}`)] },
    { id: terminalThinking, contains: ["finishThinking", token], thinking: "enabled", gate: finalGate, finishReason: "tool_calls",
      frames: [toolFrame("finishThinking", { findings: [{ kind: "project_fact", text: fact,
        evidenceIds: [`${firstReadId}:1`] }] }, `finish-structured-${token}`)] },
    { id: finalDialogue, contains: [fact], thinking: "disabled", frames: [{ content: finalPublic }] },
  ]);
  const accepted = await sendThroughComposer(page, `Check the schedule in my reading-room note ${token}`, `tool-event-${token}`);
  let offers: Awaited<ReturnType<typeof observeOffers>> | undefined;
  try {
    await expect.poll(async () => (await capturedRequests(terminalThinking)).length).toBe(1);
    const firstThinkingRequest = (await capturedRequests(`first-read-${token}`))[0]!;
    const thinkingSystem = (firstThinkingRequest.messages as Array<{ role: string; content: string }>)
      .find(message => message.role === "system")?.content;
    expect(thinkingSystem?.includes("finishThinking") && thinkingSystem.includes("needsUser"),
      "native handoff instructions survive the assembled system prompt").toBe(true);
    expect(thinkingSystem?.includes("SEPARATE tool step before the first investigative tool"),
      "the model gets a separate starting handoff before investigation").toBe(true);
    expect(thinkingSystem).toContain("checkpoints of at most 2,400 characters each");
    expect(thinkingSystem?.includes("yours is the only mouth"),
      "the private thinker does not receive the old speaking role").toBe(false);
    const offeredTool = (firstThinkingRequest.tools as Array<{ function: { name: string; parameters: { required?: string[] } } }>)
      .find(entry => entry.function.name === "offerReply");
    expect(offeredTool?.function.parameters.required).toContain("stage");
    await expect(assistantReply(page, finalPublic)).toHaveCount(0);
    await release(finalGate);
    // The endpoint can wait to send headers until the first offer. With no
    // read-only checkpoint, start observing after we release the final.
    const observed = await observeOffers(accepted.offersUrl);
    offers = observed;
    await expect(assistantReply(page, finalPublic)).toHaveCount(1);
    await expect.poll(() => observed.events.some(event => event.type === "done")).toBe(true);
    expect(offers.events.filter(event => event.type === "offer")).toHaveLength(1);
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

test("v2 publishes a plan-only opening, progress and final while discarding stale drafts", async ({ page }, testInfo) => {
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
  const openingReply = `I’ll check the original record. ${token}`;
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
      frames: [toolFrame("offerReply", { stage: "checkpoint", text: firstNote }, `opening-${token}`)] },
    { id: `speak-thinking-${token}`, contains: ["finishThinking", token], thinking: "enabled", gate: nextGate,
      finishReason: "tool_calls",
      frames: [toolFrame("offerReply", { stage: "checkpoint", text: secondNote }, `speak-${token}`)] },
    { id: `stale-thinking-${token}`, contains: ["finishThinking", token], thinking: "enabled", gate: thirdGate,
      finishReason: "tool_calls",
      frames: [toolFrame("offerReply", { stage: "checkpoint", text: staleNote }, `stale-${token}`)] },
    { id: finalThinking, contains: ["finishThinking", token], thinking: "enabled", gate: finalGate,
      finishReason: "tool_calls", frames: [toolFrame("offerReply", { stage: "final",
        text: `Final finding for ${token}` }, `final-offer-${token}`)] },
    { id: `finish-checkpoints-${token}`, contains: ["finishThinking", token], thinking: "enabled",
      finishReason: "tool_calls", frames: [toolFrame("finishThinking", { findings: [] }, `finish-checkpoints-${token}`)] },
    { id: openingDialogue, contains: [firstNote, "This is an interim update intended for the user"], thinking: "disabled",
      frames: [{ content: openingReply }] },
    { id: `speak-dialogue-${token}`, contains: [secondNote, "This is an interim update intended for the user"], thinking: "disabled",
      frames: [{ content: partialReply }] },
    { id: staleDialogue, contains: [staleNote, "This is an interim update intended for the user"], thinking: "disabled", gate: staleGate,
      frames: [{ content: staleDraft }] },
    { id: finalDialogue, contains: ["Final finding for", token, "This is the final reply"], thinking: "disabled",
      frames: [{ content: finalReply }] },
  ]);

  const accepted = await sendThroughComposer(page, `Investigate step by step ${token}`, `checkpoint-${token}`);
  const offers = await observeOffers(accepted.offersUrl);
  try {
    await expect(assistantReply(page, openingReply)).toHaveCount(1);
    const openingCall = (await capturedRequests(openingDialogue))[0]!;
    expect(openingCall).not.toHaveProperty("tools");
    expect(offers.events.find(event => event.offerId?.endsWith(`:opening-${token}`))?.stage).toBe("checkpoint");

    await release(nextGate);
    await expect(assistantReply(page, partialReply)).toHaveCount(1);
    await expect(assistantReply(page, finalReply)).toHaveCount(0);
    await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");

    await release(thirdGate);
    await expect.poll(async () => (await capturedRequests(staleDialogue)).length).toBe(1);
    await expect.poll(async () => (await capturedRequests(finalThinking)).length).toBe(1);
    await release(finalGate);
    const reply = assistantReply(page, finalReply);
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(openingReply);
    await expect(reply).toContainText(partialReply);
    await expect(reply.locator("[data-public-utterance]")).toHaveCount(3);
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
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${openingReply}\n\n${partialReply}\n\n${finalReply}`);
    const request = (await capturedRequests(finalDialogue))[0]!;
    const messages = request.messages as Array<{ role: string; content: string }>;
    const prompt = JSON.parse(messages.findLast(message => message.role === "user")!.content);
    expect(prompt).toMatchObject({ stage: "final", priorCheckpoints: [firstNote, secondNote, staleNote], alreadySaid: [openingReply, partialReply] });
    expect(offers.events.filter(event => event.type === "offer")).toHaveLength(4);
    const stale = offers.events.find(event => event.offerId?.endsWith(`:stale-${token}`))!;
    await release(staleGate);
    await expect.poll(async () => (await localRun(stale.runId!)).status).toBe("completed");
    await expect(assistantReply(page, staleDraft)).toHaveCount(0);
    expect(await backgroundRecordRun(stale.offerId!)).toBeNull();
  } finally {
    await offers.close();
  }
});

test("v2 real offerReply streams prose before parent finish and publishes typed HTML once", async ({ page }) => {
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
      frames: [{ content: safeOffer }, toolFrame("offerReply", { stage: "final", text: offerText }, `v2-offer-${token}`)],
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
    await expect(output).not.toContainText("offerReply");
    await expect(output).toContainText(privateReasoning);
    await expect(output).not.toContainText(rawToolPayload);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(output).not.toBeVisible();
    expect(stopRequests).toEqual([]);

    // offerReply, not the gated parent fallback, starts the public child.
    await expect.poll(() => offers.events.find(event => event.type === "offer")?.offerId).toBeTruthy();
    const offer = offers.events.find(event => event.type === "offer")!;
    expect(offer.runId).toBeTruthy();
    expect(offer.sourceInputId).toBe(accepted.sourceInputId);
    expect(offer.offerId).not.toBe(offer.runId);
    expect(offer.offerId).toBe(`${accepted.workId}:v2-offer-${token}`);
    native = await observeNativeStream(offer.runId!);

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

    // The real background record run is independent of the public stream.
    await expect.poll(() => backgroundRecordRun(offer.offerId!)).toMatchObject({ status: "completed" });
    await expect.poll(() => latestReflectionRun()).toMatchObject({ status: "completed" });
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
    expect(offers.events.filter(event => event.type === "offer" && event.offerId === offer.offerId)).toHaveLength(1);
    expect(offers.events.filter(event => event.type === "offer")).toHaveLength(1);
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


