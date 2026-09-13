# Chat Rendering System

## Overview

The chat rendering system pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-phase, data-evolution) through a unified stream pipeline — recall context, reasoning, tool calls, and final response — rendered inside each assistant message. The top-level container (`ChatPage`) uses `useChat` with `@ai-sdk/workflow`'s `WorkflowChatTransport`: every turn runs inside a durable Vercel Workflow run and is resumable after a dropped connection.

The home page is a single shell (v0.11) — the left time axis is persistent, and the right pane switches between chat and timeline views. The view is selected by the `?view=timeline` search param on `/` (absent = chat). The 3D timeline (`src/components/timeline-3d/`) renders inside the shell's right pane; chat ⇄ timeline is a first-class MODE switch owned by the header's segmented pill. The chat stays mounted when the timeline is open (dimmed and pointer-events-disabled) so its camera position and the live useChat stream survive the switch.

**THE CONVERSATION HAS NO SCROLL CONTAINER** (v0.12). Position is a number we own — a camera offset — and every block is an R3F billboard. See `conversation-field.tsx`, and read its header before changing anything about layout: the whole design follows from "a billboard is anchored by its top edge". The old react-virtuoso list is gone from this view entirely; nothing here imports it.

The content area is ONE unified stream: historical slice blocks above, the live turns below, older slices paged in at the window's head on request. Slice navigation never leaves the stream — a jump (search palette, recall references bar, `?at=` from the timeline) lands on the target slice's seam and plays the time-travel clock as the loading cover. On arrival, `getArrivalState` restores a still-alive newest slice's turns straight into the stream ("继续 <date> 的对话" banner) — cross-device, from the slice, not localStorage.

## Component Tree

```
ChatPage (chat-page.tsx)  ← "use client", top-level useChat container
├── Content area (one centered column)
│   ├── EmptyBriefing (empty-memory fallback only — the full-screen variant)
│   ├── UnifiedChatStream (unified-chat-stream.tsx — a thin adapter over ConversationField)
│   │   └── ConversationField (conversation-field.tsx — the renderer)
│   │       ├── [R3F Canvas, orthographic, zoom 1]
│   │       │   ├── FieldOrigin    ← the head of the loaded window ("load earlier")
│   │       │   ├── [per mounted block] <Html> billboard
│   │       │   │   ├── SliceGate        ← the boundary that closes the block
│   │       │   │   ├── HistoryTurn      ← plain-body bubbles
│   │       │   │   ├── ResumeBanner     ← "继续 <date> 的对话"
│   │       │   │   └── ChatMessage      ← live turns only
│   │       │   │       ├── HousekeepingCard  ← compact data-phase group
│   │       │   │       ├── EvolutionCard     ← data-evolution parts
│   │       │   │       ├── ThinkingSteps     ← reasoning parts
│   │       │   │       ├── PhaseIndicator    ← non-compact data-phase parts
│   │       │   │       ├── ToolRenderer      ← dispatches tool-* parts
│   │       │   │       └── MarkdownRenderer  ← text parts
│   │       │   └── [live block] <Html> billboard (grows downward)
│   │       └── StreamTimeIndicator (mobile floating "where am I in time" pill)
│   └── [time-travel cover] RelativeTimeReadout overlay (never unmounts the field)
├── [Fixed bottom bar]
│   └── ChatInput (textarea + image attachments + submit/stop/demo)
```

HistoricalChatView is gone (v0.10 final wave); the unified stream and the timeline view's right pane cover its roles.

## The field's model (read this before touching layout)

Four ideas carry the whole thing. Each one exists because its absence was a measured bug.

**1. Every block is a billboard, anchored by its TOP edge.** A block that grows grows DOWNWARD and moves nothing above it. That is why a finished history block can be measured once and frozen, and why the live turn can grow token by token underneath it without disturbing anything. The camera decides whether to follow the growth: it follows only if the reader is already at the live edge.

**2. The position is a number we own.** `offsetRef` is the world-Y of the viewport top. Inputs (wheel, pointer drag with our own inertia) write `targetRef`; a rAF eases `offsetRef` toward it. There is no `scrollTop` to be corrected under the reader, no estimated total height, no anchoring fight — the class of bug the old stack had (measured: `scrollHeight` reporting 13,471 px for ~1,000 px of content, and `scrollTop` landing 32–64 px away) cannot occur.

**3. Paging older is COMPENSATION, not anchoring.** This is the one direction idea 1 does not cover: a block arriving ABOVE the reader is exactly the case where "grows downward, moves nothing above" gives no protection. So when the block list gains blocks at its head, `relayout` moves the camera by exactly the height they add. The reader's view of what they were reading is pixel-identical, and the new conversations sit off-screen above, to be scrolled into. Measured: a 7,365 px prepend moves the visible text by **zero** pixels.

