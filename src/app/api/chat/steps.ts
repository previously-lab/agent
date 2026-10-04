/**
 * Chat turn step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (gray-matter + fs, the episodic manager) never enter the deterministic
 * workflow sandbox. `turn-workflow.ts` imports these `"use step"` functions
 * by reference only; the loader compiles them into the step bundle, not the
 * workflow bundle.
 *
 * Steps (v0.19 A1 — the three-stage rearrangement, design §A.1):
 *   1. housekeeping      — the REPLY segment. Recover/create the slice,
 *      DECIDE the lifecycle (a close is materialized in memory only — the
 *      disk close is the scribe segment's job), append + persist the user
 *      turn, assemble the read face (continuity / slice head / identity /
 *      direction), open the UI stream. Zero LLM calls, zero projection
 *      writes (no timeline weave, no catalog/index maintenance).
 *   2. persistAgentTurn  — 序 1. Append the agent turn + cognition to the
 *      slice and flush (with write-conflict self-heal).
 *   3. scribeSegment     — 序 2–7, the SCRIBE segment (post-reply): analyze
 *      (the only LLM left), execute the close, scan due tasks, post the
 *      boundary event, explicit-instruction evolution, scribe passes. Every
 *      sub-step is idempotent; a kill anywhere re-runs the whole segment.
 *   4. closeTurnStream   — terminal turn-status chunk + finish-step/finish.
 *
 * Chunk order for the UI: start → start-step → data-phase(slice/context) →
 * (reply) → data-phase(scribe segment) → data-evolution? → finish-step → finish.
 */
