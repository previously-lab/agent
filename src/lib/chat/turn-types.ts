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
import type { SlicingSignal, TimeSlice } from "@/lib/episodic";
import type { CardChangeSummary, CardMutation } from "@/lib/episodic/card-diff";
import type { UserConfig } from "@/lib/config/types";
import type { ModelConfig } from "@/lib/models/registry";
import type { CurrentView } from "@/lib/chat/current-view";
import type { SliceLandingConfig } from "@/lib/chat/slice-landing";
import type { ToolContext } from "@/app/api/agent/tool-executors";

/**
 * Everything a turn needs, built once in `start-turn.ts` (the only place real
 * `new Date()` / id-minting is allowed) and passed by value into the run. Must
 * stay JSON-serializable end to end.
 */
export interface TurnInput {
  /**
   * Converted chat history from the client (capped at a broad payload limit
   * in start-turn). The workflow cuts the slice-aligned window from its tail
   * before streaming (sliceAlignedWindow in turn-workflow.ts) — the client
   * remains the history source, the slice decides what the model sees.
   */
  modelMessages: ModelMessage[];
  /** Trimmed recent turns for Flash + context assembly. */
  recentTurns: Array<{ role: string; content: string }>;
  /** The latest user message text, extracted from the raw UI messages. */
  lastUserMessage: string;
  /** Resolved model id (body override → config default). */
  model: string;
  /**
   * The full resolved model config — carries sdk/baseURL/envKey so the agent
   * can construct the right provider model for models.dev-derived ids (which
   * are not in the curated registry). Resolved in start-turn.
   */
  modelConfig: ModelConfig;
  /** Whether DeepSeek thinking is enabled for this turn. */
  thinking: boolean;
  /** Reasoning effort level for this turn. */
  reasoningEffort: "low" | "medium" | "high";
  /** Client-reported timezone, used when minting a new slice. */
  clientTimezone: string;
  /**
   * UI locale ("zh" | "en") — relative-time annotations in the injected card,
   * turn brief, timeline brief, and read-tool output follow it. Normalized in
   * start-turn with fallback "en".
   */
  locale: string;
  /** User config snapshot (loaded once in the route layer). */
  config: UserConfig;
  /** GitHub repo owner (or "local" without a token). */
  owner: string;
  /** GitHub repo name (or "local" without a token). */
  repo: string;
  /** Whether GitHub token is configured (resolved in start-turn). */
  useGithub: boolean;
  /** Whether demo mode is active (resolved in start-turn). */
  useDemo: boolean;
  /** ISO 8601 turn start, stamped in the route layer. */
  startedAtIso: string;
  /**
   * Unique turn identifier — one per round of conversation (user message +
   * agent response + agent cognitive process). 6-char base64url, generated in
   * start-turn.ts. Cross-references core.md and agent.md.
   */
  turnId: string;
  /**
   * The CLIENT's own id for the user message this turn answers (the UIMessage
   * id the client generated before sending). The turnId above is server-minted
   * and unknown to the client — the orchestrator (v0.31) stamps this on the
   * first instance's bubble frames (`anchorId`) so the bubble seats after the
   * right message. Mid-episode arrivals need no anchor: the client mints those
   * turnIds itself. Omitted when the inbound message carried no id.
   */
  clientMessageId?: string;
  /**
   * The parallel-burst id (v0.38 §2) — the client mints ONE ULID per burst
   * (every message of a 连发 carries it; a first/solo message omits it).
   * Rides the run's start attributes (`burst`) and the writer's turn header
   * so batch membership is decidable from the record; absent = the legacy
   * time-window overlap heuristic at the merge decision.
   */
  burstId?: string;
  /**
   * True when this turn RE-RUNS the previous user message (the client
   * regenerate action — SDK trigger "regenerate-message"). Housekeeping then
   * skips the user-turn append (the question is already in the slice) and the
   * client-history mismatch detection (a legitimately truncated history). The
   * new agent turn is recorded normally — the rejected reply stays in the
   * slice as what happened. (v0.19 R4/R5: the interaction_regenerate fitness
   * signal this used to emit is retired with the fitness store.)
   */
  regenerate?: boolean;
  /**
   * Image attachments (data URLs) extracted from the current user message when
   * the main model lacks vision. Passed through to ToolContext so the viewImage
   * tool can resolve `attachment:N`. Capped at 4 images; each is client-compressed
   * to 1568px before upload.
   */
  imageAttachments: string[];
  /**
   * Optional machine context block (v0.11 §13) — an engine-built scene log
   * from the client (the game's visit log, see src/lib/game/visit-log.ts)
   * saying where the user has been this turn. It rides THIS run's input, so a
   * redelivered or reconnected run keeps "where the user was" — that ride is
   * the persistence; the block is deliberately NOT written into the slice's
   * user turn (it is not user speech, and a stored copy would poison the
   * client-history match). The workflow injects it as its own marked section
   * appended to the last user message's OUTBOUND copy — never into the
   * slice-frozen system prompt. ABSENT on plain chat turns: the field is
   * omitted entirely when the client sends none, and the turn is then
   * byte-identical to before.
   */
  machineContext?: string;
  /**
   * The client's current view (v0.13 §5 视野注入) — which slice the reader
   * is looking at, and on which surface (its room / its card). Sent as a
   * STRUCTURED field, never as text; sanitized in startTurn (shape +
   * parseSliceId-strict sliceId), omitted from TurnInput when absent — the
   * lobby default, which needs no block at all (the stable system prompt
   * states it). Sanitized and carried by value, but currently NO injection
   * point consumes it: the per-turn view block was retired in v0.19 A1
   * (the SPACE_FICTION_BLOCK states the fiction once, view-free). The field
   * stays on the wire for forward compatibility.
   */
  view?: CurrentView;
}