Two things make that exact, and both are easy to break:
- **A gate belongs to the block it CLOSES**, not the one it opens (`groupBlocks`). Attach the seam to the slice it opens and the seam that arrives with a new page lands inside the reader's own block, growing it by a gate's height under them.
- **Block heights are re-indexed on prepend.** `heightsRef` is indexed by block position; a prepend renumbers every block, so the array is shifted by the same amount. Otherwise each arriving block inherits the height of whichever block used to sit at its index, and the blocks the reader is looking at fall back to an estimate.

**4. Colour is a HIGHLIGHT, not an identity, and the band draws the MOMENT rather than the window.** The left band rests grey; the core line carries the brand blue until something is singled out, and then the core steps back and the picked threads light in their own palette colours. See `src/lib/timeline3d/ink.ts`.

Which threads it draws is decided by the anchor at the CENTRE of the viewport — the same one the knot is wound around — not by a ranking over everything in view (`lineUpFor` in `strand-transition.ts`, `activeAnchorIndex` in `winding.ts`). That is what lets a strand filter narrow the field without emptying the band: filtering drops CARDS, and a card still carries its whole strand set, so the bundle the highlight stands against survives the pick. Grey lines stay anonymous — the reader never needs to know which grey is which thread — and the selection is merged in and never dropped, so a highlight cannot vanish mid-scroll.

## Boundaries and the announcing gate

- **`SliceGate`** is an INTERTITLE: crossing a boundary is arriving at a new time, and the card states HOW FAR it is — "5 天前" one way, "5 天后" the other, the same interval read in both directions — over the animated time, the date and the destination's focus. It is a FIXED height (`SLICE_GATE_PX`) with the dormant and armed faces stacked absolutely inside it — if arming changed the box, arming would move every block below.
- **`FieldOrigin`** is the window's head: the same intertitle language for the one edge with no slice beyond it. It says either "the beginning of this memory" or offers the older page, and the page control lives HERE because the head is the only place where "show me earlier" is a coherent thing to ask.
- **Exactly one boundary announces at a time**, decided by `armedGate` in `field-blocks.ts`: the nearest boundary actually in view, with the origin taking precedence at the head. An earlier version kept ONE direction flag for the whole field, so a single wheel tick flipped every gate on screen at once.
- **Arm state travels as a MUTABLE OBJECT** (`GateSignal`), read by the gate's own frame loop. drei's `<Html>` mounts into a separate React root, so a prop change per crossing would re-render the portal to swap two words.
- **The band's anchor dot** (`CrossingDot` in `axis-band.tsx`) marks where the announcing boundary sits on the core line. The field publishes it through the shared `crossingRef` — the same contract the card field fills in the timeline view.

## Message Part Flow

1. `useChat` (in `ChatPage`) receives a `UIMessage` with typed `parts[]`; the field wraps each as a live item rendered by `ChatMessage`.
2. `ChatMessage.buildStream()` classifies each part in a single pass:
   - `reasoning` → merged consecutively into one `ThinkingSteps` block (streaming mode with typewriter subtitle)
   - `tool-*` → merged by `toolCallId` into a single `ToolRenderer` card
   - `data-phase` → compact phases merge by name into ONE `HousekeepingCard` checklist; phases carrying a `tools` array merge into a bridge item (`BridgeToolCard` / `BridgeHousekeepingCard`); other non-compact phases render as `PhaseIndicator`
   - `data-evolution` → its own `EvolutionCard` at the position the chunks arrive, streaming the live thinking line while running and the settled summary / mutations diff / calibration detail after
   - `text` → buffered and flushed into `MarkdownRenderer` blocks
3. Items render in natural stream order inside `AnimatePresence` for enter/exit animations.
4. The loading tips (`loading-tip.tsx`) are RETIRED (unused, kept for a content refresh) — no streaming indicator or pre-first-chunk placeholder; the input bar's stop state is the in-flight affordance.
5. `MessageActions` (copy/regenerate) render in `MessageFooter` — `ChatPage` threads `onRegenerate` to the LAST assistant message only. The input bar's stop button calls `handleStop`: aborts the stream, cancels the durable run via `POST /api/chat/<runId>/cancel` (stop means STOP — no recorded agent reply), clears the stored run id, and reports an `interaction_interrupt` signal (fire-and-forget).

## File Map

