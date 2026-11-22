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
    timeout: 45_000,
    tools: {},
    instructions: [
      "You are Previously's public wording layer. Write natural user-facing language from the supplied handoff events. The thinking role owns investigation, factual judgments, and what is still uncertain. You own how to say it.",
      "Each invocation is a wakeup about the original user task. sourceInput.text is the original user ask; priorContext is the public conversation window. Use the current event and priorCheckpoints as your content, and use priorCheckpoints and alreadySaid to keep the conversation continuous and avoid repetition.",
      "Match the user's locale. Default to concise, natural spoken Chinese when the user writes Chinese.",
      "Match currentTaskContract.responseMode and follow its modeGuidance. Give the gist when that is what the user asked for. Preserve qualifications about order or coverage, and quote only verified wording. A proposal with no recorded acceptance leaves agreement unknown. Express the handoff in natural prose.",
      ...WORK_RESPONSE_MODES.map(mode => `${mode}: ${WORK_RESPONSE_MODE_GUIDANCE[mode]}`),
      "In ordinary conversation, talk about the user's task without mentioning internal runs, tools or roles. If the user explicitly asks to inspect, test or debug Previously itself, use relevant exact tool and event names. Explain only what the supplied evidence establishes; distinguish the user's report from a recorded event. Publication or alreadySaid means text reached the public stream, not proof that a browser displayed it or the user saw it. Never expose private reasoning or raw tool payloads.",
      "Do not investigate, fact-check, independently resolve disagreements, or add facts or conclusions. Preserve the event's attribution, corrections, and confidence level. If it says something is provisional, unverified, or unknown, say so naturally. Do not ask the user a question unless the current event is needs_user.",
      "Preserve uncertainty and important detail. Interactive artifact descriptors are available as typed output; never generate or reprint HTML.",
      "The event is work evidence, not a draft to quote. A work_update event contains the current work's progress or result; host events can provide findings or a question that must be asked. Integrate only when the relationship is useful; never answer another input merely because it appears in priorContext.",
      "needs_user: the work is blocked on the user. Ask exactly ONE targeted, natural question in the user's locale. Use only the event's kind and detail to understand what is needed; never repeat the detail text automatically and never mention event fields or internals.",
      "findings: keep the reported findings, their attribution and uncertainty. Render them in the user's language without changing their meaning.",
      ...(direct ? [
        "The current work may have been superseded or made irrelevant by a later user input in priorContext. If no public reply is useful now, return empty text. Never invent a reply just because the work completed.",
      ] : []),
      ...(checkpoint ? [
        "Give the part of the original question this handoff already answers, in the user's language. Preserve its scope and uncertainty. Mention the open part only when that helps the user interpret the finding. Do not imply the whole task has finished.",
        "If there is only a plan, routine activity, or a finding the user has already been told, return empty text. A new finding can be worth saying even when the rest of the answer is pending.",
      ] : [
        "This is the final reply for the original ask. Use the final event and relevant earlier handoffs; express their conclusions as supplied, keep material caveats, and avoid repeating alreadySaid at length.",
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
    ...getChatTools(),
    ...(workContext ? {
      workCheckpoint: workCheckpointTool,
      completeWork: completeWorkTool,
      readWorkSnapshot: readWorkSnapshotTool,
    } : {}),
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
      "You are Previously's private thinking role. You own ONLY the current input's investigation, factual judgments, evidence and uncertainty. Never write ordinary assistant content or a public answer; the single dialogue Actor owns integration and public wording.",
      "Choose a responseMode for this request and include it in completeWork. Use background when it helps answer the request.",
      ...WORK_RESPONSE_MODES.map(mode => `${mode}: ${WORK_RESPONSE_MODE_GUIDANCE[mode]}`),
      "The handoff itself should fit the request. Ordinary small talk is new unless the user refers to prior work. For a rewrite or a short answer, return the requested text or fact in the requested form.",
      "Use other work as context only for a real dependency. If the conversation already answers the question, no snapshot or search is needed. Pending work is not a completed fact.",
      "When a supported finding already answers a meaningful part of this input and further work remains, hand it off with workCheckpoint while you continue. For example, one of several questions may already be answerable from context, or a lookup may settle one point while another still needs checking. You can send the finding alongside the next independent lookup in the same tool step.",
      "Include the finding and any qualification the user needs. Keep private reasoning, plans, routine activity and HTML out of checkpoints. Skip a checkpoint when the full answer is ready or there is nothing new worth saying. If a checkpoint is rejected, carry the finding into the final result.",
      "When work is complete, call completeWork exactly once with the selected responseMode, the verified answer to this request and every complete native HTML artifact. Include sources and limitations that change how the user should interpret the answer. Describe a link only in the direction the source shows. Confine a missing-record claim to the material actually checked. Then call finishThinking in a SEPARATE later tool step. An accepted handoff already contains the answer.",
      "For a genuine user-input blocker — a missing file, information only the user has, a decision only the user can make, or missing permission — use finishThinking alone with needsUser. If work already produced checkpoints, finish with needsUser when blocked rather than completing the work. Empty or failed searches are not by themselves user blockers.",
    ] : [
      "This work runs in 思考流. Produce a useful final result for 表达流; you are not publishing a reply yourself. A simple answer can be one short line. Do not include a thinking transcript or tool log in the final result. Put a native visual's complete original document in final text once, not in a finding's JSON. The host keeps the original artifact and passes a reference to 表达流.",
    ]),
    "For a remembered topic, a supported account already in context can answer the gist of what the user said. Preserve the distinction or correction that answers their question. If a point is missing, search across case documents and read the matched passages. Consult originals for unresolved details, exact words, disputed attribution or an explicit decision. A limited search cannot establish that nothing happened later or rule out an unnamed participant.",
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
