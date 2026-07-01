/**
 * Slicing Decision Engine — determines when to close the active time slice
 * and start a new one.
 *
 * Decision order (by cost, cheapest first):
 * 1. Capacity (deterministic) — turns or tokens exceeded
 * 2. Time silence (deterministic) — too long since last activity
 * 3. Flash continuity (model call) — topic shift detected
 *
 * Flash's power is "add split", not "prevent split":
 * time silence and capacity always win. Flash is only consulted when
 * neither deterministic signal fires, and it only returns shouldSplit=true
 * when confidence exceeds the configured threshold.
 *
 * The actual split execution happens in the chat route, after Pro completes
 * its response. This module only produces the decision.
 */

import { generateText } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import type {
  FlashSplitInput,
  FlashSplitOutput,
  SlicingSignal,
} from "./types";
import type { TimeSlice } from "./types";

// ─── Configurable thresholds ────────────────────────────────────────────

/** Minutes of inactivity before a time-silence split triggers */
export const TIME_SILENCE_THRESHOLD_MINUTES = 30;

/** Maximum turns allowed in a single time slice */
export const MAX_TURNS_PER_SLICE = 50;

/** Maximum estimated tokens allowed in a single time slice */
export const MAX_TOKENS_PER_SLICE = 30000;

/**
 * Minimum Flash confidence required for a continuity-based split.
 * Flash must be highly confident to add a split on its own.
 */
export const FLASH_SPLIT_CONFIDENCE_THRESHOLD = 0.9;

// ─── Split decision ─────────────────────────────────────────────────────

/**
 * Full split decision returned to the chat route.
 * Includes the signal that triggered the decision so the route
 * can pass it to closeSlice() for audit purposes.
 */
export interface SplitDecision {
  /** Whether a new time slice should be created */
  shouldSplit: boolean;
  /** The signal that triggered this decision */
  source: SlicingSignal;
  /** Confidence 0.0–1.0 (1.0 for deterministic signals) */
  confidence: number;
  /** Human-readable explanation */
  reason: string;
  /** Suggested focus for the new slice if splitting */
  suggestedFocus?: string;
}

// ─── Token estimation ───────────────────────────────────────────────────

/**
 * Estimate token count from raw text length.
 * Rough heuristic: 4 characters ≈ 1 token.
 * Reuses the same formula as the context assembler.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Deterministic checks ───────────────────────────────────────────────

/**
 * Check whether enough wall-clock time has passed since the last message
 * to warrant starting a fresh time slice.
 *
 * @param lastActivity - Timestamp of the last turn in milliseconds (Date.now() style)
 * @param thresholdMinutes - Override the default silence threshold
 */
export function checkTimeSilence(
  lastActivity: number,
  thresholdMinutes: number = TIME_SILENCE_THRESHOLD_MINUTES
): boolean {
  const now = Date.now();
  const elapsedMs = now - lastActivity;
  const elapsedMinutes = elapsedMs / 60_000;
  return elapsedMinutes >= thresholdMinutes;
}

/**
 * Check whether the active slice has exceeded hard capacity limits.
 * Returns true if either the turn count or estimated token count
 * has crossed the configured maximum.
 */
export function checkCapacity(slice: TimeSlice): boolean {
  return (
    slice.turns.length > MAX_TURNS_PER_SLICE ||
    slice.estimatedTokens > MAX_TOKENS_PER_SLICE
  );
}

/**
 * Synchronous, deterministic split check. Evaluates capacity and time
 * silence rules — no model call. These are hard rules that always win.
 *
 * @param input - The Flash split input with timing and message data
 * @param activeSlice - The currently active time slice (used for capacity check).
 *                      If omitted, capacity checks are skipped.
 */
