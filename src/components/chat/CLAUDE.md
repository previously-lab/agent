# Chat Rendering System

## Overview

The chat rendering system is a client-side component tree that pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-flash) through a three-phase visual pipeline — recall context, reasoning, then final response — with tool calls rendered inline via a shared expandable card pattern (`ToolLayout`). The top-level container (`ChatPage`) uses `useChat` with `@ai-sdk/workflow`'s `WorkflowChatTransport` — every turn runs inside a durable Vercel Workflow run and is resumable after a dropped connection (same-session auto-reconnect, plus same-browser post-reload resume via a localStorage run id) — `MessageScroller` for virtualized auto-scroll, and bubbles with Markdown for text output. The scroller holds three stacked regions: a server-rendered hero, the memory timeline, and the live chat messages.

## Component Tree

```
ChatPage (chat-page.tsx)  ← "use client", top-level useChat container
  MessageScrollerProvider
    MessageScroller
      MessageScrollerViewport
        MessageScrollerContent
          MessageScrollerItem (hero-section)
            HeroSection  ← passed as children from [locale]/page.tsx (server component)
          MessageScrollerItem (memory-section)
            MemorySection
              TimelinePanel (past memory slices, grouped by date)
                DateGroupHeader / SliceTimeMarker  (animated date + HH:MM markers)
                TimeSliceRow (per slice)
          ChatSection (chat-section.tsx)
            MessageScrollerItem (per message)
              ChatMessage
                RecallPhase (data-flash parts, via ToolLayout)
                ThinkingSteps (reasoning parts, via ToolLayout)
                Bubble > BubbleContent
                  [ToolRenderer dispatched]  ← inline per tool-* part
                    ToolLayout (shared expandable card)
                      ├ ReadFileRenderer   (readFile)
                      ├ WriteFileRenderer  (writeFile)
                      ├ ListFilesRenderer  (listFiles)
                      ├ MemoryToolRenderer (readMemory/listMemory/readIndex)
                      └ DefaultRenderer    (unknown tools)
                  MarkdownRenderer  ← text parts
                    CodeBlock (fenced code with copy)
                  Streaming cursor (pulse span)
                MessageFooter
                  MessageActions (copy + regenerate)  ← only when onRegenerate provided
            MessageScrollerItem (thinking-indicator)  ← spinner + "Thinking..." when LLM is thinking before first part
            MessageScrollerItem (error-banner)  ← error.message when useChat surfaces an error
      MessageScrollerButton
  ChatInput (sticky bottom, textarea + image attachments + stop btn)
```

## Message Part Flow

1. `useChat` (in `ChatPage`) receives a `UIMessage` with typed `parts[]`; `ChatSection` maps them to `ChatMessage`.
2. `ChatMessage` classifies each part in `useMemo`:
   - `data-flash` → **recallParts** (phase 1: RecallPhase via ToolLayout with History icon)
   - `reasoning` → **reasoningText** (phase 2: ThinkingSteps via ToolLayout with Brain icon)
   - `text` / `tool-*` → **inlineParts** (phase 3: rendered in stream order inside a Bubble)
3. Inline text → `MarkdownRenderer` (react-markdown + GFM + highlight). Inline tool-* → `ToolRenderer`.
4. A streaming cursor `<span>` pulses at the end of inline content while `isStreaming` is true.
5. `MessageActions` (copy/regenerate) render in `MessageFooter` — currently gated on an `onRegenerate` prop that `ChatSection` does not thread, so the footer is not mounted yet.

## File Map