/** Summary of a synchronous card evolution run (v0.7b — inline in housekeeping). */
export interface EvolutionResult {
  ran: boolean;
  changed: boolean;
  droppedRecent: number;
  note: string;
  /** ONE user-language sentence describing what changed — the indicator's
   *  headline and the core agent's account of the evolution. */
  summary?: string;
  /** Line-level mutations vs the previous card — the indicator's expanded diff. */
  mutations?: CardMutation[];
  /** Semantic change counts — the indicator's collapsed summary chips. */
  changes?: CardChangeSummary;
  /** Set when the evolution FAILED (worker down, write error) — a failure must
   *  never be presented as a legitimate "no changes" result. */
  error?: string;
  /** Set when the pass ended without a finish call (step cap / timeout) — the
   *  card carries whatever mutations landed before the cutoff. */
  partial?: boolean;
  /** v1.0 legacy wire field (fitness buckets + net scores that forced the
   *  run) — RETIRED with the fitness trigger chain (v0.19 §A.3.2): no
   *  producer sets it anymore. Kept optional so old clients tolerate it. */
  triggers?: Array<{
    bucket: "card" | "recall" | "search" | "thinkdeep" | "interaction";
    score: number;
  }>;
  /** v1.0: the Phase-1 direction verdict — omitted entirely when the check
   *  did not run. A FAILED check surfaces as outcome "failed" (never
   *  masquerading as "no_change"; a silent failure reads as "it never runs");
   *  a proposal that failed validation surfaces as "rejected" with the reason
   *  (the writing discipline did its job — distinct from the agent choosing
   *  not to move the direction). */
  direction?: {
    outcome: "no_change" | "updated" | "failed" | "rejected";
    /** The update summary, or the failure/rejection reason. */
    summary?: string;
  };
  /** v1.0: playbook mutations applied this run (Phase 2). */
  playbooks?: Array<{
    agent: "recall" | "search" | "thinkdeep";
    summary: string;
  }>;
}

