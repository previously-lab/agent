/**
 * narrateSlice — the mouth's single scene: warm retrospective narration for
 * one time slice (design v0.11 §5).
 *
 * Deliberately NOT a durable workflow: plain AI SDK streamText, ephemeral,
 * read-only. No workflow runtime, no steps, no persistence — an interrupted
 * narration simply restarts.
 *
 * Model resolution mirrors the chat turn exactly (src/app/api/chat/start-turn.ts:170-198)
 * so the mouth speaks with the user's configured voice. The prompt layers
 * follow the product's system-prompt pattern (turn-workflow.ts:675-715),
 * stable-first for prompt caching, event context last:
 *
 *   L0 identityPrompt — bundled CHARTER + "who you're assisting" (stable)
 *   L1 the folded user model (people/user/index.md, dual-root read)
 *   L2 companion playbook (memory/agent-playbooks/companion.md, default on
 *     any read failure)
 *   L3 event context — now (user-local), locale, target sliceId (varies)
 */

import { streamText } from "@/lib/deepseek/generate";
import { isStepCount } from "@/lib/deepseek/tools";

import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import {
  buildAgentIdentityPrompt,
  parseIdentityFromPreviously,
} from "@/lib/identity";
import { readUserModel } from "@/lib/evolution/store";
import { formatLocalTime } from "@/lib/turn-priming";
import {
  buildCompanionTools,
  readMemoryFile,
  type CompanionToolContext,
} from "./tools";
import {
  COMPANION_PLAYBOOK_PATH,
  DEFAULT_COMPANION_PLAYBOOK,
} from "./default-playbook";

export interface NarrateArgs {
  /** Strict YYYY-MM-DD-HHMM slice id — validated by the route before this. */
  sliceId: string;
  /** UI locale; narration language follows it (only zh/en supported). */
  locale?: "zh" | "en";
  /** Client-reported IANA timezone; anchors the event-context clock. */
  timezone?: string;
}

export interface NarrateOptions {
  /**
   * Overall wall-clock bound for the provider stream. A hung LLM provider
   * (upstream queue timeouts) is cut at this bound and the stream terminates
   * with the failure marker instead of hanging for many minutes. Injectable
   * so tests can use a short timeout.
   */
  streamTimeoutMs?: number;
}

/** Overall abort bound — hung provider cut off well inside platform walls. */
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

/**
 * Terminal marker appended to the text stream when a narration is cut
 * (provider error or overall timeout). Locale-honored. A stream that ends
 * WITHOUT this marker is a complete narration; the marker is the in-band,
 * client-distinguishable failure signal (see route.ts contract).
 */
export function streamFailureMarker(locale: "zh" | "en"): string {
  return locale === "zh"
    ? "\n\n[ Previously 暂时走神了，稍后再试。 ]"
    : "\n\n[ Previously got distracted — please try again later. ]";
}

/** Injection cap for the live companion playbook (the companion's own
 *  prompt budget — unrelated to the self/ SOPs, which load in full). */
const PLAYBOOK_MAX_CHARS = 2000;

function capPlaybook(content: string): string {
  if (content.length <= PLAYBOOK_MAX_CHARS) return content;
  return (
    content.slice(0, PLAYBOOK_MAX_CHARS) +
    `\n\n[…playbook truncated at ${PLAYBOOK_MAX_CHARS} chars]`
  );
}

/** L1 — the folded user model (people/user/index.md), through the same
 *  dual-root read the chat turn uses (readUserModel: new root first, the
 *  legacy card + direction composed on a miss, §D.1). A missing/unreadable
 *  model degrades to no card layer — it must not silence the mouth. */
async function readLiveCard(): Promise<string> {
  try {
    return (await readUserModel())?.full ?? "";
  } catch {
    return "";
  }
}

/** L2 — the companion playbook: live file when readable, built-in default on
 *  ANY failure (missing file, unreadable source — the mouth always has a voice). */
async function readPlaybookLayer(ctx: CompanionToolContext): Promise<string> {
  try {
    const raw = await readMemoryFile(ctx, COMPANION_PLAYBOOK_PATH);
    if (raw.trim()) return capPlaybook(raw.trim());
  } catch {
    // fall through to the default
  }
  return DEFAULT_COMPANION_PLAYBOOK;
}

/** L3 — event context. Everything that varies per request lives here, LAST,
 *  so the L0-L2 prefix stays byte-stable and provider prompt caching works. */
