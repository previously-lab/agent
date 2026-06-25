import { anthropic } from "@ai-sdk/anthropic";
import { streamText, tool } from "ai";
import { z } from "zod";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import { buildSystemPrompt } from "@/lib/system-prompt";

/**
 * Get GitHub repo configuration from environment.
 * Throws if required variables are missing.
 */
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

    const result = streamText({
      model: anthropic("claude-sonnet-4-6"),
      system: buildSystemPrompt(),
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
    // Handle JSON parse errors
    if (error instanceof SyntaxError) {
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Handle missing env vars
    if (error instanceof Error && error.message.includes("environment variables")) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    throw error;
  }
}
