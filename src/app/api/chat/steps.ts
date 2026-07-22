/**
 * Chat turn step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (gray-matter + fs, the episodic manager, DeepSeek Flash) never enter the
 * deterministic workflow sandbox. `turn-workflow.ts` imports these
 * `"use step"` functions by reference only; the loader compiles them into the
 * step bundle, not the workflow bundle.
 *
 * The Pro agent loop itself no longer lives here: the workflow body runs it
 * via WorkflowAgent (see src/app/api/agent/), so each LLM call and each tool
 * call is its own durable step. These four steps wrap that loop:
 *   1. housekeeping    — recover/close/create the slice, append the user turn,
 *      durably snapshot it, and open the UI stream (start / start-step).
 *   2. flashRecall     — unified Flash (intent + recall + metadata), metadata
 *      copy-back onto the slice, then the data-flash chunk for the recall card.
 *   3. prepareGenerate — assemble the dynamic system prompt + the serializable
 *      tool context the workflow passes to `agent.stream()`.
 *   4. finalizeTurn    — persist the agent turn to the episodic slice, write
 *      back startLoop pointers, close the UI stream (finish-step / finish).
 *
 * Chunk order for the UI's three-phase rendering is unchanged:
 * data-flash → reasoning/text/tool (written by agent.stream) → data-reasoning.
 */