function buildEventBlock(opts: {
  sliceId: string;
  locale: "zh" | "en";
  timezone: string;
  nowIso: string;
}): string {
  const t = formatLocalTime(opts.nowIso, opts.timezone);
  const offset = t.offset ? `, ${t.offset}` : "";
  return [
    "## Event context (companion narration)",
    "",
    "- event: narrate",
    `- now (user's local): ${t.local} (${t.zone}${offset}) · UTC ${t.utc}`,
    `- answer language: ${opts.locale}`,
    `- target slice: ${opts.sliceId} — the time slice the user is re-watching right now`,
  ].join("\n");
}

/**
 * Run one narration and return its streaming response. The bridge brain
 * resolves here to 501 (JSON) — the bridge CLI returns plain text and cannot
 * emit the structured tool calls the read-only tools need (agent.ts:126-134).
 */
export async function narrateSlice(
  args: NarrateArgs,
  opts: NarrateOptions = {},
): Promise<Response> {
  // Same data-source resolution as the chat turn (start-turn.ts:197-198).
  const locale: "zh" | "en" = args.locale === "zh" ? "zh" : "en";
  const timezone = args.timezone ?? "UTC";
  const { owner, repo } = getRepoConfig();
  const dataSource = resolveDataSource();
  const toolCtx: CompanionToolContext = {
    owner,
    repo,
    useGithub: dataSource === "github",
    useDemo: dataSource === "demo",
    timezone,
    locale,
  };

  // ── System prompt layers (stable first, event context last) ────────────
  const card = await readLiveCard();
  const playbook = await readPlaybookLayer(toolCtx);

  // L0 — charter + who you're assisting; the profile is parsed from the same
  // user-model read the chat turn parses it from (steps.ts:1038).
  const profile = parseIdentityFromPreviously(card);
  const identityPrompt = buildAgentIdentityPrompt(profile);

  const eventBlock = buildEventBlock({
    sliceId: args.sliceId,
    locale,
    timezone,
    nowIso: new Date().toISOString(),
  });

  const system = [
    identityPrompt,
    card
      ? `## What I know about the user — the living card\n\n${card}`
      : "",
    `## Companion playbook\n\n${playbook}`,
    eventBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  const userPrompt = [
    `The user is sitting with you, re-watching the time slice ${args.sliceId} together.`,
    "Narrate that slice to them, following your companion playbook: first use your",
    "read-only tools to actually read the slice (and its summary or month",
    "neighbors when they add context), then speak — warm, retrospective, honest",
    "about gaps.",
    `Answer in ${locale === "zh" ? "Chinese (中文)" : "English"}.`,
  ].join(" ");

  // Ephemeral read-only narration uses the fixed companion profile.
  const streamTimeoutMs = opts.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const abortSignal = AbortSignal.timeout(streamTimeoutMs);
  const result = streamText({
    role: "companion",
    system,
    prompt: userPrompt,
    tools: buildCompanionTools(toolCtx),
    thinking: true,
    stopWhen: isStepCount(6),
    abortSignal,
    onError: ({ error }) => {
      console.error("[Companion] narration stream error:", error);
    },
  });

  // NOT result.toTextStreamResponse(): its text stream silently drops the
  // SDK's error/abort parts, so a cut narration would look like a clean
  // close — and the client reads clean-close as "complete narration".
  // Forward fullStream manually instead: text deltas become the prose, and
  // an error/abort part (or the overall timeout racing ahead of a hung
  // provider) appends the terminal marker and closes the stream. Either way
  // the response terminates in bounded time; the marker is what lets the
  // client tell "cut" apart from "complete" (route.ts contract).
  const marker = streamFailureMarker(locale);
  const encoder = new TextEncoder();
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const abortRace = new Promise<never>((_, reject) => {
    abortSignal.addEventListener(
      "abort",
      () =>
        reject(
          abortSignal.reason ?? new Error("companion narration timeout"),
        ),
      { once: true },
    );
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value: part } = await Promise.race([
            iterator.next(),
            abortRace,
          ]);
          if (done) break;
          if (part.type === "text-delta") {
            controller.enqueue(encoder.encode(part.text));
          } else if (part.type === "error") {
            throw part.error;
          } else if (part.type === "abort") {
            throw new Error(String(part.error ?? "aborted"));
          }
          // finish / step / tool parts: narration prose is text-delta only.
        }
        controller.close();
      } catch (e) {
        console.error(
          "[Companion] narration terminated abnormally (provider error/timeout):",
          e,
        );
        try {
          controller.enqueue(encoder.encode(marker));
        } catch {
          // client already gone
        }
        try {
          controller.close();
        } catch {
          // client already gone
        }
      }
    },
    async cancel() {
      // Client disconnected — stop pulling the source stream.
      await iterator.return?.();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
