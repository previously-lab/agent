/**
 * Loop step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (ai/deepseek for the LLM call, gray-matter + fs via the store for the write)
 * never enter the deterministic workflow sandbox. The workflow imports these
 * `"use step"` functions by reference; the loader compiles them into the step
 * bundle, not the workflow bundle.
 */
import { generateText, tool, stepCountIs } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type {
  LoopInput,
  LoopRun,
  LoopStep,
  LoopStatus,
} from "@/lib/loops/types";
import { serializeLoop, writeLoopFile } from "@/lib/loops/store";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import { readFileLocal, writeFileLocal, listFilesLocal } from "@/lib/tools/local-fs";
import { isPathAllowed, isProtectedSystemPath } from "@/lib/whitelist";

const USE_GITHUB = !!process.env.GITHUB_TOKEN;

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

const stepSchema = tool({
  description: "Report the next step toward the goal. Call this exactly once.",
  inputSchema: z.object({
    action: z.string().describe("What you are doing this step, in one line."),
    result: z
      .string()
      .describe("The outcome or reasoning produced this step."),
    done: z
      .boolean()
      .describe("True only if the goal is fully accomplished."),
  }),
});

/** One reasoning increment toward the goal, via DeepSeek. */
export async function runLoopStep(
  input: LoopInput,
  priorSteps: LoopStep[]
): Promise<{ step: LoopStep; done: boolean }> {
  "use step";

  const { owner, repo } = getRepoConfig();

  const history = priorSteps.length
    ? priorSteps
        .map((s) => `Step ${s.step}: ${s.action}\n${s.result}`)
        .join("\n\n")
    : "(no steps yet)";

  const prompt = `You are an autonomous agent working a goal step by step, on your own, while the human is away.

Goal: ${input.goal}

Work so far:
${history}

Use the memory tools to actually DO the work this step: read any context you need with readMemory/listMemory. When the goal is to produce an artifact, WRITE it to a file under memory/ using writeMemory — do not just paste the artifact into your report.
Then call the loopStep tool exactly once to report the action you took, the result, and whether the goal is done.
Set done=true only when the goal is genuinely complete — do not pad with busywork.`;

  const result = await generateText({
    model: deepseek("deepseek-chat"),
    prompt,
    temperature: 0.4,
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
      writeMemory: tool({
        description:
          "Create or update a memory file (notes or semantic nodes under memory/) when the user asks you to remember or record something. Cannot touch episodic slices/indexes or the user profile — use updateUserProfile for the profile.",
        inputSchema: z.object({
          path: z.string().describe("Path under memory/, e.g. 'memory/nodes/<id>.md'"),
          content: z.string().describe("Full file content to write"),
          reason: z.string().describe("Short note explaining the write (used as the commit message)"),
        }),
        execute: async ({ path, content, reason }) => {
          if (!isPathAllowed(path) || isProtectedSystemPath(path)) {
            return { ok: false, error: `Write denied: "${path}" is outside the writable area or is system-managed.` };
          }
          try {
            const res = USE_GITHUB
              ? await writeFile(path, content, repo, owner, `[agent] ${reason}`)
              : await writeFileLocal(path, content);
            return { ok: true, path: res.path, created: res.created };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "write failed" };
          }
        },
      }),
      loopStep: stepSchema,
    },
    stopWhen: stepCountIs(6),
  });

  const loopCall = result.toolCalls?.find((c) => c.toolName === "loopStep");
  if (loopCall && (loopCall as Record<string, unknown>).input) {
    const data = (loopCall as Record<string, unknown>).input as {
      action: string;
      result: string;
      done: boolean;
    };
    return {
      step: {
        step: priorSteps.length + 1,
        action: data.action,
        result: data.result,
        time: new Date().toISOString(),
      },
      done: data.done,
    };
  }

  // No structured loopStep call — fall back to a best-effort step rather than failing the run.
  const fallbackResult = result.text.trim() || "(no report produced this step)";
  return {
    step: {
      step: priorSteps.length + 1,
      action: "worked toward the goal",
      result: fallbackResult,
      time: new Date().toISOString(),
    },
    done: false,
  };
}

/** Serialize the current run state and write it to the loop's markdown file. */
export async function persistLoop(
  input: LoopInput,
  steps: LoopStep[],
  status: LoopStatus,
  lastError: string
): Promise<void> {
  "use step";

  const run: LoopRun = {
    loopId: input.loopId,
    goal: input.goal,
    status,
    startedAt: input.startedAt,
    updatedAt: new Date().toISOString(),
    sliceOrigin: input.sliceOrigin,
    tags: input.tags,
    iterations: steps.length,
    maxIterations: input.maxIterations,
    lastError,
    steps,
  };

  await writeLoopFile(input.filePath, serializeLoop(run));
}
