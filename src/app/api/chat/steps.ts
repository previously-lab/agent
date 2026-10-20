/**
 * Chat turn step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (gray-matter + fs, the episodic manager) never enter the deterministic
 * workflow sandbox. `turn-workflow.ts` imports these `"use step"` functions
 * by reference only; the loader compiles them into the step bundle, not the
 * workflow bundle.
 *
 * Steps (v0.21 §3 — the field agent's one round):
 *   1. housekeeping      — 进场那一拍 (the ENTRY beat, before the reply).
 *      Recover/create the slice, DECIDE the lifecycle (pure clock — the
 *      slicer is unchanged), and when a page is judged ended: summarize THAT
 *      page (the turn's one semantic derivation — analyzeTurn, or the ONE
 *      bridge housekeeping call in client mode; input = the ended page's
 *      turns, never this turn's message) into its frontmatter
 *      (focus/summary/tone) and close it — all before this turn's user
 *      message lands, in this step's one commit. No page ended → zero
 *      summarization: the living page waits for its real end. Idempotent via
 *      needs_marking semantics (an already-marked page is never
 *      re-summarized). Then the user-turn append, the read face (continuity /
 *      slice head / identity / direction / §A.3.3 statements), the UI stream.
 *      Zero projection writes (no timeline weave, no catalog/index upkeep).
 *   2. finalizeTurn      — the turn tail in ONE slice-locked step and ONE
 *      git commit (`Turn {turnId} — finalize`, body naming the segments that
 *      queued writes): 落盘这一轮 (agent turn + cognition, conflict
 *      self-heal) + 序 6 (the explicit-instruction channel — runs ONLY when
 *      the entry beat's analysis read an explicit record/correction request;
 *      no explicit instruction → zero LLM, zero writes 空转零写入).
 *   3. closeTurnStream   — terminal turn-status chunk + finish-step/finish.
 *   4. ringReflection    — the mechanical bell (v0.38 §3.3 / v0.42 §4):
 *      the SUMMARY stream rings it after landing the burst's 被动存盘,
 *      carrying {sliceId, turnRange} — a live run gets the ring, otherwise
 *      a fresh unit starts. Best-effort: a failed bell only warns (the
 *      unit's range is everything since its cursor, so the next bell
 *      covers the gap).
 *
 * Retired (v0.21 §A.2.2 改写 / §9; v0.30 §2): the scribe segment's
 * close-TRIGGERED dispatch chain — due-task scan → [boundary-event] mailbox
 * post → automatic start(boundaryRun)/start(questionRun) — and the scribe
 * passes that consumed [doc-marker] lines into cases; and, in v0.30, the
 * field's reportToHQ tool plus the §4 回程 (field-return peek). The
 * reflection unit's ONLY trigger is the mechanical bell; it reads the
 * record itself (the mailbox markers are prose clues, not triggers). The
 * [doc-*] mailbox line contract itself is frozen and untouched.
 *
 * Chunk order for the UI: data-phase(slice/analyze/slice-closed?/context) →
 * start → start-step → (reply) → data-evolution? → data-turn-status →
 * finish-step → finish.
 */
import { type UIMessageChunk, type ModelMessage, streamText } from "ai";
import crypto from "crypto";
import { getWritable, getWorkflowMetadata, setAttributes } from "workflow";
import { getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { HookNotFoundError } from "workflow/errors";
import {
  createSlice,
  closeSlice,
  appendTurn,
  saveSliceSnapshot,
  tryLoadTodaySlice,
  writeAgentTimeline,
  readPreviously,
  writePreviously,
  findMostRecentPreviously,
  deterministicSliceMark,
  createBatch,
  flushBatch,
  analyzeTurn,
  sliceIdToFilePath,
  slicePartPathCandidates,
  readSlicePart,
  parseSlice,
  loadSlice,
  RECORDS_ROOT,
  LEGACY_SLICES_ROOT,
  type SlicePart,
  type TimeSlice,
  type SlicingSignal,
  type TurnAnalysis,
  type WriteBatch,
} from "@/lib/episodic";
import { dayDirForDate } from "@/lib/episodic/paths";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import {
  mergeTurnsWithRemote,
  mergeDiskTurnsIntoSlice,
} from "@/lib/episodic/turn-merge";
import { isRefConflictError } from "@/lib/tools/batch-write";
import { getRepoConfig } from "@/lib/capabilities";
import { fsListFiles, fsReadFile } from "@/lib/episodic/io-helpers";
import {
  dataUrlToBuffer,
  persistEvidenceAttachments,
  type EvidenceAttachmentInput,
} from "@/lib/tools/attachments";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";
import { MEMORY_ROOT_DIR, caseIndexPath } from "@/lib/docs/paths";
import { parseCaseDoc } from "@/lib/docs";
import {
  readUserModel,
  readUserProfile,
} from "@/lib/evolution/store";
import { buildDirectionBlock } from "@/lib/evolution/direction-agent";
import {
  adaptHousekeepingReport,
  applyBridgeCardEvolution,
  degradedAnalysis,
  isPhaseOutsourceActive,
  runHousekeepingBridge,
  type HousekeepingPhaseReport,
} from "@/lib/bridge-phases";
import {
  createBridgeEventEmitter,
  type BridgePhaseData,
} from "@/lib/models/bridge-model";
import { createModel } from "@/lib/models/provider";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import type { HousekeepingStep } from "@/lib/chat/build-stream";
import {
  buildAgentIdentityPrompt,
  parseIdentityFromPreviously,
} from "@/lib/identity";
import {
  classifyContinuity,
  buildSliceHeadBlock,
  type PrevSliceRef,
} from "@/lib/turn-priming";
import type {
  TurnInput,
  HousekeepingResult,
  TurnOutcome,
  EvolutionResult,
  NestedTurnTail,
  InnerTurnReport,
  SummaryRunOutcome,
  SummaryRunPayload,
  TurnRunResult,
} from "@/lib/chat/turn-types";
import { deriveTurnStatus } from "@/lib/chat/turn-types";
import {
  NESTED_BUBBLE_CHUNK,
  type EpisodeInboxEvent,
  type NestedBubbleFrame,
} from "@/lib/chat/nested-bubble";
import {
  PARALLEL_SUMMARY_CHUNK,
  buildMergeWindow,
  hasOverlappingParallelSibling,
  isBlockingParallelSibling,
  isBurstSibling,
  hasLaterCreatedRun,
  isLastBurstTurn,
  isLiveRunStatus,
  isParallelTurnRun,
  type ParallelRunEntry,
} from "@/lib/chat/parallel-runs";
import { findEpisodeUnanswered, type EnvelopeUserTurn } from "./inner-envelope";
import {
  deliverReflectionWake,
  type ReflectionWakeRange,
} from "@/app/api/evolution/reflection-wake";
import { COMMIT_PREFIX } from "@/lib/chat/commit-contract";
import {
  judgeSliceLanding,
  type SliceLandingConfig,
} from "@/lib/chat/slice-landing";
import { readLatestReflectionNote } from "@/lib/chat/hq-log";
import {
  runCardEvolution,
  type CardEvolutionReaders,
} from "@/app/api/evolution/run-card-evolution";
import { readFile, readFileFresh } from "@/lib/tools/readFile";
import { readFileLocal } from "@/lib/tools/local-fs";
import { readFileDemo } from "@/lib/demo/demo-fs";
import { parseSliceId, parseTurns } from "@/lib/episodic/turn-parser";
import { localDateKey } from "@/lib/time/relative";
import {
  shouldEmitProgress,
  type ProgressWriteState,
} from "@/lib/chat/progress-throttle";
import type { UserConfig } from "@/lib/config/types";


// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * One step's stream writer — a SINGLE reused `getWritable()` writer behind a
 * serial queue.
 *
 * WHY: the old pattern grabbed a fresh `getWriter()` per chunk. A writer holds
 * the stream lock from acquisition until its `write()` resolves, and a second
 * `getWriter()` on a locked stream THROWS — so a fire-and-forget progress frame
 * whose write was still in flight made the very next emit (e.g. the evolution
 * TERMINAL frame, fired milliseconds later) throw; the catch-all then retried
 * fire-and-forget and could swallow the retry too. The card never received its
 * terminal chunk and spun forever — while later phases (emitted after slow I/O
 * released the lock) landed fine. The sub-agent runner already solved this for
 * `data-tool-progress` with one reused writer ("a fresh pipeline per write
 * failed silently on long runs") — this is the same discipline for the
 * housekeeping/evolution channel.
 *
 * The serial queue preserves chunk order across awaited and fire-and-forget
 * senders; a failed write drops the writer so the next queued chunk re-acquires
 * a fresh one instead of failing forever. `close()` releases the lock at step
 * end so the step's HTTP request can terminate and later steps get a writer.
 */
interface StepStream {
  /** Queue a chunk; resolves once the chunk has actually been written. */
  write(chunk: UIMessageChunk): Promise<void>;
  /** Fire-and-forget queued write (live progress frames). */
  send(chunk: UIMessageChunk): void;
  /** Release the writer lock. ALWAYS call at step end. */
  close(): void;
}

function createStepStream(): StepStream {
  let writer: WritableStreamDefaultWriter<UIMessageChunk> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (chunk: UIMessageChunk): Promise<void> => {
    queue = queue.then(async () => {
      try {
        if (!writer) writer = getWritable<UIMessageChunk>().getWriter();
        await writer.write(chunk);
      } catch {
        // The stream is gone (client disconnect) or the writer broke — drop it
        // so the next queued write re-acquires a fresh one.
        try {
          writer?.releaseLock();
        } catch {
          /* already released */
        }
        writer = null;
      }
    });
    return queue;
  };
  return {
    write: enqueue,
    send(chunk) {
      void enqueue(chunk);
    },
    close() {
      try {
        writer?.releaseLock();
      } catch {
        /* ignore */
      }
      writer = null;
    },
  };
}

/**
 * Emit a compact housekeeping phase (rendered as a ToolLayout card on the
 * client). Each phase is a `data-phase` chunk with `compact: true` so
 * buildStream renders it as an unobtrusive tool-style bar, not a prominent
 * PhaseIndicator. Emit `running: true` before the work, `running: false`
 * (with result summaries) after.
 */
async function emitPhase(
  stream: StepStream,
  phase: string,
  running: boolean,
  summaries?: string[],
): Promise<void> {
  await stream.write({
    type: "data-phase" as `data-${string}`,
    id: `phase-${phase}`,
    data: { phase, running, compact: true, summaries },
  } as UIMessageChunk);
}

/**
 * Emit a data-evolution progress chunk — the evolution card's running frame.
 * All evolution chunks share the id "evolution" so the client merges them into
 * ONE standalone streaming card: `status: "running"` frames carry the phase
 * step and (while the Previously Agent streams) the live thinking/writing
 * line; the terminal frame (emitEvolutionResult) carries `status: "done"`.
 * The legacy `running` key is kept for backward compatibility.
 *
 * Fire-and-forget onto the step stream's serial queue — live frames must not
 * block the agent loop; ordering against the terminal frame is guaranteed by
 * the queue.
 */
function emitEvolutionProgress(
  stream: StepStream,
  step: "direction" | "reading" | "reviewing",
  live?: string,
  liveStage?: "thinking" | "writing",
): void {
  stream.send({
    type: "data-evolution" as `data-${string}`,
    id: "evolution",
    data: {
      running: true,
      status: "running",
      step,
      ...(live ? { live, liveStage } : {}),
    },
  } as UIMessageChunk);
}

/**
 * Emit the terminal evolution chunk with the change summary. AWAITED — this
 * frame settles the card, so it must actually reach the stream (the serial
 * queue behind `stream.write` is what makes that reliable).
 */
async function emitEvolutionResult(
  stream: StepStream,
  result: EvolutionResult,
): Promise<void> {
  await stream.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution",
    data: {
      running: false,
      status: "done",
      changes: result.changes ?? {
        added: result.changed ? 1 : 0,
        reinforced: 0,
        demoted: result.droppedRecent,
        removed: 0,
        superseded: 0,
      },
      hasChanges: result.changed,
      // The review's reasoning + the actual line diff — the indicator's
      // expanded content. `error` marks a FAILED run (never a legit no-change).
      note: result.note,
      // The agent's one-sentence user-language account — the indicator's
      // headline and the core agent's notice.
      ...(result.summary ? { summary: result.summary } : {}),
      mutations: result.mutations ?? [],
      ...(result.error ? { error: result.error } : {}),
      // A pass cut off without a finish call — the card is partial work.
      ...(result.partial ? { partial: true } : {}),
      // Calibration details (design §2.3): the direction verdict (v1.1 merged
      // run — evaluated inside the one runCardEvolution call) and the SOP
      // mutations applied. All optional. (`triggers` is the retired fitness
      // wire field — no producer sets it post-v0.19; the spread is inert.)
      ...(result.triggers?.length ? { triggers: result.triggers } : {}),
      ...(result.direction ? { direction: result.direction } : {}),
      ...(result.playbooks?.length ? { playbooks: result.playbooks } : {}),
    },
  } as UIMessageChunk);
}

/**
 * File readers for the inline card evolution — same storage backends the turn
 * uses, so the Previously Agent can explore past slices / cognition / cards.
 */
