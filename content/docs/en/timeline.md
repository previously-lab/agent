# The Timeline

The timeline is the primary interaction surface of Previously — a single vertical scroll of your conversation history, read top-to-bottom, with the live chat at the bottom edge and the past behind you when you scroll up.

## Not a Chat List, Not a Search Bar

The timeline is the explicit alternative to two dominant UI patterns that most AI chat products adopt. It is **not** a list of conversation threads that you must manually manage, rename, delete, and search through. It is **not** a search bar where you type keywords hoping the right memory surfaces. Both of these patterns impose overhead on the human — they assume you will curate your own memory.

Previously rejects that assumption. Instead, it presents a single vertical timeline — your story as an autobiography, oldest at the top, newest at the bottom, with the live conversation happening at the very bottom edge (README.md:50).

> **Key takeaway: you do not manage conversations. You scroll through your life.**

## Three Regions, One Scroller

The page is a single vertically stacked scroll surface with three regions in order: a server-rendered hero, the memory timeline (`TimelinePanel`), and the live chat messages — all inside one `MessageScroller` (src/components/chat/CLAUDE.md). The timeline sits **above** the messages, not inside the message list. They are sibling regions in one scroll container. Scroll up to revisit the past. Scroll down to continue where you left off.

### Chronological Ordering

Data arrives newest-first from the hook and is reversed for display. The code comment at the render site is explicit: "Timeline — oldest at top → newest at bottom" (timeline-panel.tsx:142-143). Both the date groups and the slices within each group are rendered in oldest-first order.

```preview
demo: slice-file
```

## Date-Grouped UI

The visible timeline groups slices by exact calendar date. The helper `formatSliceDate` (time-slice-row.tsx:69-88) returns:

| Condition | Label |
|-----------|-------|
| Same day (diffDays 0) | "Today" |
| Previous day (diffDays 1) | "Yesterday" |
| Same year, older | `Intl.DateTimeFormat` with month + day (e.g., "June 14") |
| Cross-year | `Intl.DateTimeFormat` with year + month + day (e.g., "March 10, 2025") |

These labels are the grouping keys in `groupByDate` (timeline-panel.tsx:29-41). Each date group renders:

- **`DateGroupHeader`** — an animated header with `NumberTicker` components for year, month, and day. Locale-aware: Chinese renders as "2025 Year 11 Month 21 Day" with suffix labels; English renders as "November 21 [2025]" with the year shown only when cross-year (date-group-header.tsx).
- **`SliceTimeMarker`** — each individual slice row shows an animated HH:MM via `NumberTicker`, rendered in the viewer's browser timezone using `d.getHours()` / `d.getMinutes()` (time-slice-row.tsx:127-130).

## The Now Marker

At the very bottom of the timeline, a large animated "Now" word marks where the recorded past hands off to the present conversation (timeline-panel.tsx:191-221). The i18n key is `timeline.panel.now`.

Rendered with `TextGenerateEffect` at `text-5xl sm:text-6xl` (responsive), light weight (`font-light`), in a centered block with large top and bottom padding (`pt-24 pb-20`). This is the terminal point of the timeline: the timeline runs down and hands off here to the live chat below.

## Time-Gap Title Cards (Cold Open)

When you return to Previously after an absence and the chat is still empty, a cinematic gap title-card appears above the Now marker — a label that cuts forward from the last recorded moment to the present (timeline-panel.tsx:194-212).

The gap is computed by `getGapInfo` (timeline-panel.tsx:52-67), which buckets the elapsed time between the last slice's `start` and `Date.now()`:

| Elapsed | Renders as |
|---------|------------|
| < 5 minutes | "Moments later" |
| 1–59 minutes | "{N} minute(s) later" |
| 1–23 hours | "{N} hour(s) later" |
| 1–6 days | "{N} day(s) later" |
| 1–4 weeks | "{N} week(s) later" |
| ≥ 5 weeks | "{N} month(s) later" |

**Critical detail: there is no year unit.** A gap of roughly two years renders as "24 months later", not "2 years later". The gap is anchored on the last slice's `start`, not its end; the ≤30-minute imprecision this introduces is invisible at hour/day granularity (timeline-panel.tsx:43-51, 92).

The gap card is computed **after mount only** (inside a `useEffect`) to avoid SSR/hydration mismatch on the wall clock (timeline-panel.tsx:90-98). It is shown only when `chatEmpty` is true — meaning the live chat has no messages yet. Once you speak, the gap card disappears.

The i18n labels live in `timeline.gap.*` (messages/en.json): `moments`, `unit.minute`, `unit.hour`, `unit.day`, `unit.week`, `unit.month`, all with correct pluralisation via ICU syntax.

## Pagination: "Earlier Memories"

