/**
 * Typed I/O over the evolution data files (v1.0 design §2.2–§2.6) — the STORE
 * half. The analyzer scores (turn-analyzer.ts), the trigger math aggregates
 * (triggers.ts), and the evolution agent mutates (previously-agent.ts /
 * direction-agent.ts); this module only guarantees the
 * data layer is safe to build on:
 *
 *   - All reads/writes route through io-helpers (fsReadFile / fsWriteFile /
 *     fsListFiles / fsDeleteFile), so demo / GitHub / local resolution — and
 *     explicit WriteBatch threading — behave exactly like the rest of the
 *     memory subsystem.
 *   - Missing files degrade to null / empty stores, never to errors: a fresh
 *     deployment has no evolution data yet, and that is a normal state.
 *   - Evidence-anchoring is STRUCTURAL, not prompt-level: a fitness event with
 *     blank evidence is force-stored with delta 0 (design §2.5 — "无证据强制归
 *     0"). No caller, however buggy or hallucinating, can score without evidence.
 *   - The fitness store is DIRECTORY-LEVEL append-only (v0.16 S0, design §3.1):
 *     one event/signal per file under `fitness/events/`, so concurrent writers
 *     (two turns' housekeepings, the interrupt signal route) can never clobber
 *     each other — GitHub's contents API has no append, and only one-file-per-
 *     entry is real append-only. Reads aggregate the directory; the legacy
 *     whole-file `fitness.json` is still read and merged (old repos), and
 *     never crashes the parse. Aggregation serves at most the newest
 *     ~200 events / ~200 signals — a pure safety valve; generations are
 *     naturally bounded because a successful evolution run settles by
 *     DELETING the spent files.
 */