| File | Description |
|------|-------------|
| `chat-page.tsx` | Top-level `"use client"` container: `useChat` hook, `WorkflowChatTransport` wiring, the arrival verdict (run reconnect + `getArrivalState` resume gate), the stream's item model, slice-jump paging/positioning (bus + `?at=`), the viewport-slice publication for the mode switcher, sticky `ChatInput` |
| `conversation-field.tsx` | **THE RENDERER.** The camera-driven field: block layout, the eased follow, the prepend compensation, per-boundary arming, the imperative handle (`scrollToKey`/`scrollToOffset`/`scrollToBottom`). Its header is the design document; read it first |
| `unified-chat-stream.tsx` | A thin adapter over `ConversationField` — the seam between the page and the surface. It used to BE the renderer (virtuoso list, bottom-follow workaround, per-frame seam measurement); all of it is gone |
| `field-blocks.ts` + `tests/lib/chat/field-blocks.test.ts` | **Pure block model** (`src/lib/chat/`): `splitItems`, `sliceIdOf`, `groupBlocks`, `prependHeadCount`, `armedGate`, and the fixed sizes (`SLICE_GATE_PX`, `FIELD_ORIGIN_PX`). Unit-tested — this is where the layout arithmetic lives |
| `slice-gate.tsx` | The boundary between two conversations, as an intertitle. Dormant = a quiet rule; armed = direction, rolling time, date, and the destination's focus. Arm state arrives as a `GateSignal` |
| `field-origin.tsx` | The head of the loaded window — "the beginning of this memory", or the older-page control |
| `slice-seam.tsx` | The seam's shared pieces (date formatting, the gap marker). The gate renders the boundary; this module owns the interval language |
| `history-turn.tsx` | One historical turn as pure-body bubbles (no tool state) |
| `resume-banner.tsx` | The "继续 <date> 的对话" banner over a restored live slice. Extracted from the stream component so the field does not depend on it |
| `stream-time-indicator.tsx` | The transient floating time pill (mobile): top-edge, visible while scrolling, fades ~1s after stop |
| `rolling-number.tsx` | The odometer rolling-digit family (`useRollingNumber`/`RollingDigit`/`RollingField`/`RollingTime`) — the timeline wheel's central readout and the band's year labels |
| `date-stamp.tsx` | The ANIMATED date and time faces (`DateStamp`/`TimeStamp` + the pure `dateStampParts`/`timeStampParts`): the locale decides the structure, `NumberTicker` springs the parts that are numeric, and the year rolls up from twenty years back. Revived from the retired `DateGroupHeader`/`SliceTimeMarker` — it is what the gate and the window's head render |
| `relative-time.tsx` | `relativeBetween` (the app's one interval humanizer) and `RelativeStamp` — the "5 天前" / "5 天后" phrase, shared by the travel clock and the gate. A boundary's phrase is anchored to the OTHER SIDE of the boundary; the travel clock's is anchored to now |
| `mode-switch-gesture.tsx` | The card-style left drag that switches chat → timeline. UNWIRED (swipe mode switch off for now), kept for reuse; pure logic in `src/lib/chat/mode-gesture.ts` |
| `error-banner.tsx` | The red chat-error banner with expandable full detail |
| `chat-skeleton.tsx` | The loading faces (`ChatPageSkeleton`, `ChatStreamSkeleton`, `ChatInputSkeleton`), shared with the route-level `loading.tsx` so the handover is invisible |
| `chat-message.tsx` | Per-message renderer: `buildStream` classifies parts into reasoning/text/tool/phase |
| `chat-input.tsx` | Textarea with image attachments (paste/drag-drop/file picker), auto-resize, submit/stop buttons, demo trigger |
| `phase-indicator.tsx` | Reusable expandable header bar: `streaming` (typewriter subtitle, elapsed timer) and `static` (manual expand, chevron). Used by ThinkingSteps, HousekeepingCard, RecallToolRenderer, and non-compact data-phase items |
| `housekeeping-card.tsx` | The grouped prep card: compact data-phase checklist (slice / analyze / tags / context / strands) |
| `bridge-tools-card.tsx` | One ToolLayout row per CLI tool event, plus the CLI's rolling narration line, under a brand-tinted header |
| `bridge-housekeeping-card.tsx` | The whole housekeeping phase as one streaming surface: live narration + CLI tool rows + the kernel's deterministic wrap-up checklist |
| `evolution-card.tsx` | The card-evolution card (Previously Agent): streaming live thinking, then the settled headline and the calibration detail |
| `thinking.tsx` | Reasoning display: Brain icon, streaming subtitle, elapsed timer, expandable Markdown |
| `tool-renderer.tsx` | Dispatch hub: maps `toolName` to specific renderers; extracts `ToolRenderState` from raw SDK state |
| `tool-layout.tsx` | Shared expandable tool card: status icon, name, summary, meta, CSS grid-animated details panel |
| `tool-renderers/` | Per-tool: `recall.tsx`, `memory-tool.tsx`, `list-files.tsx`, `current-time.tsx`, `web-search.tsx`, `default.tsx` |
| `time-display.tsx` | The shared time readout (`NumberTicker` per field) |
| `empty-briefing.tsx` | The arrival briefing in the timeline's slice-card skin. Two seats: `variant="card"` rides the stream's tail; the full-screen form only for an empty, slice-less memory. Takes the resolved `identity` as a prop |
| `cognition-popover.tsx` | Per-turn agent thoughts dialog (lazy-loaded Markdown) |
| `loading-tip.tsx` | RETIRED (unused, kept for a content refresh) |
| `markdown.tsx` / `code-block.tsx` | Markdown rendering (react-markdown + GFM + highlight), with custom per-element styling |
| `message-actions.tsx` | Copy-to-clipboard and Regenerate, shown on hover |
| `file-name-pill.tsx` | File path badge with code-vs-text icon detection |
| `theme-toggle.tsx` / `locale-toggle.tsx` | Toolbar buttons (theme cycle, UI language) |

## Shared Primitives

- **PhaseIndicator**: universal expandable header bar, two modes, one render structure. Used by ThinkingSteps, HousekeepingCard, RecallToolRenderer, and non-compact data-phase items.
- **ToolLayout**: universal expandable tool card handling five states (running, completed, error, interrupted, denied). Every tool renderer delegates to it.

## Design Decisions

- **Arrival = in-flight work, a LIVE slice, or the briefing** (v0.10 §2): on mount, `ChatPage` asks the server TWO things before `Inner`/`useChat` mount — whether the persisted run is still pending/running (`isChatRunActive`) and whether the newest slice is still inside the idle gap (`getArrivalState`). A live run → restore from the localStorage stash + `resume`. An alive slice (and no live run) → its turns re-enter the message stream from the SLICE itself (cross-device), under a "继续 <date> 的对话" banner. Anything else → the arrival briefing. A terminal/absent run drops the stash: completed conversation is restored from slices, never from localStorage.
- **The page streams before it can be slow.** The config read lives in its own async boundary inside the page's `<Suspense>`, and `[locale]/loading.tsx` gives the route an instant placeholder — both render `ChatStreamSkeleton`, so the reader sees the conversation's own loading face from ~270 ms and the swap is invisible.
- **The field owns the position, so nothing else may.** Every programmatic move goes through `setTarget` (clamping + follow state + direction together), and `scrollToKey` does NOT fetch: the caller pages until the key exists and calls again. `scrollToKey` also remembers an unloaded target and lands when it appears — the jump caller scrolls on the frame after paging resolves, which is before React has committed the new blocks.
- **The imperative handle is a ref object, not a component ref.** `anchorsRef`/`progressRef`/`crossingRef`/`fieldApiRef` are all `MutableRefObject` handshakes; this codebase has no `forwardRef`/`useImperativeHandle` anywhere.
- **Paging is asked for, never inferred.** There is deliberately no scroll-position trigger: an earlier version fired at `target <= LOAD_OLDER_PX` from an effect keyed on the mounted count, and the mounted count changes while the first measurement pass settles, so arriving alone paged history in. A slice read is a repository call in production.
- **`<Html>` cuts React context.** Every billboard wraps its children in `NextIntlClientProvider`, and the field's own origin does too. This is required, not defensive — see the note in `frame-card.tsx`.
- **Three-layer separation**: `ChatPage` owns orchestration, `UnifiedChatStream` is the adapter, `ConversationField` renders, and the item model (`src/lib/chat/stream-items.ts`) plus the block model (`src/lib/chat/field-blocks.ts`) are pure and unit-tested.
- **Timeline as a focal wheel** (the `?view=timeline` view): a full-height column of the slice catalog whose centre row is enlarged; scrolling up goes into the past. Content loads only on explicit click — browsing costs zero requests, which matters because slice reads are repository calls in production.
- **Mode switch = search param, context carried both ways**: the chat publishes the slice at the top of its viewport (`src/lib/chat/viewport-slice.ts`) so the timeline opens docked at what the reader was reading, and the timeline returns through `/?at=<sliceId>` — consumed once, then stripped so a refresh never re-jumps.
- **Navigation = time travel, landing IN the stream**: a slice jump overlays `RelativeTimeReadout` (the field beneath never unmounts), pages the target into the stream while the clock rolls, then lands on its seam. A miss (catalog exhausted) is an honest error toast, never a fake landing. Submitting a message cancels any in-flight transition and snaps back to the present.
- **Shared slice-card language**: the travel cover and the empty briefing share one visual identity (`FrameCard`: ring, soft shadow, hairline separators, mono eyebrow row with the primary square marker).
- **ChatInput owns its images** via `useImageAttachments`: paste, drag-drop and file picker funnel into the same state, previewed as removable thumbnails.
- **MarkdownRenderer is not `prose`-only**: custom per-element styles (tables, links, code blocks) instead of relying solely on Tailwind typography.
