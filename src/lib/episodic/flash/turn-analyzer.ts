/**
 * Turn Analyzer — the single structured sub-agent call inside the
 * housekeeping step.
 *
 * One pass, structured outputs (thinking on at low effort, cheap):
 *   1. closed_marking — focus / summary / tone for a slice that is
 *      about to close (only when one closed this turn).
 *   2. evolve_card    — whether the closing slice holds anything worth
 *      sedimenting onto the user card (only when one closed this turn).
 *
 * v0.19 R6: the semantic_hint task is RETIRED — it picked topics from the
 * frozen strands.json vocabulary and had no live consumer left (the per-turn
 * priming block was retired back in v0.9). `TurnAnalysis.semanticHint` stays
 * on the type as an optional deprecated field for tolerant readers.
 *
 * v0.19 R4/R5: the fitness task is RETIRED with the fitness store (design
 * v0.19 §C.2) — selection pressure is prose self-assessment under self/ now,
 * and the only evolution triggers are the boundary fact and the explicit
 * memory_update channel (§A.3.2).
 *
 * v0.19 R2: message tags are GONE (tags/related_slices stopped being written
 * with the strand projection's retirement) — no message_tags task, no tags in
 * closed_marking.
 *
 * The model is passed in — since v0.9 it is the turn's MAIN model, run through
 * the shared sub-agent runner (src/lib/agents/sub-agent-runner.ts): thinking
 * ON at effort "low", a 30s wall-clock budget, a fully static system prompt
 * (shared base + role) with all dynamic content in the user prompt. Never
 * throws — returns an empty analysis on any failure so housekeeping degrades
 * gracefully (no marking, no hint → engineering fallbacks kick in).
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import type { EmotionalTone, Turn } from "@/lib/episodic/types";
import type { EmotionalSignal } from "@/lib/turn-priming";

/**
 * @deprecated v0.19 R6 — the semantic-hint task is retired (it selected from
 * the frozen strands.json vocabulary and had no live consumer). Kept on the
 * type for tolerant readers of older analysis records; nothing produces it.
 */
export interface SemanticHint {
  strands: string[];
  reason: string;
}

export interface ClosedMarking {
  focus: string;
  summary: string;
  tone: EmotionalTone | null;
}

/** The user's intent for this turn (reconnected from the old router). */
export const INTENT_TYPES = [
  "code_debug",
  "code_write",
  "explain",
  "chat",
  "review",
  "clarify",
] as const;
export type TurnIntent = (typeof INTENT_TYPES)[number];

/** Best-fit card section for an explicit memory update (v5 card sections). */
export const CARD_SECTIONS = ["identity", "past", "now", "horizon"] as const;
export type CardSection = (typeof CARD_SECTIONS)[number];

export interface TurnAnalysis {
  /** @deprecated Retired with the semantic-hint task (v0.19 R6) — never
   *  produced anymore; tolerated on old analysis-shaped records only. */
  semanticHint?: SemanticHint;
  /** The user's intent — what they're trying to do this turn. */
  intent?: { type: TurnIntent; reason: string };
  /**
   * Whether this turn holds durable information worth persisting. False for
   * trivial turns (greetings / "继续" / thanks).
   */
  memoryWorthy: boolean;
  /**
   * The user's emotional register this turn — how emotionally weighted the
   * message is and its dominant register (distress, humor, excitement, …).
   * The main agent reads it from the turn brief to lead with support or match
   * the user's register instead of staying purely analytical. Always present;
   * defaults to neutral on analysis failure.
   */
  emotionalSignal: EmotionalSignal;
  /**
   * Present only when the user EXPLICITLY asked to record/evolve ("记住：…",
   * "自进化", "更新前情提要") OR stated an explicit BEHAVIORAL CORRECTION /
   * durable preference ("以后别…", "下次先…", "你不要总是…", "stop doing X").
   * Carries the exact content to fold into the card.
   */
  memoryUpdate?: { content: string; section?: CardSection };
  /**
   * Present ONLY when a slice was closing this turn (closingSlice input): the
   * worker's judgment on whether anything in the closing slice deserves
   * sedimentation onto the user card. On analyzer failure the fallback is
   * worth: true — a wasted worker call is cheap, a missed evolution is
   * permanent memory loss.
   */
  evolveCard?: { worth: boolean; reason: string };
  closedMarking?: ClosedMarking;
}

