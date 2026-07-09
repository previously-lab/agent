import { deepseek } from "@ai-sdk/deepseek";
import { streamText, tool, convertToModelMessages, stepCountIs, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { readFile } from "@/lib/tools/readFile";
import { listFiles } from "@/lib/tools/listFiles";
import { readFileLocal, listFilesLocal } from "@/lib/tools/local-fs";
import { classifyIntentKeywords } from "@/lib/router";
import { listNodes } from "@/lib/memory/manager";
import { rankNodes } from "@/lib/memory/scorer";
import { assembleContext } from "@/lib/context/assembler";
import { buildAgentIdentityPrompt, loadUserProfile } from "@/lib/identity";
import type { MemoryNode } from "@/lib/memory/types";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import {
  getActiveSlice,
  createSlice,
  closeSlice,
  appendTurn,
  saveSliceSnapshot,
  ensureIndexEntries,
  tryLoadTodaySlice,
  setActiveSlice,
} from "@/lib/episodic";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import {
  runUnifiedFlash,
  readRecentSummaries,
  applyMetadataUpdates,
  type MaintenanceOutput,
  type RecentSummary,
} from "@/lib/episodic/maintenance";

const USE_GITHUB = process.env.GITHUB_TOKEN != null;

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

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

// ─── M3 Context Assembly ────────────────────────────────────────────────

async function buildDynamicSystemPrompt(
  userInput: string,
  recentTurns: Array<{ role: string; content: string }> = [],
  precomputedIntent?: { intent: string; confidence: number; source?: string }
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
  // at runtime). The user profile is loaded live from memory/ (latest version,
  // agent-editable) and woven in here.
  const userProfile = await loadUserProfile();
  const baseSystemPrompt = `${buildAgentIdentityPrompt(userProfile)}

Current intent: ${intent} (confidence: ${confidence.toFixed(2)}, source: ${source})
`;

  const assembled = assembleContext({
    systemPrompt: baseSystemPrompt,
    coreNodes: loadedNodes.slice(0, 3),
    extendedNodes: loadedNodes.slice(3, 8),
    referenceNodes: ranked.slice(8),
    sessionSummary: "",
    recentTurns: recentTurns.slice(-3),
    userInput,
  });

  return { prompt: assembled.prompt, intent, source, confidence };
}

// ─── Timeline context builder (M8) ──────────────────────────────────────

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
  slice: ReturnType<typeof getActiveSlice>,
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
    const hits = [...flashOutput.recall_hits];
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
    ctx += "Use readMemory to read specific slice bodies for deeper context.\n\n";
  } else if (flashOutput) {
    ctx += "### Recall Results\n";
    ctx += "Flash scanned recent conversation history and found no directly relevant past conversations.\n";
    ctx += "Use readMemory to explore `memory/episodic/tag-index.json` if deeper context is needed.\n\n";
  }

  return ctx;
}

