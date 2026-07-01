import { deepseek } from "@ai-sdk/deepseek";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { z } from "zod";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import { readFileLocal, writeFileLocal, listFilesLocal } from "@/lib/tools/local-fs";
import { resolveIntent, classifyIntentKeywords } from "@/lib/router";
import { classifyWithFlash } from "@/lib/router/flash";
import { listNodes } from "@/lib/memory/manager";
import { rankNodes } from "@/lib/memory/scorer";
import { assembleContext } from "@/lib/context/assembler";
import type { MemoryNode } from "@/lib/memory/types";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import {
  getActiveSlice,
  createSlice,
  closeSlice,
  appendTurn,
  readSliceIndex,
  checkTimeSilence,
  checkCapacity,
  checkContinuity,
  saveSliceSnapshot,
  ensureIndexEntries,
} from "@/lib/episodic";
import type { FlashSplitInput, SplitDecision, SlicingSignal } from "@/lib/episodic";

const USE_GITHUB = process.env.GITHUB_TOKEN != null;

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

/**
 * Load a full memory node from disk (content + frontmatter).
 */
function loadNodeOnDisk(meta: { path: string }): MemoryNode | null {
  try {
    const filePath = join(process.cwd(), meta.path);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    return {
      id: data.id ?? "",
      type: data.type ?? "concept",
      domain: data.domain ?? "general",
      tags: data.tags ?? [],
      related: data.related ?? [],
      backlinks: data.backlinks ?? [],
      priority: data.priority ?? 5,
      access_count: data.access_count ?? 0,
      last_accessed: data.last_accessed ?? "",
      recall_conditions: data.recall_conditions ?? [],
      status: data.status ?? "active",
      superseded_by: data.superseded_by,
      title: data.title ?? "",
      content: content.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Build a dynamic system prompt using the M3 context assembly pipeline.
 * Uses Flash for intent classification + keyword rules as override.
 */
async function buildDynamicSystemPrompt(
  userInput: string,
  recentTurns: Array<{ role: string; content: string }> = [],
  sessionIntent: string = "clarify"
): Promise<{ prompt: string; intent: string; source: string; confidence: number; recall_hint?: import("@/lib/router").RecallHint }> {
  // 1. Classify intent (Flash + keyword hybrid)
  const { intent, strategy } = await resolveIntent({
    currentInput: userInput,
    lastTurnSummary: "",
    sessionIntent,
    recentTurns,
  });

  // 2. Query memory index for relevant nodes
  const candidates = listNodes({
    types: (strategy.memory_types as Array<"concept" | "experience" | "project" | "people" | "personality">) ?? [],
    tags: strategy.tags,
    limit: strategy.max_nodes * 3,
  });

  // 3. Score and rank
  const ranked = rankNodes(candidates, userInput, intent.intent, strategy.max_nodes);

  // 4. Load full node content from disk
  const loadedNodes = ranked
    .map((meta) => loadNodeOnDisk(meta))
    .filter((n): n is MemoryNode => n !== null);

  // 5. Assemble context
  const coreNodes = loadedNodes.slice(0, 3);
  const extendedNodes = loadedNodes.slice(3, 8);
  const referenceNodes = ranked.slice(8);

  const baseSystemPrompt = `You are Aftrbrez, a personal AI commander platform agent.
Assist the user with coding, debugging, architecture, and general questions.

Tool usage rules:
- Use tools ONLY when the user explicitly asks you to read/write/list files
- Do NOT call tools just to "check" or "explore" — answer from your knowledge first
- If the user is just chatting or asking questions, do NOT call any tools
- When you do call a tool, be specific about the path

File access: only memory/, tasks/, sessions/ directories.

Current intent: ${intent.intent} (confidence: ${intent.confidence.toFixed(2)}, source: ${intent.source})
`;

  const assembled = assembleContext({
    systemPrompt: baseSystemPrompt,
    coreNodes,
    extendedNodes,
    referenceNodes,
    sessionSummary: "",
    recentTurns: recentTurns.slice(-3),
    userInput,
  });

  return {
    prompt: assembled.prompt,
    intent: intent.intent,
    source: intent.source,
    confidence: intent.confidence,
    recall_hint: intent.recall_hint,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { messages } = body;
    const model = (body.model as string) ?? "deepseek-chat";
    const thinking = body.thinking !== false; // default: enabled
    const clientTimezone = (body.timezone as string) ?? "UTC";

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages array is required and must not be empty" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { owner, repo } = getRepoConfig();

    // Extract recent conversation for Flash context
    const modelMessages = await convertToModelMessages(messages);
    const recentTurns = modelMessages.slice(-6).map((m) => ({
      role: m.role as string,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    // Get the user's latest message for M3 pipeline
    const userMessages = messages.filter((m: { role: string }) => m.role === "user");
    const lastMsg = userMessages[userMessages.length - 1];
    const lastUserMessage =
      lastMsg?.parts?.find((p: { type: string }) => p.type === "text")?.text
      ?? lastMsg?.content
      ?? "";

    // Build dynamic context via M3 pipeline (Flash + Memory + Assembler)
    const t0 = Date.now();
    const { prompt: dynamicSystemPrompt, intent, source, confidence, recall_hint: flashRecallHint } =
      await buildDynamicSystemPrompt(lastUserMessage, recentTurns);
    console.log(
      `[M3] intent=${intent} source=${source} confidence=${confidence.toFixed(2)} pipeline=${Date.now() - t0}ms`
    );

    // ─── Episodic slice management ────────────────────────────────────────
    // Get or create the active time slice
    const existingSlice = getActiveSlice();
    const slice = existingSlice ?? createSlice(lastUserMessage, clientTimezone);
    if (existingSlice) {
      // Append the current user message as a turn on the existing slice
      appendTurn(slice, {
        timestamp: new Date().toISOString(),
        role: "user",
        content: lastUserMessage,
      });
    } else {
      console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
      // Save initial snapshot so the slice file exists immediately
      saveSliceSnapshot(slice).then(() => ensureIndexEntries(slice)).catch(() => {});
    }

    // Deterministic split checks (time silence, capacity) — no Flash calls
    let pendingSplit: SplitDecision | null = null;
    const lastTurnTs =
      slice.turns.length > 1
        ? new Date(slice.turns[slice.turns.length - 2].timestamp).getTime()
        : Date.now();

    if (checkTimeSilence(lastTurnTs)) {
      pendingSplit = {
        shouldSplit: true,
        source: "time_silence" as SlicingSignal,
        confidence: 1.0,
        reason: "Time silence threshold exceeded",
      };
    } else if (checkCapacity(slice)) {
      pendingSplit = {
        shouldSplit: true,
        source: "capacity" as SlicingSignal,
        confidence: 1.0,
        reason: `Capacity limit: ${slice.turns.length} turns, ~${slice.estimatedTokens} tokens`,
      };
    }

    // Flash continuity check — only called when deterministic didn't fire
    let flashSplitResult: {
      shouldSplit: boolean;
      confidence: number;
      reason: string;
      suggestedFocus?: string;
    } | null = null;
    if (!pendingSplit) {
      const flashInput: FlashSplitInput = {
        timeSinceLastMessage: Math.round((Date.now() - lastTurnTs) / 1000),
        currentSliceFocus: slice.focus,
        currentSliceTopics: slice.tags,
        recentHistory: slice.turns.slice(-5),
        newMessage: lastUserMessage,
      };
      flashSplitResult = await checkContinuity(flashInput);
      if (flashSplitResult.shouldSplit) {
        pendingSplit = {
          shouldSplit: true,
          source: "flash_high_confidence" as SlicingSignal,
          confidence: flashSplitResult.confidence,
          reason: flashSplitResult.reason,
          suggestedFocus: flashSplitResult.suggestedFocus,
        };
      }
    }

    if (pendingSplit) {
      console.log(
        `[Episodic] Split pending: ${pendingSplit.source} — ${pendingSplit.reason}`
      );
    }

    // ─── Inject episodic context into the system prompt ───────────────────
    let episodicContext = "\n\n## Episodic Memory\n\n### Current Session\n";
    episodicContext += `- Slice ID: ${slice.slice_id}\n`;
    episodicContext += `- Turns so far: ${slice.turns.length}\n`;
    if (slice.focus) episodicContext += `- Focus: ${slice.focus}\n`;
    if (slice.summary) episodicContext += `- Summary: ${slice.summary}\n`;
    if (slice.open_loops.length > 0) {
      episodicContext += `- Open loops: ${slice.open_loops
        .map((l: string) => `"${l}"`)
        .join(", ")}\n`;
    }
    if (slice.decisions.length > 0) {
      episodicContext += `- Decisions: ${slice.decisions
        .map((d: string) => `"${d}"`)
        .join(", ")}\n`;
    }

    // Recent closed slices from monthly index files
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

    const [currentMonthIndex, prevMonthIndex] = await Promise.all([
      readSliceIndex(currentYear, currentMonth),
      readSliceIndex(prevMonthYear, prevMonth),
    ]);

    const recentClosed = [...prevMonthIndex, ...currentMonthIndex]
      .filter(
        (e) =>
          e.status === "closed" &&
          e.id !== slice.slice_id.split("-")[2]
      )
      .slice(-5);

    if (recentClosed.length > 0) {
      episodicContext += "\n### Recent Sessions\n";
      for (const entry of recentClosed) {
        episodicContext += `- [${entry.id}] ${entry.focus || entry.summary || "(untitled)"}\n`;
      }
    }

    // Flash recall hint — directional suggestion for Pro's memory exploration
    if (flashRecallHint) {
      const hint = flashRecallHint;
      episodicContext += `\n### Flash Hint\n`;
      episodicContext += `The Flash classifier suggests you might find relevant context in time slices tagged: ${hint.suggested_tags.join(", ")} (${hint.suggested_time_range}). ${hint.reason}\n`;
      episodicContext += `You can browse time slices with readFile("memory/episodic/tag-index.json") to find matching entries.\n`;
    } else if (flashSplitResult?.reason && !flashSplitResult.shouldSplit) {
      episodicContext += `\n### Continuity Note\n${flashSplitResult.reason}\n`;
    }

    const finalSystemPrompt = dynamicSystemPrompt + episodicContext;

    const result = streamText({
      model: deepseek(model),
      providerOptions: thinking
        ? { deepseek: { thinking: { type: "enabled" as const }, reasoningEffort: "medium" as const } }
        : undefined,
      system: finalSystemPrompt,
      messages: modelMessages,
      stopWhen: stepCountIs(20),
      onFinish: async ({ text, finishReason }) => {
        const normalCompletion = finishReason === "stop";

        if (normalCompletion) {
          // Append agent response to current slice
          appendTurn(slice, {
            timestamp: new Date().toISOString(),
            role: "agent",
            content: text,
          });

          // Flash dynamic summary update every 3 turns
          if (slice.turns.length % 6 === 0 && slice.turns.length > 0) {
            try {
              const summaryResult = await classifyWithFlash({
                currentInput: `Summarize the last few exchanges in 1-2 sentences. Focus: what are we working on?`,
                lastTurnSummary: slice.summary,
                sessionIntent: slice.focus,
                recentTurns: slice.turns.slice(-6).map(t => ({ role: t.role, content: t.content.slice(0, 300) })),
              });
              // Use Flash's reasoning (the actual summary text) as the new dynamic summary
              if (summaryResult.reasoning && summaryResult.reasoning.length > 10) {
                slice.summary = summaryResult.reasoning.slice(0, 100);
              }
              if (summaryResult.intent && summaryResult.intent !== "clarify") {
                slice.focus = summaryResult.intent.replace(/_/g, " ");
              }
            } catch {
              // Summary update is best-effort — don't block on failure
            }
          }

          // Save snapshot after every turn — ensures data survives refresh/crash
          await saveSliceSnapshot(slice);
          await ensureIndexEntries(slice);

          if (pendingSplit) {
            // Freeze summary before closing
            try {
              const freezeInput = `Time slice "${slice.focus || slice.slice_id}" with ${slice.turns.length} turns. Generate: 1) one-line summary (≤100 chars) 2) open_loops (array) 3) decisions (array) 4) tags (array) 5) emotional_tone (exploratory|frustrated|decisive|neutral). Return ONLY raw JSON.`;
              const freezeResult = await classifyWithFlash({
                currentInput: freezeInput,
                lastTurnSummary: slice.summary,
                sessionIntent: slice.focus,
                recentTurns: slice.turns.slice(-10).map(t => ({ role: t.role, content: t.content.slice(0, 200) })),
              });
              // Use Flash output to populate frozen fields
              try {
                const frozenData = JSON.parse(freezeResult.reasoning || "{}");
                slice.summary = frozenData.summary || slice.summary;
                slice.open_loops = frozenData.open_loops || [];
                slice.decisions = frozenData.decisions || [];
                slice.tags = frozenData.tags || [];
                slice.emotional_tone = frozenData.emotional_tone || "neutral";
              } catch { /* keep existing values */ }
            } catch { /* best-effort */ }

            await closeSlice(slice, pendingSplit.source);
            console.log(
              `[Episodic] Slice closed: ${pendingSplit.source} — ${pendingSplit.reason}`
            );
          }
        } else {
          // Interrupted or error — discard split, append partial if any
          if (text) {
            appendTurn(slice, {
              timestamp: new Date().toISOString(),
              role: "agent",
              content: `[partial] ${text}`,
            });
            // Save partial state even on interruption
            saveSliceSnapshot(slice).catch(() => {});
          }
          console.log(
            `[Episodic] Pro interrupted (${finishReason}), split discarded`
          );
        }
      },
      tools: {
        readFile: tool({
          description: "Read the content of a file from the GitHub repository. Only paths under memory/, tasks/, or sessions/ are accessible.",
          inputSchema: z.object({
            path: z.string().describe("The file path to read, e.g. 'memory/test.md'"),
          }),
          execute: async ({ path }) => {
            return USE_GITHUB
              ? await readFile(path, repo, owner)
              : await readFileLocal(path);
          },
        }),
        writeFile: tool({
          description: "Create or update a file in the repository. Only paths under memory/, tasks/, or sessions/ are writable.",
          inputSchema: z.object({
            path: z.string().describe("The file path to write, e.g. 'memory/note.md'"),
            content: z.string().describe("The content to write to the file"),
          }),
          execute: async ({ path, content }) => {
            return USE_GITHUB
              ? await writeFile(path, content, repo, owner)
              : await writeFileLocal(path, content);
          },
        }),
        listFiles: tool({
          description: "List files and directories in a given path. Only paths under memory/, tasks/, or sessions/ are listable.",
          inputSchema: z.object({
            path: z.string().describe("The directory path to list, e.g. 'memory/'"),
          }),
          execute: async ({ path }) => {
            return USE_GITHUB
              ? await listFiles(path, repo, owner)
              : await listFilesLocal(path);
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    if (error instanceof Error && error.message.includes("environment variables")) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    throw error;
  }
}