function buildCardReaders(input: TurnInput): CardEvolutionReaders {
  const readRaw = async (path: string): Promise<string> => {
    if (input.useDemo) return readFileDemo(path);
    if (input.useGithub) return readFile(path, input.repo, input.owner);
    return readFileLocal(path);
  };
  /** Dual-probe the records root, then the legacy slices root. */
  const readSliceDual = async (
    parsed: { y: string; m: string; d: string; hm: string },
    part: SlicePart,
  ): Promise<string> => {
    const [primary, fallback] = slicePartPathCandidates(
      `${parsed.y}-${parsed.m}-${parsed.d}-${parsed.hm}`,
      part,
    );
    try {
      return await readRaw(primary);
    } catch {
      return readRaw(fallback);
    }
  };
  return {
    readSlice: async (sid, range) => {
      const parsed = parseSliceId(sid);
      if (!parsed) return `ERROR: Invalid slice ID.`;
      // Dual-root (v0.19 R2): the cited slice may predate the records root move.
      const raw = await readSliceDual(parsed, "core");
      if (range && range.type === "last") {
        const { turns } = parseTurns(raw);
        const n = range.count ?? 3;
        return turns
          .slice(-n)
          .map((t) => `${t.header}\n${t.content}`)
          .join("\n");
      }
      return raw;
    },
    readAgentTimeline: async (sid) => {
      const parsed = parseSliceId(sid);
      if (!parsed) return `(invalid slice: ${sid})`;
      return readSliceDual(parsed, "agent").catch(
        () => `(agent.md not found: ${sid})`,
      );
    },
    readPreviously: async (sid) => {
      const parsed = parseSliceId(sid);
      if (!parsed) return `(invalid slice: ${sid})`;
      return readSliceDual(parsed, "previously").catch(
        () => `(previously not found: ${sid})`,
      );
    },
  };
}

/**
 * Detect when the client-sent history no longer matches the active slice
 * (page refresh, device switch, stale local writes). DETECTION ONLY — a
 * mismatch never closes the slice: the server slice is authoritative and
 * housekeeping rebuilds the model history window from the slice's own turns
 * instead (see rebuiltHistory in the HousekeepingResult).
 *
 * The client history may carry turns from OLDER slices before the current
 * one, so the check compares the slice-aligned TAIL: the client's user
 * messages (the current one excluded — it is not in the slice yet at
 * decision time) must end with the slice's user turns, turn for turn. A
 * short tail means the client lost turns (refresh); a non-matching tail
 * means stale writes the slice never recorded. Either way → rebuild.
 */
function checkClientHistoryMismatch(
  modelMessages: ModelMessage[],
  slice: TimeSlice,
): boolean {
  const sliceUserContents = slice.turns
    .filter((t) => t.role === "user")
    .map((t) => t.content);
  if (sliceUserContents.length === 0) return false;
  const clientUserContents = modelMessages
    .filter((m) => m.role === "user")
    .map((m) => messageText(m.content));
  const aligned = clientUserContents.slice(0, -1).slice(-sliceUserContents.length);
  if (aligned.length < sliceUserContents.length) return true; // client lost turns
  return aligned.some((c, i) => c !== sliceUserContents[i]);
}

/** Plain-text extraction for comparing a user message against a slice turn
 *  (slice turns store plain text; the client may send content parts). */
function messageText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
  }
  return "";
}

// ─── Evidence attachments (v0.19 §C.1 — the records-case wiring) ──────────

const ATTACHMENT_EXT_BY_MEDIA: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

/** A name for an attachment the client gave no filename (image-N.png etc.). */
function synthesizedAttachmentName(mediaType: string, index: number): string {
  const ext = ATTACHMENT_EXT_BY_MEDIA[mediaType] ?? "bin";
  return `attachment-${index + 1}.${ext}`;
}

/**
 * The files/images the user sent THIS turn, as bytes: the last user
 * ModelMessage's file/image parts (a vision model keeps them there), plus
 * `input.imageAttachments` (a no-vision model gets its images extracted to
 * data URLs in start-turn). Dedup by source string so a part visible on both
 * channels lands once. Remote-URL parts are not fetched — skipped visibly.
 */
function collectTurnAttachments(input: TurnInput): {
  files: EvidenceAttachmentInput[];
  unfetched: string[];
} {
  const files: EvidenceAttachmentInput[] = [];
  const unfetched: string[] = [];
  const seen = new Set<string>();
  const pushDecoded = (key: string, data: Buffer, mediaType: string, name?: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    files.push({
      name: name?.trim() || synthesizedAttachmentName(mediaType, files.length),
      data,
    });
  };
  const lastUser = [...input.modelMessages].reverse().find((m) => m.role === "user");
  if (lastUser && Array.isArray(lastUser.content)) {
    for (const part of lastUser.content) {
      const p = part as {
        type: string;
        data?: unknown;
        image?: unknown;
        mediaType?: string;
        filename?: string;
      };
      if (p.type !== "file" && p.type !== "image") continue;
      const payload = p.type === "image" ? p.image : p.data;
      const mediaType = p.mediaType ?? "image/png";
      if (payload instanceof Uint8Array) {
        pushDecoded(`bin:${payload.byteLength}:${files.length}`, Buffer.from(payload), mediaType, p.filename);
      } else if (typeof payload === "string") {
        if (payload.startsWith("data:")) {
          const decoded = dataUrlToBuffer(payload);
          if (decoded) pushDecoded(payload, decoded.data, decoded.mediaType, p.filename);
        } else if (/^https?:\/\//.test(payload)) {
          unfetched.push(p.filename ?? payload.slice(0, 80));
        } else {
          // Raw base64 (convertToModelMessages may decode the data URL).
          pushDecoded(payload, Buffer.from(payload, "base64"), mediaType, p.filename);
        }
      }
    }
  }
  for (const url of input.imageAttachments ?? []) {
    const decoded = dataUrlToBuffer(url);
    if (decoded) pushDecoded(url, decoded.data, decoded.mediaType);
  }
  return { files, unfetched };
}

/** Slice turns → wire messages (the shape the model history window uses). */
function sliceTurnsToMessages(turns: TimeSlice["turns"]): ModelMessage[] {
  return turns.map((t) => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));
}

/**
 * Slice → continuity reference. `end` falls back to the last turn's
 * timestamp: a close decided this turn is materialized in memory only (the
 * scribe segment executes it post-reply), and closeSlice's `end` IS the last
 * turn's timestamp anyway — the reference is identical either way.
 */
function toPrevRef(s: TimeSlice): PrevSliceRef {
  return {
    id: s.slice_id,
    focus: s.focus,
    start: s.start,
    end: s.end ?? s.turns.at(-1)?.timestamp,
  };
}

// ─── Disk scans (no projections — v0.19 A1) ───────────────────────────────

/**
 * Slice ids (dashed, newest first) living in TODAY's and YESTERDAY's day
 * dirs under BOTH roots — the bounded scan window every disk scan here
 * shares (same discipline as tryLoadTodaySlice: a cross-UTC-midnight
 * conversation lives in yesterday's dir).
 */
async function listRecentDaySliceIds(): Promise<string[]> {
  const now = new Date();
  const ids = new Set<string>();
  for (const d of [now, new Date(now.getTime() - 86_400_000)]) {
    for (const root of [RECORDS_ROOT, LEGACY_SLICES_ROOT] as const) {
      const dayDir = dayDirForDate(root, d);
      let entries: Awaited<ReturnType<typeof fsListFiles>>;
      try {
        entries = await fsListFiles(dayDir);
      } catch {
        continue; // missing year/month/day level — nothing there
      }
      const rel = dayDir.slice(root.length + 1); // YYYY/MM/DD
      for (const e of entries) {
        if (e.type === "dir" && /^\d{4}$/.test(e.name)) {
          ids.add(`${rel.replace(/\//g, "-")}-${e.name}`);
        }
      }
    }
  }
  return [...ids].sort().reverse();
}

/** Read + parse one slice's core.md by id; the directory name backstops a
 *  frontmatter without slice_id. Null when unreadable. */
async function readSliceById(
  id: string,
  batch?: WriteBatch,
): Promise<TimeSlice | null> {
  try {
    const s = parseSlice(await readSlicePart(id, "core", batch));
    if (!s.slice_id) s.slice_id = id;
    return s;
  } catch {
    return null;
  }
}

/**
 * The newest slice CLOSED before `excludeFromId` — the continuity reference.
 * Pure disk truth, no timeline catalog (the projection is gone from the turn
 * path in v0.19 A1). (Its other v0.19 consumer — the scribe segment's
 * boundary-event target — is retired with the dispatch chain, v0.21 §A.2.2.)
 *
 * Two tiers: the bounded today/yesterday scan first; when it holds no closed
 * slice, a full enumeration (ONE Git tree call on GitHub backends, a bounded
 * recursive walk locally) covers longer gaps. Reads are capped at 12 heads.
 */
