/** Mock only DeepSeek for the v2 server-started dialogue E2E. The Next server,
 * Workflow compiler/runtime, durable streams, local files and browser stay real.
 * Rules can hold a whole response or resume immediately after one SSE delta. */
const { access, mkdir, open, readFile, writeFile } = require("node:fs/promises");
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
  let match;
  for (const rule of rules) {
    if (!/^[a-z0-9-]+$/i.test(rule.id)) throw new Error("Invalid dialogue fixture response ID");
    if (rule.thinking && request.thinking?.type !== rule.thinking) continue;
    if (!(rule.contains ?? []).every((text) => init.body.includes(text))) continue;
    if ((rule.excludes ?? []).some((text) => init.body.includes(text))) continue;
    if (rule.repeat === true || await claimRule(rule.id)) { match = rule; break; }
  }
  // Payloads are synthetic. Captures omit provider headers and credentials;
  // an unmatched request fails instead of falling through to a real provider.
  await writeFile(join(root, "requests", `${requestId}.json`), JSON.stringify({ ruleId: match?.id ?? null, request }), "utf8");
  if (!match) throw new Error("Unexpected dialogue model request (see isolated fixture requests)");
  if (match.gate) await waitForRelease(match.gate, init.signal, match.gateTimeoutMs);
  return response(match, init.signal);
};
