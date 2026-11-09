import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { E2E_BASE_URL, E2E_DIALOGUE_PROVIDER_ROOT, E2E_MEMORY_ROOT } from "./env";
import { readChatEvents } from "@/lib/chat/client-stream";
import type { DialogueArtifactRef } from "@/lib/chat/dialogue-contract";

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

function expressionRule(token: string, attempt: string, _resultId: string, text: string, _blockIds: string[] = [], gate?: string, _omitDecisions = false): Rule {
  if (gate) gates.add(gate);
  return {
    id: `expression-${token}-${attempt}`,
    contains: ["You are Previously's public wording layer", token],
    ...(gate ? { gate } : {}),
    frames: [{ content: text }],
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
  await acceptThroughClient(page, userText, persona);
  const firstExpression = expressionRule(token, "first", "", publicText);
  await writeRules([...first, firstExpression]);
  await release(firstGate);

  const firstPublication = page.locator("[data-public-utterance]").last();
  await expect(firstPublication).toContainText(publicText);
  await expect(firstPublication).not.toContainText(privateText);

  const retry = [analyzerRule(token, "retry"), thinkingRule(token, "retry", `${privateText}_RETRY`, secondGate)];
  const retryExpression = expressionRule(token, "retry", "", regeneratedText);
  await writeRules([...first, firstExpression, ...retry, retryExpression]);
  await page.locator("[data-dialogue-work-turn]").filter({ hasText: publicText })
    .getByRole("button", { name: "Regenerate", exact: true }).click();
  await release(secondGate);

  await expect(page.locator("[data-public-utterance]").filter({ hasText: regeneratedText })).toBeVisible();
  await expect.poll(() => recordText().includes(regeneratedText)).toBe(true);
  const core = recordText();
  expect(core.split(userText)).toHaveLength(2);
  expect(core).not.toContain(privateText);
  expect(core).toContain(publicText);
  expect(core).toContain(regeneratedText);
  expect(fs.existsSync(path.join(E2E_MEMORY_ROOT, ".git"))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath(`real-workflow-regenerate-${testInfo.project.name}.png`), animations: "disabled" });
});

test("parallel thinking lets a banana correction retire an unpublished apple reply", async ({ page }) => {
  const token = randomUUID();
  const persona = `e2e-${token}`;
  const appleText = `我想吃苹果 ${token}-apple`;
  const bananaText = `算了，我想吃香蕉 ${token}-banana`;
  const appleGate = `apple-thinking-${token}`;
  const bananaGate = `banana-thinking-${token}`;
  const appleExpressionId = `expression-apple-suppressed-${token}`;
  const rules: Rule[] = [
    idleReflectionRule(),
    analyzerRule(`${token}-apple`, "thinking"),
    analyzerRule(`${token}-banana`, "thinking"),
    thinkingRule(`${token}-apple`, "thinking", `APPLE_PRIVATE_${token}`, appleGate),
    thinkingRule(`${token}-banana`, "thinking", `BANANA_PRIVATE_${token}`, bananaGate),
  ];
  await writeRules(rules);
  await acceptThroughClient(page, appleText, persona);
  await acceptThroughClient(page, bananaText, persona);
  await writeRules([...rules, {
    id: appleExpressionId,
    contains: ["You are Previously's public wording layer", appleText, bananaText],
    frames: [{ content: "" }],
  }]);
  await release(appleGate);
  await expect.poll(async () => (await capturedRequests(appleExpressionId)).length).toBe(1);
  await expect(page.locator("[data-public-utterance]").filter({ hasText: `APPLE_PRIVATE_${token}` })).toHaveCount(0);

  const publicText = `只说香蕉_${token}`;
  const bananaExpression = expressionRule(`${token}-banana`, "thinking", "", publicText);
  await writeRules([...rules, {
    id: appleExpressionId,
    contains: ["You are Previously's public wording layer", appleText, bananaText],
    frames: [{ content: "" }],
  }, bananaExpression]);
  await release(bananaGate);
  await expect(page.locator("[data-public-utterance]").filter({ hasText: publicText })).toBeVisible();
  await expect.poll(() => recordText().includes(publicText)).toBe(true);
  expect(recordText()).not.toContain(`APPLE_PRIVATE_${token}`);
  await page.reload();
  const savedBanana = page.locator("[data-public-utterance]").filter({ hasText: publicText });
  await expect(savedBanana).toBeVisible();
  await expect(page.locator("[data-public-utterance]").filter({ hasText: `APPLE_PRIVATE_${token}` })).toHaveCount(0);
});

async function thoughtRunId(page: Page, workId: string, persona: string): Promise<string> {
  const runId = await page.evaluate(({ workId, persona }) => {
    const key = `previously:dialogue:parents:v2:${encodeURIComponent(persona)}`;
    const records = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
      workId?: string; parentRunId?: string; userMessage?: { id?: string };
    }>;
    return records.find(record => record.workId === workId || record.userMessage?.id === workId)?.parentRunId;
  }, { workId, persona });
  expect(runId).toBeTruthy();
  return runId!;
}

