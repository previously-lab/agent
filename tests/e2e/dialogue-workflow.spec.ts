import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { E2E_BASE_URL, E2E_DIALOGUE_PROVIDER_ROOT, E2E_MEMORY_ROOT } from "./env";
import { readChatEvents } from "@/lib/chat/client-stream";
import type { DialogueArtifactRef, DialoguePage, PublicUtterance } from "@/lib/chat/dialogue-contract";

type Frame = Record<string, unknown> | "keepalive";
type Rule = {
  id: string;
  contains?: string[];
  excludes?: string[];
  repeat?: boolean;
  gate?: string;
  gateTimeoutMs?: number;
  finishReason?: string;
  frames: Frame[];
};

const gates = new Set<string>();
const rulesPath = path.join(E2E_DIALOGUE_PROVIDER_ROOT, "rules.json");
const requestsPath = path.join(E2E_DIALOGUE_PROVIDER_ROOT, "requests");

async function writeRules(rules: Rule[]): Promise<void> {
  await fs.promises.mkdir(E2E_DIALOGUE_PROVIDER_ROOT, { recursive: true });
  const temporary = path.join(E2E_DIALOGUE_PROVIDER_ROOT, `rules-${process.pid}-${randomUUID()}.json`);
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

function analyzerRule(token: string, attempt: string): Rule {
  return {
    id: `analyzer-${token}-${attempt}`,
    contains: ["analyzeOutput", token],
    finishReason: "tool_calls",
    frames: [toolFrame("analyzeOutput", {
      intent: { type: "chat", reason: "Offline workflow fixture" },
      memory_worthy: false,
      emotional_signal: { intensity: "none", register: "neutral", note: "" },
    }, `analyzer-call-${token}-${attempt}`)],
  };
}

function thinkingRule(token: string, attempt: string, workText: string, gate: string): Rule {
  gates.add(gate);
  return { id: `thinking-${token}-${attempt}`, contains: ["finishThinking", token], gate, frames: [{ content: workText }] };
}

function expressionRule(token: string, attempt: string, resultId: string, text: string, blockIds: string[] = [], gate?: string, omitDecisions = false): Rule {
  if (gate) gates.add(gate);
  return {
    id: `expression-${token}-${attempt}`,
    contains: ["You organize the user-facing manuscript", token],
    ...(gate ? { gate } : {}),
    frames: [{ content: JSON.stringify({
      sends: [{ text, sources: [{ resultId, productRevision: 1, claimId: "claim-1", mode: "finding" }], blockIds }],
      ...(omitDecisions ? {} : { decisions: [] }),
    }) }],
  };
}

function idleReflectionRule(): Rule {
  return {
    id: "reflection-idle",
    contains: ["hqReport"],
    repeat: true,
    finishReason: "tool_calls",
    frames: [toolFrame("hqReport", { actions: [], note: "No writes in the offline reflection fixture." }, "reflection-idle-call")],
  };
}

async function readDialogue(request: APIRequestContext, persona: string): Promise<DialoguePage> {
  const response = await request.get(`/api/chat/dialogue?persona=${encodeURIComponent(persona)}&after=0`);
  expect(response.ok()).toBe(true);
  return await response.json() as DialoguePage;
}

async function publications(request: APIRequestContext, persona: string): Promise<PublicUtterance[]> {
  return (await readDialogue(request, persona)).events.flatMap(event => event.type === "manuscript.append" ? [event.utterance] : []);
}

async function acceptThroughClient(page: Page, text: string, persona: string): Promise<string> {
  await page.goto(`/en/app?persona=${encodeURIComponent(persona)}`);
  const editor = page.locator("[data-manuscript-input]");
  await expect(editor).toBeEditable();
  await editor.fill(text);
  await editor.press("Enter");
  const accepted = page.locator("[data-dialogue-input]").last();
  await expect(accepted).toBeVisible();
  const inputId = await accepted.getAttribute("data-dialogue-input");
  expect(inputId).toBeTruthy();
  return inputId!;
}

function recordText(): string {
  const root = path.join(E2E_MEMORY_ROOT, "records");
  if (!fs.existsSync(root)) return "";
  const bodies: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "core.md") bodies.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return bodies.join("\n");
}