async function readPrevClosedSlice(
  excludeFromId?: string,
  batch?: WriteBatch,
): Promise<TimeSlice | null> {
  const findClosed = async (ids: string[]): Promise<TimeSlice | null> => {
    for (const id of ids.slice(0, 12)) {
      if (excludeFromId && id >= excludeFromId) continue;
      const s = await readSliceById(id, batch);
      if (s && s.status === "closed") return s;
    }
    return null;
  };
  const fromRecentDays = await findClosed(await listRecentDaySliceIds());
  if (fromRecentDays) return fromRecentDays;
  const all = (await enumerateSliceIds())
    .map((rel) => rel.replace(/\//g, "-"))
    .sort()
    .reverse();
  return findClosed(all);
}


/**
 * The §A.3.3 delivery surface: tasks/ tail lines dated TODAY are the
 * background stream's completion statements (a question run's notice, a
 * task case closed today). Mechanical: parse each task case's index.md,
 * collect the tail lines stamped with the user's local today. One-day
 * window by construction — no delivery ledger.
 */
async function scanTodayTaskStatements(
  todayLocal: string,
  batch: WriteBatch,
): Promise<Array<{ path: string; statement: string }>> {
  const out: Array<{ path: string; statement: string }> = [];
  let entries: Awaited<ReturnType<typeof fsListFiles>>;
  try {
    entries = await fsListFiles(`${MEMORY_ROOT_DIR}/tasks`);
  } catch {
    return out; // no tasks shelf yet
  }
  for (const e of entries) {
    if (e.type !== "dir") continue;
    try {
      const raw = await fsReadFile(caseIndexPath("tasks", e.name), batch);
      const doc = parseCaseDoc(raw, {
        category: "tasks",
        caseName: e.name,
        fileName: "index.md",
      });
      for (const line of doc.tail) {
        if (line.date === todayLocal) {
          out.push({ path: `tasks/${e.name}`, statement: line.text });
        }
      }
    } catch {
      // unreadable / unparseable case — skip
    }
  }
  return out;
}

// ─── Step 1: Housekeeping (进场那一拍 — the entry beat) ───────────────────

/**
 * How many trailing turns of a checkpointed previous slice are carried into
 * the new slice's history window (see the contextPrefix block below).
 */
const CHECKPOINT_CARRY_OVER_TURNS = 10;

/**
 * The entry beat's one semantic derivation (v0.21 §3), carried BY VALUE to
 * the post-reply explicit-instruction channel (序 6): the workflow hands the
 * housekeeping result straight through, so 序 6 reuses the reading instead of
 * re-deriving it with a second LLM call. Both fields are null in demo mode
 * (the reckoning is skipped there — and 序 6 early-returns on demo before it
 * would ever read them). Plain serializable data — safe across the workflow
 * step boundary.
 */
export interface EntryReckoning {
  /** The entry analyzeTurn result (or the adapted bridge housekeeping report). */
  analysis: TurnAnalysis | null;
  /** Client/bridge mode only: the raw bridge report — 序 6 applies its card
   *  mutations through the card-session machinery (applyBridgeCardEvolution). */
  bridgeReport: HousekeepingPhaseReport | null;
  /** Evidence attachments (names + base64 bytes) the user sent THIS
   *  beat — the entry beat commits nothing, so the summary stream
   *  persists them through the same fuse semantics (v0.42 review
   *  blocker 1). null when the turn carried none. */
  evidenceAttachments: Array<{ name: string; dataBase64: string }> | null;
  /** The people/user mid-life snapshot update for an EXISTING slice
   *  (a birth carries its own) — written to previously.md by the
   *  summary stream (v0.42 review should-fix 1). null = no change. */
  previouslyUpdate: string | null;
  /** True when THIS beat's slice was READ from disk (the edge). False for
   *  the UNSAVED context shell minted when no slice exists — the shell
   *  must never reach a flush (the real-machine ghost slice: finalize's
   *  序 6 evolution froze a summary into it and flushed it). */
  sliceOnDisk: boolean;
}

/**
 * 进场那一拍 (v0.21 §3). Recover today's slice from GitHub truth (never the
 * module global — it does not survive across workflow invocations), DECIDE
 * its lifecycle (idle gap / age cap / turn cap — pure clock, the slicer is
 * unchanged), and — when a page is judged ended — summarize THAT page and
 * close it HERE, before this turn's user message lands: the beat's one
 * semantic derivation (analyzeTurn, or the ONE bridge housekeeping call in
 * client mode) reads the ended page's turns only, writes
 * focus/summary/tone into its frontmatter (needs_marking-idempotent), and
 * closeSlice persists it in this step's ONE commit. A close decision and its
 * execution are atomic now — a kill in between simply re-runs the beat on
 * redelivery (every write is idempotent), and the findStaleActiveSlice scan
 * still catches an orphan left by a pre-v0.21 run.
 *
 * When no page ends, there is ZERO summarization — the living page waits
 * for its real end. The derivation still runs every non-demo turn: its
 * memoryUpdate reading feeds the post-reply explicit-instruction channel
 * (序 6), threaded through the returned EntryReckoning so 序 6 never needs
 * a second LLM call.
 *
 * NO projection writes (timeline weave, catalog upserts, global timeline are
 * gone from the turn path), NO strands menu / timeline brief / view block /
 * overdue block (撤清单 §A.2.2).
 */
export async function housekeeping(
  input: TurnInput,
): Promise<HousekeepingResult & EntryReckoning> {
  "use step";

  // One reused writer + serial queue for every UI chunk this step emits —
  // fresh-writer-per-write races drop frames (see createStepStream).
  const stream = createStepStream();

  // ── Phase display: two modes, two components ─────────────────────────
  // Edge mode emits one compact data-phase chunk per engineering sub-step
  // (slice / analyze / slice-closed / context) — the client merges them into
  // the HousekeepingCard checklist.
  // Client (outsourced) mode renders ONE streaming card instead: the whole
  // analysis is a single agent call + deterministic wrap-up, so the card
  // streams the CLI's live activity (tool rows + narration line, fed by the
  // bridge emitter below) and fills in wrap-up rows as the engineering
  // steps complete — the edge checklist is NOT emitted (it would sit idle
  // through the whole call, then jump to done).
  // The gate also requires the turn's model to run on the bridge — a BYOK
  // model (sdk "openai") under a bridge env brain keeps the analysis on the
  // standard API sub-agent path.
  const phaseOutsource = isPhaseOutsourceActive(input.modelConfig.sdk);
  /** Wrap-up rows of the client-mode card (same shape as the checklist). */
  const hkSteps: HousekeepingStep[] = [];
  /** Last bridge-emitter frame state, folded into every card frame. */
  const hkActivity: {
    tools: BridgePhaseData["tools"];
    live?: string;
    /** Set when the bridge call failed and the beat degraded to the
     *  deterministic path — the card shows an amber warning. */
    warning?: string;
  } = {
    tools: [],
  };
  const sendHousekeepingCard = (running: boolean) =>
    stream.send({
      type: "data-phase" as `data-${string}`,
      id: "phase-bridge-housekeeping",
      data: {
        phase: "bridgeHousekeeping",
        running,
        summaries: [],
        tools: hkActivity.tools,
        ...(hkActivity.live ? { live: hkActivity.live } : {}),
        ...(hkActivity.warning ? { warning: hkActivity.warning } : {}),
        steps: hkSteps.map((s) => ({ ...s })),
      },
    } as UIMessageChunk);
  /** Phase display dispatch: edge → compact checklist chunk; client → a
   *  wrap-up row inside the bridge housekeeping card. */
  const emitStep = async (
    phase: string,
    running: boolean,
    summaries?: string[],
  ): Promise<void> => {
    if (!phaseOutsource) return emitPhase(stream, phase, running, summaries);
    const existing = hkSteps.find((s) => s.phase === phase);
    if (existing) {
      existing.running = running;
      if (summaries !== undefined) existing.summaries = summaries;
    } else {
      hkSteps.push({
        phase,
        running,
        ...(summaries !== undefined ? { summaries } : {}),
      });
    }
    sendHousekeepingCard(hkSteps.some((s) => s.running));
  };

  // ── Phase: slice — manage the time slice (recover/create; decide) ────
  await emitPhase(stream, "slice", true);

  const { config, clientTimezone, lastUserMessage, modelMessages } = input;

  // Peek at today's slice ONLY to derive the per-slice lock key (it may be
  // stale by the time the lock is acquired — the disk slice is re-loaded
  // inside). Single-process deployments serialize turns on the same slice
  // through this mutex; cross-process races are healed at commit time.
  const peeked = await tryLoadTodaySlice();
  const lockKey =
    peeked?.slice_id ?? `new-slice:${new Date().toISOString().slice(0, 10)}`;

  try {
  return await withSliceLock(lockKey, async () => {
  // ── Begin batch: all writes below go into ONE git commit. The batch is an
  // explicit object threaded through every call — never a module global, so
  // two turns in one process can't flush each other's writes. ─────────────
  const batch = createBatch();

  const diskSlice = await tryLoadTodaySlice(batch);

  // ── 1. Context-only judgments (v0.42 §1 — 对话流不建片不封片; the
  // landing judgment — 续写还是开新片 — moved to the summary stream,
  // applied once the WHOLE burst has answered). The only entry-side
  // judgment left: a client-history mismatch rebuilds the model window
  // from the slice (a context concern, never a write).
  let rebuildFromSlice = false;
  if (diskSlice && diskSlice.status === "active") {
    // A regenerate turn legitimately carries a truncated client history (the
    // SDK dropped the rejected reply) — detection is skipped for this turn
    // shape, and demo mode never persists a slice so nothing to rebuild from.
    if (
      !input.regenerate &&
      !input.useDemo &&
      checkClientHistoryMismatch(modelMessages, diskSlice)
    ) {
      rebuildFromSlice = true;
    }
  }

  // ── 2. The current edge slice — READ-ONLY answering context ─────────
  // v0.42 §1 (the user's words): the conversation flow ANSWERS inside the
  // edge slice's context and changes NOTHING on disk; the summary stream
  // judges the landing once the WHOLE burst has answered. With no edge
  // the turn answers empty-context and the summary mints the first page.
  let slice: TimeSlice;
  /** v0.42 — the evidence bytes + the mid-life previously snapshot ride
   *  the result to the summary stream (the entry beat commits nothing). */
  let evidenceAttachments: Array<{ name: string; dataBase64: string }> | null =
    null;
  let previouslyUpdate: string | null = null;
  /** The slice we came from — resolved from disk (the newest closed page
   *  before this one). Drives the continuity brief. */
  let prevSlice: PrevSliceRef | null = null;
  if (diskSlice) {
    slice = diskSlice;
    console.log(`[Episodic] Edge slice (read-only): ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
  } else {
    // An UNSAVED context shell — feeds the model window only; the summary
    // stream decides whether (and under which id) a real page is minted.
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    console.log(`[Episodic] No edge slice — empty-context answer (landing judged by the summary)`);
  }
  // The batch key groups the burst's runs in the registry: the edge id
  // when one exists, else a deterministic per-day key (an unsaved context
  // shell mints no shared identity across turns).
  const batchKey =
    diskSlice?.slice_id ?? `new-slice:${input.startedAtIso.slice(0, 10)}`;

  // ── v0.33 连发并行 — registry stamp + live-sibling count ────────────────
  // Stamp THIS run into the Workflow run registry the moment the slice is
  // known (`slice` + `turn` attributes), so parallel siblings and the tail's
  // last-one check can find it; then count the slice's other live turn runs
  // for the outbound-tail parallel note. Bridge/demo turns never participate
  // (D10). The registry is an ENHANCER, never a blocker: a world without
  // native attributes or a transient list failure just means no note.
  let parallelSiblings: number | undefined;
  if (!input.useDemo && input.modelConfig.sdk !== "bridge") {
    try {
      const ownId = getWorkflowMetadata().workflowRunId;
      await setAttributes({
        slice: batchKey,
        turn: input.turnId,
        ...(input.burstId ? { burst: input.burstId } : {}),
      });
      const live = await listLiveRuns();
      const count = live.filter((r) =>
        isBlockingParallelSibling(r, batchKey, ownId),
      ).length;
      if (count > 0) parallelSiblings = count;
    } catch (err) {
      console.warn(
        "[Parallel] registry stamp/count failed (ignored):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Ages/due-dates compare against the USER's local calendar date, not UTC.
  const todayLocal =
    localDateKey(input.startedAtIso, clientTimezone) ??
    input.startedAtIso.slice(0, 10);

  // ── 2b. The entry's one semantic derivation (v0.42 §1: 归纳随封口走) ──
  // The analysis still runs every non-demo turn — its memoryUpdate reading
  // feeds the post-reply explicit-instruction channel (序 6) — but with NO
  // closing slice: no page "ends" at the entry anymore, so the derivation
  // is always zero-归纳. The summary stream re-runs the same analyzer over
  // the ended page when it seals one (same deterministic fallback).
  let analysis: TurnAnalysis | null = null;
  let bridgeReport: HousekeepingPhaseReport | null = null;
  if (!input.useDemo) {
    await emitStep("analyze", true);
    if (phaseOutsource) {
      const bridgeCardRaw =
        (await readUserModel(batch).catch(() => null))?.card ?? "";
      const bridgeActivity = createBridgeEventEmitter({
        id: "phase-bridge-housekeeping",
        phase: "bridgeHousekeeping",
        write: (data: BridgePhaseData) => {
          hkActivity.tools = data.tools;
          hkActivity.live = data.live;
          sendHousekeepingCard(
            data.running || hkSteps.some((s) => s.running),
          );
        },
      });
      const bridgeResult = await runHousekeepingBridge(
        {
          userMessage: lastUserMessage,
          recentTurns: input.recentTurns,
          cardContent: bridgeCardRaw,
          sliceId: slice.slice_id,
          closingSlice: undefined,
          todayLocal,
          locale: input.locale,
        },
        { onEvent: bridgeActivity.onEvent, onDelta: bridgeActivity.onDelta },
      );
      bridgeActivity.finish();
      if (bridgeResult.ok) {
        bridgeReport = bridgeResult.report;
        analysis = adaptHousekeepingReport(bridgeResult.report, false);
      } else {
        console.warn(
          `[HousekeepingBridge] ${bridgeResult.reason} — degraded to the deterministic path`,
        );
        analysis = degradedAnalysis();
        hkActivity.warning = bridgeResult.reason;
        sendHousekeepingCard(hkSteps.some((s) => s.running));
      }
    } else {
      analysis = await analyzeTurn({
        model: input.modelConfig,
        userMessage: lastUserMessage,
        closingSlice: undefined,
      });
    }
    await emitStep("analyze", false);
  }

  // ── 3. Append user turn ───────────────────────────────────────────────
  // Dedup by turnId (user and agent turns of a round share it — scope the
  // check to role): a redelivered workflow run finds its user turn already
  // persisted and skips the append. Legacy turns parsed from old files carry
  // no turnId, so the content check below stays as the fallback (mirrors the
  // turnKey fallback in lib/episodic/turn-merge.ts).
  // A regenerate turn never appends: the question is already the slice's last
  // user turn — the rejected reply stays, the new answer joins as a second
  // agent turn under the fresh turnId.
  const isNewSlice =
    slice.turns.length === 1 && slice.turns[0].content === lastUserMessage;
  const userTurnRecorded =
    !!input.turnId &&
    slice.turns.some((t) => t.role === "user" && t.turnId === input.turnId);
  if (!isNewSlice && !userTurnRecorded && !input.regenerate) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "user",
      content: lastUserMessage,
      turnId: input.turnId,
    });
  }

  // ── 3b. Evidence attachments → the records case (v0.19 §C.1) ──────────
  // The files/images the user sent THIS turn land in the slice's
  // attachments/ dir (`<turnId>-<name>`), and the landed names ride the
  // turn's content so core.md points at its own evidence. Runs on exactly
  // the deliveries that record the user turn: a slice born this call (its
  // turn 0 carries this turnId by birth, which userTurnRecorded cannot
  // distinguish from a redelivery) or a fresh append; a redelivery finds
  // the turn on disk and skips; a regenerate records nothing. Failures are
  // visible warnings, never fatal — the turn proceeds without the evidence.
  if (
    !input.regenerate &&
    input.turnId &&
    // The turn's evidence rides its user turn: an UNSAVED context shell's
    // turn 0 IS this turn (userTurnRecorded reads true from the shell — the
    // old birth case), so the gate also opens when there was no edge.
    (!diskSlice || !userTurnRecorded)
  ) {
    const { files, unfetched } = collectTurnAttachments(input);
    for (const name of unfetched) {
      console.warn(`[Attachments] remote-URL part not fetched — skipped: ${name}`);
    }
    if (files.length > 0) {
      // v0.42 — the entry beat commits NOTHING, so the evidence cannot
      // land here (the old code queued it into the never-flushed batch
      // — the files died with it, and the persisted turn never got the
      // marker). The bytes ride THIS turn's structured result to the
      // summary stream, which persists them through the SAME
      // persistEvidenceAttachments fuse semantics with the round's live
      // batch and annotates the persisted user turn with the LANDED
      // names. The in-memory marker below still feeds THIS turn's
      // model context.
      evidenceAttachments = files.map((f) => ({
        name: f.name,
        dataBase64: f.data.toString("base64"),
      }));
      const marker =
        `\n\n[attachments: ${files.map((f) => f.name).join(", ")}]`;
      const last = slice.turns.at(-1);
      if (last?.role === "user") last.content += marker;
    }
  }
  await emitPhase(stream, "slice", false, [slice.slice_id]);

  // ── Phase: context — load the user profile (previously + identity) ───
  await emitPhase(stream, "context", true);

  // ── 4. people/user read face + per-slice snapshot (v0.19 R4, §B.7) ────
  // The folded user model (people/user/index.md — card + direction in ONE
  // document) and the user's own self-description (profile.md) are the ONLY
  // case injected every turn. Tolerant reads fall back to the legacy roots
  // (current-previously.md / evolution/direction.md / user/profile.md).
  const userModel = await readUserModel(batch).catch(() => null);
  const userProfile = await readUserProfile(batch).catch(() => null);
  // The card half drives the identity head parse and the L1 injection block.
  const previouslyContent = userModel?.card ?? "";

  // Snapshot semantics (§B.7): the slice's previously.md freezes the FULL
  // index.md as it stands this turn — readPreviously is thereafter "the user
  // model as of that slice". Fresh deployments seed from the most recent
  // legacy snapshot so the chain never breaks. Write only on change.
  const modelSnapshot =
    userModel?.full ??
    (await findMostRecentPreviously(batch).catch(() => null)) ??
    "";
  if (modelSnapshot.trim()) {
    const existingSnap = await readPreviously(slice.slice_id).catch(() => "");
    if (existingSnap !== modelSnapshot) {
      // v0.42 — the snapshot ALWAYS rides the result (the batch here
      // never flushes; the old queued write died with it). The summary
      // stream writes it into the slice IT judges — continued or new.
      previouslyUpdate = modelSnapshot;
      console.log(`[Previously] Snapshotted people/user/index.md for ${slice.slice_id} (rides the summary)`);
    }
  }

  // ── 5. NO commit in the entry beat (v0.42 §0/§2) — 被动存盘 belongs to
  // the summary stream: the user turn, the ended page's seal (`sealed` on
  // this beat's result) and the slice snapshot all ride THIS turn's
  // structured result; the burst's last survivor's summary run lands them
  // in ONE `Summary — {sliceId}` commit. The batch below is NEVER flushed
  // — its queued entries serve this beat's read-your-writes only.
  await mergeSliceWithDiskTurns(slice, input);
  await saveSliceSnapshot(slice, batch);

  // ── 6. Continuity + slice-head snapshot + identity (the read face) ────
  // v0.9 slice-level prompt freeze: the continuity stance is computed at the
  // SLICE'S BIRTH, not per turn — the reference is the newest slice closed
  // before this one began (the one this beat just closed + marked, else disk
  // truth), and the gap is measured against `slice.start`. Recomputed this
  // way on every turn, the resulting line is byte-identical for the slice's
  // life.
  if (!prevSlice) {
    const prev = await readPrevClosedSlice(slice.slice_id);
    prevSlice = prev ? toPrevRef(prev) : null;
  }
  const continuity = classifyContinuity(
    slice.start,
    prevSlice,
    false,
    slice.continuesFrom,
  );

  // ── Checkpoint carry-over — a slice born from a time_cap/capacity close
  // continues the SAME conversation: the previous slice's frozen tail is
  // prepended to the history window (turn-workflow) so the dialogue flows
  // seamlessly across the checkpoint. The tail is read server-side from the
  // CLOSED slice (never from client messages), so it is byte-fixed for this
  // slice's whole life and the window stays append-only. Best-effort: an
  // unreadable predecessor just means no carry-over. Role-alternation safety
  // (orphan user tail after a stop/cancel, double agent turns after a
  // regenerate) is enforced where the prefix joins the window —
  // sanitizeCheckpointPrefix in turn-workflow.ts.
  let contextPrefix: ModelMessage[] | undefined;
  if (slice.continuesFrom) {
    // (The shell created for an edgeless turn never carries continuesFrom —
    // the summary stream owns every real slice's lineage.)
    const prevTurns = (await loadSlice(slice.continuesFrom))?.turns;
    const tail = prevTurns?.slice(-CHECKPOINT_CARRY_OVER_TURNS) ?? [];
    if (tail.length > 0) {
      contextPrefix = sliceTurnsToMessages(tail);
    }
  }

  // ── Rebuilt history window (client-history mismatch) ─────────────────
  // The client-sent history mismatched the active slice (page refresh,
  // device switch, stale local writes) — the slice stays OPEN and the model
  // history window is rebuilt from the SLICE's own turns (authoritative),
  // so the conversation continues seamlessly instead of forking a new slice.
  // Built AFTER the user-turn append: the current message is in the slice
  // by now, so it is part of the rebuilt window exactly once.
  let rebuiltHistory: ModelMessage[] | undefined;
  if (rebuildFromSlice) {
    rebuiltHistory = sliceTurnsToMessages(slice.turns);
    console.warn(
      `[Episodic] Client history mismatch — rebuilt window from slice ${slice.slice_id} ` +
        `(${rebuiltHistory.length} turns), slice stays open`,
    );
  }

  // The frozen L3 block — see buildSliceHeadBlock (src/lib/turn-priming.ts).
  // The evolution summary rides the slice frontmatter, so a restored slice
  // replays the exact line written at its birth.
  const sliceHeadBlock = buildSliceHeadBlock({
    sliceStartIso: slice.start,
    clientTimezone: input.clientTimezone,
    locale: input.locale,
    continuity,
    evolutionSummary: slice.evolutionSummary,
  });

  // The agent's constitution (SOUL + who-you're-assisting + DIRECTIVES),
  // derived from the already-loaded previously.md identity section.
  const profile = parseIdentityFromPreviously(previouslyContent);
  const identityPrompt = buildAgentIdentityPrompt(profile);

  // The direction layer for the main agent's system prompt: the direction
  // HALF of the folded people/user/index.md (readUserModel already falls
  // back to the legacy direction.md). The explicit-instruction evolution
  // channel runs post-reply (序 6), so a direction landed this turn is what
  // the NEXT turn reads — within a slice without an evolution the layer is
  // byte-stable. Missing / template / legacy-skeleton docs omit the layer
  // entirely (buildDirectionBlock returns "").
  const directionBlock = buildDirectionBlock(userModel?.direction ?? null);

  // people/user/profile.md — the user's OWN self-description (§B.7): the
  // user is its only writer, and on conflict with the model above THE
  // SELF-DESCRIPTION WINS — that discipline is stated to the model in the
  // block itself. Absent profile → the layer is omitted.
  const userProfileBlock = userProfile?.trim()
    ? [
        "## The user's own words about themselves (profile.md)",
        "",
        userProfile.trim(),
        "",
        "This is the user's self-description — they wrote it directly, and only they can change it. When it conflicts with anything in the model above, THE SELF-DESCRIPTION WINS; treat the model entry as stale and say so when it comes up.",
      ].join("\n")
    : undefined;

  // ── §A.3.3 delivery — HQ's completions, stated ────────────────────────
  // Tasks/ tail lines dated TODAY (a question run's notice, a task case
  // closed today) are declarative statements the reply owes the user. The
  // block's own text carries the discipline: state, never promise.
  // (todayLocal was computed above, before the reckoning.)
  const taskStatements = await scanTodayTaskStatements(todayLocal, batch);
  const dueTasksBlock =
    taskStatements.length > 0
      ? [
          "## Completed background work — state it, don't promise",
          "",
          "The background stream completed these since (each line is the dated closing note of a real task case). Tell the user naturally, in their language; state facts only — do NOT promise any future work.",
          ...taskStatements.map((s) => `- ${s.path}: ${s.statement}`),
        ].join("\n")
      : undefined;

  // ── v0.30 §2.4 暂存 — the reflection unit's staged note ────────────────
  // Read at the entry beat so the workflow can carry it on the OUTBOUND tail
  // of this turn's last user message — exactly once (R1: the workflow compares
  // the note's stamp against the previous user turn's). Tolerant: an absent
  // or corrupt hq.json reads as the empty pointer, and the note is omitted.
  // v0.39 §1/待裁决 3 — the 暂存 moved to the COMMIT LOG: the newest
  // `Reflection round —` commit's note paragraph + its commit timestamp.
  // The exactly-once discipline downstream (buildReflectionNoteSection's
  // newer-than-previous-user-turn check on `at`) is unchanged — `at` is
  // now the commit time, which postdates the turn it answers by construction.
  const reflectionNote = (await readLatestReflectionNote()) ?? undefined;

  await emitPhase(stream, "context", false, [`continuity: ${continuity.tier}`]);

  // ── 7. Open UI stream ────────────────────────────────────────────────
  await stream.write({ type: "start" } as UIMessageChunk);
  await stream.write({ type: "start-step" } as UIMessageChunk);

  return {
    slice,
    previouslyContent,
    sliceHeadBlock,
    identityPrompt,
    analysis,
    bridgeReport,
    evidenceAttachments,
    previouslyUpdate,
    sliceOnDisk: !!diskSlice,

    ...(directionBlock ? { directionBlock } : {}),
    ...(userProfileBlock ? { userProfileBlock } : {}),
    ...(dueTasksBlock ? { dueTasksBlock } : {}),
    ...(reflectionNote ? { reflectionNote } : {}),
    ...(parallelSiblings ? { parallelSiblings } : {}),
    ...(contextPrefix ? { contextPrefix } : {}),
    ...(rebuiltHistory ? { rebuiltHistory } : {}),
  };
  });
  } finally {
    // Release the step's writer lock so the step's HTTP request can terminate
    // and later steps (agent reply, the post-reply steps) can acquire their own.
    stream.close();
  }
}

// Platform step retries re-run the WHOLE beat — the LLM analysis included
// — and re-emit every phase chunk (the production incident's flip-flopping
// phase card): the SDK default is maxRetries=3 → 4 total attempts
// (docs/foundations/errors-and-retries.mdx:136-140; the runtime reads the
// property live at failure time — @workflow/core step-executor.js:238,
// runtime.js:1354). Flush conflicts now self-heal inside flushTurnBatch
// and typed rate limits fast-fail via the circuit breaker (immediate
// whole-step retries can only burn LLM quota against them), so ONE retry
// is kept for genuine transients (network blip, provider 5xx).
// Ruled: doc/reviews/housekeeping-and-page-hang.md §8 (user to confirm).
(housekeeping as { maxRetries?: number }).maxRetries = 1;

// ─── The turn tail: finalizeTurn — one slice-locked step, ONE commit ──────

/**
 * Reconcile the in-memory slice with the disk file before a snapshot write
 * (the episode-append race): the messages route appends nested-episode user
 * turns DIRECTLY to the slice file mid-reply, while this run still rides the
 * snapshot it loaded at turn start. A saveSliceSnapshot computed from that
 * stale base would silently erase the route-appended turns, so every snapshot
 * write in the turn pipeline (the housekeeping flush, finalizeTurn) unions
 * the disk turns in first — the same mechanical append-only merge as the
 * commit-conflict heal, keyed by turnId. Reads through the turn's ACTIVE
 * backend; a missing file (brand-new slice) or demo mode means nothing to
 * merge. Returns the number of turns appended.
 */
async function mergeSliceWithDiskTurns(
  slice: TimeSlice,
  input: TurnInput,
): Promise<number> {
  if (input.useDemo) return 0;
  const path = sliceIdToFilePath(slice.slice_id);
  let raw: string;
  try {
    if (input.useGithub) {
      // BYPASS the Data Cache — the route's commit landed seconds ago and our
      // cached copy may still hold the stale base (flushTurnBatch's reasoning).
      const { owner, repo } = getRepoConfig();
      raw = await readFileFresh(path, repo, owner);
    } else {
      raw = await readFileLocal(path);
    }
  } catch {
    return 0;
  }
  const added = mergeDiskTurnsIntoSlice(slice, raw);
  if (added > 0) {
    console.log(
      `[Episodic] Merged ${added} route-appended disk turn(s) into ${slice.slice_id}`,
    );
  }
  return added;
}

/**
 * How many times a conflicting flush re-reads the remote slice, merges, and
 * retries the commit before giving up (and failing the step → queue retry).
 */
const MAX_FLUSH_RETRIES = 2;

/**
 * Flush the turn's batch with write-conflict self-heal.
 *
 * `commitBatchToGitHub` does a non-force updateRef: when another turn (or
 * process) commits between our read and our commit, the update is rejected as
 * non-fast-forward. Slice turns are append-only, so the heal is mechanical —
 * re-read the REMOTE core.md, merge-append this turn's missing entries by
 * turnId, swap the merged file into the batch, and retry the commit.
 */
async function flushTurnBatch(
  batch: WriteBatch,
  message: string,
  /** null = no slice file backs this batch (a context shell's turn):
   *  a ref conflict retries as-is — there is nothing to merge against. */
  slice: TimeSlice | null,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await flushBatch(batch, message);
      return;
    } catch (err) {
      if (!isRefConflictError(err) || attempt >= MAX_FLUSH_RETRIES) {
        throw err;
      }
      if (slice === null) {
        console.warn(
          "[Episodic] flush conflict on a batch with no slice file — retrying as-is:",
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      const corePath = sliceIdToFilePath(slice.slice_id);
      try {
        // Re-read the remote slice BYPASSING the Data Cache: our own cached
        // copy may still hold the stale base, and the tag revalidation may
        // not be visible in this (non-request) context.
        const { owner, repo } = getRepoConfig();
        const remoteRaw = await readFileFresh(corePath, repo, owner);
        batch.entries.set(corePath, mergeTurnsWithRemote(remoteRaw, slice));
        console.warn(
          `[Episodic] flush conflict on ${corePath} — merged remote turns, retrying (${attempt + 1}/${MAX_FLUSH_RETRIES})`,
        );
      } catch (mergeErr) {
        // Remote slice unreadable (deleted?) — retry the commit as-is.
        console.warn(
          `[Episodic] flush conflict on ${corePath} — remote re-read failed, retrying as-is:`,
          mergeErr instanceof Error ? mergeErr.message : mergeErr,
        );
      }
    }
  }
}

/**
 * The turn tail — 序 6 (explicit-instruction evolution) in ONE slice-locked
 * step, riding the turn's batch (v0.38 §6: the turn's commits are the ENTRY
 * beat's — the user turn landed synchronously in housekeeping; what remains
 * here is the evolution拍 only). The REPLY side is ZERO-batch: the reply
 * turn + cognition + snapshot moved to the SUMMARY stream (v0.42 §2 —
 * 被动存盘归总结流): the burst's last turn starts the summary run BEFORE
 * closeTurnStream, carrying its own record — the persistence intent is
 * durable the moment the start succeeds. `Turn {turnId} — finalize`
 * therefore names the evolution拍 (and
 * the episode-residual bubbles) only; on a plain turn the batch is empty and
 * the flush no-ops. Idempotent under redelivery; the flush keeps the
 * turn-merge self-heal (flushTurnBatch).
 */
export async function finalizeTurn(
  slice: TimeSlice,
  outcome: TurnOutcome,
  input: TurnInput,
  hk: HousekeepingResult & EntryReckoning,
  /**
   * The episode tail (v0.30 §3.4, D7) — terminal nested bubbles + the merged
   * summary, riding this same batch and commit. Absent on a single-message
   * (兼任) episode, which stays byte-identical to the pre-episode turn.
   */
  nested?: NestedTurnTail,
): Promise<void> {
  "use step";

  // One reused writer for the evolution channel's frames — the same
  // discipline the split steps had; released in `finally`.
  const stream = createStepStream();
  try {
  return await withSliceLock(slice.slice_id, async () => {
  // ── ONE batch for the whole tail: every segment below rides a single
  //    commit. The batch is a per-call object — never module-global — so
  //    two turns in one process can't flush each other's writes.
  const batch = createBatch();
  /** D4: the commit body names the segments that actually queued writes. */
  const segments: string[] = [];
  const mark = (name: string, before: number): void => {
    if (batch.entries.size > before) segments.push(name);
  };

  // ── Segment 1 (v0.38 §6 / v0.42 §2): the reply turn + cognition +
  //    snapshot moved to the SUMMARY stream — 回复侧零批. What stays here is the
  //    episode-residual nested bubbles (the hard-off orchestrator path,
  //    retiring with that machinery) and nothing else.
  const before1 = batch.entries.size;
  await mergeSliceWithDiskTurns(slice, input);
  for (const bubble of nested?.bubbles ?? []) {
    if (
      slice.turns.some((t) => t.role === "agent" && t.turnId === bubble.turnId)
    ) {
      continue;
    }
    const bubbleStamp = bubble.doneAt ?? new Date().toISOString();
    if (bubble.finishReason === "stop" && bubble.text) {
      appendTurn(slice, {
        timestamp: bubbleStamp,
        role: "agent",
        content: bubble.text,
        turnId: bubble.turnId,
        replyTo: bubble.replyTo,
      });
    } else if (bubble.text) {
      appendTurn(slice, {
        timestamp: bubbleStamp,
        role: "agent",
        content: `[partial] ${bubble.text}`,
        turnId: bubble.turnId,
        replyTo: bubble.replyTo,
      });
      console.log(
        `[Episodic] Nested bubble ${bubble.turnId} interrupted (${bubble.finishReason})`,
      );
    } else {
      console.log(
        `[Episodic] Nested bubble ${bubble.turnId} produced no text (${bubble.finishReason})`,
      );
    }
  }
  if (nested?.bubbles.some((b) => b.text) && hk.sliceOnDisk) {
    // v0.42 A-fix: a context shell is never written — the bubble appends
    // stay in memory only (the retiring episode machinery degrades).
    await saveSliceSnapshot(slice, batch);
  }
  mark("episode bubbles", before1);

  // ── Segment 2: 序 6 — the explicit-instruction channel (post-reply) ───
  // The turn's ONLY surviving post-reply derivation (v0.19 §A.3.2): the user
  // explicitly asked to record/evolve or stated a behavioral correction —
  // READ by the entry beat's one semantic derivation (hk.analysis, carried
  // by value so this segment never re-derives it with a second LLM call),
  // EXECUTED here. Everything else the v0.19 scribe segment did is gone
  // (v0.21 §A.2.2 改写 / §9): analyze + close moved into the entry beat
  // (归纳上一页, idempotent via needs_marking), the close-triggered HQ
  // dispatch chain is retired — the reflection unit's ONLY trigger is the
  // mechanical bell (ringReflection, v0.30 §2.1) — and the marker-consuming
  // scribe passes are the unit's job now
  // (the [doc-*] mailbox contract itself is frozen and untouched — the unit
  // reads it as prose clues). Writes are idempotent under redelivery (a review
  // re-run converges); failures are reported to the client as an error
  // chunk and never take the turn down. Demo skips the segment entirely
  // (read-only preview — 空转零写入).
  const before2 = batch.entries.size;
  if (!input.useDemo) {
  const phaseOutsource = isPhaseOutsourceActive(input.modelConfig.sdk);
  // Ages compare against the USER's local calendar date, not UTC.
  const todayLocal =
    localDateKey(input.startedAtIso, input.clientTimezone) ??
    input.startedAtIso.slice(0, 10);

  // Live thinking channel: the Previously Agent streams its reasoning/writing
  // through onEvolutionLine → throttled (40ms, same discipline as tool
  // progress) data-evolution frames carrying the current line. The phase step
  // ("reading" → "reviewing") rides along; the "applied" step is folded into
  // the terminal result chunk, which follows immediately.
  let evolutionLiveState: ProgressWriteState = {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
  };
  let evolutionStep: "direction" | "reading" | "reviewing" = "reading";
  const onEvolutionProgress = (step: "reading" | "reviewing" | "applied") => {
    if (step === "applied") return; // the terminal result chunk follows
    evolutionStep = step;
    emitEvolutionProgress(stream, step);
  };
  const onEvolutionLine = (line: string, stage: "thinking" | "writing") => {
    const now = Date.now();
    if (!shouldEmitProgress(evolutionLiveState, { line, stage }, now)) return;
    evolutionLiveState = {
      lastWriteMs: now,
      lastLine: line,
      lastStage: stage,
      sentAny: true,
    };
    emitEvolutionProgress(stream, evolutionStep, line, stage);
  };

  // ── 序 6. Explicit-instruction evolution (the ONLY surviving channel) ──
  // The user explicitly asked to record/evolve or stated a behavioral
  // correction — as read by the ENTRY beat's one semantic derivation
  // (hk.analysis.memoryUpdate, threaded by value; no second LLM call here).
  // Every write runs under ONE process-wide `withSliceLock("evolution")`
  // (v0.16 S1 single-writer). A changed run's summary freezes into the slice
  // frontmatter so the L3 slice-head block replays it on every later turn of
  // the slice. Evolution failures must never take the turn down: a write/
  // agent error is reported to the client as an error chunk and the turn
  // continues.
  let evolutionResult: EvolutionResult | undefined;
  /** Freeze a changed evolution's summary into the slice (single line, YAML-safe).
   *  A context SHELL (no slice on disk) is never snapshotted — the
   *  evolution's own case/user-model writes land; the slice file does
   *  not (the real-machine ghost slice, v0.42 A-fix). */
  const freezeEvolutionSummary = async (target: TimeSlice) => {
    if (evolutionResult?.ran && evolutionResult.changed && evolutionResult.summary) {
      target.evolutionSummary = evolutionResult.summary.replace(/\s+/g, " ").trim();
      if (hk.sliceOnDisk) await saveSliceSnapshot(target, batch);
    }
  };
  const explicitUpdate = hk.analysis?.memoryUpdate;
  /** Client/bridge mode: the entry beat's raw report — its mutation
   *  proposals apply through the card-session machinery (no second spawn). */
  const bridgeReport = hk.bridgeReport;

  try {
    if (explicitUpdate) {
      if (phaseOutsource) {
        // Bridge path: the mutation proposals arrived in the SAME bridge call
        // as the analysis — apply them through the card-session machinery
        // (applyBridgeCardEvolution), no second spawn.
        const cardRaw =
          (await readUserModel(batch).catch(() => null))?.card ?? "";
        if (bridgeReport && bridgeReport.evolution.mutations.length > 0) {
          // The card opens in its running state first — a terminal chunk out
          // of nowhere reads as "it never ran".
          emitEvolutionProgress(stream, "reviewing");
          evolutionResult = await withSliceLock("evolution", () =>
            applyBridgeCardEvolution({
              card: cardRaw,
              sliceId: slice.slice_id,
              today: todayLocal,
              reason: bridgeReport.evolution.reason || explicitUpdate.content,
              mutations: bridgeReport.evolution.mutations,
              batch,
            }),
          );
          await emitEvolutionResult(stream, evolutionResult);
          await freezeEvolutionSummary(slice);
          console.log(
            `[Evolution] bridge user request: changed=${evolutionResult.changed}`,
          );
        } else {
          await emitEvolutionResult(stream, {
            ran: false,
            changed: false,
            droppedRecent: 0,
            note: bridgeReport
              ? `Memory update noted — no card mutation proposed (${bridgeReport.evolution.reason || "no reason given"}).`
              : "Housekeeping bridge unavailable — card evolution skipped this turn.",
            ...(bridgeReport ? {} : { error: "housekeeping bridge failed" }),
          });
        }
      } else {
        // The direction half of the folded model is orientation for the
        // product phase even on an explicit-request run (no direction
        // evaluation and no SOP writes on this channel).
        const direction =
          (await readUserModel(batch).catch(() => null))?.direction ?? null;
        evolutionResult = await withSliceLock("evolution", () =>
          runCardEvolution({
            model: input.modelConfig,
            sliceId: slice.slice_id,
            recentTurns: input.recentTurns,
            focus: explicitUpdate.content,
            signal: "new_observation",
            readers: buildCardReaders(input),
            onProgress: onEvolutionProgress,
            onEvolutionLine,
            batch,
            todayDate: todayLocal,
            direction,
          }),
        );
        await emitEvolutionResult(stream, evolutionResult);
        await freezeEvolutionSummary(slice);
        console.log(
          `[Evolution] explicit user request: changed=${evolutionResult.changed}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[Evolution] explicit-instruction run failed, continuing turn:`,
      err instanceof Error ? err.message : err,
    );
    await emitEvolutionResult(stream, {
      ran: false,
      changed: false,
      droppedRecent: 0,
      note: "Evolution run failed.",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  }
  mark("explicit evolution", before2);

  // ── The tail's ONE commit — an empty batch no-ops the flush (空转零写入) ──
  const headline = `Turn ${input.turnId} — finalize`;
  const message =
    segments.length > 0
      ? `${headline}\n\n${segments.map((s) => `- ${s}`).join("\n")}`
      : headline;
  await flushTurnBatch(batch, message, hk.sliceOnDisk ? slice : null);
  });
  } finally {
    stream.close();
  }
}

// ─── Step 4: closeTurnStream ───────────────────────────────────────────────

/**
 * Close the run's output stream with the trailing lifecycle chunks. The
 * agent streamed with `sendFinish: false` + `preventClose: true`, so this
 * step owns the stream tail — finish-step / finish, then close. Emit the
 * terminal turn-status chunk just before the lifecycle tail so the client
 * learns the outcome from the live stream. A reconnecting client replays the
 * stream from the last-seen index and derives the status from the final
 * assistant message.
 */
export async function closeTurnStream(
  outcome: TurnOutcome,
  turnId: string,
): Promise<void> {
  "use step";

  const status = deriveTurnStatus(outcome);
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({
    type: "data-turn-status",
    id: "turn-status-terminal",
    data: {
      status,
      turnId,
      updatedAt: new Date().toISOString(),
      // Client-visible explanation for terminal/model failures — lets the UI
      // say WHY the turn ended instead of failing silently.
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  } as UIMessageChunk);
  await writer.write({ type: "finish-step" } as UIMessageChunk);
  await writer.write({ type: "finish" } as UIMessageChunk);
  writer.releaseLock();
  await writable.close();
}

/**
 * A child run's stream tail (v0.31): finish-step / finish, then close. No
 * `data-turn-status` — the child's terminal STATE reaches the client as a
 * nested-bubble frame on the ORCHESTRATOR's stream; the child stream only
 * carries the answer's live content. Never throws: a lost tail degrades the
 * bubble to its fallback (the done frame's settled text), the report still
 * lands by hook.
 */
export async function closeChildStream(): Promise<void> {
  "use step";
  try {
    const writable = getWritable<UIMessageChunk>();
    const writer = writable.getWriter();
    await writer.write({ type: "finish-step" } as UIMessageChunk);
    await writer.write({ type: "finish" } as UIMessageChunk);
    writer.releaseLock();
    await writable.close();
  } catch (err) {
    console.warn(
      "[Episode] child stream tail dropped:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Step 5: ringReflection — the mechanical bell (v0.34 R1) ───────────────

/**
 * The reflection unit's mechanical bell (v0.38 §3.3 — PURE doorbell: the wake
 * carries NO payload at all; sealing the slice is NOT its trigger). The
 * SUMMARY stream rings it after landing the burst's 被动存盘 — `label`
 * (the slice's id) is a log aid only, `range` (v0.42 §4) is the persisted
 * turn set handed to the unit. The
 * engine (reflection-wake.ts) is getHookByToken → a live run means the unit
 * is up and the ring is DONE (触发即完成); no live run → start a fresh
 * short-lived unit. Best-effort by design — a lost bell only warns: the
 * unit's range is everything since its on-disk cursor, so the next turn's
 * bell covers the gap. Never throws.
 */
export async function ringReflection(
  label: string,
  range?: ReflectionWakeRange,
): Promise<void> {
  "use step";
  try {
    const result = await deliverReflectionWake(range);
    if (!result.ok) {
      console.warn(`[Reflection] wake not delivered for ${label} (ignored): ${result.reason}`);
    }
  } catch (err) {
    console.warn(
      "[Reflection] wake failed (ignored):",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Episode machinery steps (v0.30 §3, batch B — concurrent nesting) ─────

/**
 * The outer run's own durable id — the episode inbox token derives from it
 * (`episode:<runId>`, nested-bubble.ts). getWorkflowMetadata is only legal
 * inside a step, so the workflow body reads its id through this one-liner
 * (the reflection-steps.ts precedent).
 */
export async function ownRunId(): Promise<string> {
  "use step";
  return getWorkflowMetadata().workflowRunId;
}

/**
 * The drain loop's clock (v0.31 — the instance watchdog): the workflow body
 * has no Date (the sandbox provisions no clock — timestamps are stamped inside
 * steps, the ownRunId precedent), so one call per drain lap feeds the spawn
 * stamps and the watchdog's age check. The value replays from the event log
 * like every other step result.
 */
export async function episodeClockMs(): Promise<number> {
  "use step";
  return Date.now();
}

/**
 * The drain's disk reconciliation (D1/D2): re-read the slice BYPASSING the
 * Data Cache (a messages-route commit landed seconds ago; a cached copy could
 * miss it — the same reasoning as finalizeTurn's conflict self-heal) and
 * compute the episode's unanswered user turns. The hook is only a wake-up
 * tap; THIS scan is the queue.
 *
 * The read goes through the turn's ACTIVE backend (the flags ride in from the
 * workflow body — steps are plain Node, but the backend is request-scoped
 * input, not a module global): hard-wiring getRepoConfig() here crashed every
 * episode under STORAGE=local with "GITHUB_TOKEN environment variable is not
 * set" (v0.30 D-1).
 */
export async function readEpisodeInbox(
  sliceId: string,
  outerTurnId: string,
  episodeStartedAtIso: string,
  backend: { useDemo: boolean; useGithub: boolean },
): Promise<EnvelopeUserTurn[]> {
  "use step";
  const path = sliceIdToFilePath(sliceId);
  let raw: string;
  if (backend.useDemo) {
    raw = await readFileDemo(path);
  } else if (backend.useGithub) {
    const { owner, repo } = getRepoConfig();
    raw = await readFileFresh(path, repo, owner);
  } else {
    raw = await readFileLocal(path);
  }
  return findEpisodeUnanswered(parseSlice(raw), outerTurnId, episodeStartedAtIso);
}

/**
 * One `data-nested-bubble` frame onto the outer run's (still open — preventClose)
 * stream. Written from a step: the reflection-steps.ts precedent is that
 * step-side getWritable writes are the legal path (the workflow body never
 * writes frames directly). Terminal frames get their doneAt stamped here —
 * the workflow body has no clock.
 *
 * Never throws: a lost frame degrades the live display only — the bubble's
 * answer still lands on disk at finalizeTurn, and a reconnecting client
 * replays the stream. The turn must not die for a frame.
 */
export async function emitNestedBubble(frame: NestedBubbleFrame): Promise<void> {
  "use step";
  try {
    const writable = getWritable<UIMessageChunk>();
    const writer = writable.getWriter();
    try {
      await writer.write({
        type: NESTED_BUBBLE_CHUNK,
        id: `nested-bubble-${frame.turnId}`,
        // transient: the frame rides the stream to the client's onData ONLY —
        // it never becomes a UIMessage part, so regenerate and the local
        // persistence never see bubbles (§4.2). A replayed stream re-delivers
        // it, so the side store rebuilds deterministically on reconnect.
        transient: true,
        data: {
          ...frame,
          ...(frame.status === "done" || frame.status === "failed"
            ? { doneAt: frame.doneAt ?? new Date().toISOString() }
            : {}),
        },
      } as UIMessageChunk);
    } finally {
      writer.releaseLock();
    }
  } catch (err) {
    console.warn(
      `[Episode] nested-bubble frame dropped (${frame.turnId}/${frame.status}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * A child run's terminal report → the orchestrator's inbox hook (D2).
 * resumeHook is a runtime function that must be called outside a workflow
 * function — hence this "use step" (the handoffBriefToPrimary precedent in
 * reflection-steps.ts). HookNotFoundError means the outer run is gone
 * (cancelled — D6, or finalized): swallow with a warning instead of burning
 * the step's retry budget; the child's own stream keeps the answer, and the
 * unanswered user turn on disk stays visible to reflection.
 */
export async function reportInnerBubble(
  token: string,
  payload: EpisodeInboxEvent,
): Promise<void> {
  "use step";
  try {
    await resumeHook(token, payload);
  } catch (e) {
    if (HookNotFoundError.is(e)) {
      console.warn(
        `[Inner] episode inbox gone — bubble dropped (turnId=${payload.turnId}); ` +
          "the outer run already exited",
      );
      return;
    }
    throw e;
  }
}

/**
 * One in-flight child run's registry state, as the drain's reconciliation
 * sees it (v0.32): "inflight" (still pending/running — or unreadable: a
 * transient registry error must not fail an instance, the watchdog bounds
 * those), "done" (completed, carrying the child's returned report), or
 * "failed" (terminal — failed/cancelled — or completed with an unusable
 * report).
 */
export type InnerRunPoll =
  | { runId: string; state: "inflight" }
  | { runId: string; state: "done"; report: InnerTurnReport }
  | { runId: string; state: "failed" };

/**
 * The drain's registry reconciliation (v0.32 — D2 applied to REPORTS): the
 * inbox hook is only a wake-up tap, and production showed the tap
 * unreliable as a wake mechanism (a child's report sat undelivered until the
 * drain's 60s sleep boundary). The run registry is the queue of record: each
 * busy lap polls every in-flight child's status; a completed run's report is
 * its RETURN VALUE (innerTurnWorkflow returns what reportInnerBubble taps),
 * read exactly once — status is terminal by then, so returnValue's
 * long-poll resolves on the first read. Per-row errors degrade to
 * "inflight", never throw: the drain must not die for a registry blip.
 */
export async function pollInnerRunReports(
  runIds: string[],
): Promise<InnerRunPoll[]> {
  "use step";
  return Promise.all(
    runIds.map(async (runId): Promise<InnerRunPoll> => {
      try {
        const run = getRun<InnerTurnReport>(runId);
        const status = await run.status;
        if (status === "completed") {
          const rv = await run.returnValue;
          if (
            rv &&
            typeof rv === "object" &&
            typeof rv.turnId === "string" &&
            typeof rv.replyTo === "string" &&
            typeof rv.text === "string" &&
            typeof rv.finishReason === "string"
          ) {
            return {
              runId,
              state: "done",
              report: {
                turnId: rv.turnId,
                replyTo: rv.replyTo,
                text: rv.text,
                finishReason: rv.finishReason,
              },
            };
          }
          // Completed without a usable report — an honest failure.
          return { runId, state: "failed" };
        }
        if (status === "failed" || status === "cancelled") {
          return { runId, state: "failed" };
        }
        return { runId, state: "inflight" };
      } catch (err) {
        console.warn(
          `[Episode] child run ${runId} poll failed (treated as in-flight):`,
          err instanceof Error ? err.message : err,
        );
        return { runId, state: "inflight" };
      }
    }),
  );
}

// ─── Parallel turns steps (v0.33 — 连发并行: registry + batch summary) ─────

/**
 * The run registry as plain predicate input — one unfiltered page (no status
 * filter returns every run, newest first — the dev-spike GET's shape, verified
 * against world-local 5.0.0-beta.44). Entities carry attributes AND
 * createdAt/completedAt even under `resolveData: "none"`. Step-context only
 * (getWorld needs the runtime). The tail's burst gate needs TERMINAL siblings
 * too, not just live ones — a completed sibling is what proves the burst.
 */
async function listRegistryRuns(): Promise<ParallelRunEntry[]> {
  const world = await getWorld();
  const page = await world.runs.list({
    pagination: { limit: 100 },
    resolveData: "none",
  } as Parameters<typeof world.runs.list>[0]);
  return page.data.map((r) => ({
    runId: r.runId,
    status: r.status,
    createdAt: r.createdAt ?? null,
    completedAt: r.completedAt ?? null,
    attributes:
      (r as { attributes?: Record<string, string> | null }).attributes ?? null,
  }));
}

/** Live half of the registry (pending + running) — the housekeeping sibling
 *  count and the summary dedupe only ever care about those. */
async function listLiveRuns(): Promise<ParallelRunEntry[]> {
  return (await listRegistryRuns()).filter((r) => isLiveRunStatus(r.status));
}
// ─── The summary handoff (v0.42 §1/§2 — the last turn wakes the summary) ───

/**
 * What the tail hands the merge decision (v0.38 §3.2 ②) — the burst's
 * identity, this turn's own reply, and the merge-line generation inputs.
 * All serializable; the registry reads stay in the step.
 */
export interface BurstMergeParams {
  sliceId: string;
  turnId: string;
  /** The burst id (registry-exact enumeration); absent → overlap heuristic. */
  burstId?: string;
  /** THIS turn's reply text — the window's last entry. */
  ownReplyText: string;
  /** THIS turn's user message — the window's last user entry (v0.42 §1: the
   *  burst's user turns ride the returnValues, never the not-yet-written
   *  disk). */
  ownUserText: string;
  locale: string;
  model: string;
  modelConfig: TurnInput["modelConfig"];
  useGithub: boolean;
  useDemo: boolean;
  owner: string;
  repo: string;
}

/**
 * The last turn's merge-line decision (v0.38 §3.2 ②) — runs in the turn's
 * tail AFTER finalizeTurn (this turn's evolution拍 is committed) and BEFORE
 * the summary stream's start — the generated line rides the LAST turn's
 * summary payload as its mergeLine (v0.42 §2).
 *
 * Lastness is burst-exact when the client sent a burstId (registry attribute
 * equality — no timestamp inference), else the legacy overlap heuristic
 * (v0.38 §2 退化). Sibling replies AND user messages are read ONLY from
 * COMPLETED runs' returnValues (a turn run's return value IS its
 * TurnRunResult; failed or cancelled siblings are skipped — nothing to
 * reconcile with), never from a non-terminal run (reading a live run's
 * returnValue long-polls and burns a worker slot). The line itself is
 * generated ONLY when reconciliation is needed — the model outputs EMPTY
 * when no answer corrects or contradicts another, and an empty output means
 * NO mergeLine (收合永远可空).
 *
 * Returns the merge line (announced to the client as a transient chunk —
 * presentation proper is Part 5) or undefined. Never throws and never blocks
 * the turn: a registry hiccup or a model failure degrades to "no closing" —
 * the burst's record is carried by the summary run either way (v0.42 §2).
 */
export async function decideBurstMergeLine(
  params: BurstMergeParams,
): Promise<string | undefined> {
  "use step";
  try {
    // Stamp THIS run `phase: "tail"` FIRST — a sibling checking right now
    // then yields instead of mutual-skipping (the v0.33 window, unchanged).
    await setAttributes({ phase: "tail" });
    const ownId = getWorkflowMetadata().workflowRunId;
    const runs = await listRegistryRuns();
    let siblingRunIds: string[];
    if (params.burstId) {
      if (
        !isLastBurstTurn(runs, params.sliceId, params.burstId, ownId, params.turnId)
      ) {
        console.log(`[Parallel] merge skipped (turn ${params.turnId}): not the burst's last survivor`);
        return undefined;
      }
      siblingRunIds = runs
        .filter((r) => isBurstSibling(r, params.sliceId, params.burstId!, ownId))
        .map((r) => r.runId);
    } else {
      if (runs.some((r) => isBlockingParallelSibling(r, params.sliceId, ownId))) {
        return undefined; // a sibling is still answering — not the last yet
      }
      if (
        !hasOverlappingParallelSibling(runs, params.sliceId, ownId, Date.now())
      ) {
        return undefined; // solo turn / sequential sends — nobody to merge with
      }
      siblingRunIds = runs
        .filter((r) => r.runId !== ownId && isParallelTurnRun(r, params.sliceId))
        .map((r) => r.runId);
    }
    // COMPLETED siblings only — failed/cancelled runs are skipped (nothing
    // to reconcile with); a live run's returnValue is never read (it
    // long-polls and burns a worker slot).
    const replies: Array<{ turn: string; text: string }> = [];
    const siblingUserTexts: string[] = [];
    for (const runId of siblingRunIds) {
      const entry = runs.find((r) => r.runId === runId);
      if (!entry || entry.status !== "completed") continue;
      try {
        // v0.42 §1 — a turn's returnValue IS its TurnRunResult (legacy runs
        // returned the bare reply text; both shapes read).
        const rv = await getRun<TurnRunResult | string>(runId).returnValue;
        const text = typeof rv === "string" ? rv : (rv?.replyText ?? "");
        if (typeof rv !== "string" && rv?.userText?.trim()) {
          siblingUserTexts.push(rv.userText);
        }
        if (text.trim()) {
          replies.push({ turn: entry.attributes?.turn ?? runId, text });
        }
      } catch {
        // registry blip on one sibling — reconcile with the rest
      }
    }
    if (replies.length === 0) {
      console.log(
        `[Parallel] merge skipped (turn ${params.turnId}): no completed sibling replies ` +
        `(siblings: ${siblingRunIds
          .map((id) => `${id}:${runs.find((r) => r.runId === id)?.status ?? "?"}`)
          .join(", ") || "none"})`,
      );
      return undefined;
    }
    // The burst's USER messages: they ride the siblings' returnValues
    // (v0.42 §1 — the entry beat no longer lands them on disk before this
    // tail runs); the disk read survives as the legacy fallback (pre-v0.42
    // runs carried no userText), and THIS turn's own message closes the
    // list. The corrections that justify a closing live THERE (「不是包子，
    // 是饺子」), never in the replies alone.
    let userTexts = [...siblingUserTexts];
    if (userTexts.length === 0) {
      try {
        const path = sliceIdToFilePath(params.sliceId);
        let raw: string;
        if (params.useDemo) {
          raw = await readFileDemo(path);
        } else if (params.useGithub) {
          raw = await readFileFresh(path, params.repo, params.owner);
        } else {
          raw = await readFileLocal(path);
        }
        userTexts = parseSlice(raw)
          .turns.filter((t) => t.role === "user")
          .slice(-6)
          .map((t) => t.content);
      } catch {
        userTexts = []; // an unreadable slice degrades to a replies-only window
      }
    }
    if (params.ownUserText.trim()) userTexts.push(params.ownUserText);
    const windowText = buildMergeWindow(userTexts, replies, params.ownReplyText, params.locale);
    const line = await runMergeLineCall(params, windowText);
    if (!line) {
      console.log(`[Parallel] merge skipped (turn ${params.turnId}): the closer said EMPTY`);
      return undefined;
    }
    // Announce the closing to the client as a transient chunk (the
    // PARALLEL_SUMMARY_CHUNK precedent) — how it renders is Part 5.
    try {
      const stream = createStepStream();
      try {
        await stream.write({
          type: PARALLEL_SUMMARY_CHUNK,
          id: `parallel-summary-${params.sliceId}`,
          transient: true,
          data: { sliceId: params.sliceId, text: line },
        } as UIMessageChunk);
      } finally {
        stream.close();
      }
    } catch {
      /* the chunk is advisory — the line rides the writer payload regardless */
    }
    return line;
  } catch (err) {
    console.warn(
      "[Parallel] merge decision failed (no closing):",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * The merge line's ONE model call (v0.38 §3.2 ②) — no stream writes (the
 * turn's message is already complete; the line rides a transient chunk), no
 * token cap (project-wide ban), thinking OFF (a mechanical reconciliation).
 * The prompt's contract: output EMPTY when no answer corrects or contradicts
 * another — 收合只在需要时存在. A model failure returns "" (the caller
 * skips the merge line; the turn is never blocked by its closer).
 */
async function runMergeLineCall(
  params: BurstMergeParams,
  windowText: string,
): Promise<string> {
  try {
    const system =
      params.locale === "zh"
        ? "你是 Previously 的收尾员。用户在同一时间窗里连发了数条消息，每条已由一个并行实例各自作答（下面按顺序给出这一轮的用户消息与回答）。若后面的消息更正或矛盾于前面的内容（例如「不是包子，是饺子」），用 1–2 句话给出收束，一律以最新陈述为准。若各回答互不矛盾、已经完整，输出 EMPTY（不需要收尾）。不要逐条复述、不用列表、不道歉。"
        : "You are Previously's closer. The user fired several messages in one burst; each was answered by a parallel instance (the user messages and their answers follow, in order). When a later message corrects or contradicts an earlier one (\"not buns — dumplings\"), write a 1–2 sentence closing, the latest statement wins. When the answers do not conflict and are complete, output EMPTY (no closing needed). No per-message recap, no lists, no apologies.";
    const result = streamText({
      model: createModel(params.modelConfig),
      system,
      prompt: windowText,
      providerOptions: normalizeReasoningEffort(
        params.modelConfig.sdk,
        params.modelConfig.id,
        false,
        "low",
      ),
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    const trimmed = text.trim();
    return trimmed && !/^empty$/i.test(trimmed) ? trimmed : "";
  } catch (err) {
    console.warn(
      "[Parallel] merge line call failed (degraded to no closing):",
      err instanceof Error ? err.message : err,
    );
    return "";
  }
}

/**
 * Should THIS turn start a summary run (v0.42 §1 — 对话流完成后唤起总结流)?
 *
 * FINAL SHAPE (after the real machine kept losing content): EVERY turn of a
 * burst starts its own summary run — no election, no waiting. Both election
 * directions failed on the real machine: the collector could not see a
 * sibling on another entry shell (cross-minute shells), and a run that
 * yielded to a live sibling never came back, leaving the WHOLE batch
 * unpersisted. The summary run is INCREMENTAL — it writes only what is not
 * on disk and no-ops when THIS turn already landed — so overlapping runs
 * converge instead of duplicating, at the cost of an occasional extra
 * `Summary —` commit. 丢内容比多一条提交严重得多.
 *
 * The legacy (no-burstId) path is unchanged: the overlap heuristic decides.
 * A gate failure degrades to TRUE — a missed summary starves the turn's
 * 被动存盘, the expensive miss by far. Never throws.
 */
export async function shouldStartSummary(params: {
  sliceId: string;
  turnId: string;
  burstId?: string;
}): Promise<boolean> {
  "use step";
  try {
    if (params.burstId) {
      // Every burst turn starts its own summary run; the run-side dedupe
      // (this turn already on disk) is the only gate — see persistTurnSummary.
      return true;
    }
    const ownId = getWorkflowMetadata().workflowRunId;
    const runs = await listRegistryRuns();
    if (runs.some((r) => isBlockingParallelSibling(r, params.sliceId, ownId))) {
      return false; // a sibling is still answering — not the last yet
    }
    // v0.42 double-summary fix: the overlap window's YOUNGEST run is its
    // last survivor — an older run yields to any later-created sibling
    // (live or just completed), else two survivors in one registry window
    // both generate the legacy merge path.
    if (
      hasLaterCreatedRun(
        runs,
        runs.filter((r) => r.runId !== ownId && isParallelTurnRun(r, params.sliceId)),
        ownId,
      )
    ) {
      return false;
    }
    return true; // solo (or the overlap window's last survivor): I persist
  } catch (err) {
    console.warn(
      `[Summary] last-one check failed (turn ${params.turnId}) — starting anyway:`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

/**
 * Start the burst's summary run (v0.42 §1 — 唤起即完成): a durable start()
 * CARRYING the last turn's record, BEFORE closeTurnStream (the persistence
 * intent must be durable before the stream closes: reverse the order and a
 * turn dying between the two leaves "stream closed, summary never started").
 * The turn does NOT wait on the summary run. Never throws — a start failure
 * logs; the burst's records stay alive in the siblings' streams, and the
 * next turn's summary re-collects whatever never landed (turnId-deduped).
 */
export async function startSummaryRun(
  payload: SummaryRunPayload,
): Promise<string | null> {
  "use step";
  try {
    // Dynamic import: steps.ts → summary-run.ts → steps.ts is a static cycle
    // otherwise (the retired writer-run's precedent).
    const { summaryRun } = await import("./summary-run");
    const run = await start(summaryRun, [payload], {
      attributes: {
        role: "summary",
        slice: payload.sliceId,
        ...(payload.burstId ? { burst: payload.burstId } : {}),
      },
    });
    console.log(`[Summary] started for ${payload.sliceId}: ${run.runId}`);
    return run.runId;
  } catch (err) {
    console.warn(
      `[Summary] could not start for ${payload.sliceId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The summary run's whole job (v0.42 §1/§2 — the user's words: 「最后一个完
 * 成之后才会唤起总结流。总结流是去看这几个已经完成的对话流，然后决定
 * 开新片还是续写」) — ONE step, ONE batch, ONE commit:
 *
 *   1. MEMBERS — this (the last) turn's record rides the payload; the other
 *      same-batch turn runs contribute their returnValue records; terminal
 *      failures are noted honestly; still-running runs are skipped (§3/§5
 *      [7189] — they answer for themselves).
 *   2. THE LANDING JUDGMENT — the step reads the current EDGE slice from
 *      disk (tryLoadTodaySlice — the same reader the entry beat used) and
 *      applies the SAME continuity rules (judgeSliceLanding: idle gap /
 *      time cap / capacity — the entry beat's old thresholds), with the
 *      batch's FIRST turn as the reference moment: CONTINUE the edge, or
 *      seal it and OPEN A NEW PAGE (checkpoint closes — time_cap/capacity —
 *      carry `continuesFrom`; idle_gap does not).
 *   3. THE SEAL — when a new page opens, the edge is sealed HERE: the same
 *      analyzer the entry beat used (analyzeTurn over the ended page), with
 *      the deterministic fallback (never close dry), stamped closed_by /
 *      end / focus / summary / open_loops / decisions into the SAME batch.
 *   4. THE LANDINGS — every member's user turn + reply + merge + cognition
 *      + evidence attachments lands in the JUDGED slice (turnId-deduped);
 *      the mid-life previously snapshot refreshes the judged slice too.
 *
 * Flushed as `Summary — {landingSliceId}`, then the reflection bell with the
 * persisted range. Deduped only when MY reply already landed AND a live
 * summary owns the rest (f2f4f80). Never throws.
 */
async function persistTurnSummaryAttempt(
  payload: SummaryRunPayload,
): Promise<SummaryRunOutcome> {
  "use step";
  const fail = (err: unknown): SummaryRunOutcome => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Summary] ${payload.sliceId} commit failed: ${msg}`);
    return { kind: "failed", error: msg };
  };
  try {
    const ownId = getWorkflowMetadata().workflowRunId;
    const runs = await listRegistryRuns();
    const batch = createBatch();

    // ── 1. Members — records only; the disk dedupe happens per append
    //    against the JUDGED slice (which does not exist until step 2).
    const candidates: TurnRunResult[] = [payload.own];
    const failedTurns: Array<{ turn: string; note: string }> = [];
    const noAnswerNote = (turn: string, status: string): string =>
      payload.locale === "zh"
        ? `第 ${turn} 条没答成（${status}）`
        : `turn ${turn} produced no answer (${status})`;
    for (const r of runs) {
      if (r.runId === ownId) continue;
      if (payload.burstId) {
        // The burst id IS the batch identity (v0.42): entry shells differ
        // across a minute (0837 / 0838), so slice-equality would hide the
        // sibling on the other shell and its turn would never be collected.
        // Summary/assistant runs stamp no `turn` — they are nobody's sibling.
        if (r.attributes?.burst !== payload.burstId) continue;
        if (typeof r.attributes?.turn !== "string") continue;
      } else if (!isParallelTurnRun(r, payload.sliceId)) continue;
      const turn = r.attributes?.turn ?? r.runId;
      if (r.status !== "completed") {
        // A still-RUNNING sibling is not a failure and not material (§3/§5
        // [7189]); only a TERMINAL non-completed run is an honest 没答成.
        if (isLiveRunStatus(r.status)) continue;
        failedTurns.push({ turn, note: noAnswerNote(turn, r.status) });
        continue;
      }
      try {
        const rv = await getRun<TurnRunResult | string>(r.runId).returnValue;
        const record: TurnRunResult | null =
          typeof rv === "string"
            ? {
                turnId: turn,
                sliceId: payload.sliceId,
                at: r.createdAt
                  ? new Date(
                      Date.parse(String(r.createdAt)) || Date.now(),
                    ).toISOString()
                  : new Date().toISOString(),
                userText: "",
                replyText: rv,
                cognition: "",
              }
            : rv;
        if (record && typeof record.replyText === "string") {
          candidates.push({ ...record, turnId: record.turnId ?? turn });
        } else {
          failedTurns.push({ turn, note: noAnswerNote(turn, "unreadable result") });
        }
      } catch {
        failedTurns.push({ turn, note: noAnswerNote(turn, "unreadable result") });
      }
    }
    // Burst chronology: the appended turns follow each member's turn-start
    // stamp (own — the last survivor — sorts last).
    candidates.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    // ── 2+3. The edge + the landing judgment + the seal.
    const landing = await resolveLanding(payload, candidates[0], batch);
    if ("error" in landing) return fail(landing.error);
    const { slice, sealedEdge } = landing;

    // ── The dedupe (f2f4f80, narrowed): ONLY "this turn already landed".
    //    A live sibling summary must NOT exit this run — it cannot see this
    //    turn (cross-shell enumeration gaps cost content on the real
    //    machine); the incremental appends below converge under it.
    const ownReplyOnDisk = slice.turns.some(
      (t) => t.role === "agent" && t.turnId === payload.own.turnId,
    );
    if (ownReplyOnDisk) {
      console.log(
        `[Summary] ${slice.slice_id} deduped — my turn already landed`,
      );
      return { kind: "deduped" };
    }

    const turnOnDisk = (turnId: string): boolean =>
      slice.turns.some((t) => t.turnId === turnId);
    const members = candidates;
    /** The commit body names what actually queued (v0.37 §7-1 wording). */
    const bodyLines: string[] = [];

    if (sealedEdge) {
      // The full pass earns the analyzer's marks; the deterministic fallback
      // covers any analyzer outage (never close dry).
      try {
        const analysis = await analyzeTurn({
          model: payload.modelConfig,
          userMessage: members[0]?.userText ?? "",
          closingSlice: { turns: sealedEdge.edge.turns },
        });
        const marking = analysis?.closedMarking;
        if (marking) {
          if (marking.focus) sealedEdge.edge.focus = marking.focus;
          if (marking.summary) sealedEdge.edge.summary = marking.summary;
          if (marking.tone) sealedEdge.edge.emotional_tone = marking.tone;
          if (marking.openLoops) sealedEdge.edge.open_loops = marking.openLoops;
          if (marking.decisions) sealedEdge.edge.decisions = marking.decisions;
        }
      } catch {
        /* the analyzer never blocks the seal — the fallback below fills */
      }
      if (!sealedEdge.edge.focus || !sealedEdge.edge.summary) {
        const fallback = deterministicSliceMark(sealedEdge.edge);
        if (!sealedEdge.edge.focus) sealedEdge.edge.focus = fallback.focus;
        if (!sealedEdge.edge.summary) sealedEdge.edge.summary = fallback.summary;
      }
      await closeSlice(sealedEdge.edge, sealedEdge.signal, batch);
      bodyLines.push(`sealed ${sealedEdge.edge.slice_id} (${sealedEdge.signal})`);
    }

    // ── 4. The landings: user + reply + merge + cognition + attachments,
    //    everything into the JUDGED slice.
    /** Persist a member's evidence into THIS batch; return the marker. */
    const attachMarker = async (m: TurnRunResult): Promise<string> => {
      if (!m.attachments || m.attachments.length === 0) return "";
      // The evidence rides the result (the entry beat commits nothing): the
      // SAME fuse semantics persist it into THIS batch. Skips stay visible.
      const result = await persistEvidenceAttachments({
        sliceId: slice.slice_id,
        turnId: m.turnId,
        files: m.attachments.map((a) => ({
          name: a.name,
          data: Buffer.from(a.dataBase64, "base64"),
        })),
        batch,
      });
      for (const s of result.skipped) {
        console.warn(`[Attachments] skipped ${s.name}: ${s.reason}`);
      }
      return result.saved.length > 0
        ? `\n\n[attachments: ${result.saved.map((s) => s.name).join(", ")}]`
        : "";
    };
    if (payload.own.previously?.trim()) {
      await writePreviously(slice.slice_id, payload.own.previously, batch);
    }
    let wroteTurns = false;
    for (const m of members) {
      const burst = m.burstId ?? payload.burstId;
      if (m.userText && !turnOnDisk(m.turnId)) {
        appendTurn(slice, {
          timestamp: m.at,
          role: "user",
          content: m.userText + (await attachMarker(m)),
          turnId: m.turnId,
          ...(burst ? { burst } : {}),
        });
        bodyLines.push(`user turn ${m.turnId}`);
        wroteTurns = true;
      } else if (m.attachments?.length) {
        // The member's user turn is THIS slice's turn 0 (a minted page stamps
        // it by createSlice) — the append is skipped, so annotate it in place.
        const t0 = slice.turns.find(
          (t) => t.role === "user" && t.turnId === m.turnId,
        );
        const marker = await attachMarker(m);
        if (t0 && marker && !t0.content.includes("[attachments:")) {
          t0.content += marker;
          wroteTurns = true;
        }
      }
      if (
        m.replyText &&
        !slice.turns.some((t) => t.role === "agent" && t.turnId === m.turnId)
      ) {
        appendTurn(slice, {
          timestamp: m.at,
          role: "agent",
          content: m.replyText,
          turnId: m.turnId,
          ...(burst ? { burst } : {}),
        });
        bodyLines.push(`reply ${m.turnId}`);
        wroteTurns = true;
      }
      if (m.mergeLine?.trim()) {
        const mergeTurnId = `m${m.turnId}`;
        if (!slice.turns.some((t) => t.turnId === mergeTurnId)) {
          appendTurn(slice, {
            timestamp: m.at,
            role: "agent",
            content: m.mergeLine.trim(),
            turnId: mergeTurnId,
            merge: true,
            ...(burst ? { burst } : {}),
          });
          bodyLines.push(`merge ${m.turnId}`);
          wroteTurns = true;
        }
      }
    }
    // The cognitions → agent.md (a `## Cognition {turnId}` header guard
    // keeps redeliveries from double-appending).
    let agentKnown = await readSlicePart(slice.slice_id, "agent", batch).catch(
      () => "",
    );
    for (const m of members) {
      if (!m.cognition || agentKnown.includes(`## Cognition ${m.turnId} `)) {
        continue;
      }
      const block = `## Cognition ${m.turnId} — ${new Date().toISOString()}\n${m.cognition}`;
      await writeAgentTimeline(slice.slice_id, block, batch);
      agentKnown += `\n\n${block}`;
      bodyLines.push(`cognition ${m.turnId}`);
    }

    if (wroteTurns) {
      await saveSliceSnapshot(slice, batch);
      bodyLines.push("snapshot");
    }
    for (const f of failedTurns) bodyLines.push(f.note);
    if (batch.entries.size === 0 && failedTurns.length === 0) {
      console.log(
        `[Summary] ${slice.slice_id}: nothing to persist — the owner already landed it`,
      );
      return { kind: "nothing" };
    }
    const message =
      COMMIT_PREFIX.summary(slice.slice_id) +
      (bodyLines.length > 0
        ? `\n\n${bodyLines.map((s) => `- ${s}`).join("\n")}`
        : "");
    await flushTurnBatch(batch, message, slice);

    // The reflection bell with the range (v0.42 §4 — 触发携带范围; a hint,
    // not the only truth — the unit re-reads the log, §3.5).
    const persistedTurnIds = members
      .filter((m) => m.replyText.trim() || m.userText.trim())
      .map((m) => m.turnId);
    await ringReflection(slice.slice_id, {
      sliceId: slice.slice_id,
      turnIds: persistedTurnIds,
    });
    console.log(
      `[Summary] ${slice.slice_id} committed: ${bodyLines.join(", ") || "failure notes only"}`,
    );
    return { kind: "committed", segments: bodyLines };
  } catch (err) {
    return fail(err);
  }
}

/**
 * THE LANDING RESOLUTION (v0.42 §1 — the user's words): read the current
 * edge slice from disk and judge 续写还是开新片 with the SAME thresholds
 * the entry beat used. Shared by the full pass and the minimal commit.
 * Never throws — a failure lands in `.error`.
 */
async function resolveLanding(
  payload: SummaryRunPayload,
  first: TurnRunResult | undefined,
  batch: WriteBatch,
): Promise<
  | { slice: TimeSlice; sealedEdge: { edge: TimeSlice; signal: SlicingSignal } | null }
  | { error: Error }
> {
  const firstAtMs = Date.parse(first?.at ?? "") || Date.now();
  const edge = await tryLoadTodaySlice(batch).catch(() => null);
  const landing = judgeSliceLanding(
    edge
      ? {
          sliceId: edge.slice_id,
          start: edge.start,
          lastTurnAt: edge.turns.at(-1)?.timestamp ?? null,
          turnCount: edge.turns.length,
        }
      : null,
    firstAtMs,
    payload.slicing,
  );
  if (landing.kind === "continue-edge" && edge) {
    return { slice: edge, sealedEdge: null };
  }
  if (landing.kind === "open-new" && edge) {
    const slice = createSlice(
      first?.userText || "(empty)",
      payload.clientTimezone,
      first?.turnId ?? payload.own.turnId,
      landing.checkpoint ? edge.slice_id : undefined,
    );
    return { slice, sealedEdge: { edge, signal: landing.signal } };
  }
  // fresh — no edge on disk at all: mint the first page, nothing to seal.
  const slice = createSlice(
    first?.userText || "(empty)",
    payload.clientTimezone,
    first?.turnId ?? payload.own.turnId,
  );
  return { slice, sealedEdge: null };
}

/**
 * The summary run's ENTRY (v0.42 §5 [11279] — 兜底: a failure is recovered
 * by LANDING what was produced, not by retrying forever):
 *
 *   1. the full pass (persistTurnSummaryAttempt);
 *   2. ONE bounded retry — the whole assembly re-runs off a fresh read
 *      (transient backend hiccups heal; ref conflicts already self-heal
 *      inside flushTurnBatch, so this retry is for everything else);
 *   3. a MINIMAL commit — THIS turn's user message + whatever reply it
 *      produced, through the SAME flush path, the commit body naming the
 *      degradation (能提交的都提交上去).
 *
 * Never throws.
 */
export async function persistTurnSummary(
  payload: SummaryRunPayload,
): Promise<SummaryRunOutcome> {
  "use step";
  const first = await persistTurnSummaryAttempt(payload);
  if (first.kind !== "failed") return first;
  console.warn(
    `[Summary] ${payload.sliceId}: full summary failed (${first.error ?? "unknown"}) — one bounded retry`,
  );
  const second = await persistTurnSummaryAttempt(payload);
  if (second.kind !== "failed") return second;
  console.warn(
    `[Summary] ${payload.sliceId}: retry failed too (${second.error ?? "unknown"}) — landing the minimal commit (user turn + produced reply)`,
  );
  return await persistMinimalSummary(payload);
}

/**
 * §5's minimal commit — the floor of "把能提交的都提交上去": THIS turn's
 * user message (it exists by definition — the turn started from it) plus
 * whatever reply text it produced, NOTHING else (siblings, cognitions are
 * the full pass's riders; 没产出的就是没有). The SAME batch + flushTurnBatch
 * discipline — no second write channel — and the commit body names the
 * degradation so the log's next reader knows what happened. The landing is
 * judged the SAME way (a wrong-page write would be worse than none); the
 * seal, when one is due, uses the deterministic marks only (no LLM on the
 * degraded path). The bell still rings with the landed turn. Never throws.
 */
async function persistMinimalSummary(
  payload: SummaryRunPayload,
): Promise<SummaryRunOutcome> {
  "use step";
  const fail = (err: unknown): SummaryRunOutcome => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Summary] ${payload.sliceId} minimal commit failed: ${msg}`);
    return { kind: "failed", error: msg };
  };
  try {
    const batch = createBatch();
    const landing = await resolveLanding(payload, payload.own, batch);
    if ("error" in landing) return fail(landing.error);
    const { slice, sealedEdge } = landing;
    /** What actually exists — 没产出的就是没有, even in the fallback. */
    const bodyLines: string[] = [];
    /** Persist own's evidence into THIS batch; return the marker. */
    const ownMarker = async (): Promise<string> => {
      if (!payload.own.attachments?.length) return "";
      const result = await persistEvidenceAttachments({
        sliceId: slice.slice_id,
        turnId: payload.own.turnId,
        files: payload.own.attachments.map((a) => ({
          name: a.name,
          data: Buffer.from(a.dataBase64, "base64"),
        })),
        batch,
      });
      for (const s of result.skipped) {
        console.warn(`[Attachments] skipped ${s.name}: ${s.reason}`);
      }
      return result.saved.length > 0
        ? `\n\n[attachments: ${result.saved.map((s) => s.name).join(", ")}]`
        : "";
    };
    const ownUserOnDisk = slice.turns.some(
      (t) => t.role === "user" && t.turnId === payload.own.turnId,
    );
    if (payload.own.userText && !ownUserOnDisk) {
      appendTurn(slice, {
        timestamp: payload.own.at,
        role: "user",
        content: payload.own.userText + (await ownMarker()),
        turnId: payload.own.turnId,
        ...(payload.own.burstId ? { burst: payload.own.burstId } : {}),
      });
      bodyLines.push(`user turn ${payload.own.turnId}`);
    } else if (payload.own.attachments?.length) {
      // own's user turn is THIS slice's turn 0 — annotate in place.
      const t0 = slice.turns.find(
        (t) => t.role === "user" && t.turnId === payload.own.turnId,
      );
      const marker = await ownMarker();
      if (t0 && marker && !t0.content.includes("[attachments:")) {
        t0.content += marker;
        bodyLines.push(`user turn ${payload.own.turnId}`);
      }
    }
    if (
      payload.own.replyText.trim() &&
      !slice.turns.some((t) => t.role === "agent" && t.turnId === payload.own.turnId)
    ) {
      appendTurn(slice, {
        timestamp: payload.own.at,
        role: "agent",
        content: payload.own.replyText,
        turnId: payload.own.turnId,
        ...(payload.own.burstId ? { burst: payload.own.burstId } : {}),
      });
      bodyLines.push(`reply ${payload.own.turnId}`);
    }
    if (sealedEdge) {
      // Degraded path: deterministic marks only — never close dry.
      if (!sealedEdge.edge.focus || !sealedEdge.edge.summary) {
        const fallback = deterministicSliceMark(sealedEdge.edge);
        if (!sealedEdge.edge.focus) sealedEdge.edge.focus = fallback.focus;
        if (!sealedEdge.edge.summary) sealedEdge.edge.summary = fallback.summary;
      }
      await closeSlice(sealedEdge.edge, sealedEdge.signal, batch);
      bodyLines.push(`sealed ${sealedEdge.edge.slice_id} (${sealedEdge.signal})`);
    }
    if (payload.own.previously?.trim()) {
      await writePreviously(slice.slice_id, payload.own.previously, batch);
    }
    if (bodyLines.length === 0) {
      return { kind: "nothing" };
    }
    await saveSliceSnapshot(slice, batch);
    bodyLines.push("snapshot");
    const message =
      COMMIT_PREFIX.summary(slice.slice_id) +
      `\n\n- degraded commit — the full summary failed twice; ` +
      `landed the user turn + produced reply only (v0.42 §5)\n` +
      bodyLines.map((s) => `- ${s}`).join("\n");
    await flushTurnBatch(batch, message, slice);
    await ringReflection(slice.slice_id, {
      sliceId: slice.slice_id,
      turnIds: [payload.own.turnId],
    });
    console.log(
      `[Summary] ${slice.slice_id} minimal commit landed: ${bodyLines.join(", ")}`,
    );
    return { kind: "committed", segments: bodyLines };
  } catch (err) {
    return fail(err);
  }
}
