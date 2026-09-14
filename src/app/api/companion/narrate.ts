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
 *   L1 the living user card (current-previously.md, read live)
 *   L2 companion playbook (memory/agent-playbooks/companion.md, default on
 *     any read failure)
 *   L3 event context — now (user-local), locale, target sliceId (varies)
 */

import { streamText, isStepCount } from "ai";
import { loadUserConfig } from "@/lib/config/loader";
import { demoModelLock } from "@/lib/demo/model-lock";
import {
  getModel,
  getDefaultModelId,
  ALL_MODELS,
  type ModelConfig,
} from "@/lib/models/registry";
import { resolveAvailableModels } from "@/lib/models/catalog";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { createModel } from "@/lib/models/provider";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import {
  buildAgentIdentityPrompt,
  parseIdentityFromPreviously,
} from "@/lib/identity";
import { CURRENT_PREVIOUSLY_PATH } from "@/lib/episodic/manager";
import { isCardFormat, migrateToV3 } from "@/lib/episodic/previously-format";
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

/**
 * Resolve a model id to its full config — the start-turn resolver sequence
 * (curated registry → live catalog → deployment default). Re-implemented
 * here rather than imported: start-turn.ts pulls in the whole durable
 * workflow (workflow/api + turn-workflow), and the mouth must stay a plain
 * streamText endpoint.
 */
async function resolveModelConfig(id: string): Promise<{
  model: string;
  modelConfig: ModelConfig;
}> {
  const curated = getModel(id);
  if (curated) return { model: curated.id, modelConfig: curated };

  const available = await resolveAvailableModels();
  const found = available.find((m) => m.id === id);
  if (found) return { model: found.id, modelConfig: found };

  const fallbackId = getDefaultModelId();
  const fallback = getModel(fallbackId) ?? available[0] ?? ALL_MODELS[0];
  return { model: fallback.id, modelConfig: fallback };
}

/** Injection cap for the live playbook — same budget as the evolved
 *  playbooks (MAX_PLAYBOOK_CHARS in src/lib/evolution/store.ts), inlined so
 *  this module stays free of the evolution write path's import graph. */
const PLAYBOOK_MAX_CHARS = 2000;

function capPlaybook(content: string): string {
  if (content.length <= PLAYBOOK_MAX_CHARS) return content;
  return (
    content.slice(0, PLAYBOOK_MAX_CHARS) +
    `\n\n[…playbook truncated at ${PLAYBOOK_MAX_CHARS} chars]`
  );
}

/** L1 — the living user card, read through the data-source readers exactly
 *  like readPreviouslyExecute's live branch (tool-executors.ts:556-563).
 *  A missing/unreadable card degrades to no card layer — it must not silence
 *  the mouth. */
async function readLiveCard(ctx: CompanionToolContext): Promise<string> {
  try {
    const raw = await readMemoryFile(ctx, CURRENT_PREVIOUSLY_PATH);
    return raw.trim() ? (isCardFormat(raw) ? raw : migrateToV3(raw, "current")) : raw;
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
export async function narrateSlice(args: NarrateArgs): Promise<Response> {
  // Model resolution mirrors the chat turn (start-turn.ts:170-192): config →
  // demo lock → resolve; thinking pinned to the model's capability; effort
  // pinned low (fast responses are the product rule).
  const config = await loadUserConfig();
  const lock = demoModelLock();
  const requested = lock?.model ?? config.model.provider;
  const { model, modelConfig } = await resolveModelConfig(requested);
  const thinking = lock?.thinking ?? modelConfig.capabilities.thinking;
  const reasoningEffort = lock?.effort ?? "low";
  console.log(
    `[Companion] model=${model} (requested=${requested}) sdk=${modelConfig.sdk} thinking=${thinking} effort=${reasoningEffort}`,
  );

  if (modelConfig.sdk === "bridge") {
    return Response.json(
      {
        error:
          "The subscription bridge brain cannot narrate — the bridge CLI " +
          "returns plain text and cannot run the companion read-only tools.",
      },
      { status: 501 },
    );
  }

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
  const card = await readLiveCard(toolCtx);
  const playbook = await readPlaybookLayer(toolCtx);

  // L0 — charter + who you're assisting; the profile is parsed from the same
  // live card the chat turn parses it from (steps.ts:1977-1980).
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

  // Plain AI SDK streamText — NOT a workflow, no StepBoundaryLanguageModel:
  // createModel instantiates the real provider model directly. The agent
  // loop is bounded at 6 steps (read tools + narration fit comfortably).
  const result = streamText({
    model: createModel(modelConfig),
    system,
    prompt: userPrompt,
    tools: buildCompanionTools(toolCtx),
    providerOptions: normalizeReasoningEffort(
      modelConfig.sdk,
      modelConfig.id,
      thinking,
      reasoningEffort,
    ),
    stopWhen: isStepCount(6),
    // Narration, not deduction: some warmth/variety; the read-only tools and
    // the playbook's honesty rules keep it grounded.
    temperature: 0.7,
  });

  return result.toTextStreamResponse();
}