/** Result of the housekeeping step — slice + prepared context for the agent. */
export interface HousekeepingResult {
  slice: TimeSlice;
  /**
   * The CARD half of the folded user model (people/user/index.md, v0.19 §B.7)
   * — what the user did / is doing / plans. Tolerant read falls back to the
   * legacy current-previously.md.
   */
  previouslyContent: string;
  /**
   * The frozen slice-head snapshot block (L3): slice-start local time, date
   * anchors, continuity stance at slice birth, and the birth-evolution
   * summary. Every input anchors to `slice.start`, so the block is
   * byte-identical on every turn of the slice (v0.9 prefix-cache freeze).
   * See buildSliceHeadBlock in src/lib/turn-priming.ts.
   */
  sliceHeadBlock: string;
  /**
   * The agent's constitution: SOUL + "who you're assisting" + DIRECTIVES
   * (memory access rules included), derived from previously.md's identity
   * section. Injected into the system prompt. See src/lib/identity.
   * The workflow splits the "Who you're assisting" tail out with
   * splitIdentityPrompt and injects it as its own block (L1a, after the
   * direction layer); callers that need the whole prompt unsplit (the
   * companion narrate) use it as-is.
   */
  identityPrompt: string;
  /**
   * The direction layer (v1.1): the evolved user portrait + hypothesis pool
   * (direction.md), injected between the card (L1) and the static rules (L2).
   * Read per turn in housekeeping after the user-turn flush. Evolution now
   * runs in the SCRIBE segment (after the reply — v0.19 A1), so a direction
   * an evolution run lands this turn is what the NEXT turn reads; within a
   * slice without an evolution the layer is byte-stable. Absent when
   * direction.md is missing / still the template / still the legacy skeleton
   * awaiting migration.
   */
  directionBlock?: string;
  /**
   * people/user/profile.md block (v0.19 §B.7): the user's OWN self-description,
   * injected every turn right after the user model. Only the user writes it;
   * the block's own text states the precedence discipline (on conflict, the
   * self-description wins). Absent when no profile exists.
   */
  userProfileBlock?: string;
  /**
   * The §A.3.3 delivery block (v0.19 A3): the background stream's completion
   * statements — tasks/ tail lines dated the user's local today (a question
   * run's notice, a task case closed today). Injected after the profile; its
   * own text carries the "state, never promise" discipline. Absent when no
   * background work completed today.
   */
  dueTasksBlock?: string;
  /**
   * Checkpoint carry-over: when the slice was born from a time_cap/capacity
   * close (`slice.continuesFrom`), the previous slice's trailing turns read
   * server-side from the CLOSED slice file. The workflow prepends them to the
   * slice-aligned history window so the same conversation continues
   * seamlessly; the prefix is frozen for the slice's whole life (append-only
   * window, prefix-cache friendly). Absent for genuine conversation
   * boundaries (idle_gap) and when the predecessor is unreadable (best-effort).
   */
  contextPrefix?: ModelMessage[];
  /**
   * Window rebuild (client-history mismatch): when the client-sent history
   * no longer matched the active slice (page refresh, device switch, stale
   * local writes), housekeeping kept the slice OPEN and derived the history
   * window from the SLICE's own turns instead — the server slice is
   * authoritative. The workflow uses these messages verbatim (plus the
   * checkpoint prefix, when present) in place of the client history. Absent
   * on turns where the client history matched.
   */
  rebuiltHistory?: ModelMessage[];
  /**
   * A close the reply segment DECIDED but did not execute (v0.19 A1 three
   * stages): housekeeping keeps the lifecycle decision pure — it mints the
   * successor slice and persists the user turn, while the close itself
   * (marking + closeSlice) and everything downstream of it run in the scribe
   * segment AFTER the reply. Carried by value so the scribe segment never
   * re-derives the decision. Absent when no close fired; on a redelivered
   * run the scribe segment re-discovers the orphaned active slice from disk
   * (findStaleActiveSlice) instead.
   */
  pendingClose?: { slice: TimeSlice; signal: SlicingSignal };
  /**
   * The reflection unit's 暂存 (v0.30 §2.4): the last SUBSTANTIVE reflection
   * round's one-line note + when it landed, read from hq.json at the entry
   * beat. The workflow carries it on the OUTBOUND tail of the last user
   * message exactly once (R1: only when the note is newer than the previous
   * user turn) — never persisted, never in the system prompt. Absent when
   * no note is staged.
   */
  reflectionNote?: { note: string; at: string };
  /**
   * Parallel sends (v0.33): how many OTHER turn runs on this same slice were
   * alive when housekeeping stamped this run into the run registry. The
   * workflow carries it as a fenced outbound-tail section (buildParallelNoteSection)
   * so the model answers THIS message without waiting for the burst's rest.
   * Absent when there were no live siblings (the common single-send case) and
   * on bridge/demo deployments (D10 — no registry participation there).
   */
  parallelSiblings?: number;
  /**
   * The slice THIS beat sealed, when it did (v0.34 R1 — the reflection
   * bell's only trigger): the entry beat's close decision target OR an
   * orphaned active slice recovered from disk, closed atomically in this
   * step. The turn tail rings the reflection bell ONLY when this is set (the
   * per-turn tail bell retired — an open slice is not reflection material).
   * Absent on turns that sealed nothing (and in demo mode, which never
   * closes).
   */
  closedSliceId?: string;
}

