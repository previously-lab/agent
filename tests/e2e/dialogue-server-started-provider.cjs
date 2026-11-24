/** Mock only DeepSeek for the v2 server-started dialogue E2E. The Next server,
 * Workflow compiler/runtime, durable streams, local files and browser stay real.
 * Rules can hold a whole response or resume immediately after one SSE delta. */
const { access, mkdir, open, readFile, rename, writeFile } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const endpoint = "https://api.deepseek.com/chat/completions";
const fixtureKey = "previously-dialogue-offline-fixture";
const root = resolve(process.env.AFTRBREZ_DIALOGUE_PROVIDER_ROOT ?? "");
const expected = resolve(tmpdir(), "previously-e2e", "home", "dialogue-provider");
if (root !== expected || process.env.DEEPSEEK_API_KEY !== fixtureKey) {
  throw new Error("Server-started dialogue preload requires the isolated E2E fixture environment");
}
const upstream = globalThis.fetch;

async function claimRule(id) {
  try {
    const lock = await open(join(root, `claimed-${id}`), "wx");
    await lock.close();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function waitForRelease(gate, signal, timeoutMs = 90_000) {
  if (!/^[a-z0-9-]+$/i.test(gate)) throw new Error("Invalid dialogue fixture gate");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try { await access(join(root, `release-${gate}`)); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(25, undefined, { signal });
  }
  throw new Error(`Dialogue provider fixture gate expired: ${gate}`);
}

function dataFrame(delta) {
  return delta === "keepalive"
    ? ": fixture keepalive\n\n"
    : `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
}

function response(rule, signal) {
  if (rule.status) {
    return new Response(JSON.stringify({ error: { message: "Synthetic provider failure" } }), {
      status: rule.status, headers: { "content-type": "application/json" },
    });
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const entry of rule.frames) {
          const wrapped = entry && typeof entry === "object" && Object.hasOwn(entry, "frame");
          const frame = wrapped ? entry.frame : entry;
          if (wrapped && entry.gateBefore) await waitForRelease(entry.gateBefore, signal, rule.gateTimeoutMs);
          controller.enqueue(encoder.encode(dataFrame(frame)));
          // No timer: the consumer can render this delta while the provider
          // remains incomplete until the test explicitly releases the gate.
          if (wrapped && entry.gateAfter) await waitForRelease(entry.gateAfter, signal, rule.gateTimeoutMs);
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: rule.finishReason ?? "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// The idle reflection fixture follows the tools actually offered this round.
// Synthetic conversations may require card receipts and a separate profile pass.
function reflectionFixture(request) {
  const names = (request.tools ?? []).map(tool => tool.function.name);
  const call = (name, args, index = 0) => ({ tool_calls: [{
    index, id: `fixture-${name}-${index}`, type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }] });
  const rule = (name, frames) => ({ id: `reflection-${name}`, frames, finishReason: "tool_calls" });
  if (names.length === 1 && ["assessCard", "evolveProfile"].includes(names[0])) {
    const docket = request.messages.find(message => message.role === "user" &&
      typeof message.content === "string" && message.content.includes("Original user messages read from core.md"));
    const line = docket?.content.split("\n").find(line => line.startsWith('[{"sliceId":'));
    const cards = line ? JSON.parse(line) : [];
    if (!cards.length) throw new Error("Offline reflection fixture expected a card in its docket");
    if (names[0] === "evolveProfile") return rule("profile", [call("evolveProfile", {
      sliceId: cards[0].sliceId, focus: "Check the synthetic conversation for profile changes.",
    })]);
    return rule("cards", cards.map((card, index) => call("assessCard", {
      source: { sliceId: card.sliceId, turnId: card.turnId, quote: card.content.trim() },
      decision: "no_further_work", reason: "An offline test question supplied no new personal fact.",
    }, index)));
  }
  if (names.includes("finish") && names.includes("readPreviously")) {
    return rule("profile-finish", [call("finish", { reasoning: "No synthetic profile change.", summary: "" })]);
  }
  return undefined;
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.href !== endpoint) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port !== "3100") {
      throw new Error(`Dialogue E2E blocked fetch outside its fixture: ${url.hostname}:${url.port}`);
    }
    return upstream(input, init);
  }
  const headers = new Headers(init?.headers);
  if (init?.method !== "POST" || headers.get("authorization") !== `Bearer ${fixtureKey}` || typeof init.body !== "string") {
    throw new Error("Dialogue fixture rejected a non-fixture model request");
  }
  const request = JSON.parse(init.body);
  const rules = JSON.parse(await readFile(join(root, "rules.json"), "utf8"));
  const requestId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  await mkdir(join(root, "requests"), { recursive: true });
  let match = rules.some(rule => rule.id === "reflection-idle-v2") ? reflectionFixture(request) : undefined;
  for (const rule of rules) {
    if (match) break;
    if (!/^[a-z0-9-]+$/i.test(rule.id)) throw new Error("Invalid dialogue fixture response ID");
    if (rule.thinking && request.thinking?.type !== rule.thinking) continue;
    if (!(rule.contains ?? []).every((text) => init.body.includes(text))) continue;
    if ((rule.excludes ?? []).some((text) => init.body.includes(text))) continue;
    if (rule.repeat === true || await claimRule(rule.id)) { match = rule; break; }
  }
  // Payloads are synthetic. Captures omit provider headers and credentials;
  // an unmatched request fails instead of falling through to a real provider.
  const capture = join(root, "requests", `${requestId}.json`);
  await writeFile(`${capture}.tmp`, JSON.stringify({ ruleId: match?.id ?? null, request }), "utf8");
  await rename(`${capture}.tmp`, capture);
  if (!match) throw new Error("Unexpected dialogue model request (see isolated fixture requests)");
  if (match.gate) await waitForRelease(match.gate, init.signal, match.gateTimeoutMs);
  return response(match, init.signal);
};