import { type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import { classifyIntentKeywords } from "@/lib/router";
import { listNodes } from "@/lib/memory/manager";
import { rankNodes } from "@/lib/memory/scorer";
import { assembleContext } from "@/lib/context/assembler";
import { buildAgentIdentityPrompt, loadUserProfile } from "@/lib/identity";
import type { MemoryNode } from "@/lib/memory/types";
import {
  createSlice,
  closeSlice,
  appendTurn,
  saveSliceSnapshot,
  ensureIndexEntries,
  tryLoadTodaySlice,
  type TimeSlice,
} from "@/lib/episodic";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import {
  runUnifiedFlash,
  readRecentSummaries,
  applyMetadataUpdates,
  type MaintenanceOutput,
} from "@/lib/episodic/maintenance";
import type {
  TurnInput,
  HousekeepingResult,
  FlashRecallResult,
  PrepareGenerateResult,
  TurnOutcome,
} from "@/lib/chat/turn-types";

import { resolveDataSource } from "@/lib/data-source/resolve";

const DATA_SOURCE = resolveDataSource();
const USE_GITHUB = DATA_SOURCE === "github";
const USE_DEMO = DATA_SOURCE === "demo";

// ─── Context assembly helpers (moved verbatim from the inline route) ─────

function loadNodeOnDisk(meta: { path: string }): MemoryNode | null {
  try {
    const filePath = join(process.cwd(), meta.path);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    return {
      id: data.id ?? "", type: data.type ?? "concept", domain: data.domain ?? "general",
      tags: data.tags ?? [], related: data.related ?? [], backlinks: data.backlinks ?? [],
      priority: data.priority ?? 5, access_count: data.access_count ?? 0,
      last_accessed: data.last_accessed ?? "", recall_conditions: data.recall_conditions ?? [],
      status: data.status ?? "active", superseded_by: data.superseded_by,
      title: data.title ?? "", content: content.trim(),
    };
  } catch { return null; }
}

async function buildDynamicSystemPrompt(
  userInput: string,
  recentTurns: Array<{ role: string; content: string }>,
  precomputedIntent: { intent: string; confidence: number; source?: string } | undefined,
  episodicContext: string,
  config: { context: { recentTurnsLimit: number; tokenBudget: number } }
): Promise<{ prompt: string; intent: string; source: string; confidence: number }> {
  let intent: string, source: string, confidence: number;

  if (precomputedIntent) {
    intent = precomputedIntent.intent;
    confidence = precomputedIntent.confidence;
    source = precomputedIntent.source ?? "flash";
  } else {
    const kw = classifyIntentKeywords(userInput);
    intent = kw.intent; source = kw.source; confidence = 0.5;
  }

  const memoryTypes: Array<"concept" | "experience" | "project" | "people" | "personality"> = ["concept", "experience"];
  const strategy = { memory_types: memoryTypes, tags: [] as string[], max_nodes: 8 };
  const candidates = listNodes({ types: strategy.memory_types, tags: strategy.tags, limit: strategy.max_nodes * 3 });
  const ranked = rankNodes(candidates, userInput, intent, strategy.max_nodes);
  const loadedNodes = ranked.map((meta) => loadNodeOnDisk(meta)).filter((n): n is MemoryNode => n !== null);

  // Agent identity + directives are bundled from identity/agent/*.md (immutable
  // at runtime). The user profile is loaded live from memory/. The episodic
  // recall timeline is woven in here — as grounding that precedes the memory
  // nodes — rather than stapled on after the request.
  const userProfile = await loadUserProfile();
  const baseSystemPrompt = `${buildAgentIdentityPrompt(userProfile)}

Current intent: ${intent} (confidence: ${confidence.toFixed(2)}, source: ${source})${episodicContext}

You can start durable background loops with the startLoop tool. When the user asks for continuous or background work, or when you judge a task is large or long-running enough to work autonomously rather than answer inline, call startLoop with a clear, self-contained goal — it keeps working after this turn and records its progress to memory, so results are waiting when the user returns. Tell the user when you start one. Don't use it for anything you can answer right now.

You can search the live web with the webSearch tool when the user needs current or external information beyond their memory and your knowledge. Weave what it finds into your prose with inline citations where relevant — do NOT append a standalone list of source links; the search card already shows them.

At the end of your turn, use the recordCognition tool to record your internal cognitive process: what you were thinking, why you chose each tool, what each result meant, and a brief self-assessment. This builds your agent timeline (hidden from the user) for future self-improvement.`;

  const assembled = assembleContext({
    systemPrompt: baseSystemPrompt,
    coreNodes: loadedNodes.slice(0, 3),
    extendedNodes: loadedNodes.slice(3, 8),
    referenceNodes: ranked.slice(8),
    sessionSummary: "",
    recentTurns: recentTurns.slice(-(config.context.recentTurnsLimit ?? 20)),
    tokenBudget: config.context.tokenBudget ?? 12000,
  });

  return { prompt: assembled.prompt, intent, source, confidence };
}

function formatRelativeTime(iso: string): string {
  // Accept ISO timestamps, YYYY-MM-DD, and YYYY-MM-DD-HHMM slice ids
  let dateStr: string;
  if (iso.includes("T")) {
    dateStr = iso;
  } else {
    const p = iso.split("-");
    const ymd = `${p[0]}-${p[1]}-${p[2]}`;
    const time =
      p.length >= 4
        ? `${p[3].slice(0, 2)}:${p[3].slice(2, 4)}:00.000Z`
        : "12:00:00.000Z";
    dateStr = `${ymd}T${time}`;
  }
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 14) return "last week";
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (months < 2) return "last month";
  if (months < 12) return `${months}mo ago`;
  if (years < 2) return "last year";
  return `${years}y ago`;
}

