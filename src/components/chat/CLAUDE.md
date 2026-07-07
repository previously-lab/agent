# Chat Rendering System

## Overview

The chat rendering system is a client-side component tree that pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-flash) through a three-phase visual pipeline — recall context, reasoning, then final response — with tool calls rendered inline via a shared expandable card pattern (`ToolLayout`). The container uses `useChat` with `DefaultChatTransport` for streaming, `MessageScroller` for virtualized auto-scroll, and bubbles with Markdown for text output.

## Component Tree

```
Chat (index.tsx)
  MessageScrollerProvider
    MessageScroller
      MessageScrollerViewport
        MessageScrollerContent
          TimelinePanel (past memory slices, grouped by date)
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
                MessageActions (copy + regenerate)
          Thinking indicator (spinner when LLM is thinking before first part)
          Error banner
      MessageScrollerButton
  ChatInput (sticky bottom, textarea + image attachments + stop btn)
```

## Message Part Flow

1. `useChat` receives a `UIMessage` with typed `parts[]`.
2. `ChatMessage` classifies each part in `useMemo`:
   - `data-flash` → **recallParts** (phase 1: RecallPhase via ToolLayout with History icon)
   - `reasoning` → **reasoningText** (phase 2: ThinkingSteps via ToolLayout with Brain icon)
   - `text` / `tool-*` → **inlineParts** (phase 3: rendered in stream order inside a Bubble)
3. Inline text → `MarkdownRenderer` (react-markdown + GFM + highlight). Inline tool-* → `ToolRenderer`.
4. A streaming cursor `<span>` pulses at the end of inline content while `isStreaming` is true.
5. `MessageActions` (copy/regenerate) appear in the footer on hover for finished assistant messages.

## File Map

| File | Description |
|------|-------------|
| `index.tsx` | Top-level Chat container: `useChat` hook, MessageScroller wiring, streaming/error states, sticky ChatInput |
| `chat-message.tsx` | Per-message renderer: classifies parts into recall/reasoning/inline phases, wraps in Message/Bubble |
| `chat-input.tsx` | Textarea with image attachments (paste/drag-drop/file picker), auto-resize, submit/stop buttons |
| `markdown.tsx` | Markdown renderer: react-markdown with remark-gfm, rehype-highlight, custom components for code/table/link/list/blockquote |
| `code-block.tsx` | Fenced code block: header bar with language label + copy button, scrollable code area |
| `message-actions.tsx` | Copy-to-clipboard and Regenerate buttons, shown on hover via group-hover opacity |
| `model-pill.tsx` | Inline badge showing model name with optional reasoning-effort label |
| `file-name-pill.tsx` | File path badge with code-vs-text icon detection, optional error styling |
| `summary-bar.tsx` | Tool-call count + elapsed timer + expand/collapse toggle with animated status words (Pondering/Crafting/Analyzing/etc.), not currently wired into ChatMessage |
| `tool-renderer.tsx` | Dispatcher: extracts render state, maps toolNames to specific renderers, re-exports ToolLayout |
| `tool-layout.tsx` | Shared expandable card: status icon (spinner/dot/error/interrupted), name, summary, meta, expandable content area with CSS grid row animation |
| `thinking.tsx` | Phase 2 reasoning: Brain icon, elapsed timer, markdown-rendered thought content inside ToolLayout |
| `recall-phase.tsx` | Phase 1 context recall: History icon, elapsed timer, tags/recall-hits/reasoning inside ToolLayout |
| `slash-command-dropdown.tsx` | / command autocomplete popup: keyboard nav, matches skills via registry, click/Enter to select |
| `dashed-separator.tsx` | Simple `<div>` with dashed border-top, used as visual divider in timeline |
| `timeline-panel.tsx` | Past memory slices grouped by date with "load more" pagination, calls useTimeline hook |
| `time-slice-row.tsx` | Individual memory slice: lazy-loads content, shows last exchange by default, expandable to full conversation, open loops/decisions as pills |
| `time-slice-recovery.tsx` | Session resume card: "Continue" button + focus + summary when returning after refresh, or first-time welcome if no history |
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
- **Tool calls inline in stream order** rather than grouped at the end, matching the AI SDK's natural streaming sequence. Tools and text interleave as they arrive.
- **ToolLayout as the universal tool card** handles five states (running, completed, error, interrupted, denied) and expand/collapse with pure CSS grid animation — no JS height measurement. Every tool renderer delegates to it.
- **Bubble component from `@/components/ui/bubble`** wraps all inline parts (text + tool calls) so tool renderings visually sit inside the message bubble, not outside it.
- **MemoryPhase / ThinkingSteps reuse ToolLayout** instead of duplicating the expandable card pattern. They pass static `COMPLETED_STATE` / `STREAMING_STATE` objects since these aren't real tool calls.
- **Auto-scroll via MessageScroller** (custom in `@/components/ui/message-scroller`): scrolls to the last user message anchor, not the latest assistant token, so the viewport stays stable during streaming.
- **MarkdownRenderer is not `prose`-only**: it has custom per-element styles (tables with borders, links as blue with underline, code blocks with background, etc.) instead of relying solely on Tailwind typography prose classes.
- **TimelinePanel sits above messages** rather than inside message list, showing past context as a scrollable date-grouped index. It uses `useTimeline` hook for pagination and feeds `loadedSliceIds` back to the chat transport.
- **ChatInput owns its images** via `useImageAttachments` hook: paste, drag-drop, and file picker all funnel into the same state. Images are previewed as thumbnails with remove buttons.
- **SlashCommandDropdown is not wired into ChatInput** — it's a standalone component currently, though it reads from the skills registry and supports full keyboard navigation.
