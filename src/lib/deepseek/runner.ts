import { fromNativeAssistant, toNativeMessages } from "./messages";
import { serializeTools, InvalidToolInputError } from "./tools";
import { ROLE_EFFORT, type AgentOptions, type AgentResult, type ModelCallStreamPart, type ModelRequest, type ModelResponse, type ToolSet, type StepResult, type TokenUsage, type ToolCall, type ToolResult, type ModelMessage, type ReasoningEffort } from "./types";

export type ModelCaller = (request: ModelRequest) => Promise<ModelResponse>;
export type EventWriter = (event: ModelCallStreamPart) => void | Promise<void>;
export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 };
}
function addUsage(total: TokenUsage, next: TokenUsage): void {
  for (const key of Object.keys(total) as Array<keyof TokenUsage>) total[key] += next[key];
}
function effectiveSettings(options: Pick<AgentOptions, "role" | "thinking" | "reasoningEffort">): { thinking: boolean; effort: ReasoningEffort } {
  return { thinking: options.thinking ?? true, effort: options.reasoningEffort ?? ROLE_EFFORT[options.role ?? "chat"] };
}

/** Pure orchestration. The caller chooses plain HTTP or a durable model step. */
export async function runAgent<Tools extends ToolSet = ToolSet>(
  options: AgentOptions<Tools>, call: ModelCaller, emit: EventWriter = () => {}, callPrefix = "agent",
  durableTools = false,
): Promise<AgentResult<Tools>> {
  const messages: ModelMessage[] = [...(options.messages ?? [])];
  const system = options.system ?? options.instructions;
  if (system) messages.unshift({ role: "system", content: system });
  if (options.prompt !== undefined) messages.push({ role: "user", content: options.prompt });
  const steps: StepResult<Tools>[] = [];
  const allCalls: ToolCall[] = [];
  const allResults: ToolResult[] = [];
  const totalUsage = zeroUsage();
  const stopConditions = options.stopWhen ? (Array.isArray(options.stopWhen) ? options.stopWhen : [options.stopWhen]) : [];
  // Every caller has a finite loop. A report-only one-shot needs no executor.
  const stepLimit = Math.max(1, ...stopConditions.map((stop) => stop.maxSteps ?? 1));
  let finishReason = "stop";
  let finalText = "";
  let allReasoning = "";
  for (let stepNumber = 0; stepNumber < stepLimit; stepNumber++) {
    const preparation = await options.prepareStep?.({ stepNumber, steps, messages });
    if (preparation?.system !== undefined) {
      if (messages[0]?.role === "system") messages[0] = { role: "system", content: preparation.system };
      else messages.unshift({ role: "system", content: preparation.system });
    }
    const tools = preparation?.activeTools
      ? Object.fromEntries(Object.entries(options.tools ?? {}).filter(([name]) => preparation.activeTools!.includes(name))) as Tools
      : options.tools;
    const settings = effectiveSettings(options);
    const response = await call({ messages: toNativeMessages(messages), tools: serializeTools(tools),
      toolChoice: preparation?.toolChoice ?? options.toolChoice,
      thinking: settings.thinking, reasoningEffort: settings.effort, temperature: options.temperature,
      callId: `${callPrefix}:${stepNumber}`, timeoutMs: options.timeout, maxRetries: options.maxRetries });
    // A length/error finish may include an incomplete tool_calls fragment.
    // Preserve its text/thinking, but never leave unpaired calls in continuation.
    const permitsTools = response.finishReason === "tool_calls" || response.finishReason === "stop";
    const { tool_calls: incompleteCalls, ...textOnlyMessage } = response.message;
    const assistant = fromNativeAssistant(permitsTools ? response.message : textOnlyMessage);
    messages.push(assistant);
    finishReason = response.finishReason === "tool_calls" ? "tool-calls" : response.finishReason;
    const text = typeof response.message.content === "string" ? response.message.content : "";
    finalText = text;
    const reasoning = response.message.reasoning_content ?? "";
    allReasoning += reasoning;
    addUsage(totalUsage, response.usage);
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let hasUnexecutedReport = false;
    // Never execute an incomplete/truncated tool call.
    if (!permitsTools) for (const call of incompleteCalls ?? []) {
      await emit({ type: "tool-input-error", toolCallId: call.id, toolName: call.function.name,
        errorText: "The model response ended before this tool call completed." });
    }
    const prepared = [];
    for (const native of permitsTools ? response.toolCalls : []) {
      const definition = tools?.[native.function.name];
      let input: unknown;
      let inputError: unknown;
      try {
        input = JSON.parse(native.function.arguments);
        if (!definition) throw new InvalidToolInputError(native.function.name, "Unknown tool");
        input = definition.inputSchema.parse(input);
      } catch (error) {
        inputError = error instanceof InvalidToolInputError ? error : new InvalidToolInputError(native.function.name,
          error instanceof Error ? error.message : "Invalid JSON tool arguments");
      }
      const toolCall: ToolCall = { toolCallId: native.id, toolName: native.function.name, input,
        ...(inputError ? { invalid: true, error: inputError instanceof Error ? inputError.message : String(inputError) } : {}) };
      toolCalls.push(toolCall);
      await emit({ type: "tool-input-available", toolCallId: native.id, toolName: native.function.name, input });
      prepared.push({ native, definition, input, inputError, toolCall });
    }
    const completed = await Promise.all(prepared.map(async ({ native, definition, input, inputError, toolCall }): Promise<ToolResult | undefined> => {
      let output: unknown;
      let failure = inputError;
      if (!inputError) await options.onToolExecutionStart?.({ toolCall });
      if (inputError) {
        output = { error: inputError instanceof Error ? inputError.message : String(inputError) };
      } else if (!definition?.execute) {
        hasUnexecutedReport = true;
        return undefined;
      } else {
        const contextValue = options.toolsContext?.[native.function.name];
        const context = definition.contextSchema ? definition.contextSchema.parse(contextValue) : contextValue;
        // A method invocation would serialize `definition` as thisVal, including
        // its Zod schema. Invoke the standalone use-step function unbound.
        const execute = definition.execute;
        try {
          output = await execute(input, { toolCallId: native.id, messages, context, abortSignal: options.abortSignal });
        } catch (error) {
          // Workflow controls retry of durable executors. Plain research tools
          // return their failure to the model so other successful reads survive.
          if (durableTools || (error && typeof error === "object" && "name" in error &&
            ["FatalError", "RetryableError", "WorkflowRuntimeError"].includes(String(error.name)))) throw error;
          failure = error;
          output = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      const result: ToolResult = { toolCallId: native.id, toolName: native.function.name, output,
        ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) };
      return result;
    }));
    // Preserve provider order in prompt history even when tools finish out of
    // order. Tool executors above remain independently durable and concurrent.
    for (const result of completed) {
      if (!result) continue;
      const { toolCallId, toolName, output, error } = result;
      toolResults.push(result);
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId, toolName,
        output: typeof output === "string" ? { type: error ? "error-text" : "text", value: output }
          : { type: error ? "error-json" : "json", value: output ?? null } }] });
      await emit({ type: error ? "tool-output-error" : "tool-output-available", toolCallId,
        ...(error ? { errorText: String(error) } : { output }) });
    }
    const step: StepResult<Tools> = { text, reasoning: reasoning ? [{ type: "reasoning", text: reasoning }] : [],
      reasoningText: reasoning, toolCalls, toolResults, content: typeof assistant.content === "string" ? [] : assistant.content,
      finishReason, rawFinishReason: response.finishReason, usage: response.usage,
      response: { messages: [assistant, ...messages.slice(messages.indexOf(assistant) + 1)] }, warnings: [], stepNumber };
    steps.push(step); allCalls.push(...toolCalls); allResults.push(...toolResults);
    await options.onStepEnd?.(step);
    await emit({ type: "data-deepseek-step", id: `${callPrefix}:${stepNumber}:replay`, data: { messages: step.response.messages } });
    await emit({ type: "finish-step" });
    if (response.error) {
      const error = new Error(response.error.message);
      error.name = "DeepSeekError";
      if (response.error.statusCode !== undefined) Object.assign(error, { statusCode: response.error.statusCode });
      throw error;
    }
    if (!permitsTools || !response.toolCalls.length || hasUnexecutedReport || stopConditions.some((stop) => stop({ steps }))) break;
  }
  if (options.sendFinish !== false) await emit({ type: "finish", protocol: "deepseek-v1", finishReason, usage: totalUsage });
  return { text: finalText, reasoningText: allReasoning, toolCalls: allCalls, toolResults: allResults,
    messages, steps, finishReason, usage: totalUsage, totalUsage, sources: [], warnings: [] };
}