Scrolling upward reveals history via cursor-based pagination. An "Earlier memories" button (i18n key `timeline.panel.earlier`) sits at the top of the timeline panel. Clicking it calls `getMoreSlices(oldest.start, 10)` — loading 10 slices older than the current oldest loaded slice (use-timeline.ts:42-66).

Newer slices appear below existing ones; **older slices load in above** them, preserving the oldest-at-top invariant (timeline-panel.tsx:120-140, comment "older slices load in above"). A loading spinner replaces the button text while the request is in flight. The pagination cursor is the oldest loaded slice's `start` timestamp.

## Slice Rows: Lazy-Loaded and Expandable

Each slice in the timeline renders as a `TimeSliceRow` (time-slice-row.tsx:138-263):

- **Lazy content loading** — the full slice body is fetched on mount via `getSliceContent(slice.slice_id)`, with a spinner shown while it loads
- **Default view** — shows the first user+agent exchange (`.slice(0, 2)`), typically one user message and the agent's reply
- **Expand downward** — a "View more" button reveals later turns below the first exchange, maintaining the chronological reading direction
- **Summary caption** — the slice's YAML `summary` field renders as an italic caption below the turn content
- **Open loops and decisions** — shown as counts ("3 ongoing · 2 decided") that expand into labeled pills on click
- **Character count** — individual turns longer than 300 characters are truncated with a "Expand all ({N} chars)" button

## Two Distinct Time-Grouped Systems

There are two separate time-grouping systems in Previously that serve different audiences. Do not conflate them.

### 1. Visible UI (for you)

The on-screen timeline groups by **exact calendar date** — Today, Yesterday, or a locale-formatted date — with animated year/month/day headers and HH:MM slice markers. This is what you see on the page.

### 2. LLM Episodic Context (for the agent)

When the route assembles the system prompt for Pro, it builds a `## Episodic Memory Timeline` section via `buildTimelineEpisodicContext` (route.ts:147-216). This is a Markdown block **injected into the model's context**, not rendered on screen.

It contains:

```
### Now — Current Session
- Slice: `{slice_id}` · {N} turns
- Focus: {focus}
- Summary: {summary}
- Open loops: ["..."]
- Decisions: ["..."]
```

Followed by:

```
### Recall Results
Flash found these potentially relevant past conversations:
```

Each recall hit is bucketed by age and relevance-sorted, capped at 12 hits (`MAX_RECALL_HITS` in route.ts:170):

| Bucket Label | Days Ago | Code Range |
|---|---|---|
| "Today / This Week" | ≤ 7 | `daysAgo <= 7` |
| "This Month" | ≤ 30 | `daysAgo <= 30` |
| "A Few Months Ago" | ≤ 180 | `daysAgo <= 180` |
| "Last Year" | ≤ 365 | `daysAgo <= 365` |
| "Earlier" | > 365 | else |

Each hit line shows the `slice_id`, a relative-time label (`formatRelativeTime`), the Flash reason, and the relevance score. When Flash finds nothing, the section says so explicitly and points Pro to `memory/episodic/strands.json` for deeper exploration (route.ts:210-214).

## Data Flow

The timeline is populated through server actions:

1. **Initial load** — `getEpisodicState()` returns the most recent slice as `active`, an array of `recent` slices (with summaries and metadata), and a `hasMore` boolean
2. **Pagination** — `getMoreSlices(before: ISO timestamp, limit: 10)` fetches older slices; results are appended to the end of the `slices` array (which renders above, since the array grows at the "old" end)
3. **DEMO_MODE** — when `DEMO_MODE=true`, the scan depth expands to 48 months instead of the normal 1-2 months (src/lib/episodic/CLAUDE.md:90)

## The Atomic Unit: The Slice

Every row on the timeline represents one **slice** — a single conversation burst stored as a Markdown file at:

```
memory/episodic/slices/2025/11/21/0825.md
```

The path encodes the full timestamp: year/month/day/hour-minute. A calendar day is a directory that may hold multiple slices. A slice opens when you start talking and closes automatically after 30 minutes of silence (README.md:52-56; src/lib/episodic/CLAUDE.md:5). There is no capacity limit and no topic-shift rule — slicing is purely time-driven.

Each slice carries YAML frontmatter with structured metadata (`focus`, `summary`, `open_loops`, `decisions`, `tags`, `emotional_tone`, `status`, `start`/`end` timestamps), making it machine-readable without proprietary tooling.

## Related

- [Memory Model](/content/docs/en/memory-model) — how slices fit into the full episodic + semantic memory architecture
- [Recall](/content/docs/en/recall) — how Flash and Pro use the timeline for context retrieval
- [Architecture](/content/docs/en/architecture) — the component tree that renders the timeline alongside live messages
