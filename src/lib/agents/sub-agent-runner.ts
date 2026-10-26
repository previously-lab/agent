/** Shared native DeepSeek sub-agent: fixed role profile, structured reports and partial progress. */
import { streamText } from "@/lib/deepseek/generate";
import { isStepCount } from "@/lib/deepseek/tools";
import type { DeepSeekRole, PrepareStepFunction, ToolSet } from "@/lib/deepseek/types";
import type { UIMessageChunk } from "@/lib/chat/protocol";
import { getWritable } from "workflow";
import type { z } from "zod";
import { FIXED_MODEL, type ModelConfig } from "@/lib/models/registry";
import { withStepTimeout } from "@/lib/chat/step-timeout";
import { readSelfSopSnapshot } from "@/lib/evolution/store";
import type { SelfAgent } from "@/lib/evolution/paths";
import { readSkillLedger } from "@/lib/evolution/skill-store";
import { renderRoleSkillGuidance, type SkillRole } from "@/lib/evolution/skill-policy";
import { shouldEmitProgress, type ProgressLine, type ProgressWriteState, type ToolProgressStage } from "@/lib/chat/progress-throttle";
export async function resolveSubAgentModel(_ctx?: { mainModel?: ModelConfig }): Promise<ModelConfig> { return FIXED_MODEL; }
export interface SubAgentProgressRef {

  toolCallId?: string;

  toolName: string;
}

export interface ProgressEmitter {

  emit(line: string, stage: ToolProgressStage): void;

  close(finalLine?: string, stage?: ToolProgressStage): void;
}