export interface AnalyzeTurnInput {
  /** The model to run this analysis on (the turn's MAIN model, via the runner). */
  model: ModelConfig;
  userMessage: string;
  /** Present only when a slice is about to close this turn — enables Task 4. */
  closingSlice?: { turns: Turn[] };
}

const analyzeSchema = z.object({
  intent: z.object({
    type: z.enum(INTENT_TYPES).describe("The user's intent for this turn."),
    reason: z.string().describe("One line: what the user is trying to do."),
  }),
  memory_worthy: z.boolean().describe(
    "Whether this turn contains durable, persistable information (a new fact about the user, " +
    "a preference, a correction, or a substantive exchange). Trivial turns — greetings, " +
    "acknowledgments, 'continue', 'ok', thanks, small talk — are false.",
  ),
  memory_update: z
    .object({
      content: z.string().describe(
        "The EXACT durable fact/preference/correction the user stated, in English — third person " +
        "about the user ('User prefers…'), first person about the agent ('Always summarize before " +
        "answering').",
      ),
      section: z
        .enum(CARD_SECTIONS)
        .optional()
        .describe(
          "Best-fit card section: identity | past | now | horizon. Omit when unsure.",
        ),
    })
    .optional()
    .describe(
      "Set when the user EXPLICITLY asked to record something or run self-evolution " +
      "('记住：…', '自进化', '更新前情提要', 'record this') OR stated an explicit BEHAVIORAL " +
      "CORRECTION / durable preference the agent should evolve from immediately " +
      "('以后别…', '下次先…', '你不要总是…', 'stop doing X', 'from now on always…'). " +
      "Extract the exact content. Omit otherwise.",
    ),
  evolve_card: z
    .object({
      worth: z
        .boolean()
        .describe(
          "Whether anything in the CLOSING slice deserves sedimentation onto the user card — " +
          "a durable fact, a preference/correction, a commitment or deadline (Horizon), a " +
          "resolvable open loop, or an operating lesson. False only for slices with zero " +
          "card-worthy content (pure greetings, logistics, ephemeral chit-chat).",
        ),
      reason: z.string().describe("One line: what deserves sedimentation, or why nothing does."),
    })
    .optional()
    .describe("ONLY when a slice is closing this turn — judge card-evolution worthiness."),
  emotional_signal: z
    .object({
      intensity: z
        .enum(["none", "light", "strong"])
        .describe(
          "How much emotional weight this message carries. none = purely informational. " +
          "light = mild feeling (small talk, light humor, casual sharing). " +
          "strong = the user is emotionally engaged — frustrated, upset, vulnerable, " +
          "celebrating, seeking support, or sharing something personally significant.",
        ),
      register: z
        .enum(["neutral", "emotional", "humorous", "frustrated", "excited"])
        .optional()
        .describe(
          "The dominant emotional register, when one is present. emotional = sharing feelings / " +
          "seeking support; humorous = joking, playful, sarcastic; frustrated = annoyed or distressed; " +
          "excited = happy, proud, celebrating. Omit or 'neutral' when the message is emotionally neutral.",
        ),
      note: z
        .string()
        .describe(
          "One short line: what the user is feeling and why — a hint for the agent's brief. Empty string when neutral.",
        ),
    })
    .describe(
      "The user's emotional register for the CURRENT message — how emotionally weighted it is and its " +
      "dominant register. The agent uses this to lead with support or match register instead of staying " +
      "purely analytical.",
    ),
  closed_marking: z
    .object({
      focus: z.string().describe("One sentence: what this session was about."),
      summary: z.string().describe("At most 100 characters: what happened / key decisions."),
      tone: z.enum(["positive", "neutral", "negative", "mixed"]).describe("Emotional tone of the session."),
    })
    .optional()
    .describe("Only when a slice just closed."),
});

