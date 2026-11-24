# Episodic Memory Subsystem

## Overview

The episodic memory subsystem records, indexes, and recalls conversation history as discrete **time slices** -- one per real conversation session (closed by slice age — 30 min from slice start, context loss, or a 50-turn safety cap), stored as Markdown files with YAML frontmatter. A calendar day is a *directory* that may hold multiple slice files. Only the identity constitution (`identity/agent/`) is bundled at build time; all episodic data is fetched on-demand at runtime.

All internal sub-agent calls — recall search, the unified turn analyze (tag extraction + semantic hint + intent + slice marking), belief evolution (the Previously Agent), strand consolidation, mark backfill — run on the MAIN model through the shared sub-agent runner (`src/lib/agents/sub-agent-runner.ts`, thinking ON at low effort, shared `SHARED_SUBAGENT_BASE` prompt prefix). Single model: everything runs on the selected model — the old worker tier is gone. The main model handles user-facing chat. The core agent only reads memory; writes to tags/strands happen mechanically in the housekeeping step.

File storage is abstracted behind a local-filesystem vs. GitHub API switch, gated on `GITHUB_TOKEN`. Original conversation records live only under `memory/records/`; semantic documents and evolution data use their respective `memory/` subtrees. The retired `memory/episodic/slices/` tree is never enumerated, read, or written at runtime. `scripts/migrate-records.mjs` provides an explicit, dry-run-first offline copy path and blocks conflicting slices instead of merging them.

## File Map

