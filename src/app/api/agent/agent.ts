/** The fixed DeepSeek brain; model and tool calls remain individual Workflow steps. */
import { DeepSeekAgent, type DeepSeekAgentOptions } from "@/lib/deepseek/workflow-agent";
import type { ModelConfig } from "@/lib/models/registry";
import { getChatTools, workCheckpointTool, completeWorkTool, readWorkSnapshotTool, type buildChatToolsContext } from "./tools";
import { mediateReplayedRecordReads, rememberPublicRecordReads } from "@/lib/chat/scenario-recall-contract";
import type { ModelMessage, StepResult } from "@/lib/deepseek/types";
import { dialogueOfferId } from "@/lib/dialogue/transport";
import type { WorkUpdateResult } from "@/lib/dialogue/work-contract";
import { tool } from "@/lib/deepseek/tools";
import { thinkingReportSchema } from "@/lib/agents/thinking-product";
import { WORK_RESPONSE_MODES, WORK_RESPONSE_MODE_GUIDANCE } from "@/lib/dialogue/work-contract";
export type ChatToolSet = ReturnType<typeof getChatTools>;
export type ChatAgent = DeepSeekAgent<ChatToolSet>;

function recordMediation(scopeId: string | undefined, onStepEnd?: DeepSeekAgentOptions<ChatToolSet>["onStepEnd"]) {
  // Agent instances belong to one work; its timeout/length continuations
  // reuse these exact runner messages. A fresh work starts without trust.
  const trusted = new WeakSet<ModelMessage>();
  return {
    prepare(messages: ModelMessage[]) {
      const mediated = mediateReplayedRecordReads(messages, trusted);
      messages.splice(0, messages.length, ...mediated);
    },
    async onStepEnd(step: StepResult<ChatToolSet>) {
      rememberPublicRecordReads(step, scopeId, trusted);
      await onStepEnd?.(step);
    },
  };
}

function sessionFromTools(contexts: Record<string, unknown>): string | undefined {
  for (const context of Object.values(contexts)) {
    if (context && typeof context === "object" && typeof (context as { sliceId?: unknown }).sliceId === "string") {
      return (context as { sliceId: string }).sliceId;
    }
  }
  return undefined;
}

export function createChatAgent(opts: {
  model: ModelConfig; thinking: boolean; reasoningEffort: "low" | "medium" | "high";
  toolsContext: ReturnType<typeof buildChatToolsContext>;
  onStepEnd?: DeepSeekAgentOptions<ChatToolSet>["onStepEnd"];
  onToolExecutionResult?: DeepSeekAgentOptions<ChatToolSet>["onToolExecutionResult"];
}): ChatAgent {
  const mediation = recordMediation(opts.toolsContext.recallRead?.readScopeId, opts.onStepEnd);
  return new DeepSeekAgent({ role: "chat", thinking: true,
    instructions: "You are the user's personal agent with layered episodic memory. Answer from the provided context; use the memory tools to recall details when needed.",
    tools: getChatTools(), toolsContext: opts.toolsContext, onStepEnd: mediation.onStepEnd,
    sessionId: sessionFromTools(opts.toolsContext),
    prepareStep: ({ messages }) => mediation.prepare(messages) });
}