| File | Description |
|------|-------------|
| `chat-page.tsx` | Top-level `"use client"` container: `useChat` hook, `WorkflowChatTransport` wiring (durable-run resume — persists the `x-workflow-run-id` to localStorage, `resume` on mount; model/thinking/timezone/loadedSliceIds body via `prepareSendMessagesRequest`), MessageScroller shell, hero/memory/chat regions, sticky ChatInput |
| `chat-section.tsx` | Renders the message list (`ChatMessage` per message), the pre-first-part thinking indicator, and the error banner |
| `memory-section.tsx` | Passthrough wrapper forwarding props to `TimelinePanel` (past-memory region of the scroller) |
| `hero-section.tsx` | Server component: "Previously on {name}" landing block; name comes from `memory/user/profile.md` via `getUserName()` |
| `chat-message.tsx` | Per-message renderer: classifies parts into recall/reasoning/inline phases, wraps in Message/Bubble, footer |
| `chat-input.tsx` | Textarea with image attachments (paste/drag-drop/file picker), auto-resize, submit/stop buttons |
| `markdown.tsx` | Markdown renderer: react-markdown with remark-gfm, rehype-highlight, custom components for code/table/link/list/blockquote |
| `code-block.tsx` | Fenced code block: header bar with language label + copy button, scrollable code area |
| `message-actions.tsx` | Copy-to-clipboard and Regenerate buttons, shown on hover via group-hover opacity |
| `file-name-pill.tsx` | File path badge with code-vs-text icon detection, optional error styling |
| `tool-renderer.tsx` | Dispatcher: extracts render state, maps toolNames to specific renderers, re-exports ToolLayout |
| `tool-layout.tsx` | Shared expandable card: status icon (spinner/dot/error/interrupted), name, summary, meta, expandable content area with CSS grid row animation |
| `thinking.tsx` | Phase 2 reasoning: Brain icon, elapsed timer, markdown-rendered thought content inside ToolLayout |
| `recall-phase.tsx` | Phase 1 context recall: History icon, elapsed timer, tags/recall-hits/reasoning inside ToolLayout |
| `timeline-panel.tsx` | Past memory slices grouped by date with "load more" pagination, calls useTimeline hook, feeds `loadedSliceIds` back to the chat transport |
| `date-group-header.tsx` | `DateGroupHeader` (locale-aware animated year/month/day header) + `SliceTimeMarker` (animated HH:MM), both built on `NumberTicker` |
| `time-slice-row.tsx` | Individual memory slice: lazy-loads content, shows last exchange by default, expandable to full conversation, open loops/decisions as pills |
| `tool-renderers/read-file.tsx` | ReadFile tool: FileNamePill summary, line count meta, scrollable preview (5k char cap) |
| `tool-renderers/write-file.tsx` | WriteFile tool: FileNamePill summary, +/- line diff meta, preview of written content |
| `tool-renderers/list-files.tsx` | ListFiles tool: path + item count summary, expanded view shows file/dir list with icons |
| `tool-renderers/memory-tool.tsx` | Memory tools (readMemory/listMemory/readIndex): Search icon, path/index label summary, output preview with smart formatting for slices |
| `tool-renderers/default.tsx` | Fallback for unknown tools: Wrench icon, JSON-snippet summary, no expandable content |

## Tool Renderers

`ToolRenderer` (tool-renderer.tsx) is the dispatch hub. It calls `extractRenderState()` from `@/lib/chat/tool-state` to normalize the raw SDK state string into a `ToolRenderState` object. Each tool maps to a dedicated renderer, all sharing `ToolLayout`:

- **ReadFileRenderer** — shows `FileNamePill` + line count + scrollable code preview (5k char cap). Error state tints the pill red.
- **WriteFileRenderer** — shows `FileNamePill` + `+N/-0` diff meta + content preview. Distinguishes "Create" vs "Update" via output text.
- **ListFilesRenderer** — shows path + item count. Expanded view lists entries with folder/file icons.
- **MemoryToolRenderer** — shows human-friendly name ("Recalling in detail...", "Scanning timeline...") + path/index label. Expanded view shows raw tool name + output, smart-formatted for slices (month/year grouping).
- **DefaultRenderer** — shows friendly-cased tool name + first 40 chars of JSON input. No expandable content.

Every renderer passes `state` to `ToolLayout`, which handles: running spinner, error (red), interrupted (yellow), denied (red), and expand/collapse with a CSS `grid-template-rows` transition on the details panel.

**Human-friendly display names** (defined in tool-renderer.tsx): `readMemory` becomes "Recalling in detail...", `listMemory` becomes "Recalling more...", `readIndex` becomes "Scanning timeline...". All others get capitalized first letter.

## Design Decisions

- **Three-phase rendering** (recall → think → respond) mirrors the agent's internal execution order. Each phase gets its own `ToolLayout`-based component for visual consistency, but they are rendered at the `ChatMessage` level (outside the Bubble) so they aren't treated as inline content.
- **ChatPage owns the scroller, ChatSection owns the messages**: the top-level `useChat` state lives in `ChatPage`, which lays out three scroller regions (hero, memory, chat). `ChatSection` is a pure child that maps `messages` to `ChatMessage` and renders the thinking/error banners.
- **Tool calls inline in stream order** rather than grouped at the end, matching the AI SDK's natural streaming sequence. Tools and text interleave as they arrive.
- **ToolLayout as the universal tool card** handles five states (running, completed, error, interrupted, denied) and expand/collapse with pure CSS grid animation — no JS height measurement. Every tool renderer delegates to it.
- **Bubble component from `@/components/ui/bubble`** wraps all inline parts (text + tool calls) so tool renderings visually sit inside the message bubble, not outside it.
- **RecallPhase / ThinkingSteps reuse ToolLayout** instead of duplicating the expandable card pattern. They pass static `COMPLETED_STATE` / `STREAMING_STATE` objects since these aren't real tool calls.
- **Auto-scroll via MessageScroller** (custom in `@/components/ui/message-scroller`): scrolls to the last user message anchor, not the latest assistant token, so the viewport stays stable during streaming.
- **MarkdownRenderer is not `prose`-only**: it has custom per-element styles (tables with borders, links as blue with underline, code blocks with background, etc.) instead of relying solely on Tailwind typography prose classes.
- **TimelinePanel sits above messages** (in the memory-section region) rather than inside the message list, showing past context as a scrollable date-grouped index. It uses `useTimeline` for pagination and feeds `loadedSliceIds` back to the chat transport.
- **ChatInput owns its images** via `useImageAttachments` hook: paste, drag-drop, and file picker all funnel into the same state. Images are previewed as thumbnails with remove buttons.
</content>
</invoke>