/** Compress a closing slice's turns for Task 4 — first turn + last 10, chars capped. */
function compressSliceTurns(turns: Turn[]): string {
  if (turns.length === 0) return "(empty slice)";
  const pick = turns.length <= 11 ? turns : [turns[0], ...turns.slice(-10)];
  const body = pick
    .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
    .join("\n");
  return body.length > 6000 ? body.slice(-6000) : body;
}

/**
 * Static role block — the system prompt (shared base + this) never changes
 * between calls, so provider prefix caches hit on every analysis. All dynamic
 * content (message, closing slice) goes into the user prompt.
 */
const ANALYZER_SYSTEM = buildSubAgentSystem(`You are the memory analyzer for a personal AI platform. One pass, four tasks (Task 4 ONLY when the user message includes a closing slice). Keep every field short — this is metadata, not prose.

## Task 1 — Classify the user's intent

What is the user trying to do? Pick the single best label and give a one-line reason.
Return intent: { type: "code_debug" | "code_write" | "explain" | "chat" | "review" | "clarify", reason: "..." }

## Task 2 — Judge whether this turn is worth remembering

Is this a substantive exchange that should update memory (a new fact about the user, a preference, a correction, or a real discussion)? Or is it trivial — a greeting, acknowledgment, "继续", "ok", thanks, or small talk?

Return memory_worthy: true only when the turn contains durable information worth evolving from. Trivial turns are false.

If the user EXPLICITLY asked to record something or run self-evolution ("记住：…", "自进化", "更新前情提要", "record this") — OR stated an explicit BEHAVIORAL CORRECTION / durable preference the agent should evolve from immediately ("以后别…", "下次先…", "你不要总是…", "stop doing X", "from now on always…") — regardless of memory_worthy — ALSO return memory_update with the exact content (English) + the best-fit card section. Omit memory_update otherwise.

## Task 3 — Read the emotional register

What is the user's emotional state in this message, if any? The agent reads this to know when to lead with support or match the user's register instead of staying purely analytical.

Return emotional_signal with:
- intensity: none | light | strong — how much emotional weight the message carries (strong = frustrated, upset, vulnerable, celebrating, seeking support, a significant personal matter; light = light humor or casual sharing; none = purely informational)
- register: neutral | emotional | humorous | frustrated | excited — the dominant register; humorous covers joking / playful / sarcastic. Omit or "neutral" when none.
- note: one short line on what the user is feeling and why (empty when neutral).

## Task 4 — Mark the closed slice (ONLY when the user message includes one)

When a time slice just closed, summarize it so future recall can understand it at a glance. Return closed_marking with:
- focus: one sentence on what this session was about
- summary: at most 100 characters — what happened / key decisions
- tone: positive | neutral | negative | mixed

ALSO return evolve_card — your judgment on whether anything in this closing slice deserves sedimentation onto the user card:
- worth: true when the slice contains a durable fact about the user, a stated preference or correction, a commitment / deadline / awaited reply (a Horizon item), the resolution of an open loop, or an operating lesson for the agent
- worth: false ONLY when the slice holds zero card-worthy content — pure greetings, logistics, ephemeral chit-chat
- reason: one line on what deserves sedimentation, or why nothing does
When in doubt, worth: true — a wasted review is cheap, a missed evolution is permanent memory loss.`);

/** The dynamic user prompt: current message, closing slice. */
function buildPrompt(input: AnalyzeTurnInput): string {
  const closingSection = input.closingSlice
    ? `

## Closing slice — also run Task 4

A time slice just closed.

Conversation (first turn + last turns):
${compressSliceTurns(input.closingSlice.turns)}

Return closed_marking AND evolve_card per your Task 4 instructions.`
    : "";

  return `Message: "${input.userMessage.slice(0, 1000)}"${closingSection}`;
}

