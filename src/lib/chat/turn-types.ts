/**
 * By-value contract for the durable chat turn.
 *
 * Every chat turn runs inside a Vercel Workflow run (see
 * `src/app/api/chat/turn-workflow.ts`). The workflow body is deterministic and
 * runs its steps in *separate invocations*, so nothing can be shared through a
 * module-global (the old `activeSlice` in episodic/manager.ts is unusable
 * there). All state the steps need is threaded through these serializable
 * shapes: `TurnInput` in, the slice + Flash output re-bound after each mutating
 * step.
 *
 * TYPE-ONLY MODULE. Everything here is erased at compile time, so importing it
 * from the `"use workflow"` file pulls no Node.js code into the workflow bundle.
 */
import type { ModelMessage } from "ai";
import type { TimeSlice } from "@/lib/episodic";
import type { MaintenanceOutput } from "@/lib/episodic/maintenance";
import type { UserConfig } from "@/lib/config/types";

/**
 * Everything a turn needs, built once in `start-turn.ts` (the only place real
 * `new Date()` / id-minting is allowed) and passed by value into the run. Must
 * stay JSON-serializable end to end.
 */
export interface TurnInput {
  /** Converted chat history for `streamText`. */
  modelMessages: ModelMessage[];
  /** Trimmed recent turns for Flash + context assembly. */
  recentTurns: Array<{ role: string; content: string }>;
  /** The latest user message text, extracted from the raw UI messages. */
  lastUserMessage: string;
  /** Resolved model id (body override → config default). */
  model: string;
  /** Whether DeepSeek thinking is enabled for this turn. */
  thinking: boolean;
  /** Client-reported timezone, used when minting a new slice. */
  clientTimezone: string;
  /** User config snapshot (loaded once in the route layer). */
  config: UserConfig;
  /** GitHub repo owner (or "local" without a token). */
  owner: string;
  /** GitHub repo name (or "local" without a token). */
  repo: string;
  /** ISO 8601 turn start, stamped in the route layer. */
  startedAtIso: string;
}

/** Result of the housekeeping step — the recovered/created slice by value. */
export interface HousekeepingResult {
  slice: TimeSlice;
}

/**
 * Result of the Flash step — the slice with any metadata updates applied, the
 * Flash output (or null on failure), and how long Flash took.
 */
export interface FlashRecallResult {
  slice: TimeSlice;
  flashOutput: MaintenanceOutput | null;
  flashMs: number;
}
