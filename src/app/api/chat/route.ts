import { deepseek } from "@ai-sdk/deepseek";
import { streamText, tool } from "ai";
import { z } from "zod";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import { resolveIntent } from "@/lib/router";
import { listNodes } from "@/lib/memory/manager";
import { rankNodes } from "@/lib/memory/scorer";
import { assembleContext } from "@/lib/context/assembler";
import { getSession, updateTurn } from "@/lib/session/manager";
import type { MemoryNode } from "@/lib/memory/types";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  if (!owner || !repo) {
    throw new Error(
      "GITHUB_REPO_OWNER and GITHUB_REPO_NAME environment variables must be set"
    );
  }
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
 */
function buildDynamicSystemPrompt(userInput: string): string {
  // 1. Classify intent
  const { intent, strategy } = resolveIntent(userInput);

  // 2. Query memory index for relevant nodes
  const candidates = listNodes({
    types: (strategy.memory_types as Array<"concept" | "experience" | "project" | "people" | "personality">) ?? [],
    tags: strategy.tags,
    limit: strategy.max_nodes * 3, // oversample for scoring
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
Your role: assist the user with coding, debugging, architecture, and general questions.
You have access to the user's knowledge base (memory nodes) and can read/write files in their GitHub repository.
Only access files under memory/, tasks/, or sessions/ directories.
Be concise, direct, and helpful.

Current intent: ${intent.intent} (confidence: ${intent.confidence.toFixed(2)}, source: ${intent.source})
`;

  const assembled = assembleContext({
    systemPrompt: baseSystemPrompt,
    coreNodes,
    extendedNodes,
    referenceNodes,
    sessionSummary: "",
    recentTurns: [],
    userInput,
  });

  return assembled.prompt;
}

export async function POST(request: Request) {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages array is required and must not be empty" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { owner, repo } = getRepoConfig();

    // Get the user's latest message for M3 pipeline
    const userMessages = messages.filter((m: { role: string }) => m.role === "user");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content ?? "";

    // Build dynamic context via M3 pipeline
    const dynamicSystemPrompt = buildDynamicSystemPrompt(lastUserMessage);

    const result = streamText({
      model: deepseek("deepseek-chat"),
      system: dynamicSystemPrompt,
      messages,
      tools: {
        readFile: tool({
          description: "Read the content of a file from the GitHub repository. Only paths under memory/, tasks/, or sessions/ are accessible.",
          inputSchema: z.object({
            path: z.string().describe("The file path to read, e.g. 'memory/test.md'"),
          }),
          execute: async ({ path }) => {
            return await readFile(path, repo, owner);
          },
        }),
        writeFile: tool({
          description: "Create or update a file in the GitHub repository. Only paths under memory/, tasks/, or sessions/ are writable.",
          inputSchema: z.object({
            path: z.string().describe("The file path to write, e.g. 'memory/note.md'"),
            content: z.string().describe("The content to write to the file"),
          }),
          execute: async ({ path, content }) => {
            return await writeFile(path, content, repo, owner);
          },
        }),
        listFiles: tool({
          description: "List files and directories in a given path. Only paths under memory/, tasks/, or sessions/ are listable.",
          inputSchema: z.object({
            path: z.string().describe("The directory path to list, e.g. 'memory/'"),
          }),
          execute: async ({ path }) => {
            return await listFiles(path, repo, owner);
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
