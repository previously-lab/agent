# Chat Rendering System

## Overview

The chat rendering system uses project-owned `UIMessage` parts (`src/lib/chat/protocol.ts`) for text, reasoning, tools and custom data. `useDurableChat` posts a turn once; `readDurableChat` parses SSE and reconnects only to the same durable Vercel Workflow run. A replay rebuilds the assistant message from index zero, preserving original DeepSeek checkpoints without duplicated text. No AI SDK dependency is required.

**Shared manuscript presentation.** `conversation-turn.tsx` and `writing.css` give live replies and saved turns the same reading column: serif prose, sans speaker/time metadata, and quiet ruled tool details. Both voices align in the column; a user turn has a light margin rule rather than a bubble. This conversation is responsive, naturally flowing text. Only the document desk uses fixed A4 geometry. Use `--background` and `--foreground` here, because the desk's `--paper` stays light even in dark mode. The persistent composer uses `--tool-glass` and `--shadow-float`, with round controls and visible attachment removal actions.

**Native HTML is opt-in reply language.** Assistant prose (live, history, nested, and parallel) keeps ONE semantic Markdown document per text segment: `remark-native-sections.ts` maps only parser-confirmed root code nodes to native islands, so reference links and footnote definitions still resolve across them. Only fully closed, root-level ```html live fences execute through `native-html.tsx`; ordinary `html`, raw HTML, user text, reasoning, tool output, and display-repaired incomplete native fences stay inert. During streaming, a closing fence at source EOF without a line ending remains a candidate until EOL or terminal completion, so a delayed invalid suffix cannot execute earlier source. The opaque iframe uses sandbox `allow-scripts` only and a local-only CSP; a second load or ready-handshake timeout removes the failed document. Bounded UI state is scoped by the actual owner persona/source/turn/block/source version. Chat uses the resolved `ChatPage` verdict persona, desk uses its document owner, and demo datasets use a hash of their configured remote origin or local root. Only a terminal-confirmed same-run provisional alias migrates without remounting; other scope changes start fresh. Restoration updates every control, notifies changed controls so derived output recomputes, then restores scroll on the next frame. Native follow-up first becomes one host-owned pending suggestion — only the reader's **Add to draft** action appends it, preserving draft and attachments, and it never sends. Paper duplicates are script-free fixed figures; only a deliberate dialog opens one interactive copy.

`/app` opens the ordinary-DOM conversation/document workspace, with no world canvas beneath chat. `/game` is the real hotel route; only its first visit creates the lazy persistent game host. Reading a world paper opens the same DOM reader on `/app`; Back or close restores the preserved room and position. `?view=field` opens the bounded DOM document/record selector.

The conversation is the LAYOUT-OWNED CONVERSATION LAYER (`conversation-panel.tsx`): one persistent two-tier overlay (floating pill / fullscreen), mounted as a sibling of route content so draft, attachments, live run, and scroll survive app/reader/game navigation. The main `/app` conversation defaults to fullscreen. Mini sends on game and reader stay mini; a deliberate slice jump expands to reveal its destination, while an unloaded target opens the record manuscript instead. The composer's COMPACT form (`chat-input.tsx`'s `collapsed`) is fully latent — nothing renders it.

**ONE SURFACE, AND IT IS DOM.** The R3F conversation field (`conversation-field.tsx`) retired with the ladder — it was the conversation rung's 2.5D view, and there is no conversation rung. `dom-chat-list.tsx` is the ONLY conversation renderer: a native scroll container with windowed mounting, at every tier, on every route. Read its header before touching layout — the prepend compensation and the live-edge pin documented there are its guarantees. The field's pure arithmetic survives it: `stream-layout.ts` (offset table) and `field-blocks.ts` (block model, `sliceIdOf`, the fixed sizes) are unchanged and unit-tested.

**THE CARD FIELD PAGES ONLY WHEN ASKED** (a preserved-tree rule). The card field's window head (`FieldOrigin`, via `origin-row.tsx`) is the only thing that loads an older page. Two automatic triggers were removed: a 320px top-zone edge trigger, which made the head unreachable — every approach pulled another page in, so the control moved away from the reader walking toward it — and a 900ms fill pass, which filled the screen before anyone had decided they wanted more. A page request is a repository read in production.

The content area is ONE unified stream: on a briefing arrival, the cold-open page of repository history above, the briefing card seated as a stream item, the live turns below; on a resume arrival, the alive slice's turns restore under a banner. The list pages NOTHING older — an explicit button at its upper edge opens the bounded DOM record selector instead. Slice navigation never leaves the stream when the target is loaded — a jump (search palette, recall references bar, a `?at=` cold-boot link) rises the panel, plays the time-travel clock as the loading cover, and lands on the target slice's seam; a target outside the loaded page opens its `records/<sliceId>` manuscript through `openDesk` instead of a false not-found toast. On arrival, `getArrivalState` restores a still-alive newest slice's turns straight into the stream ("继续 <date> 的对话" banner) — cross-device, from the slice, not localStorage.

## Component Tree

```
ConversationOverlay (conversation-overlay.tsx — layout-level, gated per route
                     by conversation-overlay-mount.tsx; the home hides it)