/** Public wording only: one-shot, non-thinking DeepSeek Chat Completions. */
export function createDialogueAgent(checkpoint = false, direct = false, sessionId?: string) {
  return new DeepSeekAgent({
    publicWording: true,
    role: "chat",
    ...(sessionId ? { sessionId } : {}),
    thinking: false,
    reasoningEffort: "low",
    temperature: 0.2,
    tools: {},
    instructions: [
      "Speak as Previously to the person who wrote sourceInput.text. Answer what they mean now, in their language and register. A greeting, thanks or personal observation can be a whole exchange.",
      "The thinking role supplies facts and judgments through the handoff. You own the wording. Follow currentTaskContract.modeGuidance and preserve the requested form. Keep attribution, corrections and uncertainty intact. Preserve qualifications about order or coverage, and quote only verified wording. A proposal alone cannot establish agreement.",
      "Use priorContext to understand the user. priorCheckpoints contain earlier findings; alreadySaid contains previous publications for this request. Build on what has been said. Repeat a point when a requested recap or a correction needs it.",
      "For needs_user, ask the specific question that unblocks the work. In chat, respond to what mattered to the user in this moment. When someone simply shares a feeling, receive it and leave the next turn to them. A follow-up question is useful when the person has actually invited you to explore something with them.",
      "Keep internal activity out of everyday replies. When the user asks to debug Previously, use exact names where helpful and distinguish recorded publication from what a browser displayed. Keep private reasoning and raw tool payloads private. Native artifacts are delivered separately; never reprint their HTML.",
      ...(direct ? ["Address the current candidates. A later remark in priorContext can change how to phrase this reply; it does not assign you a new task."] : []),
      ...(checkpoint ? [
        "Give the part of the original question this handoff already answers. Leave the open question for its own reply unless it changes how to use this finding. If that qualification matters, describe what you still need to verify. Claim an outside decision is pending only when the handoff independently establishes its current status. For plans, routine activity or a finding already published, return empty text.",
      ] : [
        "Complete the exchange with the answer that is still due. After a useful checkpoint, lead with what it left open. Avoid a second opening or a recap unless the user asked for one.",
      ]),
    ].join("\n"),
  });
}
/** Native thinking hands off tool events; the unsplit legacy mode retains its text contract. */
export function createThinkingAgent(opts: Parameters<typeof createChatAgent>[0]) {
  const workContext = Object.values(opts.toolsContext)[0]?.dialogueOffer;
  const mediation = recordMediation(opts.toolsContext.recallRead?.readScopeId, opts.onStepEnd);
  let completionAccepted = false;
  const tools = {
    ...(workContext ? { workCheckpoint: workCheckpointTool, completeWork: completeWorkTool } : {}),
    ...getChatTools(),
    ...(workContext ? { readWorkSnapshot: readWorkSnapshotTool } : {}),
    finishThinking: tool({
      description: (workContext
        ? "End the private run after completeWork succeeds in an earlier step. The handoff already carries the answer. Include structured findings when attribution or a memory update needs them. An empty report is sufficient otherwise. If only the user can unblock the task, finish with needsUser instead of completeWork. Keep working on any remaining questions you can resolve yourself."
        : "Finish this work with compact findings when source attribution, a proposal, an explicit user decision or a missing dependency matters. For an ordinary short answer, just return the short answer; this tool is optional. This is a terminal result, not a public utterance.") +
        " Use evidenceIds from this run's real reads. Omit memoryDelta unless there is a useful new conclusion worth preserving.",
      inputSchema: thinkingReportSchema,
    }),
  };
  const toolsContext = Object.fromEntries(Object.entries(opts.toolsContext).map(([name, context]) =>
    [name, { ...context, thinkingFlow: true }]));
  if (workContext) {
    toolsContext.workCheckpoint = { ...Object.values(opts.toolsContext)[0], thinkingFlow: true };
    toolsContext.completeWork = { ...Object.values(opts.toolsContext)[0], thinkingFlow: true };
    toolsContext.readWorkSnapshot = { ...Object.values(opts.toolsContext)[0], thinkingFlow: true };
  }
  const instructions = [
    ...(workContext ? [
      "You are Previously's private thinking role. Work on what the user brings up in the current input. Make factual judgments and hand off the answer through tools. The dialogue role writes the public reply.",
      "Choose a responseMode for this request and include it in completeWork. Match the handoff to what was asked: for a rewrite or short answer, return the requested text or fact in the requested form.",
      ...WORK_RESPONSE_MODES.map(mode => `${mode}: ${WORK_RESPONSE_MODE_GUIDANCE[mode]}`),
      "If the conversation already answers the question, no snapshot or search is needed. For a personal remark you already understand, go straight to completeWork with what matters to the user now. Before a lookup, identify the missing fact that would change your reply. Recognizing a name or finding more background is insufficient on its own. A pending lookup supplies no finding.",
      "When one part is settled and independent work remains, send the supported point with workCheckpoint alongside the next independent lookup in the same tool step. Include the caveat that affects this point. Leave independently unresolved questions for their own handoff. Skip openings, plans, running commentary and already published conclusions. If the whole answer is ready, go straight to completion. Include a rejected checkpoint's finding in the final handoff.",
      "When ready, call completeWork exactly once with the answer, material caveats and every complete native HTML artifact. Describe a link only in the direction the source shows. Confine a missing-record claim to the material actually checked. After acceptance, call finishThinking in a separate later step.",
      "If only the user can unblock the work, use finishThinking alone with needsUser, including after previous checkpoints. An inconclusive search may still support an answer with a caveat.",
    ] : [
      "You are working privately. Give the public dialogue role the result in the form the user requested. Leave out private reasoning and tool logs. For a native visual, include the complete original document once in final text; the host will pass the dialogue role an artifact reference.",
    ]),
    "Use the conversation to resolve who or what the user means. A new development they tell you about is already evidence of what happened. Retrieve from memory when the response needs a particular fact absent from the exchange. For a factual question about the past, read the relevant case. Use original messages when the question needs exact wording, disputed attribution or proof of a decision.",
    "When reporting findings, distinguish the current user's report, a prior user's exact words, your proposal, and an explicit adoption. Do not assert that a tool result or assistant suggestion was confirmed by the user. Preserve scope and uncertainty.",
  ].join("\n");
  return new DeepSeekAgent({ role: "chat", thinking: true, tools, toolsContext, onStepEnd: mediation.onStepEnd,
    sessionId: sessionFromTools(opts.toolsContext),
    onToolExecutionResult: async result => {
      if (workContext && !result.error && result.toolName === "completeWork") {
        const update = result.output as WorkUpdateResult | undefined;
        if (update?.ok === true && update.kind === "work-update" &&
            update.sourceInputId === workContext.sourceInputId &&
            update.updateId === dialogueOfferId(workContext.workId, result.toolCallId)) completionAccepted = true;
      }
      await opts.onToolExecutionResult?.(result);
    },
    instructions,
    prepareStep: ({ messages, stepNumber }) => {
      mediation.prepare(messages);
      const activeTools = completionAccepted ? ["finishThinking" as const] : undefined;
      const system = messages.find((message) => message.role === "system");
      if (stepNumber === 0 && workContext && system?.role === "system" &&
          typeof system.content === "string" && system.content !== instructions) {
        return { system: `${system.content}\n\n${instructions}`, activeTools };
      }
      return { activeTools };
    },
  });
}