async function capturedRequests(ruleId: string): Promise<Array<Record<string, unknown>>> {
  const names = await fs.promises.readdir(requestsPath).catch(() => [] as string[]);
  const found: Array<Record<string, unknown>> = [];
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const entry = JSON.parse(await fs.promises.readFile(path.join(requestsPath, name), "utf8")) as { ruleId?: string; request?: Record<string, unknown> };
    if (entry.ruleId === ruleId && entry.request) found.push(entry.request);
  }
  return found;
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  for (const gate of gates) await fs.promises.writeFile(path.join(E2E_DIALOGUE_PROVIDER_ROOT, `release-${gate}`), "", "utf8").catch(() => {});
  gates.clear();
});

test("real accept, thinking, expression, records and regenerate keep one original input", async ({ page }, testInfo) => {
  const token = randomUUID();
  const persona = `e2e-${token}`;
  const userText = `Offline real workflow ${token}`;
  const privateText = `PRIVATE_THINKING_${token}`;
  const publicText = `PUBLIC_EXPRESSION_${token}`;
  const regeneratedText = `PUBLIC_REGENERATED_${token}`;
  const firstGate = `first-${token}`;
  const secondGate = `second-${token}`;
  const first = [idleReflectionRule(), analyzerRule(token, "first"), thinkingRule(token, "first", privateText, firstGate)];
  await writeRules(first);
  const inputId = await acceptThroughClient(page, userText, persona);
  const firstExpression = expressionRule(token, "first", `${inputId}:1`, publicText);
  await writeRules([...first, firstExpression]);
  await release(firstGate);

  const firstPublication = page.locator("[data-public-utterance]").last();
  await expect(firstPublication).toContainText(publicText);
  await expect(firstPublication).not.toContainText(privateText);
  await expect.poll(async () => (await publications(page.request, persona)).length).toBe(1);

  const retry = [analyzerRule(token, "retry"), thinkingRule(token, "retry", `${privateText}_RETRY`, secondGate)];
  await writeRules([...first, firstExpression, ...retry]);
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  let retryWorkId: string | undefined;
  await expect.poll(async () => {
    const events = (await readDialogue(page.request, persona)).events;
    retryWorkId = events.flatMap(event => event.type === "work.status" && event.work.inputId === inputId && event.work.workId !== inputId
      ? [event.work.workId] : []).at(-1);
    return retryWorkId;
  }).toBeTruthy();
  const retryExpression = expressionRule(token, "retry", `${retryWorkId!}:1`, regeneratedText);
  await writeRules([...first, firstExpression, ...retry, retryExpression]);
  await release(secondGate);

  await expect.poll(async () => (await publications(page.request, persona)).length).toBe(2);
  await expect(page.locator("[data-public-utterance]").last()).toContainText(regeneratedText);
  const data = await readDialogue(page.request, persona);
  expect(data.events.filter(event => event.type === "input.accepted")).toHaveLength(1);
  const published = await publications(page.request, persona);
  expect(published.map(item => item.inputIds)).toEqual([[inputId], [inputId]]);
  await expect.poll(() => recordText().includes(regeneratedText)).toBe(true);
  const core = recordText();
  expect(core.split(userText)).toHaveLength(2);
  expect(core).not.toContain(privateText);
  expect(core).toContain(publicText);
  expect(core).toContain(regeneratedText);
  expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, ".git"))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath(`real-workflow-regenerate-${testInfo.project.name}.png`), animations: "disabled" });
});