└── ConversationPanel (conversation-panel.tsx — the two tiers; hosts ChatPage)
    └── ChatPage (chat-page.tsx)  ← "use client", top-level useDurableChat container
        ├── Content area (the conversation's column inside the panel body)
        │   ├── DomChatList (dom-chat-list.tsx — THE renderer: windowed DOM
        │   │   scroller; history page + briefing card + resume block + live)
        │   │   ├── SliceSeam         ← the boundary as hairline checkpoint / date-pill
        │   │   ├── HistoryTurn       ← saved turns in ConversationTurn
        │   │   ├── ResumeBanner      ← "继续 <date> 的对话"
        │   │   ├── EmptyBriefing     ← the arrival card, a stream item (variant="card")
        │   │   ├── ChatMessage       ← live stream parts in ConversationTurn
        │   │   └── ErrorBanner
        │   ├── StreamTimeIndicator (mobile floating "where am I in time" pill)
        │   ├── [time-travel cover] RelativeTimeReadout overlay (never unmounts the list)
        │   └── [arrival skeleton cover] ChatStreamSkeleton
        ├── [Floating composer] — ComposerHost positions it inside the panel and
        │   reports its height up (`onComposerClearanceChange`) so the list's
        │   foot padding clears it.
        └── ChatInput (three forms: full = textarea + toolbar, pill = the tier's
            one row, compact = latent)
```

HistoricalChatView is gone (v0.10 final wave); the unified stream covers its roles.

## The stream's model (read this before touching layout)

The DOM list's guarantees — each one exists because its absence was a measured bug:

- **ONLY THE VISIBLE ROWS EXIST.** The offset table (`stream-layout.ts`) gives every item a height — measured once the row has mounted, an estimate until then — and the mounted window is the viewport plus one screen of overscan.
- **A PREPEND IS COMPENSATED, NOT ANCHORED.** Items landing ABOVE the reader shift `scrollTop` by exactly the height they add, measured off the freshly-committed rows in the same frame. `overflow-anchor: none` keeps the browser's own anchoring out of it — two compensations fighting was the old stack's measured bug.
- **THE LIVE EDGE IS A PIN, NOT A TRIGGER.** The reader is either at the bottom (following) or not; growth pins the scroll to the tail only while following. Sending a message re-pins.
- **THE BAND FEED HAS ONE WRITER.** While the panel body is on screen the list publishes progress and block anchors to the shared `FieldFeed` and consumes its seek requests; folded to the pill it writes nothing. See `lib/timeline3d/field-feed.ts` for why the lease exists.

## Boundaries and the announcing gate (the preserved card field's pieces)

These components are no longer mounted by the app — the card field they serve lives on untouched in `src/components/timeline-3d/`, preserved for the archive dispatch. They remain here because that tree imports them:

- **`SliceGate`** is an INTERTITLE: crossing a boundary is arriving at a new time, and the card states HOW FAR it is — "5 天前" one way, "5 天后" the other, the same interval read in both directions — over the animated time, the date and the destination's focus. It is a FIXED height (`SLICE_GATE_PX`) with the dormant and armed faces stacked absolutely inside it — if arming changed the box, arming would move every block below. (The DOM list renders the plain `SliceSeam` — hairline checkpoint / date-pill — instead; announcing belongs to the fields that have a camera to read it with.)
- **`FieldOrigin`** is the window's head: the same intertitle language for the one edge with no slice beyond it. It says either "the beginning of this memory" or offers the older page, and the page control lives HERE because the head is the only place where "show me earlier" is a coherent thing to ask.
- **Exactly one boundary announces at a time**, decided by `armedGate` in `field-blocks.ts`: the nearest boundary actually in view, with the origin taking precedence at the head. An earlier version kept ONE direction flag for the whole field, so a single wheel tick flipped every gate on screen at once.
- **Arm state travels as a MUTABLE OBJECT** (`GateSignal`), read by the gate's own frame loop. drei's `<Html>` mounts into a separate React root, so a prop change per crossing would re-render the portal to swap two words.

## Message Part Flow

1. `useDurableChat` (in `ChatPage`) receives a `UIMessage` with typed `parts[]`; the page wraps each as a live item (`LiveStreamItem`) and `DomChatList` renders it through `ChatMessage`.
2. `ChatMessage.buildStream()` classifies each part in a single pass:
   - `reasoning` → merged consecutively into one `ThinkingSteps` block (streaming mode with typewriter subtitle)
   - `tool-*` → merged by `toolCallId` into a single `ToolRenderer` card
   - `data-phase` ? compact phases merge by name into ONE `HousekeepingCard` checklist; other phases render as `PhaseIndicator`
   - `data-evolution` → skipped by the stream classifier; ChatPage republishes each newly-arrived frame onto the evolution-activity bus (`src/lib/chat/evolution-activity.ts`) — the shell subscribes there to drive the companion pod (button breathing + achievement toast)
   - `text` → buffered and flushed into `MarkdownRenderer` blocks
3. Items render in natural stream order inside `AnimatePresence` for enter/exit animations.
4. The loading tips (`loading-tip.tsx`) are RETIRED (unused, kept for a content refresh) — no generic pre-first-chunk placeholder; the input bar's stop state is the in-flight affordance. Markdown has a quiet stream caret, and an incomplete native fence has its own preparing state (or a terminal source/retry fallback).
5. `MessageActions` (copy/regenerate) render in `MessageFooter` — `ChatPage` threads `onRegenerate` to the LAST assistant message only. The input bar's stop button calls `handleStop`: aborts the stream, cancels the durable run via `POST /api/chat/<runId>/cancel` (stop means STOP — no recorded agent reply), clears the stored run id, and reports an `interaction_interrupt` signal (fire-and-forget).

## File Map

| File | Description |
|------|-------------|
| `chat-page.tsx` | Top-level `"use client"` container: `useDurableChat` hook, project-owned SSE transport wiring, the arrival verdict (run reconnect + `getArrivalState` resume gate), the stream's item model (cold-open history + briefing card + resume block + live), slice-jump positioning (bus + `?at=` — rises the panel, scrolls the list, no paging), the empty-memory auto-rise, the send-rises-the-panel wrapper. The verdict persona scopes native replies. Arrival errors use the pointer-enabled `ComposerHost`, so Retry and the normal Expand path work with a mouse as well as the keyboard. Lives INSIDE `ConversationPanel` |
| `conversation-panel.tsx` | **The conversation layer's two tiers** (v0.13 §4): the pill — a floating translucent glass bar (`PILL_HEIGHT_PX` × up to `PILL_MAX_WIDTH_PX`, `rounded-full`, centred `PILL_BOTTOM_GAP_PX` above the viewport's bottom edge; one control row: round attach / single-line input / round send-stop / round expand) — and fullscreen, the full-capability overlay (`position: fixed`, never a route). The subtitle above the pill is an FPS-radio strip, never part of the pill's height or width: a block capped to `SUBTITLE_BLOCK_MAX_WIDTH_PX` (660) and centred over the pill — never full-bleed — with a fixed-width uppercase speaker column (`SUBTITLE_SPEAKER_COLUMN_PX`, 112; persona in `text-brand`, user in the warm grey `SUBTITLE_USER_INK`), the body pinned to the column's x and wrapped to at most two lines (`SUBTITLE_LINE_HEIGHT_PX`, 20, seat grows to 40 only when the fold exceeds half the reducer cap). The pill tier's box is chromeless and pointer-transparent — only the pill eats events. Controlled by the shell provider (`panelMode`), which freezes the world's `frameloop` at fullscreen. Pure `reducePanelMode` transition table (unit-tested in `__tests__/`), `Cmd/Ctrl+J` toggle (K = search, `.` = the world rungs), container-level `Escape` (portaled popovers never reach it), focus follows the tier. Publishes the tier through `PanelTierContext` (`usePanelTier`) so the composer and input draw their pill forms; renders the `subtitleLine` prop (folded by `lib/chat/subtitle-line.ts`). The children stay MOUNTED at every tier — the body folds to zero height + inert at the pill, never an unmount — and the composer is absolutely positioned against the panel box, so it stays live (and keeps its draft) inside the pill |
| `dom-chat-list.tsx` | **THE conversation renderer.** A native DOM scroll container with windowed mounting: the offset table, the prepend/remeasure scroll compensation, the live-edge pin, the band-feed publishing, the imperative handle (`scrollToKey`/`scrollToOffset`/`scrollToBottom` — `scrollToKey` remembers an unloaded key and lands when it arrives). Renders the briefing card item when the page passes `briefing` props. Its header documents the guarantees |
| `stream-layout.ts` + `tests/lib/chat/stream-layout.test.ts` | **Pure layout model** (`src/lib/chat/`): height estimates, the running offset table, the mounted-window range, the top-item lookup — the DOM list's arithmetic. Unit-tested |
| `field-blocks.ts` + `tests/lib/chat/field-blocks.test.ts` | **Pure block model** (`src/lib/chat/`): `splitItems`, `sliceIdOf`, `groupBlocks`, `prependHeadCount`, `armedGate`, and the fixed sizes (`SLICE_GATE_PX`, `FIELD_ORIGIN_PX`). Unit-tested — the DOM list reuses `sliceIdOf`; the rest serves the preserved card field |
| `slice-gate.tsx` | The boundary between two conversations, as an intertitle. Dormant = a quiet rule; armed = the shared `Intertitle` arrangement with the destination's focus in its slot. Arm state arrives as a `GateSignal`. Preserved-tree component (the card field's units import it) |
| `field-origin.tsx` | The head of the loaded window — "the beginning of this memory", or the older-page control. The same `Intertitle` arrangement, with the older-page control in that one slot. Preserved-tree component |
| `intertitle.tsx` | **The arrangement both intertitles are drawn with** — two edge-aligned rows: interval + chevron over the stateful slot on the left, the clock over its date on the right. The gate and the head differ in that one seat and nowhere else, so moving between them never re-lays-out the region |
| `slice-seam.tsx` | The seam's shared pieces (date formatting, the gap marker). The DOM list renders the seam itself (`SliceSeam` — hairline checkpoint / date-pill) from these pieces |
| `history-turn.tsx` | One historical turn as pure-body bubbles (no tool state) |
| `resume-banner.tsx` | The "继续 <date> 的对话" banner over a restored live slice |
| `stream-time-indicator.tsx` | The transient floating time pill (mobile): top-edge, visible while scrolling, fades ~1s after stop |
| `rolling-number.tsx` | The odometer rolling-digit family (`useRollingNumber`/`RollingDigit`/`RollingField`/`RollingTime`) — the travel clock's and the preserved band's readouts |
| `date-stamp.tsx` | The ANIMATED date and time faces (`DateStamp`/`TimeStamp` + the pure `dateStampParts`/`timeStampParts`): the locale decides the structure, `NumberTicker` springs the parts that are numeric, and the year rolls up from twenty years back. Revived from the retired `DateGroupHeader`/`SliceTimeMarker` — it is what the gate and the window's head render |
| `relative-time.tsx` | The client faces of the interval language: `RelativeStamp` — the "5 天前" / "5 天后" phrase, shared by the travel clock and the gate — and the travel clock's readout. A boundary's phrase is anchored to the OTHER SIDE of the boundary; the travel clock's is anchored to now. The ladder itself (`relativeBetween`) lives in `src/lib/time/relative-between.ts`, because the home page — a SERVER component — decides its dateline on the same thresholds |
| `composer-host.tsx` | The composer's floating seat and its measurement: positions the composer (centred over the panel box AS the glass pill at the pill tier — rounded-full, translucent background, ring, blur — at most `--pill-max-width` wide; a floating 44rem card at fullscreen) and reports its height up (`onClearanceChange`) so the list's foot padding clears it. The composer arrives as a plain child and is never unmounted — typed text and image attachments survive every tier change |
| `error-banner.tsx` | The red chat-error banner with expandable full detail |
| `chat-skeleton.tsx` | The loading faces (`ChatPageSkeleton`, `ChatStreamSkeleton`, `ChatInputSkeleton`), shared with the route-level `loading.tsx` so the handover is invisible |
| `chat-message.tsx` | Per-message renderer: `buildStream` classifies parts into reasoning/text/tool/phase |
| `chat-input.tsx` | Three forms, one component. FULL: row 1 is the textarea (auto-resize, image attachments via paste/drag-drop/file picker), row 2 is attach / send-stop. COMPACT (`collapsed`): one row of siblings — the arrow that restores the full form (FULLY LATENT — nothing renders it since the card rungs retired). PILL (the v0.13 pill tier, drawn when `usePanelTier()` says "pill"): the floating glass pill's one row — round attach on the left, a single-line input in the middle (no box of its own), round send-stop + expand on the right — reusing the same attachments state, submit and stop paths as the FULL form. The model is fixed to DeepSeek Flash; there is no model or effort control. The memory-docs popover retired with v0.25b — the library's pinned Dossier section is the archive's only door |
| `phase-indicator.tsx` | Reusable expandable header bar: `streaming` (typewriter subtitle, elapsed timer) and `static` (manual expand, chevron). Used by ThinkingSteps, HousekeepingCard, RecallToolRenderer, and non-compact data-phase items |
| `housekeeping-card.tsx` | The grouped prep card: compact data-phase checklist (slice / analyze / tags / context / strands) |
| `evolution-card.tsx` | The card-evolution card (Previously Agent): streaming live thinking, then the settled headline and the calibration detail |
| `thinking.tsx` | Reasoning display: Brain icon, streaming subtitle, elapsed timer, expandable Markdown |
| `tool-renderer.tsx` | Dispatch hub: maps `toolName` to specific renderers; extracts `ToolRenderState` from project-owned stream state |
| `tool-layout.tsx` | Shared expandable tool card: status icon, name, summary, meta, CSS grid-animated details panel |
| `tool-renderers/` | Per-tool: `recall.tsx`, `memory-tool.tsx`, `list-files.tsx`, `list-docs.tsx`, `read-doc.tsx`, `current-time.tsx`, `web-search.tsx`, `default.tsx` |
| `time-display.tsx` | The shared time readout (`NumberTicker` per field) |
| `empty-briefing.tsx` | The arrival briefing in the slice-card skin. Two seats: `variant="card"` is a stream item in the panel's list (between the cold-open history page and the live edge); the full-screen form only for an empty, slice-less memory — where the panel auto-rises once on `/app` to show it. Takes the resolved `identity` as a prop |
| `cognition-popover.tsx` | Per-turn agent thoughts dialog (lazy-loaded Markdown) |
| `loading-tip.tsx` | RETIRED (unused, kept for a content refresh) |
| `markdown.tsx` / `code-block.tsx` | Stable Markdown components (react-markdown + GFM + highlight), one semantic document across native islands, display-only streaming tail repair, and custom per-element styling |
| `native-html.tsx` / `native-html.css` | Opaque native figure, validated bridge host, bounded state restoration with derived-output notification, discreet controls, host-accepted suggestions, and static-paper/dialog forms |
| `lib/markdown/{native-sections,remark-native-sections,native-document}.ts` + `lib/chat/native-{bridge,state,draft}.ts` | Pure fence scanner, mdast island mapping, srcdoc/CSP/runtime, token/schema checks, TTL/LRU JSON state, and the host-accepted composer draft channel |
| `message-actions.tsx` | Copy-to-clipboard and Regenerate, shown on hover |
| `file-name-pill.tsx` | File path badge with code-vs-text icon detection |

Native `data-deepseek-step` checkpoints preserve exact reasoning and tool arguments across requests. Completed run recovery carries `nativeMessages`; a bounded local archive (24 turns, 1 MiB) can restore current-slice checkpoints only when the authoritative user ID and both visible texts match. Missing, changed or oversized entries fall back to visible history. The archive never adds a turn absent from the current slice.

## Shared Primitives

- **PhaseIndicator**: universal expandable header bar, two modes, one render structure. Used by ThinkingSteps, HousekeepingCard, RecallToolRenderer, and non-compact data-phase items.
- **ToolLayout**: universal expandable tool card handling five states (running, completed, error, interrupted, denied). Every tool renderer delegates to it.

## Design Decisions

- **TWO VOICES: PROSE IS SERIF, CHROME IS SANS.** The app speaks in two fonts and the split is by WHO IS TALKING, not by size. What the reader wrote and what the agent wrote back — message bodies, history turns, the composer, the memory documents — is PROSE and sets in `--font-serif` (Source Serif). Everything the app says ABOUT the turn — the phase indicator, thinking, tool cards, the housekeeping checklist, status strips — is CHROME and sets in the UI sans (`--font-sans`, Raleway), which is what you get by NOT asking for the serif. So the rule has one direction: prose opts IN with `font-serif`; chrome opts out by saying nothing. A new tool renderer or status card therefore starts correct, and only a thing that renders the reader's or the agent's own words needs to do anything.

- **Arrival = in-flight work, a LIVE slice, or the briefing** (v0.10 §2): on mount, `ChatPage` asks the server TWO things before `Inner`/`useDurableChat` mount — whether the persisted run is still pending/running (`isChatRunActive`) and whether the newest slice is still inside the idle gap (`getArrivalState`). A live run → restore from the localStorage stash + `resume`. An alive slice (and no live run) → its turns re-enter the message stream from the SLICE itself (cross-device), under a "继续 <date> 的对话" banner. Anything else → the arrival briefing. A terminal/absent run drops the stash: completed conversation is restored from slices, never from localStorage.
- **The page streams before it can be slow.** The config read lives in its own async boundary inside the page's `<Suspense>`, and `[locale]/loading.tsx` gives the route an instant placeholder — both render `ChatStreamSkeleton`, so the reader sees the conversation's own loading face from ~270 ms and the swap is invisible.
- **The list owns the position, so nothing else may.** Every programmatic move goes through the imperative handle, and `scrollToKey` does NOT fetch: the list pages nothing. Once the initial page has settled, a target outside the loaded window opens its record manuscript through `openDesk`; while that page is pending, `scrollToKey` remembers the target and lands when the items commit.
- **The imperative handle is a ref object, not a component ref.** `streamApiRef` is a `MutableRefObject` handshake; this codebase has no `forwardRef`/`useImperativeHandle` anywhere. The band feed is the same idea taken one step further: it is the mutable object ITSELF, not a ref to one — a ref would be a second layer of the same idea and the one that gets forgotten when a new field is added.
- **`<Html>` cuts React context** (a preserved-tree rule). Every billboard in the card field wraps its children in `NextIntlClientProvider`. This is required, not defensive — see the note in `frame-card.tsx`.
- **Two layers, one stream**: `ChatPage` owns orchestration, `DomChatList` renders. The item model (`src/lib/chat/stream-items.ts`) plus the layout arithmetic (`src/lib/chat/stream-layout.ts`) are pure and unit-tested.
- **Navigation = time travel, landing IN the stream**: a loaded slice jump follows the route-aware panel policy, overlays `RelativeTimeReadout`, then lands on the target's seam; an older unloaded target opens its record manuscript. Submitting a message cancels any in-flight transition and snaps back to the present.
- **A point is `?at=`**: `?at=<sliceId>` addresses a POINT, consumed once and then stripped so a refresh never re-jumps. It is a cold-boot deep link only — nothing inside the session produces one any more (`?z=` and the view switch are gone; the two rungs are in-memory state in the shell).
- **Shared slice-card language**: the travel cover and the empty briefing share one visual identity (`FrameCard`: ring, soft shadow, hairline separators, mono eyebrow row with the primary square marker).
- **ChatInput owns its images** via `useImageAttachments`: paste, drag-drop and file picker funnel into the same state, previewed as removable thumbnails.
- **MarkdownRenderer is not `prose`-only**: custom per-element styles (tables, links, code blocks) instead of relying solely on Tailwind typography.
