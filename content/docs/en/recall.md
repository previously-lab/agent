# Recall

Recall is how Previously retrieves relevant past conversations — a two-tier engine where a fast Flash pass returns lightweight pointers, then the main Pro model reads the slices it chooses, all in a single request-response cycle.

## The Two-Tier Recall Engine

Episodic memory in Previously is stored as **slices** — Markdown files at paths like `memory/episodic/slices/2025/11/21/0825.md`, one per conversation burst, opened when you talk and closed after 30 minutes of silence. Over weeks and months these accumulate into a deep archive. The challenge: how does the agent find what matters without reading everything every time?

Previously splits the problem into two reflexes:

| Layer | Model | Cost | What it does |
|-------|-------|------|-------------|
| **Flash** (conditioned reflex) | DeepSeek-chat | Fast, temperature 0.1 | Scans recent slice summaries, returns **pointers** — `{ slice_id, relevance, reason }` — never full content |
| **Pro** (deliberate reasoning) | User's chosen model (default DeepSeek-chat) | Slower, may enable thinking | Receives pointers, reads full slices on demand via `readMemory`, explores the directory when Flash finds nothing |

Flash is fallible by design. It trades completeness for speed: it reads summaries, not full bodies. Pro is the safety net — it can dig deeper wherever Flash's pointers lead, or start from scratch and explore the directory tree.

> **Key takeaway**: Flash answers "where to look." Pro answers "what does it mean." Neither replaces the other.

### Step 1: Flash Recall (~500ms observed)

Flash runs **before** the response stream opens. Each user request triggers one unified call (`runUnifiedFlash` in `src/lib/episodic/maintenance.ts`) that does three jobs in a single round-trip:

1. **Intent classification** — what kind of request is this (chat, task, memory, etc.)
2. **Recall scan** — read recent closed-slice summaries (up to 15, from monthly `_index.json` files) and judge relevance
3. **Metadata maintenance** — propose updates to the active slice's focus, summary, decisions, and tags

Flash returns a structured `flashOutput` with a `recall_hits` array. Each hit is a pointer — a slice id, a relevance score (0-1), and a one-line reason why it matches. The model is prompted to return up to 5; `MAX_RECALL_HITS` (12) caps context injection only (`buildTimelineEpisodicContext`) — display renders all recall hits uncapped.

The output is deterministic (tool choice: required, temperature 0.1) and reliability-critical. If the call fails, it retries once after 300ms, then falls back to safe defaults — intent `chat`, confidence 0.3, empty recall hits — so the conversation never stalls.

**What Flash does NOT read**: the strand index (`strands.json`). Despite appearing in earlier roadmap descriptions, the shipped code only scans slice summaries. The strand index — a keyword-to-slice-paths map built at slice-close — is present on disk but not wired into recall yet. Pro can reach it manually via `readMemory` if needed.

```preview
demo: recall-phase
```

The recall phase renders as a collapsible card with a History icon. Collapsed: duration in seconds. Expanded: the recall text (Markdown), each hit as a `slice_id` + reason + relevance percentage, an italic reasoning line, and topic tag pills.

### Step 2: Deep Recall

Flash's pointer list is injected into Pro's system prompt. Pro decides which slices to open in full by calling the `readMemory` tool on specific file paths. It has three tools for recall exploration:

| Tool | Purpose |
|------|---------|
| `readMemory` | Read the full body of any file inside `memory/` |
| `listMemory` | List contents of a directory inside `memory/` |
| `readIndex` | Read a monthly `_index.json` to browse slice summaries by month |

When Flash found hits, Pro receives guidance: "These summaries are usually enough — only `readMemory` a specific slice if you need a detail they don't carry." When Flash found nothing, Pro is told to explore the directory directly — starting with `strands.json` if it wants a keyword index, or browsing monthly indices.

Consecutive memory-read tools in the response are collapsed into a single "RecallGroup" card: the 'timeline' category (`readMemory` + `readIndex`) uses the label "Read N timeline records", while the 'browse' category (`listMemory`) uses "Recalled N more".

### Step 3: Metadata Maintenance

The same Flash call that performs recall also proposes metadata updates for the **active slice** — the one currently being written in this conversation. Every round, Flash suggests new values for:

- `focus` — what the conversation is about right now
- `summary` — a one-line recap
- `decisions` — decisions reached
- `open_loops` — unresolved threads to revisit
- `tags` — keyword labels
- `emotional_tone` — the conversational mood

The route applies these in place each round (`applyMetadataUpdates`), so the index stays fresh without a separate post-processing pass. This is the third job folded into the unified Flash call, and it's why a single round-trip replaces the old split-classifier architecture.

## Three-Phase Chat Rendering

A single assistant message renders in three visually distinct phases, split by part type in `ChatMessage`:

```
Recall (History icon, expandable card, outside bubble)
    |
    v
Reasoning (Brain icon, expandable card, outside bubble)
    |
    v
Response (text + inline tool calls in a Bubble)
```

```preview
demo: thinking-steps
```

### 1. Recall Phase

The server writes a `data-flash` part into the AI-SDK stream with `phase: "recall"`, `done: true`, `durationMs`, `text`, `tags`, `reasoning`, and `recall_hits`. The client renders it as `RecallPhase` — a `ToolLayout` expandable card with a History icon.

- **Collapsed summary**: duration rounded to seconds (minimum 1s)
- **Expanded content**: recall text via `MarkdownRenderer`, each hit shown as `slice_id` (mono) + reason + `Math.round(relevance * 100)%`, italicized reasoning line, and tag pills

The recall text reads either "Recalled N conversations related to <up-to-3 topics>" or "Scanned recent conversations — no directly relevant matches found".

Recall and Reasoning phases are **not real tool calls**. They reuse the shared `ToolLayout` expandable-card component with static completed/streaming states so they render visually like tools, but they sit **outside** the message bubble.

### 2. Reasoning Phase

When Pro has thinking enabled (default: on, reasoning effort "medium", controlled by `body.thinking`), the server measures thinking duration by recording the wall-clock time between the first reasoning chunk and the first text chunk. It emits a `data-reasoning` part with `durationMs`.

The client renders it as `ThinkingSteps` — a `ToolLayout` expandable card with a Brain icon.

- **Collapsed summary**: "Thought · Ns" timer (minimum 1s)
- **Expanded content**: the reasoning markdown

Using `data-reasoning` (not client-side timers) means the duration survives re-renders and hydration.

### 3. Response Phase

The response body renders inside a `Bubble`. Text flows through `MarkdownRenderer` (react-markdown + remark-gfm + rehype-highlight). Tool calls appear inline in the order Pro invoked them, each wrapped in a per-tool renderer:

| Tool | Display name |
|------|-------------|
| `readMemory` | "Recalling in detail..." |
| `listMemory` | "Recalling more..." |
| `readIndex` | "Scanning timeline..." |

When two or more memory-read tools appear consecutively, `groupInlineParts` collapses them into a single `RecallGroup` card. The 'timeline' category (`readMemory` + `readIndex`) uses "Read N timeline records" (`chat.recall.group`); the 'browse' category (`listMemory`) uses "Recalled N more".

## Related

- [Slices](/docs/en/slices) — how slices are created, closed, and indexed
- [Strands](/docs/en/strands) — the semantic keyword index across slices (experimental)
- [Architecture](/docs/en/architecture) — the full component tree for message rendering