function buildTimelineEpisodicContext(
  slice: TimeSlice | null,
  flashOutput: MaintenanceOutput | null
): string {
  let ctx = "\n\n## Episodic Memory Timeline\n\n";

  // Now: Current Session
  if (slice) {
    ctx += "### Now — Current Session\n";
    ctx += `- Slice: \`${slice.slice_id}\` · ${slice.turns.length} turns\n`;
    if (slice.focus) ctx += `- Focus: ${slice.focus}\n`;
    if (slice.summary) ctx += `- Summary: ${slice.summary}\n`;
    if (slice.open_loops.length > 0)
      ctx += `- Open loops: ${slice.open_loops.map(l => `"${l}"`).join("; ")}\n`;
    if (slice.decisions.length > 0)
      ctx += `- Decisions: ${slice.decisions.map(d => `"${d}"`).join("; ")}\n`;
    ctx += "\n";
  }

  // Recall Results — timeline format
  if (flashOutput && flashOutput.recall_hits.length > 0) {
    // Cap the list so an over-eager Flash can't blow the context budget:
    // keep the most relevant hits.
    const MAX_RECALL_HITS = 12;
    const hits = [...flashOutput.recall_hits]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_RECALL_HITS);
    const buckets: Record<string, typeof hits> = {
      "Today / This Week": [],
      "This Month": [],
      "A Few Months Ago": [],
      "Last Year": [],
      "Earlier": [],
    };

    for (const h of hits) {
      const parts = h.slice_id.split("-");
      if (parts.length >= 3) {
        const sliceDate = new Date(`${parts[0]}-${parts[1]}-${parts[2]}`).getTime();
        const daysAgo = Math.floor((Date.now() - sliceDate) / 86_400_000);
        if (daysAgo <= 7) buckets["Today / This Week"].push(h);
        else if (daysAgo <= 30) buckets["This Month"].push(h);
        else if (daysAgo <= 180) buckets["A Few Months Ago"].push(h);
        else if (daysAgo <= 365) buckets["Last Year"].push(h);
        else buckets["Earlier"].push(h);
      } else {
        buckets["Earlier"].push(h);
      }
    }

    ctx += "### Recall Results\n";
    ctx += "Flash found these potentially relevant past conversations:\n\n";

    for (const [label, items] of Object.entries(buckets)) {
      if (items.length === 0) continue;
      ctx += `**${label}**\n`;
      for (const h of items) {
        const timeLabel = formatRelativeTime(h.slice_id);
        ctx += `- \`${h.slice_id}\` (${timeLabel}) — ${h.reason} (relevance ${h.relevance.toFixed(2)})\n`;
      }
      ctx += "\n";
    }
    ctx += "These summaries are usually enough — only readMemory a specific slice if you need a detail they don't carry.\n\n";
  } else if (flashOutput) {
    ctx += "### Recall Results\n";
    ctx += "Flash scanned recent conversation history and found no directly relevant past conversations.\n";
    ctx += "Use readMemory to explore `memory/episodic/strands.json` if deeper context is needed.\n\n";
  }

  return ctx;
}

// ─── Step 1: Housekeeping ────────────────────────────────────────────────

/**
 * Recover today's slice from GitHub truth (never the module global — it does
 * not survive across workflow invocations), close it on time-silence / turn
 * cap, or create a fresh one. Append the user turn and durably snapshot before
 * returning, so the message is on GitHub before we stream anything.
 */