// ─── POST handler (M8 refactored) ──────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { messages } = body;
    const model = (body.model as string) ?? "deepseek-chat";
    const thinking = body.thinking !== false;
    const clientTimezone = (body.timezone as string) ?? "UTC";
    const loadedSliceIds = (body.loadedSliceIds as string[]) ?? [];

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages array is required and must not be empty" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { owner, repo } = getRepoConfig();

    // Extract recent conversation context
    const modelMessages = await convertToModelMessages(messages);
    const recentTurns = modelMessages.slice(-8).map((m) => ({
      role: m.role as string,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    const userMessages = messages.filter((m: { role: string }) => m.role === "user");
    const lastMsg = userMessages[userMessages.length - 1];
    const lastUserMessage =
      lastMsg?.parts?.find((p: { type: string }) => p.type === "text")?.text
      ?? lastMsg?.content
      ?? "";

    // ─── Step 1: Housekeeping (M8: moved to request start, time-only) ───
    let slice = getActiveSlice();

    if (!slice) {
      // Try disk recovery (page refresh scenario)
      const diskSlice = await tryLoadTodaySlice();
      if (diskSlice && diskSlice.status === "active") {
        const lastTurn = diskSlice.turns[diskSlice.turns.length - 1];
        const lastActivity = new Date(lastTurn.timestamp).getTime();
        if (checkTimeSilence(lastActivity)) {
          await closeSlice(diskSlice, "time_silence");
          console.log(`[Episodic] Recovered & closed stale slice: ${diskSlice.slice_id}`);
          slice = createSlice(lastUserMessage, clientTimezone);
        } else {
          setActiveSlice(diskSlice);
          slice = diskSlice;
          console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
        }
      } else {
        slice = createSlice(lastUserMessage, clientTimezone);
        console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
      }
    } else {
      // Check time silence on active slice
      const lastTurnTs = slice.turns.length > 0
        ? new Date(slice.turns[slice.turns.length - 1].timestamp).getTime()
        : Date.now();
      if (checkTimeSilence(lastTurnTs)) {
        await closeSlice(slice, "time_silence");
        console.log(`[Episodic] Closed stale slice: ${slice.slice_id}`);
        slice = createSlice(lastUserMessage, clientTimezone);
      }
    }

    // Append user message (skip if createSlice already added it)
    const isNewSlice = slice.turns.length === 1 && slice.turns[0].content === lastUserMessage;
    if (!isNewSlice) {
      appendTurn(slice, { timestamp: new Date().toISOString(), role: "user", content: lastUserMessage });
    }
    if (isNewSlice) {
      saveSliceSnapshot(slice).then(() => ensureIndexEntries(slice)).catch(() => {});
    }

    // ─── Step 2: Unified Flash (M8: one call, three outputs) ────────────
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

      // Apply metadata updates from Flash (M8: per-round maintenance)
      if (flashOutput.needs_metadata_update && flashOutput.metadata_updates) {
        const meta: { slice_id: string; focus: string; summary: string; open_loops: string[]; decisions: string[]; tags: string[]; emotional_tone: string } = {
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
      console.warn("[Flash] Unified call failed, continuing without Flash:", err instanceof Error ? err.message : err);
    }

    // ─── Step 3: M3 Context Assembly ────────────────────────────────────
    const { prompt: dynamicSystemPrompt, intent, confidence } =
      await buildDynamicSystemPrompt(lastUserMessage, recentTurns, flashOutput
        ? { intent: flashOutput.intent, confidence: flashOutput.confidence, source: "flash" }
        : undefined);

    console.log(`[M3] intent=${intent} confidence=${confidence.toFixed(2)} pipeline=${Date.now() - t0}ms`);

    // ─── Step 4: Episodic Context (M8: timeline format) ─────────────────
    const episodicContext = buildTimelineEpisodicContext(slice, flashOutput);
    const finalSystemPrompt = dynamicSystemPrompt + episodicContext;

    // ─── Step 5: Recall text for data-flash ─────────────────────────────
    const recallHits = flashOutput?.recall_hits ?? [];
    const recallText = recallHits.length > 0
      ? `Recalled ${recallHits.length} conversations related to ${flashOutput!.suggested_topics.slice(0, 3).join(", ") || "past topics"}`
      : flashOutput
        ? "Scanned recent conversations — no directly relevant matches found"
        : null;

    // ─── Step 6: Multi-phase streaming ──────────────────────────────────
    const uiStream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Phase 1: data-flash — always send if Flash ran (even with no hits)
        if (flashOutput) {
          writer.write({
            type: "data-flash",
            id: `flash-recall-${Date.now()}`,
            data: {
              phase: "recall",
              text: recallText || "",
              tags: flashOutput.suggested_topics ?? [],
              reasoning: flashOutput.reasoning ?? "",
              recall_hits: recallHits,
            },
          });
        }

        // Phase 2 + 3: Pro — thinking + text
        const result = streamText({
          model: deepseek(model),
          providerOptions: thinking
            ? { deepseek: { thinking: { type: "enabled" as const }, reasoningEffort: "medium" as const } }
            : undefined,
          system: finalSystemPrompt,
          messages: modelMessages,
          stopWhen: stepCountIs(20),
          onFinish: async ({ text, finishReason }) => {
            if (finishReason === "stop") {
              appendTurn(slice, { timestamp: new Date().toISOString(), role: "agent", content: text });
              await saveSliceSnapshot(slice);
              await ensureIndexEntries(slice);
            } else {
              if (text) {
                appendTurn(slice, { timestamp: new Date().toISOString(), role: "agent", content: `[partial] ${text}` });
                saveSliceSnapshot(slice).catch(() => {});
              }
              console.log(`[Episodic] Pro interrupted (${finishReason})`);
            }
          },
          tools: {
            readMemory: tool({
              description: "Read a file from memory (time slices or semantic nodes). Only memory/ paths are accessible.",
              inputSchema: z.object({
                path: z.string().describe("Path within memory/, e.g. 'memory/episodic/slices/2026/07/01.md'"),
              }),
              execute: async ({ path }) => {
                return USE_GITHUB ? await readFile(path, repo, owner) : await readFileLocal(path);
              },
            }),
            listMemory: tool({
              description: "List directories under memory/ to explore available time slices.",
              inputSchema: z.object({
                path: z.string().describe("Directory path within memory/, e.g. 'memory/episodic/slices/2026/'"),
              }),
              execute: async ({ path }) => {
                return USE_GITHUB ? await listFiles(path, repo, owner) : await listFilesLocal(path);
              },
            }),
            readIndex: tool({
              description: "Read a monthly _index.json to browse time slices in a given month.",
              inputSchema: z.object({
                year: z.number().int().min(2000).max(2100), month: z.number().min(1).max(12),
              }),
              execute: async ({ year, month }) => {
                const mm = String(month).padStart(2, "0");
                const path = `memory/episodic/slices/${year}/${mm}/_index.json`;
                try {
                  const raw = USE_GITHUB ? await readFile(path, repo, owner) : await readFileLocal(path);
                  return JSON.parse(raw);
                } catch {
                  return { exists: false, month: `${year}-${mm}`, slices: [] };
                }
              },
            }),
          },
        });

        writer.merge(result.toUIMessageStream());
      },
    });

    return createUIMessageStreamResponse({ stream: uiStream });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return new Response(JSON.stringify({ error: "Invalid JSON in request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (error instanceof Error && error.message.includes("environment variables")) {
      console.error("[chat] Configuration error:", error.message);
      return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    throw error;
  }
}
