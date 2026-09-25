# Chat Rendering System

## Overview

The chat rendering system pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-phase, data-evolution) through a unified stream pipeline — recall context, reasoning, tool calls, and final response — rendered inside each assistant message. The top-level container (`ChatPage`) uses `useChat` with `@ai-sdk/workflow`'s `WorkflowChatTransport`: every turn runs inside a durable Vercel Workflow run and is resumable after a dropped connection.

The app route (`/{locale}/app`) is a single shell — the left time axis is persistent, and the right pane shows the conversation field's pane slot or the card field depending on the RUNG. There is no view mode: the rung is in-memory state owned by the shell (`?z=` is gone, `src/lib/chat/deep-link.ts`); the card field (`src/components/timeline-3d/`) renders inside the shell's right pane at slice/day/week; the header's segmented pill is gone and the board bar (`shell/board-bar.tsx`, top centre) is the only control that moves along the ladder — it holds the zoom lens and the strand selector, which used to sit on the 24-32px time rail. The conversation field stays mounted at every rung (its pane slot held at `opacity-0` + `inert`) so its camera position and the live useChat stream survive.

The conversation is ALSO the CONVERSATION LAYER (`conversation-panel.tsx`, v0.11 §14.1, reworked v0.13 §4): a persistent two-tier overlay (floating pill / fullscreen) over the world — `position: fixed`, so opening it never resizes the canvas (覆盖，不挤压), and fullscreen freezes the world's `frameloop` without unmounting it. Since v0.13 §3.1 the layer mounts at the LAYOUT (`conversation-overlay.tsx`, gated per route by `conversation-overlay-mount.tsx` — the home route hides it), a sibling of the route content that survives navigation and world rebuilds; the state it shares with the route (tier, slice cursor, view getter, freeze signal, feed, composer clearance) lives in `shell/shell-provider.tsx`. The overlay pins the panel's ChatPage to the `conversation` rung (tier visibility is the panel's job), so the composer's COMPACT form (`composer-host.tsx` + `chat-input.tsx`'s `collapsed`) is latent — the panel hosts the composer.

**THE 2.5D SPLIT (the 2026-09 restore).** The R3F conversation field (`conversation-field.tsx`, deleted by `419ad3d`) is restored, and it once again renders the conversation rung IN THE PANE — history, slice gates, the older-page head, the camera, all of it verbatim. The field is authored against the window-derived tier column (680 px) and needs a wide host, so it reaches the pane through a portal: `unified-chat-stream.tsx` renders `ConversationField` into a slot composed by the layout-level provider (`conversation-surface.tsx`) — the app shell's pane slot while the panel floats beside it (the v0.13 pill leaves the whole pane free), the overlay's slot inside the panel body at fullscreen. Where no wide surface exists (the game view below fullscreen, or a route with no pane) the DOM list (`dom-chat-list.tsx`, the pre-restore surface) carries the conversation instead. **The ONE difference from the old field: the turn that is IN FLIGHT never enters the 3D field** — history is the field's whole content, and the ongoing turn renders as plain DOM in the panel, above the composer (`LiveTurnStrip`). The panel is the ongoing conversation's home and the only input.

**THE CARD FIELD PAGES ONLY WHEN ASKED.** Its window head (`FieldOrigin`, via `origin-row.tsx`) is the only thing that loads an older page. Two automatic triggers were removed: a 320px top-zone edge trigger, which made the head unreachable — every approach pulled another page in, so the control moved away from the reader walking toward it — and a 900ms fill pass, which filled the screen before anyone had decided they wanted more. A page request is a repository read in production.

**THE CONVERSATION HAS NO SCROLL CONTAINER** (v0.12). Position is a number we own — a camera offset — and every block is an R3F billboard. See `conversation-field.tsx`, and read its header before changing anything about layout: the whole design follows from "a billboard is anchored by its top edge". The old react-virtuoso list is gone from this view entirely; nothing here imports it. (The DOM fallback, `dom-chat-list.tsx`, IS a native scroller — that is the point of it: the browser owns the position there, and the prepend compensation / live-edge pin documented in its header are its guarantees.)

The content area is ONE unified stream: historical slice blocks above, the live turns below, older slices paged in at the window's head on request. Slice navigation never leaves the stream — a jump (search palette, recall references bar, `?at=` from the timeline) lands on the target slice's seam and plays the time-travel clock as the loading cover. On arrival, `getArrivalState` restores a still-alive newest slice's turns straight into the stream ("继续 <date> 的对话" banner) — cross-device, from the slice, not localStorage.

## Component Tree

```
ConversationOverlay (conversation-overlay.tsx — layout-level, gated per route
                     by conversation-overlay-mount.tsx; the home hides it)
└── ConversationPanel (conversation-panel.tsx — the two tiers; hosts ChatPage)
    └── ChatPage (chat-page.tsx)  ← "use client", top-level useChat container
        ├── Content area (the conversation's column inside the panel body)
        │   ├── UnifiedChatStream (unified-chat-stream.tsx — the adapter: splits
        │   │   history from live, portals the field into the provider-composed
        │   │   surface slot)
    │   │   └── ConversationField (conversation-field.tsx — the R3F renderer)
    │   │       ├── [R3F Canvas, orthographic, zoom 1]
    │   │       │   ├── FieldOrigin    ← the head of the loaded window ("load earlier")
    │   │       │   ├── [per mounted block] <Html> billboard
    │   │       │   │   ├── SliceGate        ← the boundary that closes the block
    │   │       │   │   ├── HistoryTurn      ← plain-body bubbles
    │   │       │   │   ├── ResumeBanner     ← "继续 <date> 的对话"
    │   │       │   │   └── (briefing card, seated in the tail block)
    │   │       │   └── StreamTimeIndicator (mobile floating "where am I in time" pill)
    │   │       └── ErrorBanner
    │   ├── LiveTurnStrip ← THE IN-PROGRESS TURN: plain DOM, the one thing that
    │   │   never enters the 3D field; pins to its tail while streaming
    │   └── [time-travel cover] RelativeTimeReadout overlay (never unmounts the field)
    ├── [Floating composer] — ComposerHost positions it inside the panel; it
    │   reports its height up (`onComposerClearanceChange`) so both the field's
    │   range and the live strip clear it.
    └── ChatInput (two forms: full = textarea + toolbar, compact = one row — latent)
```

On narrow surfaces (the game view's pilled panel) the adapter renders `DomChatList` instead — the whole stream, history and live, as a native scroll container (`stream-layout.ts` arithmetic).

HistoricalChatView is gone (v0.10 final wave); the unified stream and the timeline view's right pane cover its roles.

## The field's model (read this before touching layout)

Four ideas carry the whole thing. Each one exists because its absence was a measured bug.

**1. Every block is a billboard, anchored by its TOP edge.** A block that grows grows DOWNWARD and moves nothing above it. That is why a finished history block can be measured once and frozen. The camera decides whether to travel: it follows only if the reader is already at the live edge. (Since the restore the live block is always empty — the in-progress turn is the panel's DOM strip — but the mechanism stays, and the live-edge follow now simply rests at the history tail.)

**2. The position is a number we own.** `offsetRef` is the world-Y of the viewport top. Inputs (wheel, pointer drag with our own inertia) write `targetRef`; a rAF eases `offsetRef` toward it. There is no `scrollTop` to be corrected under the reader, no estimated total height, no anchoring fight — the class of bug the old stack had (measured: `scrollHeight` reporting 13,471 px for ~1,000 px of content, and `scrollTop` landing 32–64 px away) cannot occur.

**3. Paging older is COMPENSATION, not anchoring.** This is the one direction idea 1 does not cover: a block arriving ABOVE the reader is exactly the case where "grows downward, moves nothing above" gives no protection. So when the block list gains blocks at its head, `relayout` moves the camera by exactly the height they add. The reader's view of what they were reading is pixel-identical, and the new conversations sit off-screen above, to be scrolled into. Measured: a 7,365 px prepend moves the visible text by **zero** pixels.

Two things make that exact, and both are easy to break:
- **A gate belongs to the block it CLOSES**, not the one it opens (`groupBlocks`). Attach the seam to the slice it opens and the seam that arrives with a new page lands inside the reader's own block, growing it by a gate's height under them.
- **Block heights are re-indexed on prepend.** `heightsRef` is indexed by block position; a prepend renumbers every block, so the array is shifted by the same amount. Otherwise each arriving block inherits the height of whichever block used to sit at its index, and the blocks the reader is looking at fall back to an estimate.

**4. Colour is a HIGHLIGHT, not an identity, and the band draws the MOMENT rather than the window.** The left band rests grey; the core line carries the brand blue until something is singled out, and then the core steps back and the picked threads light in their own palette colours. See `src/lib/timeline3d/ink.ts`.

Which threads it draws is decided by the anchor at the CENTRE of the viewport — the same one the knot is wound around — not by a ranking over everything in view (`lineUpFor` in `strand-transition.ts`, `activeAnchorIndex` in `winding.ts`). That is what lets a strand filter narrow the field without emptying the band: filtering drops CARDS, and a card still carries its whole strand set, so the bundle the highlight stands against survives the pick. Grey lines stay anonymous — the reader never needs to know which grey is which thread — and the selection is merged in and never dropped, so a highlight cannot vanish mid-scroll.

## Boundaries and the announcing gate

- **`SliceGate`** is an INTERTITLE: crossing a boundary is arriving at a new time, and the card states HOW FAR it is — "5 天前" one way, "5 天后" the other, the same interval read in both directions — over the animated time, the date and the destination's focus. It is a FIXED height (`SLICE_GATE_PX`) with the dormant and armed faces stacked absolutely inside it — if arming changed the box, arming would move every block below. (The DOM fallback renders the plain `SliceSeam` — hairline checkpoint / date-pill — instead; announcing belongs to the fields that have a camera to read it with.)
- **`FieldOrigin`** is the window's head: the same intertitle language for the one edge with no slice beyond it. It says either "the beginning of this memory" or offers the older page, and the page control lives HERE because the head is the only place where "show me earlier" is a coherent thing to ask.
- **Exactly one boundary announces at a time**, decided by `armedGate` in `field-blocks.ts`: the nearest boundary actually in view, with the origin taking precedence at the head. An earlier version kept ONE direction flag for the whole field, so a single wheel tick flipped every gate on screen at once.
- **Arm state travels as a MUTABLE OBJECT** (`GateSignal`), read by the gate's own frame loop. drei's `<Html>` mounts into a separate React root, so a prop change per crossing would re-render the portal to swap two words.
- **The band's anchor dot** (`CrossingDot` in `axis-band.tsx`) marks where the announcing boundary sits on the core line. The field publishes it through the shared `FieldFeed` (`lib/timeline3d/field-feed.ts`) — the same object the card field fills in the timeline view, and the same object the band reads its progress and zoom from. **A field publishes only while it OWNS the pane**: the chat field stays mounted behind the timeline, so the shell hands out a lease rather than letting both write. See the module header for why four refs with four private ownership rules was the bug.

## Message Part Flow

1. `useChat` (in `ChatPage`) receives a `UIMessage` with typed `parts[]`; the adapter wraps each as a live item (`LiveStreamItem`), renders it through `ChatMessage` in the panel's `LiveTurnStrip`, and — the one difference from the old field — keeps it out of the 3D field's feed.
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
| `chat-page.tsx` | Top-level `"use client"` container: `useChat` hook, `WorkflowChatTransport` wiring, the arrival verdict (run reconnect + `getArrivalState` resume gate), the stream's item model, slice-jump paging/positioning (bus + `?at=`), the rung-aware `ComposerHost`. Lives INSIDE `ConversationPanel` on both surfaces; the shell pins its `rung` to `"conversation"` (tier visibility is the panel's job) |
| `conversation-panel.tsx` | **The conversation layer's two tiers** (v0.13 §4): the pill — a floating translucent glass bar (`PILL_HEIGHT_PX` × up to `PILL_MAX_WIDTH_PX`, `rounded-full`, centred `PILL_BOTTOM_GAP_PX` above the viewport's bottom edge; one control row: round attach / single-line input / round send-stop / round expand) — and fullscreen, the full-capability overlay (`position: fixed`, never a route). The subtitle is its own dim centred line floating directly above the pill, never part of the pill's height or width. The pill tier's box is chromeless and pointer-transparent — only the pill eats events. Controlled by the owning surface (`app-shell`), which reacts to `mode` (per-surface default tier, `frameloop` freeze at fullscreen). Pure `reducePanelMode` transition table (unit-tested in `__tests__/`), `Cmd/Ctrl+J` toggle (K = search, `.` = rungs were taken), container-level `Escape` (portaled popovers never reach it), focus follows the tier. Publishes the tier through `PanelTierContext` (`usePanelTier`) so the composer and input draw their pill forms; renders the `subtitleLine` prop (folded by `lib/chat/subtitle-line.ts`). The children stay MOUNTED at every tier — the body folds to zero height + inert at the pill, never an unmount — and the composer is absolutely positioned against the panel box, so it stays live (and keeps its draft) inside the pill. At fullscreen its `bodyPrefix` slot hosts the R3F field |
| `conversation-field.tsx` | **THE RENDERER.** The camera-driven field: block layout, the eased follow, the prepend compensation, per-boundary arming, the imperative handle (`scrollToKey`/`scrollToOffset`/`scrollToBottom`). Its header is the design document; read it first. Restored from `419ad3d^`; receives HISTORY items only — the live run is the panel's |
| `conversation-surface.tsx` | **The field's host, decided by the shell.** `{ kind: "field", el }` portals the field into `el` (the pane slot, or the panel body at fullscreen); `{ kind: "narrow" }` means no wide host exists and the DOM list carries the conversation. The shell owns both slot elements; the adapter consumes the context |
| `unified-chat-stream.tsx` | A thin adapter over `ConversationField` — the seam between the page and the surface: splits history from live (`splitItems`), portals the field into the surface slot, renders the live turn's `LiveTurnStrip`, falls back to `DomChatList` on narrow surfaces. It used to BE a virtuoso renderer; all of that is gone |
| `dom-chat-list.tsx` | **The narrow-surface conversation.** A native DOM scroll container with windowed mounting: the offset table, the prepend/remeasure scroll compensation, the live-edge pin, the band-feed publishing. Its header documents which of the field's guarantees survived the move. Serves the game view below the panel's fullscreen tier |
| `stream-layout.ts` + `tests/lib/chat/stream-layout.test.ts` | **Pure layout model** (`src/lib/chat/`): height estimates, the running offset table, the mounted-window range, the top-item lookup — the DOM list's arithmetic. Unit-tested |
| `field-blocks.ts` + `tests/lib/chat/field-blocks.test.ts` | **Pure block model** (`src/lib/chat/`): `splitItems`, `sliceIdOf`, `groupBlocks`, `prependHeadCount`, `armedGate`, and the fixed sizes (`SLICE_GATE_PX`, `FIELD_ORIGIN_PX`). Unit-tested — this is where the layout arithmetic lives; the DOM list reuses its sizes and `sliceIdOf` |
| `slice-gate.tsx` | The boundary between two conversations, as an intertitle. Dormant = a quiet rule; armed = the shared `Intertitle` arrangement with the destination's focus in its slot. Arm state arrives as a `GateSignal` |
| `field-origin.tsx` | The head of the loaded window — "the beginning of this memory", or the older-page control. The same `Intertitle` arrangement, with the older-page control in that one slot |
| `intertitle.tsx` | **The arrangement both intertitles are drawn with** — two edge-aligned rows: interval + chevron over the stateful slot on the left, the clock over its date on the right. The gate and the head differ in that one seat and nowhere else, so moving between them never re-lays-out the region |
| `slice-seam.tsx` | The seam's shared pieces (date formatting, the gap marker). The gate renders the boundary; this module owns the interval language. The DOM list renders the seam itself (`SliceSeam` — hairline checkpoint / date-pill) from these pieces |
| `history-turn.tsx` | One historical turn as pure-body bubbles (no tool state) |
| `resume-banner.tsx` | The "继续 <date> 的对话" banner over a restored live slice. Extracted from the stream component so the field does not depend on it |
| `stream-time-indicator.tsx` | The transient floating time pill (mobile): top-edge, visible while scrolling, fades ~1s after stop |
| `rolling-number.tsx` | The odometer rolling-digit family (`useRollingNumber`/`RollingDigit`/`RollingField`/`RollingTime`) — the timeline wheel's central readout and the band's year labels |
| `date-stamp.tsx` | The ANIMATED date and time faces (`DateStamp`/`TimeStamp` + the pure `dateStampParts`/`timeStampParts`): the locale decides the structure, `NumberTicker` springs the parts that are numeric, and the year rolls up from twenty years back. Revived from the retired `DateGroupHeader`/`SliceTimeMarker` — it is what the gate and the window's head render |
| `relative-time.tsx` | `relativeBetween` (the app's one interval humanizer) and `RelativeStamp` — the "5 天前" / "5 天后" phrase, shared by the travel clock and the gate. A boundary's phrase is anchored to the OTHER SIDE of the boundary; the travel clock's is anchored to now |
| `composer-host.tsx` | The composer's chrome, which changes with the rung: a full-width footer at the conversation rung, a compact pill that opens into a floating card at any card rung. It OWNS the open/compact state and hands the composer in as a RENDER PROP (`{collapsed, expand}`), so `ChatInput` is one component with an early return — never unmounted — and typed text and image attachments survive a rung change in both directions. Also reads `usePanelTier()`: at the panel's pill tier it centres the composer against the panel box's bottom edge AS the glass pill (carrying the pill's chrome — rounded-full, translucent background, ring, blur), at most `PILL_MAX_WIDTH_PX` wide |
| `error-banner.tsx` | The red chat-error banner with expandable full detail |
| `chat-skeleton.tsx` | The loading faces (`ChatPageSkeleton`, `ChatStreamSkeleton`, `ChatInputSkeleton`), shared with the route-level `loading.tsx` so the handover is invisible |
| `chat-message.tsx` | Per-message renderer: `buildStream` classifies parts into reasoning/text/tool/phase |
| `chat-input.tsx` | Three forms, one component. FULL: row 1 is the textarea (auto-resize, image attachments via paste/drag-drop/file picker), row 2 is attach / memory-docs / model picker / send-stop. COMPACT (`collapsed`): one row of siblings — memory-docs, then the arrow that restores the full form, standing where the send button stands (latent in the panel surface). PILL (the v0.13 pill tier, drawn when `usePanelTier()` says "pill"): the floating glass pill's one row — round attach on the left, a single-line input in the middle (no box of its own), round send-stop + expand on the right — reusing the same attachments state, submit and stop paths as the FULL form. Attach and the model picker are FULL-only (choosing a file is the first half of sending, and there is no send button on screen; the model configures a message not yet started); memory-docs is in BOTH, because reading the memory is not a conversation act |
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
- **The field owns the position, so nothing else may.** Every programmatic move goes through `setTarget` (clamping + follow state + direction together), and `scrollToKey` does NOT fetch: the caller pages until the key exists and calls again. `scrollToKey` also remembers an unloaded target and lands when it appears — the jump caller scrolls on the frame after paging resolves, which is before React has committed the new blocks.
- **The imperative handle is a ref object, not a component ref.** `fieldApiRef` is a `MutableRefObject` handshake; this codebase has no `forwardRef`/`useImperativeHandle` anywhere. The band feed is the same idea taken one step further: it is the mutable object ITSELF, not a ref to one — a ref would be a second layer of the same idea and the one that gets forgotten when a new field is added.
- **Paging is asked for, never inferred.** There is deliberately no scroll-position trigger: an earlier version fired at `target <= LOAD_OLDER_PX` from an effect keyed on the mounted count, and the mounted count changes while the first measurement pass settles, so arriving alone paged history in. A slice read is a repository call in production.
- **`<Html>` cuts React context.** Every billboard wraps its children in `NextIntlClientProvider`, and the field's own origin does too. This is required, not defensive — see the note in `frame-card.tsx`.
- **Three-layer separation**: `ChatPage` owns orchestration, `UnifiedChatStream` is the adapter (and decides the surface), `ConversationField` renders the 2.5D history, `LiveTurnStrip` carries the in-progress turn in the panel, and `DomChatList` is the narrow fallback. The item model (`src/lib/chat/stream-items.ts`) plus the block model (`src/lib/chat/field-blocks.ts`) are pure and unit-tested.
- **Why the field portals instead of mounting in place.** The field's reading column comes from `useTier()` — a WINDOW-derived 680 px, agreed with the card field's conversation units so a slice never reflows on a rung change. The conversation panel's pill tier is a one-row floating pill with no room for history, and the pre-v0.13 dock (420–520 px) could not fit the column either; shrinking the column would break the agreement. So the shell owns a surface slot (`conversation-surface.tsx`, the same provider pattern as `world-slot.tsx`): the field renders in the pane at the pill tier, in the panel body at fullscreen, and the DOM list covers surfaces with no wide host. One `useChat`, one composer, both surfaces mounted through the panel.
- **The card rungs are a FIELD, not a wheel**: `CardField` lays the catalog out as rows in a virtualized R3F scene (oldest at the top, the present at the bottom), one row per unit at the current rung. A card's turns load when it mounts, through `getSliceContent` — there is NO client cache (`slice-cache.ts` was deleted); the server's Data Cache is what absorbs repeat reads.
- **Navigation IS the rung, and a point is `?at=`**: `?z=<rung>` names the zoom (`src/lib/chat/deep-link.ts`); `?at=<sliceId>` addresses a POINT, consumed once and then stripped so a refresh never re-jumps. The old `?view=` mode switch and its `viewport-slice.ts` publication are gone — the rung replaced them.
- **Navigation = time travel, landing IN the stream**: a slice jump overlays `RelativeTimeReadout` (the field beneath never unmounts), pages the target into the stream while the clock rolls, then lands on its seam. A miss (catalog exhausted) is an honest error toast, never a fake landing. Submitting a message cancels any in-flight transition and snaps back to the present.
- **Shared slice-card language**: the travel cover and the empty briefing share one visual identity (`FrameCard`: ring, soft shadow, hairline separators, mono eyebrow row with the primary square marker).
- **ChatInput owns its images** via `useImageAttachments`: paste, drag-drop and file picker funnel into the same state, previewed as removable thumbnails.
- **MarkdownRenderer is not `prose`-only**: custom per-element styles (tables, links, code blocks) instead of relying solely on Tailwind typography.
