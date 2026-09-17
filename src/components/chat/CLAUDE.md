# Chat Rendering System

## Overview

The chat rendering system pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-phase, data-evolution) through a unified stream pipeline — recall context, reasoning, tool calls, and final response — rendered inside each assistant message. The top-level container (`ChatPage`) uses `useChat` with `@ai-sdk/workflow`'s `WorkflowChatTransport`: every turn runs inside a durable Vercel Workflow run and is resumable after a dropped connection.

The home page is a single shell — the left time axis is persistent, and the right pane shows the conversation or the card field depending on the RUNG. There is no view mode: `?z=<rung>` names the rung (absent = `conversation`) and `src/lib/chat/deep-link.ts` owns the parsing. The card field (`src/components/timeline-3d/`) renders inside the shell's right pane at slice/day/week; the header's segmented pill is gone and the board bar (`shell/board-bar.tsx`, top centre) is the only control that moves along the ladder — it holds the zoom lens and the strand selector, which used to sit on the 24-32px time rail. The conversation stream stays mounted at every rung (its content held at `opacity-0` + `inert`) so its scroll position and the live useChat stream survive — and its COMPOSER stays interactive, taking a COMPACT form (`composer-host.tsx` + `chat-input.tsx`'s `collapsed`) rather than disappearing.

**THE CARD FIELD PAGES ONLY WHEN ASKED.** Its window head (`FieldOrigin`, via `origin-row.tsx`) is the only thing that loads an older page. Two automatic triggers were removed: a 320px top-zone edge trigger, which made the head unreachable — every approach pulled another page in, so the control moved away from the reader walking toward it — and a 900ms fill pass, which filled the screen before anyone had decided they wanted more. A page request is a repository read in production.

**THE CONVERSATION IS A DOM SCROLLER AGAIN** (v0.11 §13/§14.5). R3F renders only what has already happened — the closed time slices; the conversation in flight (new turns + the streaming reply) is plain DOM: selectable, copyable, screen-reader readable, scrolled by the browser's own wheel/touch/keyboard. The R3F conversation field (`conversation-field.tsx`) is deleted; `unified-chat-stream.tsx` is the surface, and its header documents which of the field's guarantees survived the move (windowed mounting, prepend compensation, the live-edge pin, the one-writer band feed).

The content area is ONE unified stream: historical slice blocks above, the live turns below, older slices paged in at the window's head on request. Slice navigation never leaves the stream — a jump (search palette, recall references bar, `?at=` from the timeline) lands on the target slice's seam and plays the time-travel clock as the loading cover. On arrival, `getArrivalState` restores a still-alive newest slice's turns straight into the stream ("继续 <date> 的对话" banner) — cross-device, from the slice, not localStorage.

## Component Tree

```
ChatPage (chat-page.tsx)  ← "use client", top-level useChat container
├── Content area (one centered column)
│   ├── EmptyBriefing (empty-memory fallback only — the full-screen variant)
│   ├── UnifiedChatStream (unified-chat-stream.tsx — THE DOM SURFACE: native
│   │   scroll container + windowed mounting, offsets from lib/chat/stream-layout)
│   │   ├── FieldOrigin    ← the head of the loaded window ("load earlier")
│   │   ├── SliceSeam      ← the boundary between two slices (hairline / date pill)
│   │   ├── HistoryTurn    ← plain-body bubbles
│   │   ├── ResumeBanner   ← "继续 <date> 的对话"
│   │   ├── ChatMessage    ← live turns only
│   │   │   ├── HousekeepingCard  ← compact data-phase group
│   │   │   ├── EvolutionCard     ← data-evolution parts
│   │   │   ├── ThinkingSteps     ← reasoning parts
│   │   │   ├── PhaseIndicator    ← non-compact data-phase parts
│   │   │   ├── ToolRenderer      ← dispatches tool-* parts
│   │   │   └── MarkdownRenderer  ← text parts
│   │   └── StreamTimeIndicator (mobile floating "where am I in time" pill)
│   └── [time-travel cover] RelativeTimeReadout overlay (never unmounts the stream)
├── [Floating composer] — ComposerHost positions it; it reports its height up to the SHELL, which hands it back to BOTH surfaces as an inset (the card field floats over the same foot). The pane reserves nothing: content runs under the chrome and comes to rest clear of it.
│   └── ChatInput (two forms: full = textarea + toolbar, compact = one row)
```

HistoricalChatView is gone (v0.10 final wave); the unified stream and the timeline view's right pane cover its roles.

## The stream's model (read this before touching layout)

Three ideas carry the DOM surface. Each one exists because its absence was a measured bug — the first two are inherited from the R3F field that preceded it, restated for a native scroller.

**1. Only the visible rows exist.** `lib/chat/stream-layout.ts` keeps the offset table: a measured height per item KEY (a prepend renumbers indices, so the height travels with the row, never with its position), an estimate until the row mounts. The mounted window is the viewport plus ~one screen of overscan. A long conversation mounts a handful of rows.

**2. Paging older is COMPENSATION, not anchoring.** A page arriving ABOVE the reader is the one case a native scroller gets wrong on its own. When items land at the head, the stream shifts `scrollTop` by exactly the height they add — estimates first, then each newly-mounted row's real height as a second correction (a row re-measuring above the viewport top shifts `scrollTop` by the delta). The reader's view of what they were reading is pixel-identical. `overflow-anchor: none` on the scroller keeps the browser's own anchoring out of it: two compensations fighting was the old stack's measured bug (`scrollHeight` reporting 13,471 px for ~1,000 px of real content; `scrollTop` landing 32–64 px away from where it was set).

**3. The live edge is a PIN, not a trigger.** The reader is either following (parked at the bottom) or not. Growth pins the scroll to the tail only while following; scrolling away releases the pin, scrolling back re-arms it, and sending a message re-pins deliberately. A reader walking history is never yanked by the reply being written below.

**4. Colour is a HIGHLIGHT, not an identity, and the band draws the MOMENT rather than the window.** The left band rests grey; the core line carries the brand blue until something is singled out, and then the core steps back and the picked threads light in their own palette colours. See `src/lib/timeline3d/ink.ts`.

Which threads it draws is decided by the anchor at the CENTRE of the viewport — the same one the knot is wound around — not by a ranking over everything in view (`lineUpFor` in `strand-transition.ts`, `activeAnchorIndex` in `winding.ts`). That is what lets a strand filter narrow the field without emptying the band: filtering drops CARDS, and a card still carries its whole strand set, so the bundle the highlight stands against survives the pick. Grey lines stay anonymous — the reader never needs to know which grey is which thread — and the selection is merged in and never dropped, so a highlight cannot vanish mid-scroll.

## Boundaries: gates in the timeline, a head in the stream

- **`SliceGate`** (timeline only, since v0.11 §14.5) is an INTERTITLE: crossing a boundary is arriving at a new time, and the card states HOW FAR it is — "5 天前" one way, "5 天后" the other — over the animated time, the date and the destination's focus. It is a FIXED height (`SLICE_GATE_PX`) with the dormant and armed faces stacked absolutely inside it — if arming changed the box, arming would move every block below. The DOM stream renders the plain `SliceSeam` instead (hairline checkpoint / date-pill boundary): the gate's announcing behaviour belongs to the fields that have a camera to read it with.
- **`FieldOrigin`** is the window's head in BOTH surfaces: the same intertitle language for the one edge with no slice beyond it. It says either "the beginning of this memory" or offers the older page, and the page control lives HERE because the head is the only place where "show me earlier" is a coherent thing to ask. In the DOM stream it arms when `scrollTop` is inside the head region — the same mutable `GateSignal`, driven by a scroll position instead of a camera.
- **Arm state travels as a MUTABLE OBJECT** (`GateSignal`), read by the boundary's own frame loop — a prop change per crossing would re-render the region to swap two words.
- **The band feed has ONE WRITER.** The stream publishes progress and block anchors through the shared `FieldFeed` (`lib/timeline3d/field-feed.ts`) and consumes its seek requests — but only while it OWNS the pane: the stream stays mounted behind the timeline, so the shell hands out a lease rather than letting both write. See the module header for why four refs with four private ownership rules was the bug. The stream publishes no `crossing` mark — it has no announcing gate.

## Message Part Flow

1. `useChat` (in `ChatPage`) receives a `UIMessage` with typed `parts[]`; the stream wraps each as a live item rendered by `ChatMessage`.
2. `ChatMessage.buildStream()` classifies each part in a single pass:
   - `reasoning` → merged consecutively into one `ThinkingSteps` block (streaming mode with typewriter subtitle)
   - `tool-*` → merged by `toolCallId` into a single `ToolRenderer` card
   - `data-phase` → compact phases merge by name into ONE `HousekeepingCard` checklist; phases carrying a `tools` array merge into a bridge item (`BridgeToolCard` / `BridgeHousekeepingCard`); other non-compact phases render as `PhaseIndicator`
   - `data-evolution` → its own `EvolutionCard` at the position the chunks arrive, streaming the live thinking line while running and the settled summary / mutations diff / calibration detail after. ChatPage ALSO republishes each newly-arrived frame onto the evolution-activity bus (`src/lib/chat/evolution-activity.ts`) — the shell subscribes there to drive the companion pod (button breathing + achievement toast); the card and the pod are independent surfaces until M3
   - `text` → buffered and flushed into `MarkdownRenderer` blocks
3. Items render in natural stream order inside `AnimatePresence` for enter/exit animations.
4. The loading tips (`loading-tip.tsx`) are RETIRED (unused, kept for a content refresh) — no streaming indicator or pre-first-chunk placeholder; the input bar's stop state is the in-flight affordance.
5. `MessageActions` (copy/regenerate) render in `MessageFooter` — `ChatPage` threads `onRegenerate` to the LAST assistant message only. The input bar's stop button calls `handleStop`: aborts the stream, cancels the durable run via `POST /api/chat/<runId>/cancel` (stop means STOP — no recorded agent reply), clears the stored run id, and reports an `interaction_interrupt` signal (fire-and-forget).

## File Map

| File | Description |
|------|-------------|
| `chat-page.tsx` | Top-level `"use client"` container: `useChat` hook, `WorkflowChatTransport` wiring, the arrival verdict (run reconnect + `getArrivalState` resume gate), the stream's item model, slice-jump paging/positioning (bus + `?at=`), the rung-aware `ComposerHost` |
| `unified-chat-stream.tsx` | **THE SURFACE.** A native DOM scroll container with windowed mounting: the offset table, the prepend/remeasure scroll compensation, the live-edge pin, the imperative handle (`scrollToKey`/`scrollToOffset`/`scrollToBottom`), the band-feed publishing. Its header is the design document; read it first |
| `stream-layout.ts` + `tests/lib/chat/stream-layout.test.ts` | **Pure layout model** (`src/lib/chat/`): height estimates, the running offset table, the mounted-window range, the top-item lookup. Unit-tested — this is where the stream's arithmetic lives |
| `field-blocks.ts` + `tests/lib/chat/field-blocks.test.ts` | **Pure block model** (`src/lib/chat/`): `splitItems`, `sliceIdOf`, `groupBlocks`, `prependHeadCount`, `armedGate`, and the fixed sizes (`SLICE_GATE_PX`, `FIELD_ORIGIN_PX`). Served the deleted conversation field first; now serves the timeline's fields, and the DOM stream reuses its sizes and `sliceIdOf` |
| `slice-gate.tsx` | The boundary between two conversations, as an intertitle — TIMELINE ONLY since v0.11 §14.5 (the DOM stream renders `SliceSeam` instead). Dormant = a quiet rule; armed = the shared `Intertitle` arrangement with the destination's focus in its slot. Arm state arrives as a `GateSignal` |
| `field-origin.tsx` | The head of the loaded window — "the beginning of this memory", or the older-page control. The same `Intertitle` arrangement, with the older-page control in that one slot. Shared by the DOM stream and the timeline's origin row |
| `intertitle.tsx` | **The arrangement both intertitles are drawn with** — two edge-aligned rows: interval + chevron over the stateful slot on the left, the clock over its date on the right. The gate and the head differ in that one seat and nowhere else, so moving between them never re-lays-out the region |
| `slice-seam.tsx` | The seam between two slices in the DOM stream (hairline checkpoint / date-pill boundary) plus the shared pieces (date formatting, the gap marker) |
| `history-turn.tsx` | One historical turn as pure-body bubbles (no tool state) |
| `resume-banner.tsx` | The "继续 <date> 的对话" banner over a restored live slice. Extracted from the stream component so the surface does not depend on it |
| `stream-time-indicator.tsx` | The transient floating time pill (mobile): top-edge, visible while scrolling, fades ~1s after stop |
| `rolling-number.tsx` | The odometer rolling-digit family (`useRollingNumber`/`RollingDigit`/`RollingField`/`RollingTime`) — the timeline wheel's central readout and the band's year labels |
| `date-stamp.tsx` | The ANIMATED date and time faces (`DateStamp`/`TimeStamp` + the pure `dateStampParts`/`timeStampParts`): the locale decides the structure, `NumberTicker` springs the parts that are numeric, and the year rolls up from twenty years back. Revived from the retired `DateGroupHeader`/`SliceTimeMarker` — it is what the gate and the window's head render |
| `relative-time.tsx` | `relativeBetween` (the app's one interval humanizer) and `RelativeStamp` — the "5 天前" / "5 天后" phrase, shared by the travel clock and the gate. A boundary's phrase is anchored to the OTHER SIDE of the boundary; the travel clock's is anchored to now |
| `composer-host.tsx` | The composer's chrome, which changes with the rung: a full-width footer at the conversation rung, a compact pill that opens into a floating card at any card rung. It OWNS the open/compact state and hands the composer in as a RENDER PROP (`{collapsed, expand}`), so `ChatInput` is one component with an early return — never unmounted — and typed text and image attachments survive a rung change in both directions |
| `error-banner.tsx` | The red chat-error banner with expandable full detail |
| `chat-skeleton.tsx` | The loading faces (`ChatPageSkeleton`, `ChatStreamSkeleton`, `ChatInputSkeleton`), shared with the route-level `loading.tsx` so the handover is invisible |
| `chat-message.tsx` | Per-message renderer: `buildStream` classifies parts into reasoning/text/tool/phase |
| `chat-input.tsx` | Two forms, one component. FULL: row 1 is the textarea (auto-resize, image attachments via paste/drag-drop/file picker), row 2 is attach / memory-docs / model picker / send-stop. COMPACT (`collapsed`): one row of siblings — memory-docs, then the arrow that restores the full form, standing where the send button stands. Attach and the model picker are FULL-only (choosing a file is the first half of sending, and there is no send button on screen; the model configures a message not yet started); memory-docs is in BOTH, because reading the memory is not a conversation act |
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

## Shared Primitives

- **PhaseIndicator**: universal expandable header bar, two modes, one render structure. Used by ThinkingSteps, HousekeepingCard, RecallToolRenderer, and non-compact data-phase items.
- **ToolLayout**: universal expandable tool card handling five states (running, completed, error, interrupted, denied). Every tool renderer delegates to it.

## Design Decisions

- **TWO VOICES: PROSE IS SERIF, CHROME IS SANS.** The app speaks in two fonts and the split is by WHO IS TALKING, not by size. What the reader wrote and what the agent wrote back — message bodies, history turns, the composer, the memory documents — is PROSE and sets in `--font-serif` (Source Serif). Everything the app says ABOUT the turn — the phase indicator, thinking, tool cards, the housekeeping checklist, status strips — is CHROME and sets in the UI sans (`--font-sans`, Raleway), which is what you get by NOT asking for the serif. So the rule has one direction: prose opts IN with `font-serif`; chrome opts out by saying nothing. A new tool renderer or status card therefore starts correct, and only a thing that renders the reader's or the agent's own words needs to do anything.

- **Arrival = in-flight work, a LIVE slice, or the briefing** (v0.10 §2): on mount, `ChatPage` asks the server TWO things before `Inner`/`useChat` mount — whether the persisted run is still pending/running (`isChatRunActive`) and whether the newest slice is still inside the idle gap (`getArrivalState`). A live run → restore from the localStorage stash + `resume`. An alive slice (and no live run) → its turns re-enter the message stream from the SLICE itself (cross-device), under a "继续 <date> 的对话" banner. Anything else → the arrival briefing. A terminal/absent run drops the stash: completed conversation is restored from slices, never from localStorage.
- **The page streams before it can be slow.** The config read lives in its own async boundary inside the page's `<Suspense>`, and `[locale]/loading.tsx` gives the route an instant placeholder — both render `ChatStreamSkeleton`, so the reader sees the conversation's own loading face from ~270 ms and the swap is invisible.
- **The scroller is native; the position guarantees are the stream's own.** Programmatic moves go through the imperative handle, and `scrollToKey` does NOT fetch: the caller pages until the key exists and calls again. `scrollToKey` also remembers an unloaded target and lands when it appears — the jump caller scrolls on the frame after paging resolves, which is before React has committed the new items.
- **The imperative handle is a ref object, not a component ref.** `apiRef` is a `MutableRefObject` handshake; this codebase has no `forwardRef`/`useImperativeHandle` anywhere. The band feed is the same idea taken one step further: it is the mutable object ITSELF, not a ref to one — a ref would be a second layer of the same idea and the one that gets forgotten when a new field is added.
- **Paging is asked for, never inferred.** There is deliberately no scroll-position trigger: an earlier version fired at `target <= LOAD_OLDER_PX` from an effect keyed on the mounted count, and the mounted count changes while the first measurement pass settles, so arriving alone paged history in. A slice read is a repository call in production.
- **Layer separation**: `ChatPage` owns orchestration, `UnifiedChatStream` renders, and the item model (`src/lib/chat/stream-items.ts`), the layout arithmetic (`src/lib/chat/stream-layout.ts`) and the shared block model (`src/lib/chat/field-blocks.ts`) are pure and unit-tested.
- **The card rungs are a FIELD, not a wheel**: `CardField` lays the catalog out as rows in a virtualized R3F scene (oldest at the top, the present at the bottom), one row per unit at the current rung. A card's turns load when it mounts, through `getSliceContent` — there is NO client cache (`slice-cache.ts` was deleted); the server's Data Cache is what absorbs repeat reads.
- **Navigation IS the rung, and a point is `?at=`**: `?z=<rung>` names the zoom (`src/lib/chat/deep-link.ts`); `?at=<sliceId>` addresses a POINT, consumed once and then stripped so a refresh never re-jumps. The old `?view=` mode switch and its `viewport-slice.ts` publication are gone — the rung replaced them.
- **Navigation = time travel, landing IN the stream**: a slice jump overlays `RelativeTimeReadout` (the stream beneath never unmounts), pages the target into the stream while the clock rolls, then lands on its seam. A miss (catalog exhausted) is an honest error toast, never a fake landing. Submitting a message cancels any in-flight transition and snaps back to the present.
- **Shared slice-card language**: the travel cover and the empty briefing share one visual identity (`FrameCard`: ring, soft shadow, hairline separators, mono eyebrow row with the primary square marker).
- **ChatInput owns its images** via `useImageAttachments`: paste, drag-drop and file picker funnel into the same state, previewed as removable thumbnails.
- **MarkdownRenderer is not `prose`-only**: custom per-element styles (tables, links, code blocks) instead of relying solely on Tailwind typography.