export function createProgressEmitter(
  ref?: SubAgentProgressRef,
): ProgressEmitter {
  const noop: ProgressEmitter = { emit() {}, close() {} };
  if (!ref?.toolCallId) return noop;
  const { toolCallId, toolName } = ref;

  let writer: WritableStreamDefaultWriter<UIMessageChunk> | null | undefined;
  let state: ProgressWriteState = {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
  };

  const send = (line: string, stage: ToolProgressStage) => {
    if (writer === undefined) {
      try {
        writer = getWritable<UIMessageChunk>().getWriter();
      } catch {
        writer = null; // not inside a workflow step — stay noop
      }
    }
    if (!writer) return;
    void writer
      .write({
        type: "data-tool-progress",
        id: `tool-${toolCallId}`,
        data: { toolCallId, toolName, text: line, stage },
      })
      .catch(() => {});
  };

  return {
    emit(line, stage) {
      if (!line) return;
      const now = Date.now();
      if (!shouldEmitProgress(state, { line, stage }, now)) return;
      state = { lastWriteMs: now, lastLine: line, lastStage: stage, sentAny: true };
      send(line, stage);
    },
    close(finalLine, stage = "done") {
      try {
        // Push the final line so the box settles on it (the last throttled
        // write may have been a few lines behind).
        if (finalLine && (finalLine !== state.lastLine || stage !== state.lastStage)) {
          send(finalLine, stage);
        }
        writer?.releaseLock();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Report extraction ─────────────────────────────────────────────────────


export function extractToolReport<S extends z.ZodType>(
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> | undefined,
  reportToolName: string,
  reportSchema: S,
): z.infer<S> | undefined {
  const call = toolCalls?.find((tc) => tc.toolName === reportToolName);
  if (!call || call.input === undefined || call.input === null) return undefined;
  const parsed = reportSchema.safeParse(call.input);
  return parsed.success ? parsed.data : undefined;
}

// ─── Runner ────────────────────────────────────────────────────────────────



export interface RunSubAgentOptions<Report> {
  /** Parent cancellation must reach the model request, not just a waiting caller. */
  abortSignal?: AbortSignal;
  model?: ModelConfig;
  role?: DeepSeekRole;
  system?: string; selfSop?: SelfAgent; skillRole?: SkillRole; prompt: string; tools: ToolSet;
  toolChoice?: "auto" | "required" | "none";
  reportToolName?: string; reportSchema?: z.ZodType<Report>; maxSteps?: number;
  prepareStep?: PrepareStepFunction<ToolSet>;
  onToolProgress?: (toolCall: {toolName: string; input: unknown}) => ProgressLine | undefined;
  timeoutMs?: number;
  progress?: SubAgentProgressRef; startLine?: string;
  onLine?: (line: string, stage: "thinking" | "writing") => void;
}
export interface SubAgentResult<Report> {
  ok: boolean; report?: Report; text: string; reasoning?: string;
  sources?: Array<{sourceType: string; url?: string; title?: string}>;
  timedOut?: boolean; error?: string;
}
export async function runSubAgent<Report = unknown>(opts: RunSubAgentOptions<Report>): Promise<SubAgentResult<Report>> {
  const skillRole = opts.skillRole ?? opts.selfSop;
  const [sop, skillState] = await Promise.all([
    opts.selfSop
      ? readSelfSopSnapshot(opts.selfSop, undefined, { fresh: false }).catch(() => null)
      : Promise.resolve(null),
    skillRole
      ? readSkillLedger().catch(() => null)
      : Promise.resolve(null),
  ]);
  const guidance = skillRole
    ? renderRoleSkillGuidance({
        role: skillRole,
        hostReservedChars: 2,
        ledger: skillState?.status === "ok" ? skillState.ledger : null,
        legacySop: sop?.content?.trim() && opts.selfSop
          ? {
              content: sop.content,
              ref: sop.origin === "legacy"
                ? `agent-playbooks/${opts.selfSop}.md`
                : `self/${opts.selfSop}/index.md`,
            }
          : null,
        stateDiagnostic: skillState?.status === "corrupt"
          ? "Skill ledger is corrupt; adopted skills were not injected and the ledger was not reset."
          : skillState?.status === "unavailable"
            ? "Skill ledger is unavailable; adopted skills were not injected."
            : undefined,
      })
    : { text: "" };
  const guidedSystem = guidance.text
    ? (opts.system ?? "") + `\n\n${guidance.text}`
    : opts.system;
  const system = opts.reportToolName ? (guidedSystem ?? "") + `\n\nFinish by calling ${opts.reportToolName} with the structured report. Do not substitute a prose-only answer for that report.` : guidedSystem;
  const emitter = createProgressEmitter(opts.progress);
  if (opts.startLine) emitter.emit(opts.startLine, "running");
  let text = "", reasoning = "";
  const pushLine = () => {
    const source = text || reasoning;
    if (!source) return;
    const line = source.slice(source.lastIndexOf("\n") + 1);
    const stage = text ? "writing" : "thinking";
    emitter.emit(line, stage); opts.onLine?.(line, stage);
  };
  const run = async () => {
    opts.abortSignal?.throwIfAborted();
    const stream = await streamText({ role: opts.role ?? "recall", system, prompt: opts.prompt,
      abortSignal: opts.abortSignal,
      tools: opts.tools, toolChoice: opts.toolChoice === "none" ? "none" : "auto", thinking: true,
      ...(opts.maxSteps !== undefined ? {stopWhen: isStepCount(opts.maxSteps)} : {}),
      ...(opts.timeoutMs !== undefined ? {timeout: opts.timeoutMs} : {}),
      prepareStep: opts.prepareStep,
      onToolExecutionStart: ({toolCall}) => {
        const line = opts.onToolProgress?.(toolCall);
        if (line?.line) emitter.emit(line.line, line.stage);
      },
      onChunk: ({chunk}) => {
        if (chunk.type === "text-delta") text += chunk.text ?? chunk.delta ?? "";
        else if (chunk.type === "reasoning-delta") reasoning += chunk.text ?? chunk.delta ?? "";
        pushLine();
      },
    });
    const [finalText, calls, finalReasoning, sources] = await Promise.all([stream.text, stream.toolCalls, stream.reasoningText, stream.sources]);
    return { ok: true as const, text: finalText ?? "", reasoning: finalReasoning,
      report: opts.reportToolName && opts.reportSchema ? extractToolReport(calls, opts.reportToolName, opts.reportSchema) : undefined,
      ...(sources?.length ? {sources} : {}),
    };
  };
  try {
    if (opts.timeoutMs === undefined) return await run();
    const result = await withStepTimeout(run, opts.timeoutMs + 3000);
    if (result.ok) return result.result!;
    return {ok:false, timedOut:true, text, reasoning, error:"Sub-agent deadline exceeded"};
  } catch(error) {
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    return {ok:false, text, reasoning, ...(timedOut ? {timedOut:true} : {}), error:timedOut && opts.timeoutMs !== undefined ? `Sub-agent did not finish within ${Math.round(opts.timeoutMs / 1000)}s.` : error instanceof Error ? error.message : "Sub-agent failed"};
  } finally {
    const source = text || reasoning;
    emitter.close(source ? source.slice(source.lastIndexOf("\n")+1) : undefined, text ? "writing" : "thinking");
  }
}