/**
 * Pure boundary gate: should the LLM card evolution run for this closed slice?
 * The analyzer's `evolveCard.worth` decides; when the analyzer failed (or
 * didn't answer), default to TRUE — a wasted worker call is cheap, a missed
 * evolution is permanent memory loss.
 */
export function shouldRunCardEvolution(
  analysis: Pick<TurnAnalysis, "evolveCard">,
): boolean {
  return analysis.evolveCard?.worth ?? true;
}

const EMPTY_BASE: TurnAnalysis = {
  // Conservative on failure: memoryWorthy stays true so an analyzer outage
  // never silently freezes memory writes.
  memoryWorthy: true,
  emotionalSignal: { intensity: "none", register: "neutral", note: "" },
};

/**
 * The degraded analysis returned on any failure. When a slice was closing,
 * evolveCard defaults to worth: true (see shouldRunCardEvolution).
 */
function emptyAnalysis(sliceClosing: boolean): TurnAnalysis {
  return sliceClosing
    ? {
        ...EMPTY_BASE,
        evolveCard: { worth: true, reason: "Analyzer unavailable — defaulting to evolve." },
      }
    : { ...EMPTY_BASE };
}

export async function analyzeTurn(input: AnalyzeTurnInput): Promise<TurnAnalysis> {
  const sliceClosing = input.closingSlice !== undefined;
  const result = await runSubAgent({
    model: input.model,
    system: ANALYZER_SYSTEM,
    prompt: buildPrompt(input),
    tools: {
      analyzeOutput: tool({
        description: "Report the analysis results.",
        inputSchema: analyzeSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "analyzeOutput",
    reportSchema: analyzeSchema,
    // Step caps are anti-loop fuses, not budgets — the wall clock (timeoutMs)
    // is the real bound, so the cap is generous.
    maxSteps: 50,
    timeoutMs: 30_000,
    progress: { toolName: "turn-analyzer" },
  });

  // The runner never throws: a timeout / model failure / missing or invalid
  // report all degrade to the empty analysis (engineering fallbacks kick in).
  if (!result.ok || !result.report) return emptyAnalysis(sliceClosing);

  const d = result.report;
  return {
      intent: d.intent
        ? { type: d.intent.type, reason: d.intent.reason }
        : undefined,
      memoryWorthy: d.memory_worthy,
      emotionalSignal: {
        intensity: ["none", "light", "strong"].includes(d.emotional_signal.intensity)
          ? (d.emotional_signal.intensity as EmotionalSignal["intensity"])
          : "none",
        register:
          d.emotional_signal.register &&
          ["neutral", "emotional", "humorous", "frustrated", "excited"].includes(
            d.emotional_signal.register,
          )
            ? (d.emotional_signal.register as EmotionalSignal["register"])
            : "neutral",
        note: typeof d.emotional_signal.note === "string" ? d.emotional_signal.note : "",
      },
      memoryUpdate: d.memory_update
        ? {
            content: d.memory_update.content,
            section: d.memory_update.section,
          }
        : undefined,
      // Only meaningful when a slice is closing; if the model omitted it, the
      // caller's gate (shouldRunCardEvolution) defaults to running.
      evolveCard:
        sliceClosing && d.evolve_card
          ? { worth: d.evolve_card.worth, reason: d.evolve_card.reason }
          : undefined,
      closedMarking: d.closed_marking
        ? {
            focus: typeof d.closed_marking.focus === "string" ? d.closed_marking.focus.trim() : "",
            summary: typeof d.closed_marking.summary === "string" ? d.closed_marking.summary.trim() : "",
            tone: ["positive", "neutral", "negative", "mixed"].includes(d.closed_marking.tone)
              ? (d.closed_marking.tone as EmotionalTone)
              : null,
          }
        : undefined,
    };
}