export async function housekeeping(input: TurnInput): Promise<HousekeepingResult> {
  "use step";

  const { config, clientTimezone, lastUserMessage } = input;
  const silenceMs = config.slicing.timeSilenceMinutes * 60 * 1000;

  let slice: TimeSlice;
  const diskSlice = await tryLoadTodaySlice();

  if (diskSlice && diskSlice.status === "active") {
    const lastTurn = diskSlice.turns[diskSlice.turns.length - 1];
    const lastActivity = lastTurn
      ? new Date(lastTurn.timestamp).getTime()
      : Date.now();

    if (checkTimeSilence(lastActivity, silenceMs)) {
      await closeSlice(diskSlice, "time_silence");
      console.log(`[Episodic] Recovered & closed stale slice: ${diskSlice.slice_id}`);
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      // Force-close on turn count (safety net for marathon sessions).
      await closeSlice(diskSlice, "capacity");
      console.log(`[Episodic] Closed at turn cap: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else {
      slice = diskSlice;
      console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
    }
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
  }

  // Append the user message (skip if createSlice already seeded it as turn 1).
  const isNewSlice =
    slice.turns.length === 1 && slice.turns[0].content === lastUserMessage;
  if (!isNewSlice) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "user",
      content: lastUserMessage,
      turnId: input.turnId,
    });
  }

  // Durable snapshot BEFORE streaming (was fire-and-forget in the inline route):
  // guarantees the user turn is on GitHub, and that the next turn's
  // tryLoadTodaySlice sees it even if the agent never finishes.
  await saveSliceSnapshot(slice);
  await ensureIndexEntries(slice);

  // Open the UI message stream. Lifecycle chunks are written INTO the durable
  // run stream (not injected by the route transform) so the POST path and the
  // reconnect path replay identical chunk sequences — WorkflowChatTransport
  // resumes by chunk index, which must line up across both.
  const writer = getWritable<UIMessageChunk>().getWriter();
  await writer.write({ type: "start" } as UIMessageChunk);
  await writer.write({ type: "start-step" } as UIMessageChunk);
  writer.releaseLock();

  return { slice };
}

// ─── Step 2: Flash recall + metadata maintenance ─────────────────────────

/**
 * Unified Flash call (intent + recall scan + metadata maintenance) in one
 * DeepSeek round-trip. Metadata updates are applied to the slice in place and
 * returned by value; they reach GitHub when generate's onFinish snapshots.
 * Never throws — Flash is expected to be fallible, so a failure just yields a
 * null output and the turn continues without recall.
 */
export async function flashRecall(
  input: TurnInput,
  slice: TimeSlice
): Promise<FlashRecallResult> {
  "use step";

  const { recentTurns, lastUserMessage } = input;
  const t0 = Date.now();
  let flashOutput: MaintenanceOutput | null = null;

  try {
    const recentSummaries = await readRecentSummaries(15);
    flashOutput = await runUnifiedFlash({
      slice: {
        slice_id: slice.slice_id,
        focus: slice.focus || "",
        summary: slice.summary || "",
        open_loops: slice.open_loops || [],
        decisions: slice.decisions || [],
        tags: slice.tags || [],
        emotional_tone: slice.emotional_tone || "neutral",
      },
      recentTurns,
      newMessage: lastUserMessage,
      recentSummaries,
    });

    console.log(
      `[Flash] intent=${flashOutput.intent} confidence=${flashOutput.confidence.toFixed(2)} ` +
      `recall=${flashOutput.recall_hits.length} updates=${flashOutput.needs_metadata_update} ` +
      `time=${Date.now() - t0}ms`
    );

    if (flashOutput.needs_metadata_update && flashOutput.metadata_updates) {
      const meta = {
        slice_id: slice.slice_id,
        focus: slice.focus || "",
        summary: slice.summary || "",
        open_loops: slice.open_loops || [],
        decisions: slice.decisions || [],
        tags: slice.tags || [],
        emotional_tone: slice.emotional_tone || "neutral",
      };
      applyMetadataUpdates(meta, flashOutput.metadata_updates);
      slice.focus = meta.focus;
      slice.summary = meta.summary;
      slice.open_loops = meta.open_loops;
      slice.decisions = meta.decisions;
      slice.tags = meta.tags;
      slice.emotional_tone = meta.emotional_tone as typeof slice.emotional_tone;
    }
  } catch (err) {
    console.warn(
      "[Flash] Unified call failed, continuing without Flash:",
      err instanceof Error ? err.message : err
    );
  }

  const flashMs = Date.now() - t0;

  // Phase 1: recall card (data-flash) — written here, before the agent runs,
  // so the UI's three-phase order (recall → reasoning → response) holds.
  if (flashOutput) {
    const recallHits = flashOutput.recall_hits ?? [];
    const recallText =
      recallHits.length > 0
        ? `Recalled ${recallHits.length} conversations related to ${flashOutput.suggested_topics.slice(0, 3).join(", ") || "past topics"}`
        : "Scanned recent conversations — no directly relevant matches found";

    const writer = getWritable<UIMessageChunk>().getWriter();
    await writer.write({
      type: "data-flash",
      id: `flash-recall-${Date.now()}`,
      data: {
        phase: "recall",
        done: true,
        durationMs: flashMs,
        text: recallText,
        tags: flashOutput.suggested_topics ?? [],
        reasoning: flashOutput.reasoning ?? "",
        recall_hits: recallHits,
      },
    } as UIMessageChunk);
    writer.releaseLock();
  }

  return { slice, flashOutput, flashMs };
}


// ─── Step 3: Prepare generate ────────────────────────────────────────────

/**
 * Assemble the dynamic system prompt (identity + intent + episodic timeline +
 * ranked memory nodes) and the serializable tool context for this turn. Both
 * feed the workflow's `agent.stream()` call — prompt assembly does local fs +
 * profile I/O, so it lives in a step, never the workflow body.
 */
export async function prepareGenerate(
  input: TurnInput,
  slice: TimeSlice,
  flashOutput: MaintenanceOutput | null
): Promise<PrepareGenerateResult> {
  "use step";

  const { owner, repo, lastUserMessage, recentTurns, config } = input;

  const episodicContext = buildTimelineEpisodicContext(slice, flashOutput);
  const { prompt, intent, confidence } = await buildDynamicSystemPrompt(
    lastUserMessage,
    recentTurns,
    flashOutput
      ? { intent: flashOutput.intent, confidence: flashOutput.confidence, source: "flash" }
      : undefined,
    episodicContext,
    config
  );
  console.log(`[M3] intent=${intent} confidence=${confidence.toFixed(2)}`);

  return {
    systemPrompt: prompt,
    intent,
    confidence,
    toolContext: {
      repo,
      owner,
      useGithub: USE_GITHUB,
      useDemo: USE_DEMO,
      sliceId: slice.slice_id,
      turnId: input.turnId,
    },
  };
}

// ─── Step 4: Finalize turn ───────────────────────────────────────────────

/**
 * Persist the agent turn to the episodic slice (the old streamText onFinish),
 * write back pointers for any loops the agent started this turn, and close the
 * run's output stream with the trailing lifecycle chunks.
 *
 * The agent streamed with `sendFinish: false` + `preventClose: true`, so this
 * step owns the stream tail — finish-step / finish, then close. Retries are
 * safe: the slice arrives by value, so re-running appends to the same base
 * copy and the snapshot write is idempotent.
 */
export async function finalizeTurn(
  slice: TimeSlice,
  outcome: TurnOutcome,
  turnId: string,
): Promise<void> {
  "use step";

  // 1. Episodic persistence (the old onFinish branches).
  if (outcome.finishReason === "stop") {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "agent",
      content: outcome.text,
      turnId,
    });
  } else if (outcome.text) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "agent",
      content: `[partial] ${outcome.text}`,
      turnId,
    });
    console.log(`[Episodic] Pro interrupted (${outcome.finishReason})`);
  } else {
    console.log(`[Episodic] Pro produced no text (${outcome.finishReason})`);
  }

  // 2. startLoop writeback: record the slice→loop pointer and weave loop tags
  // into strands (moved here from the old inline tool closure — the executor
  // only knows the sliceId; this step owns the slice by value).
  for (const started of outcome.startedLoops) {
    if (!slice.loops.includes(started.loopId)) {
      slice.loops.push(started.loopId);
    }
    for (const tag of started.tags) {
      if (!slice.tags.includes(tag)) {
        slice.tags.push(tag);
      }
    }
  }

  if (
    outcome.finishReason === "stop" ||
    outcome.text ||
    outcome.startedLoops.length > 0
  ) {
    await saveSliceSnapshot(slice);
    if (outcome.finishReason === "stop") {
      await ensureIndexEntries(slice);
    }
  }

  // 3. Close the UI stream.
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({ type: "finish-step" } as UIMessageChunk);
  await writer.write({ type: "finish" } as UIMessageChunk);
  writer.releaseLock();
  await writable.close();
}