/**
 * What the LAST surviving parallel turn hands to the batch summary run
 * (v0.33 §4). All serializable, resolved by the spawning turn so the summary
 * never re-derives deployment state: the model to write with, the backend
 * flags for reading the slice (the readEpisodeInbox pattern — getRepoConfig
 * only runs in the github branch), and the locale the closing lines follow.
 */
export interface SummaryRunInput {
  /** The slice the parallel batch landed on (summary reads + appends it). */
  sliceId: string;
  /** UI locale — the closing follows the reader's language. */
  locale: string;
  /** Resolved model id + config of the spawning turn (createModel input). */
  model: string;
  modelConfig: TurnInput["modelConfig"];
  /** Backend flags, exactly as TurnInput carries them. */
  useGithub: boolean;
  useDemo: boolean;
  owner: string;
  repo: string;
}

/**
 * What the workflow extracts (as pure serializable values) from the agent
 * stream result and hands to the finalizeTurn step (the turn tail).
 */
export interface TurnOutcome {
  /** Final assistant text (empty when the model produced none). */
  text: string;
  /** Finish reason of the last step — "stop" means a clean completion. */
  finishReason: string;
  /**
   * Mechanically extracted cognition data for agent.md — reasoning traces
   * and tool calls with success/failure status. Written by finalizeTurn.
   */
  cognition: string;
  /**
   * Client-visible explanation for a non-stop finish (workflow timeout /
   * terminal model error). Emitted in the terminal `data-turn-status` chunk so
   * the client can show why the turn ended instead of failing silently.
   * Absent for clean "stop" turns and for the partial-text "interrupted" case.
   */
  error?: string;
}

// ─── Inner (nested) turn — v0.30 §3, batch B ──────────────────────────────

/**
 * The by-value input of ONE child run (v0.31 — the orchestrator-shell
 * architecture): every user message gets its own answering child run, spawned
 * by the orchestrator (E is the only spawner, D1). Must stay JSON-serializable
 * end to end, same discipline as TurnInput.
 */
