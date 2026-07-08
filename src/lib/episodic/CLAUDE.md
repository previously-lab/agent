# Episodic Memory Subsystem

## Overview

The episodic memory subsystem records, indexes, and recalls conversation history as discrete **time slices** -- one per calendar day, stored as Markdown files with YAML frontmatter. It is the L2 memory layer in Previously On's three-tier memory architecture (L0/L1 bundled at build time, L2 fetched on-demand at runtime).

The subsystem is designed around a **Flash/Pro split**: Flash (a fast, fallible DeepSeek call) handles slicing decisions, intent classification, and metadata maintenance in one round-trip per request. Pro (the main agent) performs deeper recall by reading full slice bodies when Flash finds nothing or the query requires richer context.

File storage is abstracted behind a local-filesystem vs. GitHub API switch, gated on `GITHUB_TOKEN`. All paths are under `memory/episodic/`.

## File Map

| File | Role |
|------|------|
| `types.ts` | All type definitions: `TimeSlice`, `Turn`, `SliceFrontmatter`, `SlicingSignal`, `EmotionalTone`, `SliceIndexEntry`, `MonthlyIndex`, `TagIndex`, `FlashSplitInput`/`Output`, `RecallHint`, `MismatchLogEntry` |
| `index.ts` | Barrel export -- re-exports from `manager.ts` and `slicer.ts` |
| `manager.ts` | Core CRUD: in-memory active slice, path helpers, gray-matter serialization/parsing, turn append, snapshot saves, monthly index and tag index maintenance |
| `slicer.ts` | Slicing decision engine -- single rule: time silence after 30 minutes of inactivity |
| `parallel-timeline.ts` | Topic-based index: one MD+YAML file per topic under `memory/episodic/parallel-timelines/`. Recall Agent reads only frontmatter (source pointers), never slice bodies. |
| `maintenance.ts` | Unified Flash call combining intent classification, recall scanning, and metadata updates in one LLM round-trip (DeepSeek via Vercel AI SDK). Includes retry logic and safe defaults. |
| `actions.ts` | Server actions (`"use server"`) for UI consumption: `getEpisodicState`, `getMoreSlices`, `getSliceContent`. Drives the episodic sidebar panel. |

## Key Flows

### 1. Time slice lifecycle

1. **Create** -- `createSlice()` in `manager.ts` is called when the chat route receives a message with no active slice. Derives `slice_id` from UTC date (e.g. `2026-07-07`), creates an in-memory `TimeSlice` with the first turn.
2. **Extend** -- `appendTurn()` adds subsequent turns to the in-memory slice. `saveSliceSnapshot()` writes the slice to disk as a checkpoint every N turns and on `beforeunload`.
3. **Close** -- `checkTimeSilence()` in `slicer.ts` checks whether 30 minutes have elapsed since the last turn. When `true`, `closeSlice()` in `manager.ts` sets `status: "closed"`, writes the MD file, updates `_index.json` and `tag-index.json`. The cycle repeats with a new slice.
4. **Recover** -- `tryLoadTodaySlice()` re-hydrates the active slice from disk on page refresh.

### 2. Unified Flash maintenance (per request)

1. `runUnifiedFlash()` in `maintenance.ts` builds a prompt from current slice metadata, recent turns, the new user message, and recent closed-slice summaries.
2. DeepSeek returns structured output via `flashOutput` tool call: intent classification, recall hits (up to 5 past slices with relevance scores), and metadata updates (focus/summary/decisions/open_loops/tags/tone).
3. On failure, retries once after 300ms, then falls back to safe defaults (`intent: "chat"`, `confidence: 0.3`, no updates).
4. `applyMetadataUpdates()` patches the slice object in place.

### 3. Episodic state for the UI

1. `getEpisodicState()` (server action in `actions.ts`) scans monthly indices backward, returns the most recent slice as `active` plus up to 2 more as `recent`, plus a `hasMore` flag for pagination.
2. `getMoreSlices(before)` returns slices older than the given cursor, with cursor-based pagination.
3. `getSliceContent(sliceId)` reads the full MD file, parses turns, and returns structured content for the detail view.

## Core Types

All defined in `types.ts` unless noted.

