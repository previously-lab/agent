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
 *   L1 the live folded user model (people/user/index.md only)
 *   L2 companion playbook (memory/agent-playbooks/companion.md, default on
 *     any read failure)
 *   L3 event context — now (user-local), locale, target sliceId (varies)
 */

import { streamText } from "@/lib/deepseek/generate";

import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import {
  buildAgentIdentityPrompt,
  parseIdentityFromPreviously,
} from "@/lib/identity";
import { readUserModel } from "@/lib/evolution/store";
import { buildDirectionBlock } from "@/lib/evolution/direction-agent";
import { projectLivePreviously } from "@/lib/episodic/previously-format";
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
  signal?: AbortSignal;
}

/**
 * Terminal marker appended to the text stream when a narration is cut
 * (provider error or cancellation). Locale-honored. A stream that ends
 * WITHOUT this marker is a complete narration; the marker is the in-band,
 * client-distinguishable failure signal (see route.ts contract).
 */
export function streamFailureMarker(locale: "zh" | "en"): string {
  return locale === "zh"
    ? "\n\n[ Previously 暂时走神了，稍后再试。 ]"
    : "\n\n[ Previously got distracted — please try again later. ]";
}

/** L1 — the only live folded user model (people/user/index.md). Historical
 *  card/direction files are not fallbacks. An unavailable model is logged and
 *  degrades to no card layer — it must not silence the mouth. */
async function readLiveModel() {
  try {
    return await readUserModel(undefined, { fresh: false });
  } catch (error) {
    console.warn(
      "[Companion] current user model unavailable; no historical fallback used:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** L2 — the companion playbook: live file when readable, built-in default on
 *  ANY failure (missing file, unreadable source — the mouth always has a voice). */
async function readPlaybookLayer(ctx: CompanionToolContext): Promise<string> {
  try {
    const raw = await readMemoryFile(ctx, COMPANION_PLAYBOOK_PATH);
    if (raw.trim()) return raw.trim();
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
  const userModel = await readLiveModel();
  const card = projectLivePreviously(userModel?.card ?? "");
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
    buildDirectionBlock(userModel?.direction ?? null),
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
  const client = new AbortController();
  const abortSignal = opts.signal ? AbortSignal.any([client.signal, opts.signal]) : client.signal;
  const result = streamText({
    role: "companion",
    sessionId: args.sliceId,
    system,
    prompt: userPrompt,
    tools: buildCompanionTools(toolCtx),
    thinking: true,
    abortSignal,
    onError: ({ error }) => {
      console.error("[Companion] narration stream error:", error);
    },
  });

  // Preserve the distinction between a complete narration and a provider error.
  const marker = streamFailureMarker(locale);
  const encoder = new TextEncoder();
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value: part } = await iterator.next();
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
    async cancel(reason) {
      client.abort(reason);
      await iterator.return?.();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