export interface InnerTurnInput {
  /** The orchestrator's inbox hook token (`episode:<runId>`) — the bubble
   *  report's return address (D2). */
  inboxToken: string;
  /** This instance's own id — derived deterministically from the user turn
   *  it serves (`n${replyTo}`), so a replayed orchestrator run re-derives the
   *  same id and the finalize dedupe holds. Becomes the bubble's slice
   *  turnId. */
  turnId: string;
  /** The user turn this instance answers. */
  replyTo: string;
  /** The child run's message list: for the episode's FIRST message this is
   *  the turn's slice-aligned history window (ending in that user message);
   *  for queued arrivals it is the single envelope user message
   *  (inner-envelope.ts). */
  messages: ModelMessage[];
  /** The orchestrator's assembled system prompt, carried by value so the
   *  child answer speaks with the same agent's voice (and the provider
   *  prompt-cache prefix reuse keeps working). */
  systemPrompt: string;
  /** Resolved model id (same as the orchestrator's). */
  model: string;
  modelConfig: ModelConfig;
  thinking: boolean;
  reasoningEffort: "low" | "medium" | "high";
  /** Serializable tool context for the FULL chat tool set (v0.31 — children
   *  are the answerers now, so they get the same tools the outer turn had).
   *  The FIRST child carries the turn's imageAttachments (viewImage resolves
   *  `attachment:N` through them); arrivals are text-only. */
  toolsContext: ToolContext;
}

/**
 * The child run's terminal report (v0.32). Carried on TWO channels:
 *  1. the inbox hook tap (reportInnerBubble) — low latency when it works;
 *  2. the child workflow's RETURN VALUE — the durable channel the
 *     orchestrator's drain reconciles from (pollInnerRunReports). Production
 *     showed the hook tap unreliable as a wake mechanism (a report sat in the
 *     event log until the drain's 60s sleep boundary), so the registry, like
 *     the disk for arrivals (D1/D2), is the queue of record.
 * Must stay JSON-serializable (it is a workflow return value).
 */
export interface InnerTurnReport {
  /** The inner instance's own id (= the bubble frame's turnId). */
  turnId: string;
  /** The user turn the instance answered. */
  replyTo: string;
  /** The full answer text ("" on failure). */
  text: string;
  /** Mirrors the agent stream's finishReason ("stop" clean, "error" failed). */
  finishReason: string;
}

/**
 * The episode tail handed to finalizeTurn (v0.30 §3.4, D7): every terminal
 * inner bubble plus the outer agent's merged summary, riding the SAME batch
 * and single commit as the outer agent turn. Absent entirely on a
 * single-message (兼任) episode — that path stays byte-identical to the
 * pre-episode turn.
 */
export interface NestedTurnTail {
  bubbles: Array<{
    /** The instance id — becomes the bubble's agent-turn turnId. */
    turnId: string;
    /** The user turn answered (persisted as the turn's replyTo). */
    replyTo: string;
    text: string;
    finishReason: string;
    /** Terminal stamp (the frame-write time, stamped in a step). */
    doneAt?: string;
  }>;
  /** The outer agent's merged closing message. FOLDED into the outer agent
   *  turn's content (one agent turn per outer turnId) rather than appended as
   *  a second turn with the same turnId — turn-merge keys turns by turnId, so
   *  two agent turns sharing it would make the conflict self-heal drop one. */
  mergeSummary?: string;
}

// ─── Turn status / persistent turn state (Layer 2, v0.6) ───────────────────
/**
 * Turn-level lifecycle status, streamed to the client as `data-turn-status`
 * chunks. No persistence layer — the agent's reply is already in the time
 * slice; the client sees these chunks live or reconnects via the stored runId.
 *
 * Terminal-only lifecycle statuses. Mid-turn transitions (thinking /
 * synthesizing around dispatched sub-agents) were removed when thinkDeep
 * became an agent-as-a-tool: reasoning fragments now flow back inline through
 * tool results, so there is no separate wait/integrate phase to announce.
 */
export type TurnStatus =
  | "active" // LLM is generating or tools are executing
  | "done" // Final text delivered to client
  | "interrupted" // Timeout or error, partial result available
  | "error"; // Fatal error, no result

/**
 * Derive the terminal turn status from the agent's finish reason and output.
 * Pure function — used by closeTurnStream to emit the terminal data-turn-status
 * stream chunk. The client sees it live or reconnects via the stored runId.
 */