| Type | Key Fields |
|------|------------|
| `TimeSlice` | `slice_id`, `focus`, `status` (active/closed), `start`/`end`, `turns: Turn[]`, `estimatedTokens`, `closedBy: SlicingSignal` |
| `Turn` | `timestamp` (ISO 8601), `role` ("user"/"agent"), `content` |
| `SliceFrontmatter` | The YAML representation of a slice: adds `summary`, `open_loops`, `decisions`, `tags`, `related_slices`, `emotional_tone` |
| `SlicingSignal` | `"time_silence" \| "user_explicit" \| "flash_high_confidence" \| "capacity"` |
| `SliceIndexEntry` | Slim version stored in `_index.json`: `id`, `focus`, `summary`, `tags`, `status`, `start`, `open_loops`, `decisions` |
| `TopicSource` (parallel-timeline.ts) | `slice` (relative path), `turns[]`, `relevance` (0-1), `open_loops`, `decisions` |
| `TopicIndex` (parallel-timeline.ts) | `topic`, `sources: TopicSource[]`, `summary` |
| `MaintenanceOutput` (maintenance.ts) | `intent`, `confidence`, `suggested_topics`, `recall_hits[]`, `needs_metadata_update`, `metadata_updates`, `reasoning` |
| `SliceSummary` (actions.ts) | Truncated view for UI: `slice_id`, `focus`, `summary`, `start`, `status`, `open_loops`, `decisions` |

## File Layout on Disk

```
memory/episodic/
  slices/
    YYYY/
      MM/
        DD.md                   -- time slice body (YAML frontmatter + turns as ## Turn N)
        _index.json              -- monthly index of all slices in this month
  tag-index.json                 -- global tag -> slice path mapping
  parallel-timelines/
    topic-name.md               -- one per topic (YAML frontmatter: sources[], body: summary)
```

## Design Decisions

- **Flash as a conditioned reflex**: Intent, recall scanning, and metadata maintenance are combined into one LLM call per request layer to keep latency low. Flash is expected to be fallible; Pro does deeper work when Flash returns nothing.
- **Time-only slicing in M8**: Capacity checks and Flash-based continuity analysis were removed as premature optimization. The sole slicing trigger is 30 minutes of inactivity. The `SlicingSignal` type still defines `flash_high_confidence` and `capacity` variants, but they are never emitted.
- **In-memory active slice with periodic snapshots**: The slice is held in a module-level variable. It is snapshotted to disk periodically (every N turns, `beforeunload`) but not on every turn -- avoids excessive GitHub API writes. `tryLoadTodaySlice()` recovers state on refresh.
- **Gray-matter serialization**: Slices use `---` YAML frontmatter + markdown body, parsed via `gray-matter`. Turn headers follow the convention `## Turn N -- ISO_TIMESTAMP (role)`.
- **Parallel timelines decouple topic from chronology**: Time slices are chronological; parallel timelines are topic-first. The Recall Agent reads only timeline frontmatter (source pointers, not full bodies) -- cheap enough to scan many topics per request. The Core Agent decides which slices to expand via `readMemory`.
- **Dual storage backend**: Local filesystem (dev) vs. GitHub API (production) selected at import time via a `USE_GITHUB` flag. The `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in `manager.ts` delegate transparently.
- **DEMO_MODE extends scan range**: `actions.ts` checks `DEMO_MODE=true` to scan up to 48 months back instead of 1-2, supporting pre-seeded demo personas.

## Dead Code, Stubs, and TODOs

- **`freezeSliceSummary()`** in `manager.ts` is a no-op shell -- the comment says "handled by Flash via the chat route on slice close." The function exists as a hook point but does nothing.
- **`updateDynamicSummary()`** in `manager.ts` is a stub that only sets a fallback focus from the first user message if focus is empty. The comment says the real Flash call happens in the chat route.
- **`FlashSplitInput` / `FlashSplitOutput` / `RecallHint` / `MismatchLogEntry`** types in `types.ts` are defined but not referenced in any file in this directory. They may be consumed by the chat route or other subsystems.
- **`SlicingSignal` values `"flash_high_confidence"` and `"capacity"`** are never emitted -- `slicer.ts` only triggers on `"time_silence"`. `parseSlice()` in `manager.ts` hardcodes `closedBy: "user_explicit"` for any slice parsed from disk with `status: "closed"`, ignoring the actual signal that closed it.
- **`parallel-timeline.ts` has no cleanup or pruning** -- topic source entries accumulate without deduplication across runs. Stale topics are never removed.
- **Mismatch-log** (`mismatch-log.jsonl`) is described in the `MismatchLogEntry` type but no code writes or reads it anywhere in this directory.