async function publicRunId(page: Page, workId: string, persona: string): Promise<string> {
  const runId = await page.evaluate(({ workId, persona }) => {
    const key = `previously:dialogue:parents:v2:${encodeURIComponent(persona)}`;
    const records = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
      workId?: string; dialogueRunId?: string; offers?: Array<{ runId?: string }>; userMessage?: { id?: string };
    }>;
    const record = records.find(candidate => candidate.workId === workId || candidate.userMessage?.id === workId);
    return record?.dialogueRunId ?? record?.offers?.at(-1)?.runId;
  }, { workId, persona });
  expect(runId).toBeTruthy();
  return runId!;
}

async function probeWorkStreamIdentity(page: Page, workId: string, persona: string) {
  const runId = await thoughtRunId(page, workId, persona);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const query = new URLSearchParams({ workId, startIndex: "0" });
    const response = await fetch(`${E2E_BASE_URL}/api/chat/${encodeURIComponent(runId)}/thoughts?${query}`, {
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
  await expect(page.locator(`[data-dialogue-input="${inputId}"]`)).toHaveCount(1);

  const disclosure = page.locator("[data-dialogue-work-caption]").last();
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const output = page.locator("[data-dialogue-work]").last().locator("[data-dialogue-thought-content]");
  await expect(output).toContainText(firstText);
  await probeWorkStreamIdentity(page, inputId, persona);
  await expect(output).toContainText("Check time");

  await expect(output).toContainText(privateReasoning);
  await expect(output).not.toContainText(rawToolPayload);
  await page.screenshot({ path: testInfo.outputPath(`real-work-preview-${testInfo.project.name}.png`), animations: "disabled" });

  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(output).not.toBeVisible();
  expect(stopRequests).toEqual([]);
  await expect(disclosure).not.toHaveAttribute("title", "Completed");

  await page.reload();
  await expect(accepted).toContainText(userText);
  await expect(page.locator(`[data-dialogue-input="${inputId}"]`)).toHaveCount(1);
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(output).toContainText(firstText);
  await probeWorkStreamIdentity(page, inputId, persona);
  await expect(output).toContainText("Check time");
  expect(stopRequests).toEqual([]);

  const publicText = `PUBLIC_PREVIEW_${token}`;
  const expression = expressionRule(token, "preview", `${inputId}:1`, publicText);
  await writeRules([...first, expression]);
  await release(finalGate);
  await expect(page.locator("[data-public-utterance]").last()).toContainText(publicText);
  const runId = await thoughtRunId(page, inputId, persona);
  const replay = await page.request.get(`/api/chat/${encodeURIComponent(runId)}/thoughts?workId=${encodeURIComponent(inputId)}&startIndex=0`);
  expect(replay.ok()).toBe(true);
  const safeBody = await replay.text();
  expect(safeBody).toContain(firstText);
  expect(safeBody).toContain(secondText);
  expect(safeBody).toContain("currentTime");
  expect(safeBody.split(firstText)).toHaveLength(2);
  expect(safeBody.split(secondText)).toHaveLength(2);
  expect(safeBody).toContain(privateReasoning);
  expect(safeBody).not.toContain(rawToolPayload);
  expect(stopRequests).toEqual([]);
});
test("real artifact exact bytes and sandbox recovery", async ({ page }, testInfo) => {
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
  const expression = expressionRule(token, "artifact", "", publicText, [], expressionGate, true);
  await writeRules([...first, expression]);
  await release(thinkingGate);
  await expect.poll(async () => (await capturedRequests(expression.id)).length).toBe(1);
  await release(expressionGate);

  const publication = page.locator("[data-public-utterance]").filter({ hasText: publicText });
  await expect(publication).toBeVisible();
  const artifactSlot = publication.locator("[data-artifact-ref]");
  await expect(artifactSlot).toHaveAttribute("data-artifact-state", "ready");
  const artifactId = await artifactSlot.getAttribute("data-artifact-ref");
  expect(artifactId).toBeTruthy();
  const runId = await publicRunId(page, inputId, persona);
  const artifactUrl = `/api/chat/${encodeURIComponent(runId)}/artifacts/${artifactId}`;
  const afterPublication = await page.request.get(artifactUrl);
  expect(afterPublication.ok()).toBe(true);
  const stored = await afterPublication.json() as { artifact: DialogueArtifactRef; body: string };
  const expected = stored.artifact;
  expect(expected.sha256).toBe(createHash("sha256").update(rawHtml, "utf8").digest("hex"));
  expect(expected.byteSize).toBe(Buffer.byteLength(rawHtml, "utf8"));
  expect(stored.body).toBe(rawHtml);

  const expressionPayload = JSON.stringify(await capturedRequests(expression.id));
  expect(expressionPayload).toContain(expected.artifactId);
  expect(expressionPayload).not.toContain("window.__PRIVATE_NATIVE_BYTES__");
  expect(expressionPayload).not.toContain("<script>");
  expect(expressionPayload).not.toContain("base64,");

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