export function deriveTurnStatus(outcome: TurnOutcome): TurnStatus {
  if (outcome.finishReason === "stop") return "done";
  // An explicit soft-timeout interruption is always "interrupted", even when
  // the model produced no text before it was cut off (the client offers a
  // "continue" path rather than treating it as a hard error).
  if (outcome.finishReason === "interrupted") return "interrupted";
  if (outcome.text) return "interrupted";
  return "error";
}


/**
 * What a turn run RETURNS (v0.42 §1/§2) — the burst's persistence record. The
 * turn answers in its stream and returns THIS; it persists NOTHING passively
 * (用户那句话不由 turn 侧同步提交 — v0.42 §0). The burst's last survivor's
 * summary run reads completed siblings' returnValues and lands the whole
 * burst's 被动存盘 in ONE commit. Legacy runs returned the bare reply text —
 * readers tolerate that (replyText = the string, the rest empty).
 */
export interface TurnRunResult {
  /** This turn's id (the turn headers + dedupe keys carry it). */
  turnId: string;
  /** The slice this turn attached to. */
  sliceId: string;
  /** The user-clock/UTC stamp of this turn's start (the appended turns' time). */
  at: string;
  /** The user's message THIS turn answered (persisted by the summary run). */
  userText: string;
  /** The full assistant reply ("" when the turn failed — nothing to persist). */
  replyText: string;
  /** The cognition body for agent.md ("" when none). */
  cognition: string;
  /** The burst's closing line when THIS turn generated one (可空 — v0.42 §2). */
  mergeLine?: string;
  /** The burst id (rides the [burst {id}] turn-header segment). */
  burstId?: string;
  /**
   * Evidence attachments the user sent THIS turn (names + base64 bytes —
   * v0.42 review blocker 1). The entry beat commits nothing, so the summary
   * stream persists them through the same fuse semantics and annotates the
   * persisted user turn with the landed names.
   */
  attachments?: Array<{ name: string; dataBase64: string }>;
  /**
   * The people/user mid-life snapshot update for an EXISTING slice (a birth
   * carries its own) — written to previously.md by the summary stream.
   */
  previously?: string;
}

/**
 * The summary run's durable payload (v0.42 §1 — 总结流由最后一个对话流唤起,
 * 唤起即完成). The burst's LAST turn carries its OWN record here (its
 * returnValue may not be readable yet — the turn run completes after starting
 * the summary); the other members are enumerated from the run registry inside
 * the step. `sliceId` is the BATCH KEY (the edge slice's id the turn runs
 * stamped, or a per-day key when no edge existed) — the LANDING slice is the
 * summary stream's own judgment.
 */
export interface SummaryRunPayload {
  /** The batch key (registry enumeration + dedupe) — NOT the landing slice. */
  sliceId: string;
  /** The burst id (registry-exact member enumeration); absent → same-slice
   *  terminal turn runs are the members. */
  burstId?: string;
  /** User-local date (YYYY-MM-DD), the stamping convention. */
  date: string;
  /** The last turn's own record. */
  own: TurnRunResult;
  /** The SAME continuity thresholds the entry beat used (idle gap / time
   *  cap / capacity) — the landing judgment applies them. */
  slicing: SliceLandingConfig;
  /** The client timezone — a minted slice stamps it. */
  clientTimezone: string;
  /** The turn's model config — the seal-time analyzer's model. */
  modelConfig: TurnInput["modelConfig"];
  /** Backend flags, exactly as TurnInput carries them. */
  useGithub: boolean;
  useDemo: boolean;
  owner: string;
  repo: string;
  /** UI locale — the honest-failure record follows it. */
  locale: string;
}

/** What the summary run reports back (observability; the turn never waits). */
export interface SummaryRunOutcome {
  /** "deduped" = a live summary for this slice already owns the burst. */
  kind: "committed" | "deduped" | "nothing" | "failed";
  /** commit segments, for the log. */
  segments?: string[];
  error?: string;
}