| File | Role |
|------|------|
| `types.ts` | All type definitions: `TimeSlice`, `Turn`, `SliceFrontmatter`, `SlicingSignal`, `EmotionalTone`, `SliceIndexEntry`, `MonthlyIndex`, `StrandIndex` |
| `index.ts` | Barrel export -- re-exports from `manager.ts` and `slicer.ts` |
| `manager.ts` | Core CRUD: in-memory active slice, path helpers, gray-matter serialization/parsing, turn append, snapshot saves, monthly index and tag index maintenance, previously.md I/O |
| `slicer.ts` | Slicing decision engine — slice age cap (30 min from slice start) |
| `maintenance.ts` | Deprecated v1 module — retained as a stub. Sub-agent calls now live in `flash/previously-agent.ts` and `flash/turn-analyzer.ts`; original-conversation recollection lives in `../agents/scenario-recall.ts`. |
| `actions.ts` | Server actions (`"use server"`) for UI consumption: `getEpisodicState`, `getTimelineCatalog` (full catalog), `getSlicePageWithContent` (catalog-derived cursor pagination WITH turns — v0.10 unified message flow), `getArrivalState` (resume-vs-briefing gate reusing `slicing.idleGapMinutes`), `getSliceContent` (single-slice detail for /timeline and search jumps), previously/agent-timeline readers. |
| `turn-parser.ts` | Pure functions to parse core.md into frontmatter + parsed turns, apply range filters, reassemble filtered slices |
| `../agents/scenario-recall.ts` | Independent original-conversation recollection colleague (main model via the shared runner). The main agent reads semantic documents directly; this colleague navigates record focus/summary metadata, searches candidates with continuable cursors, reads bounded original-turn views, and returns only host-verified verbatim evidence. Navigation metadata and unverified narrative never become original evidence. |
| `flash/turn-analyzer.ts` | Turn analysis and slice marking. Evolution scheduling follows the reflection plan. |
| `flash/global-timeline.ts` | Global timeline file aggregating all slice summaries |
| `flash/previously-agent.ts` | The user-model pass can evaluate the direction and edit individual card entries. Changes use validated mutations. An interrupted pass retains accepted mutations. Allowlisted SOP edits require a full read basis. |
| `previously-format.ts` | previously.md format — v3 archive (read-only history) + v5 user card (Identity / Past = profile paragraph + anchor facts / Now = agent-expired hooks). Legacy Horizon sections remain readable/writable at the storage layer, but the evolution agent no longer exposes Horizon mutations: commitments, dates and lifecycle belong to the authoritative task ledger and tasks/ cases. The old Self-model section is gone from the WRITER — patterns live in the direction Portrait now — but parseCard still reads it on legacy cards (the migration source) |
| `card-session.ts` | The mutation session behind the agent's write tools — in-memory CardDocument + per-entry validated mutations (`addNow` / `updatePastProfile` / …), loop brake (repeated identical rejections escalate → force-apply/skip), substance comparison. Pure, no I/O; deliberately no task/Horizon mutation surface |
| `flash/backfill-marks.ts` | Opportunistic dry-slice remediation — on a close boundary, a sub-agent (main model via the shared runner) fills focus/summary for up to 3 `needs_marking` slices, inside the turn's batch |
| `timeline/` | Canonical catalog (`store.ts`: `timeline/index.json` + upsert), `weave.ts` projection reconcile ("slices are truth, timeline is a projection"), `render.ts` pointer lines (incl. `sliceLineWithTime`), `enumerate.ts` repo enumeration (default-branch aware) |
| `io-helpers.ts` | I/O wrappers delegating to demo-fs, GitHub API, or local FS. Batching is an EXPLICIT `WriteBatch` object (`createBatch()` → thread through I/O calls → `flushBatch(batch, msg)`) — never module-global, so concurrent turns in one process can't flush each other's writes. A failed flush keeps the queue for retry. Local-backend writes additionally record a best-effort git commit when the memory root is a git repo (see `local-git.ts`) |
| `local-git.ts` | Best-effort git ledger for the local backend (isomorphic-git, no git binary needed): bare `fsWriteFile` = one commit, `flushBatch` = one commit for the batch. The filesystem stays the source of truth — commit failures are warned and swallowed, and the layer is inert when the memory root has no `.git` |
| `slice-mutex.ts` | In-process per-sliceId async mutex (`withSliceLock`) serializing housekeeping/finalizeTurn on the same slice; acquired inside a single step only |
| `turn-merge.ts` | `mergeTurnsWithRemote` — pure append-only turn merge used by finalizeTurn's write-conflict self-heal (re-read remote core.md, append missing turns by turnId, retry commit ≤ 2×) |
| `rework-signal.ts` | Best-effort audit observations for legacy recall and UI interactions. Native dialogue derives source-reference observations from work-scoped receipts. These record which sources were used. They do not score quality or schedule profile updates. |
| `strand-files.ts` | Topic-home (主题之家) layer — one `docs/topic/<名字>.md` per strand in the v0.15 document notation (three-field frontmatter + 截至块 + dated entry stream; entries are 动态 / 名录 prose), one-to-one with strands.json keys. LEGACY `memory/episodic/strands/<name>.md` files are a READ-ONLY fallback (converted in memory) until the migration script runs; new writes land in `docs/topic/` only. Read by recall (listStrands carries truncated summaries, readStrand the full text) for SEMANTIC strand matching; written by the librarian and by document writers (名录 entries). Missing dir/file degrades to the bare index |
| `doc-lock.ts` | Per-document lock (`withDocLock` — the `withSliceLock("doc:<文件名>")` keyed mutex, design §4.3) + `updateDocUnderLock`: locked fresh-read → pure mutation (src/lib/docs ops) → name validation → batch write. The lock is held inside a single write step only |
| `flash/librarian.ts` | The librarian (topic-home maintenance, v0.15 §3.2) + the scribe (书记段, §3.1/§3.6). Librarian: invoked at slice close, judges FOR ITSELF whether a touched home deserves an entry — NO semantic gates (the old ≥5-slices / 7-day-cooldown / ≤10-per-pass thresholds are deleted, axiom D), empty runs are legal; writer-is-reader is structural (the closed slice + full home texts enter the prompt BEFORE the call; the model returns write-intents engineering applies through the docs pure ops under the doc lock); evidence slice ids are stamped mechanically. Also owns: merge fallout (merged-from homes get a dated 作废 entry + `void`), 名录 directory entries (doc open/close → same-batch home entry), and the `[doc-marker]` mailbox contract. Scribe: picks up sediment/task markers from a slice's agent.md → docs/research, docs/<entityKind>/, docs/task/ (date anchors stamped mechanically), records `[doc-scribe]` lines so markers never double-write |
| `flash/doc-research.ts` | Background research/hypothesis pass (v0.15 §3.4/§3.5) — the design's DEGRADED form (the real independent background run needs the v0.11 §10 groundwork): one boundary-triggered function, driven ONLY by user "question" markers (no automatic research, no scheduled re-thinking), with read tools (readDoc / readTopicHome / readSlice) for cross-slice digging. Writes docs/research + docs/hypothesis through validated intents under the doc lock; a hypothesis without a falsification condition is refused |
| `../evolution/` | `store.ts` reads and writes the live user model and capability SOPs. `direction-agent.ts` validates portrait and hypothesis changes, applies expiry, and renders the direction for the main agent. |