import { type UIMessageChunk, type ModelMessage } from "ai";
import { getWritable } from "workflow";
import {
  createSlice,
  closeSlice,
  appendTurn,
  saveSliceSnapshot,
  tryLoadTodaySlice,
  writeAgentTimeline,
  ensurePreviously,
  readStrands,
  deterministicSliceMark,
  createBatch,
  flushBatch,
  analyzeTurn,
  readCurrentPreviously,
  sliceIdToFilePath,
  sliceIdToAgentPath,
  slicePartPathCandidates,
  readSlicePart,
  readSlicePartResolved,
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
import { mergeTurnsWithRemote } from "@/lib/episodic/turn-merge";
import { isRefConflictError } from "@/lib/tools/batch-write";
import { getRepoConfig } from "@/lib/capabilities";
import {
  buildSliceExcerpt,
  runScribePass,
  extractDocMarkers,
  extractProcessedMarkerIds,
  RESEARCH_RECORD_PREFIX,
} from "@/lib/episodic/flash/librarian";
import { checkSliceAge, checkIdleGap } from "@/lib/episodic/slicer";
import { fsListFiles, fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";
import { MEMORY_ROOT_DIR, caseIndexPath } from "@/lib/docs/paths";
import { readDirection } from "@/lib/evolution/store";
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
} from "@/lib/chat/turn-types";
import { deriveTurnStatus } from "@/lib/chat/turn-types";
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
      // v1.0 calibration details (design §2.3/§2.5): why the run fired, the
      // direction verdict (v1.1 merged run — evaluated inside the one
      // runCardEvolution call), and the playbook mutations applied. All
      // optional — absent on analyzer-gated / explicit-request / bridge runs.
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
 * The newest slice CLOSED before `excludeFromId` — the continuity reference
 * (and the scribe segment's boundary-event target). Pure disk truth, no
 * timeline catalog (the projection is gone from the turn path in v0.19 A1).
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
 * The kill-matrix catch (v0.19 A1 §A.2.4): the reply segment materializes a
 * close in memory only — a run killed between housekeeping and the scribe
 * segment leaves the OLD slice active on disk next to its ACTIVE successor.
 * On redelivery housekeeping recovers the successor (newer HHMM sorts first
 * in tryLoadTodaySlice), and this scan finds the orphan: the newest ACTIVE
 * slice in today/yesterday's dirs that is NOT the current one (and not NEWER
 * than it — clock skew must never close the future). Orphans older than the
 * two-day window are the background scan's job (A2), not the turn's.
 */
async function findStaleActiveSlice(
  excludeId: string,
  batch?: WriteBatch,
): Promise<TimeSlice | null> {
  for (const id of await listRecentDaySliceIds()) {
    if (id >= excludeId) continue;
    const s = await readSliceById(id, batch);
    if (s && s.status === "active") return s;
  }
  return null;
}

/**
 * Re-derive the close signal for an orphaned slice on a redelivered run (the
 * reply segment's pendingClose decision was never persisted). The three
 * clock/turn-count checks are monotone in wall time, so a signal that fired
 * on the first delivery MUST fire again — a null here means none ever did
 * (the orphan predates A1, or was left by a crash mid-creation) and we skip
 * rather than fabricate a cause; the background scan (A2) owns those.
 */
function rederiveCloseSignal(
  slice: TimeSlice,
  config: UserConfig,
): SlicingSignal | null {
  const lastTurnTs = slice.turns.at(-1)?.timestamp;
  if (lastTurnTs && checkIdleGap(lastTurnTs, config.slicing.idleGapMinutes * 60_000)) {
    return "idle_gap";
  }
  if (checkSliceAge(slice.start, config.slicing.maxSliceMinutes * 60_000)) {
    return "time_cap";
  }
  if (slice.turns.length >= config.slicing.maxTurnsPerSlice) return "capacity";
  return null;
}

/**
 * 序 4 — due tasks, mechanically: every open task case's index.md carries a
 * mechanically-stamped `日期锚：YYYY-MM-DD` line (the scribe stamps it, not
 * the model); an anchor on or before the user's local today is due.
 */
async function scanDueTasks(
  todayLocal: string,
  batch: WriteBatch,
): Promise<string[]> {
  const due: string[] = [];
  let entries: Awaited<ReturnType<typeof fsListFiles>>;
  try {
    entries = await fsListFiles(`${MEMORY_ROOT_DIR}/tasks`);
  } catch {
    return due; // no tasks shelf yet
  }
  for (const e of entries) {
    if (e.type !== "dir") continue;
    try {
      const text = await fsReadFile(caseIndexPath("tasks", e.name), batch);
      const m = text.match(/日期锚[:：]\s*(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] <= todayLocal) due.push(`tasks/${e.name}（日期锚 ${m[1]}）`);
    } catch {
      // no index.md in this case dir — skip
    }
  }
  return due;
}

/** The boundary-event mailbox line (序 5) — one JSON object per slice close. */
const BOUNDARY_EVENT_PREFIX = "[boundary-event]";

/**
 * 序 5 — post the boundary event onto the closed slice's agent.md mailbox:
 * `{v, sliceId, closedBy, dueTasks}`. Idempotent by content (a mailbox that
 * already carries this slice's event is left untouched), so a redelivered
 * scribe segment never double-posts. The write lands IN PLACE on the root
 * the mailbox was read from (dual-root discipline, same as the scribe's
 * record lines); a slice without an agent.md yet gets one holding just the
 * event. Question markers are NOT answered here (that is the background
 * stream's job, A3) — they stay in the mailbox as the on-disk pending fact.
 */
async function postBoundaryEvent(
  slice: TimeSlice,
  dueTasks: string[],
  batch: WriteBatch,
): Promise<void> {
  try {
    const resolved = await readSlicePartResolved(slice.slice_id, "agent", batch).catch(
      () => null,
    );
    const existing = resolved?.content ?? "";
    if (
      existing.includes(
        `${BOUNDARY_EVENT_PREFIX} {"v":1,"sliceId":${JSON.stringify(slice.slice_id)}`,
      )
    ) {
      return; // already posted — idempotent re-run
    }
    const line = `${BOUNDARY_EVENT_PREFIX} ${JSON.stringify({
      v: 1,
      sliceId: slice.slice_id,
      closedBy: slice.closedBy ?? null,
      dueTasks,
    })}`;
    const next = existing.trimEnd()
      ? `${existing.trimEnd()}\n\n${line}\n`
      : `${line}\n`;
    await fsWriteFile(resolved?.path ?? sliceIdToAgentPath(slice.slice_id), next, batch);
    console.log(
      `[Boundary] event posted to ${slice.slice_id} mailbox (${dueTasks.length} due task(s))`,
    );
  } catch (e) {
    // A mailbox-line failure must never take the turn down — the next turn's
    // scribe segment retries (the idempotency check keeps it single-post).
    console.warn(
      "[Boundary] event post failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

// ─── Step 1: Housekeeping (the reply segment) ─────────────────────────────

/**
 * How many trailing turns of a checkpointed previous slice are carried into
 * the new slice's history window (see the contextPrefix block below).
 */
const CHECKPOINT_CARRY_OVER_TURNS = 10;

/**
 * Recover today's slice from GitHub truth (never the module global — it does
 * not survive across workflow invocations), DECIDE its lifecycle (idle gap /
 * age cap / turn cap — the close itself is the scribe segment's job, see
 * pendingClose), or keep it open (rebuilding the history window from the
 * slice's own turns when the client history mismatches). Append the user
 * turn and durably snapshot before returning, so the message is on GitHub
 * before we stream anything.
 *
 * The reply segment is deliberately lean (v0.19 A1): NO LLM call (the
 * analyzer moved post-reply), NO projection writes (timeline weave, catalog
 * upserts, global timeline are gone from the turn path), NO strands menu /
 * timeline brief / view block / overdue block (撤清单 §A.2.2).
 */
export async function housekeeping(input: TurnInput): Promise<HousekeepingResult> {
  "use step";

  // One reused writer + serial queue for every UI chunk this step emits —
  // fresh-writer-per-write races drop frames (see createStepStream).
  const stream = createStepStream();

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

  // ── 1. Decide lifecycle (pure — no I/O, no LLM) ──────────────────────
  let closeSignal: SlicingSignal | null = null;
  /** True when the client-sent history mismatched the active slice: the
   *  slice STAYS OPEN and the model window is rebuilt from the slice's own
   *  turns (context_lost used to close the slice here — it is a rebuild
   *  trigger now, never a close trigger). */
  let rebuildFromSlice = false;
  if (diskSlice && diskSlice.status === "active") {
    // Idle gap FIRST: a long silence since the last turn means the user left
    // and came back — this is a genuinely new conversation, not a checkpoint.
    // (Closes are lazy: this fires on the first turn after the gap.)
    const lastTurnTs = diskSlice.turns.at(-1)?.timestamp;
    if (
      lastTurnTs &&
      checkIdleGap(lastTurnTs, config.slicing.idleGapMinutes * 60_000)
    ) {
      closeSignal = "idle_gap";
    } else if (checkSliceAge(diskSlice.start, config.slicing.maxSliceMinutes * 60_000)) {
      // The age cap is a periodic autosave CHECKPOINT, not a conversation end
      // — the new slice continues the same one (continuesFrom below).
      closeSignal = "time_cap";
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      closeSignal = "capacity";
    // A regenerate turn legitimately carries a truncated client history (the
    // SDK dropped the rejected reply) — detection is skipped for this turn
    // shape, and demo mode never persists a slice so nothing to rebuild from.
    } else if (
      !input.regenerate &&
      !input.useDemo &&
      checkClientHistoryMismatch(modelMessages, diskSlice)
    ) {
      rebuildFromSlice = true;
    }
  }

  // ── 2. Materialize (IN MEMORY only) ───────────────────────────────────
  // A close decided above is NOT executed here: the old slice stays active on
  // disk until the scribe segment closes it post-reply (序 3). A run killed
  // in between leaves an orphaned active slice that the scribe segment's disk
  // scan (findStaleActiveSlice) re-discovers — the decision itself needs no
  // persistence.
  let slice: TimeSlice;
  /** The close decision handed to the scribe segment by value. */
  let pendingClose: HousekeepingResult["pendingClose"];
  /** The slice we came from — set when we decided a close this call, or
   *  resolved from disk when today has none. Drives the continuity brief. */
  let prevSlice: PrevSliceRef | null = null;
  if (closeSignal && diskSlice) {
    prevSlice = toPrevRef(diskSlice);
    pendingClose = { slice: diskSlice, signal: closeSignal };
    // Checkpoint continuation link: only time_cap/capacity closes are
    // autosave checkpoints of the SAME conversation — the new slice carries
    // the closed slice's tail as live context. idle_gap is a genuine
    // conversation boundary and gets no link (no carry-over).
    const checkpoint =
      closeSignal === "time_cap" || closeSignal === "capacity";
    slice = createSlice(
      lastUserMessage,
      clientTimezone,
      input.turnId,
      checkpoint ? diskSlice.slice_id : undefined,
    );
    console.log(
      `[Episodic] Close decided: ${diskSlice.slice_id} (${closeSignal}) — executed post-reply by the scribe segment`,
    );
  } else if (diskSlice && diskSlice.status === "active") {
    slice = diskSlice;
    console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
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
  await emitPhase(stream, "slice", false, [slice.slice_id]);

  // ── Phase: context — load the user profile (previously + identity) ───
  await emitPhase(stream, "context", true);

  // ── 4. Ensure previously.md (pure copy forward, no decay) ────────────
  const previouslyContent = await ensurePreviously(slice.slice_id, batch);
  console.log(`[Previously] Seeded previously.md for ${slice.slice_id}`);

  // ── 5. Durable snapshot, then THE reply segment's one commit ─────────
  // No projection writes here anymore (A1): the timeline catalog / global
  // timeline / monthly index maintenance moved out of the turn path.
  await saveSliceSnapshot(slice, batch);
  await flushBatch(batch, `Turn ${input.turnId} — user turn`);

  // ── 6. Continuity + slice-head snapshot + identity (the read face) ────
  // v0.9 slice-level prompt freeze: the continuity stance is computed at the
  // SLICE'S BIRTH, not per turn — the reference is the newest slice closed
  // before this one began (the one we are about to close, else disk truth),
  // and the gap is measured against `slice.start`. Recomputed this way on
  // every turn, the resulting line is byte-identical for the slice's life.
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
    const prevTurns =
      pendingClose && pendingClose.slice.slice_id === slice.continuesFrom
        ? pendingClose.slice.turns // closing this call — already in memory
        : (await loadSlice(slice.continuesFrom))?.turns;
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

  // The direction layer for the main agent's system prompt (v1.1): read per
  // turn like the card. Evolution runs in the scribe segment now (post-reply,
  // v0.19 A1), so a direction landed this turn is what the NEXT turn reads —
  // within a slice without an evolution the layer is byte-stable. Missing /
  // template / legacy-skeleton docs omit the layer entirely
  // (buildDirectionBlock returns "").
  const directionBlock = buildDirectionBlock(
    await readDirection().catch(() => null),
  );

  await emitPhase(stream, "context", false, [`continuity: ${continuity.tier}`]);

  // ── 7. Open UI stream ────────────────────────────────────────────────
  await stream.write({ type: "start" } as UIMessageChunk);
  await stream.write({ type: "start-step" } as UIMessageChunk);

  return {
    slice,
    previouslyContent,
    sliceHeadBlock,
    identityPrompt,
    ...(directionBlock ? { directionBlock } : {}),
    ...(contextPrefix ? { contextPrefix } : {}),
    ...(rebuiltHistory ? { rebuiltHistory } : {}),
    ...(pendingClose ? { pendingClose } : {}),
  };
  });
  } finally {
    // Release the step's writer lock so the step's HTTP request can terminate
    // and later steps (agent reply, the post-reply steps) can acquire their own.
    stream.close();
  }
}

// ─── Step 2: persistAgentTurn (序 1) ──────────────────────────────────────

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
  slice: TimeSlice,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await flushBatch(batch, message);
      return;
    } catch (err) {
      if (!isRefConflictError(err) || attempt >= MAX_FLUSH_RETRIES) {
        throw err;
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
 * 序 1 — persist the agent turn to the episodic slice (the old streamText
 * onFinish). Retries are safe: the agent-turn append is deduped by turnId,
 * and the snapshot write is idempotent.
 */
export async function persistAgentTurn(
  slice: TimeSlice,
  outcome: TurnOutcome,
  turnId: string,
): Promise<void> {
  "use step";

  // Serialize turns on the same slice within this process (see housekeeping).
  return withSliceLock(slice.slice_id, async () => {

  // ── Begin batch: all writes below go into ONE git commit ──────────────
  const batch = createBatch();

  // Episodic persistence (the old onFinish branches). `outcome.text` is the
  // agent's FULL assistant text for the turn (intermediate + final), so the
  // stored slice keeps both ends; tool calls are not preserved.
  // Idempotent under redelivery: when this turnId's agent turn is already in
  // the slice (a retried run re-executing against persisted disk state), skip
  // the append. User and agent turns share the turnId — scope by role.
  const agentTurnRecorded =
    !!turnId &&
    slice.turns.some((t) => t.role === "agent" && t.turnId === turnId);
  if (agentTurnRecorded) {
    console.log(`[Episodic] Agent turn ${turnId} already persisted — skipping append`);
  } else if (outcome.finishReason === "stop") {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "agent",
      content: outcome.text,
      turnId,
    });
  } else if (outcome.text) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "agent",
      content: `[partial] ${outcome.text}`,
      turnId,
    });
    console.log(`[Episodic] Pro interrupted (${outcome.finishReason})`);
  } else {
    console.log(`[Episodic] Pro produced no text (${outcome.finishReason})`);
  }

  if (outcome.finishReason === "stop" || outcome.text) {
    await saveSliceSnapshot(slice, batch);
  }

  // Write agent timeline — mechanical extraction from the model's own
  // reasoning traces and tool calls. The cognition body is produced by
  // extractCognition() in the workflow body; here we prepend the header
  // (timestamp stamped in this step, where Date is allowed) and persist.
  if (outcome.cognition) {
    const header = `## Cognition ${turnId} — ${new Date().toISOString()}\n`;
    await writeAgentTimeline(slice.slice_id, header + outcome.cognition, batch);
  }

  // Commit all queued writes as one commit.
  await flushTurnBatch(batch, `Turn ${turnId} — agent response`, slice);
  });
}

