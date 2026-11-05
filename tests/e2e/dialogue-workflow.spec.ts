import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { E2E_DIALOGUE_PROVIDER_ROOT, E2E_MEMORY_ROOT } from "./env";
import type { DialogueArtifactRef, DialoguePage, PublicUtterance } from "@/lib/chat/dialogue-contract";

type Frame = Record<string, unknown> | "keepalive";
type Rule = {
  id: string;
  contains?: string[];
  excludes?: string[];
  repeat?: boolean;
  gate?: string;
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

function expressionRule(token: string, attempt: string, resultId: string, text: string, blockIds: string[] = [], gate?: string): Rule {
  if (gate) gates.add(gate);
  return {
    id: `expression-${token}-${attempt}`,
    contains: ["You organize the user-facing manuscript", token],
    ...(gate ? { gate } : {}),
    frames: [{ content: JSON.stringify({
      sends: [{ text, sources: [{ resultId, productRevision: 1, claimId: "claim-1", mode: "finding" }], blockIds }],
      decisions: [],
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

test("real artifact authorization, exact bytes, expression reference and sandbox recovery", async ({ page }, testInfo) => {
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
  const expression = expressionRule(token, "artifact", `${inputId}:1`, publicText, [blockId], expressionGate);
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