## Key Flows

### 1. Time slice lifecycle

1. **Create** — `createSlice()` in `manager.ts` is called when the chat route receives a message with no active slice (or after context loss/close). Derives `slice_id` from the UTC date+time of the first message (e.g. `2026-07-07-1558`), creates an in-memory `TimeSlice` with the first turn.
2. **Extend** — `appendTurn()` adds subsequent turns to the in-memory slice. `saveSliceSnapshot()` writes the slice to disk as a checkpoint every N turns and on `beforeunload`.
3. **Close** — Triggered by: slice age cap (30 min from slice start), context loss (page refresh / device switch), or turn count cap (safety net). `closeSlice()` sets `status: "closed"`, writes the MD file, updates `_index.json` and `strands.json`. The cycle repeats with a new slice.
4. **Recover** — `tryLoadTodaySlice()` scans today's canonical records directory (`memory/records/YYYY/MM/DD/`) and re-hydrates the most recent slice still marked `active` on page refresh.

### 2. Turn analyze (per turn, in housekeeping)

1. `housekeeping` first decides the slice lifecycle (pure — continue / close / create), then calls `analyzeTurn` (main model via the shared runner, thinking ON at low effort) ONCE with the user message + existing strand names + (when closing) the closing slice's turns.
2. The call returns: 0-5 message tags (reusing existing tags across languages), a semantic hint (which existing strands the message relates to), the user's intent, and — only when a slice is closing — its `focus` / `summary` / refined `tags` / `emotional_tone`.
3. The close marking is applied to the closing slice BEFORE `closeSlice` persists it, so the timeline and monthly index carry real descriptions.
4. Message tags are written to `slice.tags` and woven into `strands.json` via `updateStrands()` during the snapshot save.

### 3. Episodic state for the UI

1. `getEpisodicState()` (server action in `actions.ts`) scans monthly indices backward, returns the most recent slice as `active` plus up to 2 more as `recent`, plus a `hasMore` flag for pagination.
2. `getSlicePageWithContent(before, limit)` pages the full timeline catalog (`timeline/index.json`) backwards from the `before` cursor, filling each slice's turns in the same request — the scroll-back channel of the unified message flow (v0.10). `getArrivalState()` decides resume-vs-briefing on arrival using `slicing.idleGapMinutes`.
3. `getSliceContent(sliceId)` reads the full MD file, parses turns, and returns structured content for the detail view.

### 4. Card evolution

1. The reflection plan evaluates fresh material, conversation boundaries, date rollover and due agenda items. HQ can run `evolveProfile` over the raw turns in scope. Explicit user instructions have a separate memory-update path. Neither path consumes a fitness score.
1b. The direction pass evaluates confirmed preferences and durable observations. Its optional pool holds up to ten falsifiable interpretations, with no replenishment target. An isolated question about memory establishes no enduring user motive. A guess does not set the precision or breadth of a field lookup. Supported guesses may be promoted, refuted guesses removed, and those still unverified after four slices expire. An empty pool and an unchanged profile are valid outcomes.
2. There is NO mechanical card pass: Now expiry and card caps are the agent's decisions, enforced inside its write tools. The time context carries the user-local date and Now ages. Task due/check dates are projected separately from the authoritative task ledger; the card pass does not review Horizon commitments.
3. The Previously Agent edits the card through validated entry mutations. A pass that omits its structured finish retains accepted changes and marks the card partial. Malformed entries remain repairable through the same tools.
4. The serialized result is written back only when the card's substance changed (stamps ignored) — only the live `people/user/index.md`. Historical per-slice snapshots remain readable; new snapshots are not produced.