export function shouldSplit(
  input: FlashSplitInput,
  activeSlice?: TimeSlice
): SplitDecision {
  // ── Check 1: Capacity (hard limit) ──────────────────────────────────
  if (activeSlice && checkCapacity(activeSlice)) {
    const turnCount = activeSlice.turns.length;
    const tokenEstimate = activeSlice.estimatedTokens;

    let reason: string;
    if (turnCount > MAX_TURNS_PER_SLICE && tokenEstimate > MAX_TOKENS_PER_SLICE) {
      reason = `Capacity exceeded: ${turnCount} turns (max ${MAX_TURNS_PER_SLICE}) and ~${tokenEstimate} tokens (max ${MAX_TOKENS_PER_SLICE})`;
    } else if (turnCount > MAX_TURNS_PER_SLICE) {
      reason = `Capacity exceeded: ${turnCount} turns (max ${MAX_TURNS_PER_SLICE})`;
    } else {
      reason = `Capacity exceeded: ~${tokenEstimate} tokens (max ${MAX_TOKENS_PER_SLICE})`;
    }

    return {
      shouldSplit: true,
      source: "capacity",
      confidence: 1.0,
      reason,
    };
  }

  // ── Check 2: Time silence (hard rule) ───────────────────────────────
  const lastActivity =
    Date.now() - input.timeSinceLastMessage * 1000;

  if (checkTimeSilence(lastActivity)) {
    const elapsedMinutes = Math.round(
      input.timeSinceLastMessage / 60
    );
    return {
      shouldSplit: true,
      source: "time_silence",
      confidence: 1.0,
      reason: `Time silence: ${elapsedMinutes} minutes since last activity (threshold ${TIME_SILENCE_THRESHOLD_MINUTES}m)`,
    };
  }

  // ── No deterministic trigger — caller should consult Flash ──────────
  return {
    shouldSplit: false,
    source: "flash_high_confidence",
    confidence: 0,
    reason:
      "No deterministic split trigger. Call checkContinuity() for Flash assessment.",
  };
}

// ─── Flash continuity check ─────────────────────────────────────────────

/**
 * Ask Flash whether the incoming message represents a topic shift
 * significant enough to warrant a new time slice.
 *
 * This function is async — it makes a model call. Only call it after
 * shouldSplit() returns shouldSplit=false (i.e. no deterministic trigger
 * fired). Flash's role is "add split", not "prevent split":
 * time silence and capacity always win upstream.
 *
 * Flash only returns shouldSplit=true when its confidence exceeds
 * FLASH_SPLIT_CONFIDENCE_THRESHOLD (default 0.9).
 */
export async function checkContinuity(
  input: FlashSplitInput
): Promise<FlashSplitOutput> {
  const {
    timeSinceLastMessage,
    currentSliceFocus,
    currentSliceTopics,
    recentHistory,
    newMessage,
  } = input;

  const historyStr = recentHistory
    .slice(-5)
    .map((t) => `${t.role}: ${t.content.slice(0, 200)}`)
    .join("\n");

  const topicsStr =
    currentSliceTopics.length > 0
      ? currentSliceTopics.join(", ")
      : "none";

  const elapsedMinutes = Math.round(timeSinceLastMessage / 60);

  const prompt = `You are a conversation continuity classifier. Output ONLY raw JSON — no markdown, no explanation.

Your job: determine whether the user's new message represents a significant enough topic shift to start a new time slice (conversation session).

Current slice context:
- Focus: "${currentSliceFocus || "not yet set"}"
- Topics covered: ${topicsStr}
- Time since last message: ${elapsedMinutes} minutes

Recent conversation history:
${historyStr || "none"}

New user message: "${newMessage}"

A split is warranted when:
1. The new message shifts to a completely different domain (e.g. from debugging to deployment)
2. The user explicitly starts a new task or workflow
3. The emotional tone or intent has changed significantly
4. A substantial amount of context would be needed to bridge the gap

A split is NOT warranted when:
1. The new message is a natural follow-up or clarification
2. It continues the same task or topic
3. It references context from the recent turns

Output this exact JSON shape:
{"shouldSplit":true/false,"confidence":0.0-1.0,"reason":"one line explanation"}`;

  try {
    const result = await generateText({
      model: deepseek("deepseek-chat"),
      prompt,
      temperature: 0.1,
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in Flash response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const confidence = Math.min(
      1,
      Math.max(0, Number(parsed.confidence) || 0)
    );

    // Flash can only ADD a split, and only with high confidence
    const shouldSplit =
      parsed.shouldSplit === true &&
      confidence > FLASH_SPLIT_CONFIDENCE_THRESHOLD;

    return {
      shouldSplit,
      confidence,
      reason: String(parsed.reason || ""),
      suggestedFocus: parsed.suggestedFocus ?? undefined,
    };
  } catch {
    return {
      shouldSplit: false,
      confidence: 0,
      reason:
        "Flash continuity check unavailable, defaulting to no split",
    };
  }
}