async function probeWorkStreamIdentity(page: Page, workId: string, persona: string) {
  const data = await readDialogue(page.request, persona);
  const runId = data.events.flatMap(event => event.type === "work.status" && event.work.workId === workId
    ? [event.work.runId] : []).at(-1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const query = new URLSearchParams({ persona, startIndex: "0", ...(runId ? { runId } : {}) });
    const response = await fetch(`${E2E_BASE_URL}/api/chat/dialogue/work/${encodeURIComponent(workId)}/stream?${query}`, {
      headers: { Accept: "text/event-stream", "Accept-Encoding": "identity" }, signal: controller.signal,
    });
    const headers = response.headers;
    console.log(`[WorkPreviewHttp] ${JSON.stringify({ time: Date.now(), type: "node.identity.headers",
      contentEncoding: headers.get("content-encoding") ?? "none", cacheControl: headers.get("cache-control") ?? "none" })}`);
    if (!response.ok || !response.body) return;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        console.log(`[WorkPreviewHttp] ${JSON.stringify({ time: Date.now(), type: "node.network.chunk", cursor: -1 })}`);
        stream.enqueue(chunk);
      },
    }));
    for await (const event of readChatEvents(body, controller.signal)) {
      const cursor = "cursor" in event && typeof event.cursor === "number" ? event.cursor : -1;
      console.log(`[WorkPreviewHttp] ${JSON.stringify({ time: Date.now(), type: `node.recv.${event.type}`, cursor })}`);
      if (event.type === "tool") break;
    }
  } catch {
    console.log(`[WorkPreviewHttp] ${JSON.stringify({ time: Date.now(), type: "node.stop", cursor: -1 })}`);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

test("real acceptance feedback and safe work preview survive close and replay", async ({ page }, testInfo) => {
  page.on("console", message => {
    if (message.text().startsWith("[WorkPreviewBrowser]")) console.log(message.text());
  });
  page.on("response", response => {
    if (!new URL(response.url()).pathname.endsWith("/stream")) return;
    console.log(`[WorkPreviewHttp] ${JSON.stringify({ time: Date.now(), type: "browser.headers",
      contentEncoding: response.headers()["content-encoding"] ?? "none", cacheControl: response.headers()["cache-control"] ?? "none" })}`);
  });
  const token = randomUUID();
  const persona = `e2e-${token}`;
  const userText = `Offline preview ${token}`;
  const firstText = `SAFE_FIRST_${token}`;
  const secondText = `SAFE_SECOND_${token}`;
  const privateReasoning = `PRIVATE_REASONING_${token}`;
  const rawToolPayload = `RAW_TOOL_PAYLOAD_${token}`;
  const finalGate = `preview-final-${token}`;
  const stopRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/chat/dialogue/stop") stopRequests.push(request.url());
  });
  gates.add(finalGate);
  const first: Rule[] = [
    idleReflectionRule(),
    analyzerRule(token, "preview"),
    {
      id: `thinking-${token}-preview-tool`, contains: ["finishThinking", token], finishReason: "tool_calls",
      frames: [
        { reasoning_content: privateReasoning },
        { content: firstText },
        toolFrame("currentTime", { secret: rawToolPayload }, `preview-time-${token}`),
      ],
    },
    {
      id: `thinking-${token}-preview-final`, contains: ["finishThinking", token], gate: finalGate, gateTimeoutMs: 90_000,
      frames: [{ content: secondText }],
    },
  ];
  await writeRules(first);
  const inputId = await acceptThroughClient(page, userText, persona);
  const accepted = page.locator(`[data-dialogue-input="${inputId}"]`);
  await expect(accepted).toContainText(userText);
  expect((await readDialogue(page.request, persona)).events.filter(event => event.type === "input.accepted")).toHaveLength(1);

  const disclosure = page.locator(".dialogue-work-disclosure");
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const output = page.locator(`[data-dialogue-work="${inputId}"] .dialogue-work-output`);
  await expect(output.locator("pre")).toHaveText(firstText);
  await probeWorkStreamIdentity(page, inputId, persona);
  await expect(output.locator(".dialogue-work-tool-name")).toHaveText("currentTime");

  await expect(output).not.toContainText(privateReasoning);
  await expect(output).not.toContainText(rawToolPayload);
  await page.screenshot({ path: testInfo.outputPath(`real-work-preview-${testInfo.project.name}.png`), animations: "disabled" });

  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(output).toHaveCount(0);
  expect(stopRequests).toEqual([]);
  const held = await readDialogue(page.request, persona);
  expect(held.events.some(event => event.type === "work.status" && event.work.workId === inputId && event.work.status === "running")).toBe(true);

  await page.reload();
  await expect(accepted).toContainText(userText);
  await expect(page.locator(`[data-dialogue-input="${inputId}"]`)).toHaveCount(1);
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(output.locator("pre")).toHaveText(firstText);
  await probeWorkStreamIdentity(page, inputId, persona);
  await expect(output.locator(".dialogue-work-tool-name")).toHaveText("currentTime");
  expect(stopRequests).toEqual([]);

  const publicText = `PUBLIC_PREVIEW_${token}`;
  const expression = expressionRule(token, "preview", `${inputId}:1`, publicText);
  await writeRules([...first, expression]);
  await release(finalGate);
  await expect(page.locator("[data-public-utterance]").last()).toContainText(publicText);
  const final = await readDialogue(page.request, persona);
  const work = final.events.flatMap(event => event.type === "work.status" && event.work.workId === inputId ? [event.work] : []).at(-1);
  expect(work?.runId).toBeTruthy();
  const replay = await page.request.get(`/api/chat/dialogue/work/${encodeURIComponent(inputId)}/stream?persona=${encodeURIComponent(persona)}&runId=${encodeURIComponent(work!.runId!)}&startIndex=0`);
  expect(replay.ok()).toBe(true);
  const safeBody = await replay.text();
  expect(safeBody).toContain(firstText);
  expect(safeBody).toContain(secondText);
  expect(safeBody).toContain("currentTime");
  expect(safeBody.split(firstText)).toHaveLength(2);
  expect(safeBody.split(secondText)).toHaveLength(2);
  expect(safeBody).not.toContain(privateReasoning);
  expect(safeBody).not.toContain(rawToolPayload);
  expect(stopRequests).toEqual([]);
});
test("real artifact authorization, exact bytes, omitted decisions and sandbox recovery", async ({ page }, testInfo) => {
  const token = randomUUID();
  const persona = `e2e-${token}`;
  const userText = `Offline real artifact ${token}`;
  const rawHtml = `<!doctype html>\n<html><body><button id="increment">Count: 0</button><script>const b=document.querySelector('#increment');let n=previously.getState()?.count??0;b.textContent='Count: '+n;b.onclick=()=>{n++;previously.setState({count:n});b.textContent='Count: '+n};window.__PRIVATE_NATIVE_BYTES__=true;</script></body></html>\n`;
  const workText = `Private native artifact ${token}\n\n\`\`\`html live\n${rawHtml}\`\`\`\n`;
  const publicText = `Use the original widget ${token}`;
  const thinkingGate = `artifact-thinking-${token}`;
  const expressionGate = `artifact-expression-${token}`;
  const first = [idleReflectionRule(), analyzerRule(token, "artifact"), thinkingRule(token, "artifact", workText, thinkingGate)];
  await writeRules(first);
  const inputId = await acceptThroughClient(page, userText, persona);
  const blockId = `${inputId}:artifact-1`;
  const expression = expressionRule(token, "artifact", `${inputId}:1`, publicText, [blockId], expressionGate, true);
  await writeRules([...first, expression]);
  await release(thinkingGate);

  let artifact: DialogueArtifactRef | undefined;
  await expect.poll(async () => {
    const events = (await readDialogue(page.request, persona)).events;
    artifact = events.flatMap(event => event.type === "work.status" ? (event.work.artifacts ?? []) : []).at(-1);
    return artifact?.artifactId;
  }).toBeTruthy();
  const expected = artifact!;
  expect(expected.sha256).toBe(createHash("sha256").update(rawHtml, "utf8").digest("hex"));
  expect(expected.byteSize).toBe(Buffer.byteLength(rawHtml, "utf8"));
  const artifactUrl = `/api/chat/dialogue/artifacts/${expected.artifactId}?persona=${encodeURIComponent(persona)}`;
  const beforePublication = await page.request.get(artifactUrl);
  expect(beforePublication.status()).toBe(404);
  await release(expressionGate);

  await expect.poll(async () => (await publications(page.request, persona)).length).toBe(1);
  const utterance = (await publications(page.request, persona))[0]!;
  expect(utterance.blocks).toContainEqual({ kind: "artifact_ref", blockId, artifact: expected });
  const afterPublication = await page.request.get(artifactUrl);
  expect(afterPublication.ok()).toBe(true);
  expect(await afterPublication.json()).toEqual({ artifact: expected, body: rawHtml });

  const expressionPayload = JSON.stringify(await capturedRequests(expression.id));
  expect(expressionPayload).toContain(expected.artifactId);
  expect(expressionPayload).toContain(blockId);
  expect(expressionPayload).not.toContain("window.__PRIVATE_NATIVE_BYTES__");
  expect(expressionPayload).not.toContain("<script>");
  expect(expressionPayload).not.toContain("base64,");

  const publication = page.locator("[data-public-utterance]");
  await expect(publication.locator(`[data-artifact-ref="${expected.artifactId}"]`)).toHaveAttribute("data-artifact-state", "ready");
  const widget = publication.locator("[data-native-frame]").contentFrame().frameLocator("[data-native-content]");
  await widget.getByRole("button", { name: "Count: 0" }).click();
  await expect(widget.getByRole("button", { name: "Count: 1" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("previously:native-replies:v1") ?? '{"entries":[]}') as { entries: { json: string }[] };
    return store.entries.some(({ json }) => {
      const state = JSON.parse(json) as { custom?: { count?: number } };
      return state.custom?.count === 1;
    });
  })).toBe(true);
  await page.reload();
  await expect(publication).toBeVisible();
  await expect(widget.getByRole("button", { name: "Count: 1" })).toBeVisible();
  expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, ".git"))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath(`real-artifact-${testInfo.project.name}.png`), animations: "disabled" });
});