## Core Types

All defined in `types.ts` unless noted.

| Type | Key Fields |
|------|------------|
| `TimeSlice` | `slice_id`, `focus`, `status` (active/closed), `start`/`end`, `turns: Turn[]`, `estimatedTokens`, `closedBy: SlicingSignal`, optional `continuesFrom` (checkpoint link) |
| `Turn` | `timestamp` (ISO 8601), `role` ("user"/"agent"), `content`, optional `turnId` (6-char base64url) |
| `SliceFrontmatter` | The YAML representation of a slice: adds `summary`, `open_loops`, `decisions`, `tags`, `related_slices`, `emotional_tone`, `continues_from` |
| `SlicingSignal` | `"time_cap" \| "time_silence" (legacy) \| "user_explicit" \| "capacity" \| "context_lost" (legacy — no longer emitted) \| "idle_gap"` |
| `SliceIndexEntry` | Slim version stored in `_index.json`: `id`, `focus`, `summary`, `tags`, `status`, `start`, `open_loops`, `decisions` |
| `SliceSummary` (actions.ts) | Truncated view for UI: `slice_id`, `focus`, `summary`, `start`, `status`, `open_loops`, `decisions` |

## File Layout on Disk

```
memory/records/
  YYYY/
    MM/
      DD/
        HHMM/
          core.md               -- original conversation (YAML frontmatter + turns)
          agent.md              -- agent cognition log (+ the [doc-marker] mailbox)
          previously.md         -- historical user-card snapshot (read-only; no new files)
          works/                -- immutable full private dialogue work results linked from agent.md
memory/docs/                    -- the v0.15 document system (see src/lib/docs/CLAUDE.md)
  topic/<名字>.md               -- topic homes (主题之家): one per strand
  research/ hypothesis/ task/   -- L3 working documents (scribe + research pass)
  event/ person/ object/ place/ org/  -- L2 entity documents
```

`memory/records/` is the sole original-record root. Runtime readers enumerate
this tree directly; no monthly index, global timeline projection, or retired
slices-root fallback participates in reads or writes.

The live card and direction share `memory/people/user/index.md`. Capability SOPs live under `memory/self/`. Historical direction and playbook files may still exist in older archives. There is no fitness-event store.

**Strands.** A slice carries `tags` (keywords). A **strand** is a keyword woven
through all the slices that carry it — one entry in `strands.json` maps a strand
to its slice paths, i.e. "the whole history of that thing" across time. It's the
thin, lossless semantic-memory layer over the episodic slices. Tags are extracted
by the turn analyzer in the housekeeping step and woven into strands at snapshot time.

On top of the index sit the **topic homes** (`memory/docs/topic/<名字>.md`, see
`strand-files.ts`): one v0.15 document per strand — 截至块 + dated entry stream
(动态 and 名录 prose), one-to-one with the strands.json key. The recall
sub-agent reads them for semantic strand matching — `listStrands` carries a
truncated one-line summary per described strand, `readStrand` the full text —
so a question phrased with synonyms or in another language can still find the
right thread. Old memory roots without any homes degrade to the bare keyword
index; LEGACY `strands/<name>.md` entity files are read as a fallback and
converted in memory until the one-shot migration
(`scripts/migrate-strands-to-docs.mjs`) moves them. The **librarian**
(`flash/librarian.ts`) is the home's maintainer: invoked at every slice-close
boundary, it reads the closed slice and the touched homes and judges whether
anything is worth an entry — there are NO semantic thresholds (the old
≥5-new-slices / 7-day-cooldown / ≤10-per-pass gates were deleted per v0.15
axiom D); an empty run is a legal outcome, and cost discipline comes from the
trigger's rarity (close boundaries only) plus the engineering fuses (sub-agent
step cap + timeout). When the merge machinery collapses a strand, the
merged-from home gets a dated 作废 entry and `status: void` — it is never
deleted. Document writers (the scribe, the research pass) append 名录 entries
to a home in the same WriteBatch as the document they open/close. All document
writes go through the per-doc lock (`doc-lock.ts`) and stamp their triggering
slice id as evidence mechanically.