// ─── Step 3: scribeSegment (序 2–7, the scribe segment) ───────────────────

/**
 * The post-reply segment (v0.19 A1 §A.2.1) — everything the reply must not
 * wait for, in seven steps:
 *   序 2  analyze    — the turn-analyzer (or the ONE bridge housekeeping
 *                      call, minimal payload) produces the semantic hint, the
 *                      close marking, and the explicit memory-update reading.
 *   序 3  close      — execute the close the reply segment decided
 *                      (pendingClose), or close the orphaned active slice a
 *                      killed run left behind (findStaleActiveSlice +
 *                      rederived signal). Marks first; never closes dry.
 *   序 4  due tasks  — mechanical 日期锚 scan of the tasks shelf.
 *   序 5  boundary   — post the [boundary-event] line onto the previous
 *                      closed slice's mailbox (idempotent); log the count of
 *                      its unanswered question markers (the background
 *                      stream's trigger, A3 — not answered here).
 *   序 6  evolution  — EXPLICIT-INSTRUCTION only (the user asked to
 *                      record/change something): the single surviving
 *                      evolution channel. Fitness-triggered / boundary /
 *                      direction-gated runs are gone with the loop's
 *                      retirement (the store keeps whatever A2+ rebuilds).
 *   序 7  scribe     — the scribe pass on the just-closed slice (markers →
 *                      task/sediment cases), then on the active slice's tail.
 *
 * Everything runs under the turn's slice lock and lands in ONE batch commit
 * at the end. EVERY sub-step is idempotent (close: status flip + signal
 * re-derivation; boundary event: content check; evolution: a review re-run
 * converges; scribe: processed-marker records), so a kill anywhere re-runs
 * the whole segment safely. Demo mode skips the segment entirely (read-only
 * preview — the analysis has nowhere to land).
 */
