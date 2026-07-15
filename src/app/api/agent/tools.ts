/**
 * Shared tool definitions for the WorkflowAgent — chat and loop both bind
 * their tool sets here.
 *
 * Each tool couples an inputSchema (what the model provides), a contextSchema
 * (what the workflow provides via `toolsContext`), and a standalone
 * `"use step"` executor from ./tool-executors — so every tool call is an
 * individually durable, auto-retried workflow step.
 *
 * Import-graph discipline: this module stays pure JS (zod + `tool()` +
 * executor references). All Node I/O lives inside the executors' step bodies,
 * which the workflow compiler bundles separately.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  readMemoryExecute,
  listMemoryExecute,
  readIndexExecute,
  writeMemoryExecute,
  updateUserProfileExecute,
  startLoopExecute,
  loopReportExecute,
  type ToolContext,
  type LoopToolContext,
} from "./tool-executors";

// ─── Context schemas ─────────────────────────────────────────────────────

const toolContextSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  useGithub: z.boolean(),
  sliceId: z.string(),
});

const loopToolContextSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  useGithub: z.boolean(),
  loopId: z.string(),
  goal: z.string(),
  filePath: z.string(),
  startedAt: z.string(),
  sliceOrigin: z.string().nullable(),
  tags: z.array(z.string()),
  maxIterations: z.number(),
});

// ─── Memory tools (shared by chat + loop) ────────────────────────────────

export const memoryTools = {
  readMemory: tool({
    description:
      "Read a file from memory (time slices or semantic nodes). Only memory/ paths are accessible.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Path within memory/, e.g. 'memory/episodic/slices/2026/07/01.md'"),
    }),
    contextSchema: toolContextSchema,
    execute: readMemoryExecute,
  }),
  listMemory: tool({
    description:
      "List directories under memory/ to explore available time slices.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Directory path within memory/, e.g. 'memory/episodic/slices/2026/'"),
    }),
    contextSchema: toolContextSchema,
    execute: listMemoryExecute,
  }),
  readIndex: tool({
    description:
      "Read a monthly _index.json to browse time slices in a given month.",
    inputSchema: z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().min(1).max(12),
    }),
    contextSchema: toolContextSchema,
    execute: readIndexExecute,
  }),
  writeMemory: tool({
    description:
      "Create or update a memory file (notes or semantic nodes under memory/) when the user asks you to remember or record something. Cannot touch episodic slices/indexes or the user profile — use updateUserProfile for the profile.",
    inputSchema: z.object({
      path: z.string().describe("Path under memory/, e.g. 'memory/nodes/<id>.md'"),
      content: z.string().describe("Full file content to write"),
      reason: z
        .string()
        .describe("Short note explaining the write (used as the commit message)"),
    }),
    contextSchema: toolContextSchema,
    execute: writeMemoryExecute,
  }),
};

// ─── Chat tool set ───────────────────────────────────────────────────────

export const chatTools = {
  ...memoryTools,
  updateUserProfile: tool({
    description:
      "Update the user's profile (memory/user/profile.md) when they tell you who they are or ask you to remember something about them. Patch individual fields; omitted fields are left unchanged.",
    inputSchema: z.object({
      name: z.string().optional(),
      pronouns: z.string().optional(),
      timezone: z.string().optional(),
      locale: z.string().optional(),
      addressAs: z
        .string()
        .optional()
        .describe("What to call the user (frontmatter address_as)"),
      body: z.string().optional().describe("Free-form 'about you' markdown"),
      reason: z
        .string()
        .describe("Why this change is being made (used as the commit message)"),
    }),
    contextSchema: toolContextSchema,
    execute: updateUserProfileExecute,
  }),
  startLoop: tool({
    description:
      "Start a durable background loop that works a goal over multiple steps on its own and records its progress to memory/loops. Use this when the user explicitly asks to run something in the background or continuously, OR when you judge a task is large or long-running enough that it is better worked autonomously than answered inline right now. The loop keeps running after this turn finishes; tell the user you have started it and that results will be waiting when they return. Do NOT use it for anything you can simply answer now.",
    inputSchema: z.object({
      goal: z
        .string()
        .describe("A clear, self-contained statement of what the loop should accomplish."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Keyword tags for later recall, e.g. topic names."),
    }),
    contextSchema: toolContextSchema,
    execute: startLoopExecute,
  }),
};

// ─── Loop tool set ───────────────────────────────────────────────────────
// No startLoop (a loop must not spawn loops) and no updateUserProfile (an
// autonomous loop has no business editing the user's profile).

export const loopTools = {
  ...memoryTools,
  loopReport: tool({
    description:
      "Report one completed increment of work toward the goal. Call this exactly once after each meaningful step: what you did (action), what came out of it (result), and whether the goal is now fully accomplished (done). Set done=true only when the goal is genuinely complete — do not pad with busywork.",
    inputSchema: z.object({
      action: z.string().describe("What you did this step, in one line."),
      result: z.string().describe("The outcome or reasoning produced this step."),
      done: z.boolean().describe("True only if the goal is fully accomplished."),
    }),
    contextSchema: loopToolContextSchema,
    execute: loopReportExecute,
  }),
};

// ─── toolsContext builders ───────────────────────────────────────────────

/** Same serializable chat context, fanned out to every chat tool by name. */
export function buildChatToolsContext(ctx: ToolContext): Record<keyof typeof chatTools, ToolContext> {
  return {
    readMemory: ctx,
    listMemory: ctx,
    readIndex: ctx,
    writeMemory: ctx,
    updateUserProfile: ctx,
    startLoop: ctx,
  };
}

/** Memory tools share the chat-shaped context; loopReport gets the loop identity. */
export function buildLoopToolsContext(
  memoryCtx: ToolContext,
  loopCtx: LoopToolContext,
): Record<keyof typeof memoryTools, ToolContext> & { loopReport: LoopToolContext } {
  return {
    readMemory: memoryCtx,
    listMemory: memoryCtx,
    readIndex: memoryCtx,
    writeMemory: memoryCtx,
    loopReport: loopCtx,
  };
}