## Design Decisions

- **Tag extraction in housekeeping**: A quick low-effort sub-agent call (main model via the shared runner) extracts tags from each user message. Existing tags are preferred to encourage cross-language semantic merging (e.g., "self-evolution" and "自我进化" reuse the same tag).
- **The history window is the client's conversation**: the old "client-history mismatch → rebuild from the slice" mechanism is retired. It compared the client-sent history against the slice on disk and preferred the disk copy when they differed, which stopped being a safeguard once the conversation flow stopped writing: the summary stream appends the record afterwards and records selectively, so the record is *expected* to lag the conversation — the check mostly detected that lag and answered it with an older window. The old `"context_lost"` CLOSE signal stays legacy-only — kept in the `SlicingSignal` union so historical slices still parse and seam-classify as boundaries, but never emitted.
- **Main agent reads only**: The main agent never modifies previously.md. The Previously Agent (main model via the shared runner) edits the card through validated mutation tools; mechanical writes (slice tags, strands) happen in housekeeping and finalizeTurn. Card evolution runs INLINE in the housekeeping step, gated by the analyzer's `evolve_card.worth` judgment (a legacy-format card forces a run).
- **Pure time-based slicing with idle-gap close**: The primary slicing triggers are slice age (30 min from slice start, `"time_cap"`) and idle gap (30 min since the last turn, `"idle_gap"`). Turn count cap is a pure safety net (`"capacity"`). `time_cap`/`capacity` are autosave CHECKPOINTS of the same conversation — the new slice links back via `continuesFrom` and carries the closed slice's last 10 turns as a frozen history prefix; `idle_gap` is a genuine conversation boundary (no link, no carry-over); a client-history mismatch is not a slicing trigger at all (the mechanism is retired — see above). `"time_silence"` and `"context_lost"` are legacy `closed_by` values kept for historical slices.
- **In-memory active slice with periodic snapshots**: The slice is held in a module-level variable. It is snapshotted to disk periodically (every N turns, `beforeunload`) but not on every turn -- avoids excessive GitHub API writes. `tryLoadTodaySlice()` recovers state on refresh.
- **Gray-matter serialization**: Slices use `---` YAML frontmatter + markdown body, parsed via `gray-matter`. Turn headers follow the convention `## Turn {id} — ISO_TIMESTAMP (role)`. New public dialogue HTML is stored in the original assistant turn body in `core.md`. Historical views restore the verified bytes in the existing sandbox; model transcripts use the prose view. The sidecar reader remains for older records.
- **Dual storage backend**: Local filesystem (dev) vs. GitHub API (production) selected at import time via a `USE_GITHUB` flag. The `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in `io-helpers.ts` delegate transparently.
- **Demo mode extends scan range**: with the demo data source (`STORAGE=demo`), `actions.ts` scans up to 48 months back instead of 1-2, supporting pre-seeded demo personas.

## Known Limitations

- **Turn-header collision**: a message body containing a line shaped like `## Turn {id} — ISO (role)` splits slice parsing incorrectly (pinned by a guard test in `manager.test.ts`).
- **Topic homes are boundary-maintained, never per turn**: the librarian runs only at slice close, so a brand-new strand carries no home until the next boundary — and the librarian may legitimately judge a young thread not worth a home yet (there is no threshold forcing one). Until the reply segment (v0.11) emits `[doc-marker]` lines, the scribe/research passes are no-ops in production — the mailbox contract is implemented and tested, the producer is not.
- **The background research pass is the degraded form**: it rides the housekeeping tail at close boundaries instead of running as an independent durable run (that needs the v0.11 §10 groundwork); its results surface only through the documents it writes.