export async function scribeSegment(
  input: TurnInput,
  hk: HousekeepingResult,
): Promise<void> {
  "use step";

  if (input.useDemo) return;

  const stream = createStepStream();
  const { slice } = hk;
  const { config, lastUserMessage } = input;

  // ── Phase display: two modes, two components ─────────────────────────
  // Edge mode emits one compact data-phase chunk per engineering sub-step
  // (analyze / slice-closed) — the client merges them into the
  // HousekeepingCard checklist.
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
    /** Set when the bridge call failed and the segment degraded to the
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

  try {
  return await withSliceLock(slice.slice_id, async () => {
  const batch = createBatch();
  // Ages/due-dates compare against the USER's local calendar date, not UTC.
  const todayLocal =
    localDateKey(input.startedAtIso, input.clientTimezone) ??
    input.startedAtIso.slice(0, 10);

  // The slice closing this turn: the reply segment's pending decision, or —
  // on a redelivered run (the decision was never persisted) — an orphaned
  // ACTIVE slice on disk that is not the current one. Undefined when the
  // disk holds no orphan (the close already landed, or never fired).
  const closingSlice =
    hk.pendingClose?.slice ??
    (await findStaleActiveSlice(slice.slice_id, batch));

  // ── 序 2. Analyze ─────────────────────────────────────────────────────
  await emitStep("analyze", true);
  const existingStrands = await readStrands(batch);
  let analysis: TurnAnalysis;
  /** The bridge report — kept for 序 6's mutation application. */
  let bridgeReport: HousekeepingPhaseReport | null = null;
  if (phaseOutsource) {
    // Phase outsourcing (client mode + bridge brain, kill-switch
    // PREVIOUSLY_PHASE_OUTSOURCE=0): ONE bridge call covers the analysis AND
    // (on an explicit update) the card-mutation proposal. The payload is the
    // minimal set (A1): message, recent turns, strand names, the card, the
    // closing slice — no dry slices / merge candidates / signals / playbooks
    // / direction anymore. A failed call degrades EXACTLY like an analyzer
    // outage (memoryWorthy=true, no tags, deterministic closed marking below)
    // and additionally SKIPS the evolution — no second bridge spawn on a
    // broken bridge.
    const bridgeCardRaw = await readCurrentPreviously(batch);
    // Forward the client agent's live tool activity into the turn stream so
    // the user can watch the CLI work during the analysis — the same
    // data-phase channel + payload the chat bridge model uses
    // (createBridgeEventEmitter), on a distinct id/phase so the two
    // indicators never merge. Frames ride this step's serial stream queue
    // (stream.send), throttled inside the emitter. Deltas ARE forwarded here:
    // for phase "housekeeping" the client suppresses the JSON report block
    // and deltas carry only narration/thinking — they become the indicator's
    // rolling "current activity" line (data.live), so the wait is visible
    // even when the CLI makes zero tool calls. The activity state is folded
    // into the shared card frame (hkActivity) so wrap-up rows (emitStep) and
    // tool/narration frames never overwrite each other — every frame carries
    // the full cumulative state (build-stream: last chunk wins).
    const bridgeActivity = createBridgeEventEmitter({
      id: "phase-bridge-housekeeping",
      phase: "bridgeHousekeeping",
      write: (data: BridgePhaseData) => {
        hkActivity.tools = data.tools;
        hkActivity.live = data.live;
        // The emitter's settle (running:false) fires the moment the bridge
        // call returns, while wrap-up rows (analyze → close) are still being
        // applied — keep the card spinning until they settle too.
        sendHousekeepingCard(
          data.running || hkSteps.some((s) => s.running),
        );
      },
    });
    const bridgeResult = await runHousekeepingBridge(
      {
        userMessage: lastUserMessage,
        recentTurns: input.recentTurns,
        existingStrandNames: Object.keys(existingStrands),
        cardContent: bridgeCardRaw,
        sliceId: slice.slice_id,
        closingSlice: closingSlice
          ? { sliceId: closingSlice.slice_id, turns: closingSlice.turns }
          : undefined,
        todayLocal,
        locale: input.locale,
      },
      { onEvent: bridgeActivity.onEvent, onDelta: bridgeActivity.onDelta },
    );
    // Settle the indicator (running: false) whatever the outcome.
    bridgeActivity.finish();
    if (bridgeResult.ok) {
      bridgeReport = bridgeResult.report;
      analysis = adaptHousekeepingReport(bridgeResult.report, !!closingSlice);
    } else {
      console.warn(
        `[HousekeepingBridge] ${bridgeResult.reason} — degraded to the deterministic path`,
      );
      analysis = degradedAnalysis();
      // Surface the degradation on the card — it must not settle silently
      // green when the memory analysis fell back to heuristics.
      hkActivity.warning = bridgeResult.reason;
      sendHousekeepingCard(hkSteps.some((s) => s.running));
    }
  } else {
    analysis = await analyzeTurn({
      model: input.modelConfig,
      userMessage: lastUserMessage,
      existingStrandNames: Object.keys(existingStrands),
      closingSlice: closingSlice ? { turns: closingSlice.turns } : undefined,
    });
  }
  await emitStep("analyze", false);

  // ── 序 3. Execute the close — marking BEFORE the slice persists ───────
  // Idempotent: a slice already closed on disk (a previous delivery got this
  // far) is not touched again.
  let closedThisTurn: TimeSlice | null = null;
  if (closingSlice && closingSlice.status === "active") {
    const signal =
      hk.pendingClose?.slice.slice_id === closingSlice.slice_id
        ? hk.pendingClose.signal
        : rederiveCloseSignal(closingSlice, config);
    if (!signal) {
      console.warn(
        `[Episodic] stale active slice ${closingSlice.slice_id} re-derives no close signal — left for the background scan (A2)`,
      );
    } else {
      if (analysis.closedMarking) {
        if (analysis.closedMarking.focus) closingSlice.focus = analysis.closedMarking.focus;
        if (analysis.closedMarking.summary) closingSlice.summary = analysis.closedMarking.summary;
        if (analysis.closedMarking.tone) closingSlice.emotional_tone = analysis.closedMarking.tone;
      }
      // Never close a slice dry when it has content: the analyzer silently
      // returns EMPTY on any failure (worker outage, schema mismatch), which
      // used to leave focus/summary empty — the "39% dry" timeline. Fill any
      // gap with a deterministic mark from the slice itself.
      if (!closingSlice.focus || !closingSlice.summary) {
        const fallback = deterministicSliceMark(closingSlice);
        if (!closingSlice.focus) closingSlice.focus = fallback.focus;
        if (!closingSlice.summary) closingSlice.summary = fallback.summary;
        console.log(
          `[Episodic] ${closingSlice.slice_id} closed with deterministic mark (analyzer output incomplete)`,
        );
      }
      await closeSlice(closingSlice, signal, batch);
      closedThisTurn = closingSlice;
      console.log(`[Episodic] Closed slice: ${closingSlice.slice_id} (${signal})`);
      // Signal the client that a slice closed (rendered as a housekeeping
      // checklist row).
      await emitStep("slice-closed", false, [closingSlice.slice_id]);
    }
  }

  // ── 序 4. Due tasks (mechanical) ──────────────────────────────────────
  const dueTasks = await scanDueTasks(todayLocal, batch);

  // ── 序 5. Boundary event + unanswered-question count ──────────────────
  // The target is the newest slice closed before the current one — NOT the
  // close executed above: a run killed between 序 3 and here re-finds it
  // from disk, and the post's own content check keeps the event single.
  const prevClosed = await readPrevClosedSlice(slice.slice_id, batch);
  if (prevClosed) {
    await postBoundaryEvent(prevClosed, dueTasks, batch);
    try {
      const agentMd = await readSlicePart(prevClosed.slice_id, "agent", batch);
      const answered = extractProcessedMarkerIds(agentMd, RESEARCH_RECORD_PREFIX);
      const openQuestions = extractDocMarkers(agentMd).filter(
        (m) => m.kind === "question" && !answered.has(m.id),
      );
      if (openQuestions.length > 0) {
        console.log(
          `[Docs] ${openQuestions.length} unanswered question marker(s) sit in ${prevClosed.slice_id}'s mailbox — the background stream's trigger (A3)`,
        );
      }
    } catch {
      // no mailbox on the closed slice — no questions either
    }
  }

  // ── 序 6. Explicit-instruction evolution (the ONLY surviving channel) ──
  // The user explicitly asked to record/evolve or stated a behavioral
  // correction (analyzeTurn's memoryUpdate). Every write runs under ONE
  // process-wide `withSliceLock("evolution")` (v0.16 S1 single-writer). A
  // changed run's summary freezes into the slice frontmatter so the L3
  // slice-head block replays it on every later turn of the slice. Evolution
  // failures must never take the turn down: a write/agent error is reported
  // to the client as an error chunk and the turn continues.
  let evolutionResult: EvolutionResult | undefined;
  /** Freeze a changed evolution's summary into the slice (single line, YAML-safe). */
  const freezeEvolutionSummary = async (target: TimeSlice) => {
    if (evolutionResult?.ran && evolutionResult.changed && evolutionResult.summary) {
      target.evolutionSummary = evolutionResult.summary.replace(/\s+/g, " ").trim();
      await saveSliceSnapshot(target, batch);
    }
  };
  const explicitUpdate = analysis.memoryUpdate;
  try {
    if (explicitUpdate) {
      if (phaseOutsource) {
        // Bridge path: the mutation proposals arrived in the SAME bridge call
        // as the analysis — apply them through the card-session machinery
        // (applyBridgeCardEvolution), no second spawn.
        const cardRaw = await readCurrentPreviously(batch);
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
        // The direction doc is orientation for the product phase even on an
        // explicit-request run (no direction evaluation and no fitness
        // buckets here).
        const direction = await readDirection().catch(() => null);
        evolutionResult = await withSliceLock("evolution", () =>
          runCardEvolution({
            model: input.modelConfig,
            sliceId: slice.slice_id,
            recentTurns: input.recentTurns,
            currentSliceTags: slice.tags,
            focus: explicitUpdate.content,
            signal: "new_observation",
            readers: buildCardReaders(input),
            onProgress: onEvolutionProgress,
            onEvolutionLine,
            batch,
            todayDate: todayLocal,
            direction,
            triggeredBuckets: [],
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
      `[Evolution] scribe-segment run failed, continuing turn:`,
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

  // ── 序 7. Scribe — pick up [doc-marker] mailbox lines ────────────────
  // The just-closed slice first (its mailbox is final), then the active
  // slice's tail (the reply segment's own markers). No markers → one file
  // read, no LLM. Best-effort each — a document write must never take a
  // turn down.
  if (closedThisTurn) {
    try {
      const boundaryScribe = await runScribePass({
        model: input.modelConfig,
        sliceId: closedThisTurn.slice_id,
        excerpt: buildSliceExcerpt(closedThisTurn),
        strands: existingStrands,
        date: todayLocal,
        batch,
      });
      if (boundaryScribe.ran) {
        console.log(
          `[Docs] Scribe (boundary): ${boundaryScribe.written.length} doc(s) written`,
        );
      }
    } catch (e) {
      console.warn("[Docs] boundary scribe failed:", e instanceof Error ? e.message : e);
    }
  }
  try {
    const tailScribe = await runScribePass({
      model: input.modelConfig,
      sliceId: slice.slice_id,
      excerpt: buildSliceExcerpt(slice),
      strands: existingStrands,
      date: todayLocal,
      batch,
    });
    if (tailScribe.ran) {
      console.log(
        `[Docs] Scribe (tail): ${tailScribe.written.length} doc(s) written`,
      );
    }
  } catch (e) {
    console.warn("[Docs] scribe tail failed:", e instanceof Error ? e.message : e);
  }

  // ONE commit for the whole segment (close + boundary event + evolution +
  // scribe). A kill before this flush re-runs the segment from disk state —
  // every step above is idempotent, so nothing doubles.
  await flushBatch(batch, `Turn ${input.turnId} — scribe`);
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
