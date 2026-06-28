import { deepseek } from "@ai-sdk/deepseek";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { z } from "zod";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import { readFileLocal, writeFileLocal, listFilesLocal } from "@/lib/tools/local-fs";
import { resolveIntent, classifyIntentKeywords } from "@/lib/router";
import { listNodes } from "@/lib/memory/manager";
import { rankNodes } from "@/lib/memory/scorer";
import { assembleContext } from "@/lib/context/assembler";
import type { MemoryNode } from "@/lib/memory/types";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";

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
): Promise<{ prompt: string; intent: string; source: string; confidence: number }> {
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
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { messages } = body;
    const model = (body.model as string) ?? "deepseek-chat";
    const thinking = body.thinking !== false; // default: enabled

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
    const { prompt: dynamicSystemPrompt, intent, source, confidence } =
      await buildDynamicSystemPrompt(lastUserMessage, recentTurns);
    console.log(
      `[M3] intent=${intent} source=${source} confidence=${confidence.toFixed(2)} pipeline=${Date.now() - t0}ms`
    );

    const result = streamText({
      model: deepseek(model),
      providerOptions: thinking
        ? { deepseek: { thinking: { type: "enabled" as const }, reasoningEffort: "medium" as const } }
        : undefined,
      system: dynamicSystemPrompt,
      messages: modelMessages,
      stopWhen: stepCountIs(20),
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