import { randomBytes } from "crypto";
import {
  fsReadFile,
  fsWriteFile,
  fsListFiles,
  fsDeleteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import {
  DIRECTION_PATH,
  DIRECTION_REJECTED_PATH,
  FITNESS_EVENTS_DIR,
  FITNESS_PATH,
  playbookPath,
  type PlaybookAgent,
} from "./paths";

// ─── Direction document (design §2.2) ────────────────────────────────────

/** The minimal direction.md template — the two fixed sections of the USER
 *  PORTRAIT (six fixed dimensions) + HYPOTHESIS POOL (see direction-agent.ts).
 *  Only the skeleton and the writing discipline are fixed; the content is the
 *  evolution agent's. */
const DIRECTION_TEMPLATE = `# Portrait

_(Not set yet — confirmed, cross-slice understanding of WHO the user is: descriptive, portrait-grade (holds across contexts, outlives its evidence, predicts), never imperatives. Slice pointers ride trailing "— refs:" tails only.)_

## Traits & cognitive style

## Triggers & rhythms

## Patterns & loops

## Strengths & resilience

## Communication preferences

## Values & boundaries

# Hypotheses

_(Not set yet — bounded dynamic pool of trait-level guesses (≤10), each "- [proposed YYYY-MM-DD-HHMM] <guess> — falsify if: <condition>". Confirmed → promoted into the Portrait in the same run; refuted → removed; unverified 4 slices → retired. Refilled toward 10 each run.)_
`;

/**
 * Read the evolution-direction document. Returns null when it does not exist
 * yet (a fresh deployment is a normal state, not an error).
 */
export async function readDirection(): Promise<string | null> {
  try {
    const content = await fsReadFile(DIRECTION_PATH);
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/**
 * True when the direction doc has never actually been written — missing file,
 * or still the untouched bootstrap template (the "(Not set yet" placeholders
 * are the tell; writeDirection replaces the whole doc, so any real write
 * clears them). Used to gate the bootstrap path: the FIRST direction gets a
 * lowered evidence bar (see direction-agent.ts).
 */
export function isDirectionTemplate(content: string | null): boolean {
  if (content === null) return true;
  return content.includes("(Not set yet");
}

/** Overwrite the direction document. The EVOLUTION AGENT is the only writer
 *  (design §3 — single-writer discipline); this helper does not judge content. */
export async function writeDirection(
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(DIRECTION_PATH, content, batch);
}

/**
 * Best-effort bootstrap: create direction.md from the minimal template when
 * (and only when) it is missing. Never throws, never overwrites existing
 * content — the whole point of the file is that an evolved direction survives.
 */
export async function ensureEvolutionFiles(): Promise<void> {
  try {
    await fsReadFile(DIRECTION_PATH);
    return; // exists — leave it untouched
  } catch {
    // Missing (or unreadable) — try to create below.
  }
  try {
    await fsWriteFile(DIRECTION_PATH, DIRECTION_TEMPLATE);
  } catch (e) {
    console.warn(
      "[Evolution] could not bootstrap direction.md:",
      e instanceof Error ? e.message : e,
    );
  }
}

// ─── Playbooks (design §2.4) ─────────────────────────────────────────────

/**
 * Hard cap on INJECTED playbook length. A playbook is short working notes by
 * design; a bloated one would flood every sub-agent prompt, so injection
 * truncates with a marker rather than failing.
 */
export const MAX_PLAYBOOK_CHARS = 2000;

/** Truncate a playbook to the injection budget, marking the cut so the
 *  sub-agent knows the notes continue beyond what it sees. */
export function capPlaybook(content: string): string {
  if (content.length <= MAX_PLAYBOOK_CHARS) return content;
  return (
    content.slice(0, MAX_PLAYBOOK_CHARS) +
    `\n\n[…playbook truncated at ${MAX_PLAYBOOK_CHARS} chars]`
  );
}

/**
 * Read a sub-agent's evolved playbook. Returns null when missing/blank — the
 * caller then omits the injection block entirely (no behavior change).
 */
export async function readPlaybook(
  agent: PlaybookAgent,
): Promise<string | null> {
  try {
    const content = await fsReadFile(playbookPath(agent));
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** Overwrite a sub-agent's playbook. Evolution-agent writes only (design §3). */
export async function writePlaybook(
  agent: PlaybookAgent,
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(playbookPath(agent), content, batch);
}

// ─── Fitness store (design §2.5 / §2.6) ──────────────────────────────────

/** The attribution buckets — each scores (or observes) independently. */
export type FitnessBucket =
  | "card"
  | "recall"
  | "search"
  | "thinkdeep"
  | "interaction";

/**
 * One scored observation. Coarse ordinal only: -2 explicit complaint/correction,
 * -1 dissatisfaction signs, 0 no signal, +1 explicit approval. A non-zero delta
 * is only meaningful WITH user-verbatim evidence — enforced structurally in
 * appendFitnessEvents.
 */
export interface FitnessEvent {
  ts: string;
  sliceId: string;
  bucket: FitnessBucket;
  delta: -2 | -1 | 0 | 1;
  /** User's own words (or a slice pointer) backing a non-zero delta. */
  evidence: string;
}

/**
 * A mechanical observation, NOT a score: emitted by instrumentation (the
 * rework signal of design §2.6, extended by the document system §4.4) rather
 * than by any model. The analyzer stage reads these when scoring; nothing
 * here interprets them. Closed union — doc_rework (v0.15 §4.4: a readDoc's
 * cited slice was re-opened with readSlice — the document was not credited)
 * lands in the SAME recall bucket ("memory quality") as the recall signals.
 */
export interface FitnessSignal {
  ts: string;
  sliceId: string;
  type:
    | "recall_verify"
    | "recall_rework"
    | "recall_repeat"
    | "doc_rework"
    | "interaction_regenerate"
    | "interaction_interrupt";
  detail: string;
}

export interface FitnessStore {
  events: FitnessEvent[];
  signals: FitnessSignal[];
  /**
   * Slice ids whose direction proposal was already REJECTED once (v1.1
   * per-slice backoff): the doc keeps its old skeleton after a rejection, so
   * the migrate/bootstrap gate would otherwise re-fire the full merged
   * evolution run on EVERY remaining turn of that slice. Housekeeping reads
   * this list and stops gating on the direction for the rest of the slice;
   * the NEXT slice retries fresh (a new slice, a new chance). Ids are never
   * reused, so the bound below only ages out long-dead slices.
   */
  directionRejections: string[];
}

/** Read-side retention bounds — a pure safety valve applied at aggregation;
 * generations are naturally bounded because settle DELETES the spent entry
 * files (v0.16 S0). The store is read whole on every use, so even a runaway
 * generation must not flood every evolution prompt that quotes it. */
export const MAX_FITNESS_EVENTS = 200;
export const MAX_FITNESS_SIGNALS = 200;
/** Rejection ids are one-per-slice at most; only the CURRENT slice's
 *  membership is ever consulted, so a shallow tail is plenty. */
export const MAX_DIRECTION_REJECTIONS = 50;

export function emptyFitnessStore(): FitnessStore {
  return { events: [], signals: [], directionRejections: [] };
}

// ─── Directory-level append-only fitness store (v0.16 S0) ────────────────

/**
 * One event/signal per file under `fitness/events/` — `<sanitized-ts>-<rand6>.json`.
 * Concurrent writers never share a filename, so appends cannot clobber each
 * other no matter who races whom (two turns' housekeepings, the interrupt
 * signal route). The random suffix covers batches of events sharing one ts.
 */
function fitnessEntryPath(ts: string): string {
  const safe = ts.replace(/[^\w.-]/g, "-");
  return `${FITNESS_EVENTS_DIR}/${safe}-${randomBytes(3).toString("hex")}.json`;
}

/** A directory entry is a scored event when it carries `bucket`, a mechanical
 * signal when it carries `type` — the two shapes are disjoint by contract. */
function classifyFitnessEntry(
  parsed: unknown,
): { kind: "event"; event: FitnessEvent } | { kind: "signal"; signal: FitnessSignal } | null {
  if (!parsed || typeof parsed !== "object") return null;
  if ("bucket" in parsed) {
    return { kind: "event", event: parsed as unknown as FitnessEvent };
  }
  if ("type" in parsed) {
    return { kind: "signal", signal: parsed as unknown as FitnessSignal };
  }
  return null;
}

/** Chronological order — entry timestamps are ISO strings, so lexical order
 *  IS time order. */
function byTs(a: { ts: string }, b: { ts: string }): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

/**
 * Read the fitness store: aggregate the directory store, merge the LEGACY
 * whole-file `fitness.json` (old repos may still have one — merging it here
 * migrates reads forward with zero ceremony), and honor this batch's pending
 * entries so the trigger math sees this turn's own appends (read-your-writes).
 * Missing, corrupt, or unclassifiable entries are skipped — the store is a
 * soft-signal log, and losing some of it must never break a turn.
 */
export async function readFitness(batch?: WriteBatch): Promise<FitnessStore> {
  const events: FitnessEvent[] = [];
  const signals: FitnessSignal[] = [];

  // 1. Directory store, with the batch's pending view layered on top.
  const dirEntries = new Map<string, unknown>();
  try {
    for (const f of await fsListFiles(FITNESS_EVENTS_DIR)) {
      if (f.type !== "file" || !f.name.endsWith(".json")) continue;
      try {
        dirEntries.set(f.name, JSON.parse(await fsReadFile(f.path)));
      } catch {
        // corrupt entry file — skip it, never crash the aggregation
      }
    }
  } catch {
    // directory absent — a fresh deployment, fine
  }
  if (batch) {
    const prefix = `${FITNESS_EVENTS_DIR}/`;
    for (const [p, content] of batch.entries) {
      if (!p.startsWith(prefix) || !p.endsWith(".json")) continue;
      const name = p.slice(prefix.length);
      if (content === null) {
        dirEntries.delete(name); // queued delete
      } else {
        try {
          dirEntries.set(name, JSON.parse(content));
        } catch {
          dirEntries.delete(name);
        }
      }
    }
  }
  for (const parsed of dirEntries.values()) {
    const entry = classifyFitnessEntry(parsed);
    if (entry?.kind === "event") events.push(entry.event);
    else if (entry?.kind === "signal") signals.push(entry.signal);
  }

  // 2. Legacy whole-file store — merged, tolerated, never fatal.
  let legacyRejections: string[] = [];
  try {
    const parsed = JSON.parse(await fsReadFile(FITNESS_PATH, batch)) as Partial<FitnessStore>;
    if (Array.isArray(parsed.events)) {
      events.push(...(parsed.events as FitnessEvent[]));
    }
    if (Array.isArray(parsed.signals)) {
      signals.push(...(parsed.signals as FitnessSignal[]));
    }
    if (Array.isArray(parsed.directionRejections)) {
      legacyRejections = parsed.directionRejections as string[];
    }
  } catch {
    // absent or corrupt — fine
  }

  // 3. directionRejections: the live small file first, legacy folded in
  //    (deduped, order-preserved), tail-capped.
  const liveRejections: string[] = [];
  try {
    const parsed = JSON.parse(await fsReadFile(DIRECTION_REJECTED_PATH, batch)) as unknown;
    if (Array.isArray(parsed)) liveRejections.push(...(parsed as string[]));
  } catch {
    // absent — fine
  }
  const seen = new Set(liveRejections);
  const directionRejections = [...liveRejections];
  for (const id of legacyRejections) {
    if (!seen.has(id)) {
      seen.add(id);
      directionRejections.push(id);
    }
  }

  events.sort(byTs);
  signals.sort(byTs);
  return {
    events: events.slice(-MAX_FITNESS_EVENTS),
    signals: signals.slice(-MAX_FITNESS_SIGNALS),
    directionRejections: directionRejections.slice(-MAX_DIRECTION_REJECTIONS),
  };
}

/**
 * Append scored events. STRUCTURAL evidence-anchoring: an event whose
 * evidence is empty/whitespace is stored with delta 0 no matter what the
 * caller passed — scoring without evidence is impossible by construction
 * here, not by prompt discipline. Each event becomes its OWN file: a pure
 * append, no read-modify-write, safe under unbounded concurrency.
 */
export async function appendFitnessEvents(
  events: FitnessEvent[],
  batch?: WriteBatch,
): Promise<void> {
  if (events.length === 0) return;
  const normalized = events.map((e) =>
    e.evidence.trim() ? e : { ...e, delta: 0 as const },
  );
  for (const e of normalized) {
    await fsWriteFile(fitnessEntryPath(e.ts), JSON.stringify(e), batch);
  }
}

/** Append one mechanical signal (see FitnessSignal) — its own file, same
 *  directory-level append-only discipline as the scored events. */
export async function appendSignal(
  signal: FitnessSignal,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(fitnessEntryPath(signal.ts), JSON.stringify(signal), batch);
}

/**
 * Settle the current generation (v0.9.2): a SUCCESSFUL evolution run has
 * responded to everything the store was holding — the outcome already
 * sedimented into the card / direction / playbooks, so the scored events
 * and mechanical signals that produced it are spent and DELETED (settle is
 * removal, not bookkeeping: no cross-generation archive, semantics identical
 * to the old clear-the-file). Deleting the spent entry files cannot race a
 * concurrent append — a new signal/event is a NEW file, untouched here.
 * Every bucket re-accumulates from zero. directionRejections survive: they
 * are a per-slice UI backoff, not selection pressure. An already-empty
 * generation is a strict no-op (no writes). Never demo-reachable —
 * housekeeping's evolution block is skipped entirely in demo mode.
 */
export async function resetFitnessGeneration(batch?: WriteBatch): Promise<void> {
  const store = await readFitness(batch);
  if (store.events.length === 0 && store.signals.length === 0) return;

  // Delete every spent entry file — both the on-disk ones and this batch's
  // own not-yet-flushed appends (a queued delete converts the pending write;
  // the Map's last-set-wins does exactly that).
  const prefix = `${FITNESS_EVENTS_DIR}/`;
  const names = new Set<string>();
  try {
    for (const f of await fsListFiles(FITNESS_EVENTS_DIR)) {
      if (f.type === "file" && f.name.endsWith(".json")) names.add(f.name);
    }
  } catch {
    // directory absent — nothing on disk
  }
  if (batch) {
    for (const p of batch.entries.keys()) {
      if (p.startsWith(prefix) && p.endsWith(".json")) names.add(p.slice(prefix.length));
    }
  }
  for (const name of names) {
    await fsDeleteFile(`${FITNESS_EVENTS_DIR}/${name}`, batch);
  }

  // Legacy whole-file store: clear it too if it still holds anything (kept
  // whole-file only for this legacy clear; the live store is the directory).
  try {
    const legacy = JSON.parse(
      await fsReadFile(FITNESS_PATH, batch),
    ) as Partial<FitnessStore>;
    if (
      (legacy.events?.length ?? 0) > 0 ||
      (legacy.signals?.length ?? 0) > 0
    ) {
      await fsWriteFile(
        FITNESS_PATH,
        JSON.stringify(
          {
            events: [],
            signals: [],
            directionRejections: Array.isArray(legacy.directionRejections)
              ? legacy.directionRejections
              : [],
          },
          null,
          2,
        ),
        batch,
      );
    }
  } catch {
    // absent or corrupt — nothing to clear
  }
}

/**
 * Record that this slice's direction proposal was REJECTED by validation —
 * the per-slice backoff for the migrate/bootstrap gate (see the
 * directionRejections field). Idempotent per slice. The rejections live in
 * their own small file, written only on the evolution path (inside the
 * evolution lock, v0.16 S1). Never demo-reachable: housekeeping's evolution
 * block is skipped entirely in demo mode.
 */
export async function recordDirectionRejection(
  sliceId: string,
  batch?: WriteBatch,
): Promise<void> {
  const store = await readFitness(batch);
  if (store.directionRejections.includes(sliceId)) return;
  const next = [...store.directionRejections, sliceId].slice(
    -MAX_DIRECTION_REJECTIONS,
  );
  await fsWriteFile(DIRECTION_REJECTED_PATH, JSON.stringify(next), batch);
}

/** The newest `n` signals, oldest-first (chronological read order). */
export async function readRecentSignals(n: number): Promise<FitnessSignal[]> {
  const store = await readFitness();
  return store.signals.slice(-Math.max(0, n));
}

/**
 * Net score for one bucket over the CURRENT GENERATION (design §2.5: the
 * aggregation lives in CODE, deterministic; the LLM only ever produces
 * single evidence-anchored deltas). Every event in the store is
 * current-generation by construction — a successful evolution run settles
 * the store (resetFitnessGeneration), so there is no window to compute.
 * Pure — takes the store, never reads it.
 */
export function bucketNetScore(
  store: FitnessStore,
  bucket: FitnessBucket,
): number {
  let net = 0;
  for (const e of store.events) {
    if (e.bucket === bucket) net += e.delta;
  }
  return net;
}
