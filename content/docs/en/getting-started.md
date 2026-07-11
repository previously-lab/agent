# Getting Started

Previously replaces chat threads with a single, continuous relationship organized on a vertical timeline — you just show up and talk, and the agent decides what past context is relevant per message.

## The Interface

A fixed **AppHeader** spans the top of every page: the "Previously" logo on the left, with GitHub, Docs, Settings, theme toggle, and language toggle on the right. Always visible regardless of scroll position.

The page is one vertical scroller in three sections, top to bottom:

1. **Full-screen hero** — `"Previously on {your name}"` rendered in a cinematic text-reveal animation. Navigation links and appearance controls have moved to the AppHeader, keeping the hero clean and focused.
2. **Memory timeline** — your past slices, oldest at the top, newest at the bottom, grouped by date with per-slice timestamps and a "load more" button for older history.
3. **Live chat messages** — the ongoing conversation, streaming in real time.

Below all three, **pinned to the bottom of the screen**, sits a sticky input bar: a textarea that auto-resizes from 24 px to 72 px max. Enter submits; Shift+Enter adds a newline. When the agent is streaming, the submit arrow becomes a square stop button. The toolbar offers image attachment (paste, drag-drop, or file picker; `image/*` only, 10 MB per file).

The whole layout lives inside a single `MessageScroller` — scroll up to revisit the past, scroll down to continue where you left off.

> **Key takeaway: there is no conversation list, no thread management, no "new chat" button. The timeline IS the conversation list.**

```preview
demo: tool-layout
```

## How Memory Forms as You Talk

Memory is not something you manage — it forms automatically while you talk.

A **slice** is one conversation burst. It opens when you start typing, stays active while you're engaged, and closes after 30 minutes of silence. That's the only rule. No capacity limits, no topic-shift detection, no ML-driven false splits. Pure time-driven slicing.

Every close slice writes a Markdown file at:

```
memory/episodic/slices/2025/11/21/0825.md
```

The path is the timestamp: year, month, day, and the hour-minute of the first message. The file carries YAML frontmatter — focus, summary, decisions, open loops, emotional tone, and tags — all maintained by the agent per round. You never annotate anything by hand.

Read top to bottom across months and years, the slice directory is your autobiography. Git-diffable, human-readable, portable.

```preview
demo: slice-file
```

## Asking About Your Past: Watching Recall Work

When you ask something that touches the past — "What did I decide about the housing project?" or "Remind me when I last talked to Sarah" — Previously runs a visible two-tier recall that renders as expandable cards above the answer.

1. **Flash recall** (~500 ms, DeepSeek-chat) — scans recent slice summaries and the strand index (`memory/episodic/strands.json`). It returns **pointers** to relevant slices: slice IDs, relevance scores, and a reason for each hit. This is the fast, approximate pass. It also maintains the active slice's metadata (summary, tags, open loops) as a side effect — no separate post-processing step.

2. **Deep recall** (Pro, the main model) — receives Flash's pointers and decides which slices to read in full via the `readMemory` tool. The tool call shows as an inline card labeled `"Recalling in detail..."`. If Flash found nothing, the model can explore the directory on its own.

The recall results render inside a shared `ToolLayout` card with a History icon:

- **Collapsed**: shows the elapsed time (e.g. "1s").
- **Expanded**: shows Flash's reasoning text, a list of recall hits (slice ID, reason, relevance percentage), and the tags it found relevant.

Tool calls during deep recall render as inline cards with human-friendly labels:

| Tool | You See |
|------|---------|
| `readMemory` | Recalling in detail... |
| `listMemory` | Recalling more... |
| `readIndex` | Scanning timeline... |

Each card has five visual states: **running** (spinning loader), **completed** (green dot), **error** (red), **interrupted** (yellow), **denied** (red). Click or press Enter/Space to expand and see the full tool output — no JS height measurement, just a CSS `grid-template-rows` transition.

The message itself renders in three phases, matching the agent's internal execution order: **Recall** → **Reasoning** → **Response**. You see the agent scan the timeline, think, and then answer — all in one message.

```preview
demo: recall-phase
```

## First-Run Experience: Demo Mode

Previously does not have an in-app onboarding wizard. Instead, it ships a **DEMO_MODE** environment flag that transforms the deployment into a read-only tour.

Set `DEMO_MODE=true` in your environment and every `memory/` read is redirected to `memory/demo/personal_14/` — a seeded fictional persona spanning 30+ slices and several years of conversations. A fixed banner at the top of the screen tells you nothing written is saved. Writes appear to succeed but never hit the repository; refresh the page and the slate resets.

The live demo is at [previously-demo.ldwid.com](https://previously-demo.ldwid.com). It runs the full two-tier recall system (Flash + Pro), so you can browse the timeline, scroll through past slices, chat freely, and watch recall work — all without setting up your own deployment.

> **Important: the demo dataset is not in the `main` branch of the repository.** It lives on the `DEMO_REF` branch and is served by GitHub reads pinned to that branch when `DEMO_MODE` is on. Trying to browse `memory/demo/personal_14/` locally on `main` will find nothing.

### Starting Your Own Timeline

To move from demo to your own timeline:

1. Deploy Previously with your own GitHub repository and a GitHub personal access token (contents read/write scope).
2. Leave `DEMO_MODE` unset or set to `false`.
3. That's it. The first message you type opens your first slice.

There is no account creation, no database setup, and no seed data. The timeline starts empty. Memory accumulates from your first conversation forward.

## Strands: The Semantic Layer Over Time

As slices accumulate, the agent builds a lightweight keyword index called **strands**. A strand is a topic keyword — like `work`, `family`, `housing` — that recurs across multiple slices. The file `memory/episodic/strands.json` maps each strand to every slice that carries it.

Flash scans the strand index during recall to find slices by topic, not just by recency. If you've talked about "housing" across 30 slices across three years, Flash finds them through the strand index, then Pro reads the actual content.

```preview
demo: strands-index
```

> **Roadmap:** Strands today are a thin keyword-to-slice index. A richer first-class strand with rolling summaries and deep recall integration is a future milestone. For now, the index is lossless — it points to every relevant slice, and Pro reads what it needs.

## What This Means Day to Day

There are no rituals. You don't open a "new conversation." You don't tag or classify anything. You don't manage memory.

- **Show up** — open the page. The timeline is there, pre-loaded with your recent past. The hero says "Previously on {your name}."
- **Talk** — type and press Enter. If it's been more than 30 minutes, a new slice opens. The agent reads the timeline, scans for relevant context, and responds.
- **Ask about the past** — "What did I decide about X?" or "When did Y happen?" Flash scans the summaries and strand index, Pro reads the full slices, and you see the tool cards appear and resolve.
- **Scroll** — the timeline above the live chat is your full history. Date-grouped, paginated, with cinematic "N minutes/hours/days later" title-cards that fill the gap between the last recorded moment and now.

That's the loop. No setup, no cleanup, no thread management. Just one continuous conversation with memory that works.

## Project Status

**Previously is in active early development and not yet ready for personal or production use** (status: experimental). This guide documents v0.1.0 as it exists in the code. The core architecture is functional, but many subsystems are still being designed and built. The Getting Started docs frame it as a personal self-hosted deployment, not a SaaS signup.

## Related

- [Memory Model](/content/docs/en/memory-model) — slices, strands, nodes, the whitelist, and context assembly under a token budget
- [Architecture Overview](/content/docs/en/architecture) — three-layer separation, the agent loop, and the edge deployment model
- [Agent Loop](/content/docs/en/agent-loop) — the execution pipeline from trigger to response
