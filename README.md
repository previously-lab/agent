<p align="center">
  <img alt="Previously" src="https://raw.githubusercontent.com/LikeDreamwalker/Aftrbrez/main/public/previously-on-you.png" width="600">
</p>

<p align="center">
  <strong>Previously on you.</strong>
</p>

<p align="center">
  <a href="https://previously-demo.ldwid.com"><strong>previously-demo.ldwid.com</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: Experimental">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://sdk.vercel.ai"><img src="https://img.shields.io/badge/AI_SDK-v7-8b5cf6" alt="AI SDK v7"></a>
  <img src="https://img.shields.io/badge/Next.js-16.2-black" alt="Next.js 16.2">
  <img src="https://img.shields.io/badge/TypeScript-6.x-3178C6" alt="TypeScript 6">
  <img src="https://img.shields.io/badge/memory-episodic-ec4899" alt="Memory: Episodic">
</p>

---

## Previously — an agent that always remembers

Previously is a lightweight cloud agent that lives on the edge — always available, never forgetting. Open a browser tab and it's there. It can read, write, reason, and act on your behalf. What makes it different isn't any single feature — it's that there are no "conversations." Just one continuous relationship, organized on a timeline.

Most AI agents split your life into chat threads. Each new thread starts cold. Memory exists but is siloed, fragile, lossy. The conversation list — an artifact of messaging apps — became the default interaction model for AI, even though human relationships don't work that way.

Previously replaces chat threads with **time slices**: episodic memory organized the way human memory actually works. You don't manage conversations. You just show up and talk. The agent figures out what's relevant — scanning *when* something happened, then retrieving *what* was said.

And because context is assembled dynamically from the timeline rather than crammed into a growing prompt window, there's no point where the agent suddenly "forgets" the beginning of a long exchange. The timeline grows, but what's loaded into each request stays bounded and relevant.

The name comes from how TV series recap previous episodes: *"Previously on…"* — a brief reminder of what happened last time, just enough context to pick up where you left off.

### Why this matters

Two problems that are really one:

1. **Memory across conversations is broken.** AI agents have memory, but it's siloed per chat thread. Cross-conversation recall requires hacking together vector databases, RAG pipelines, and fragile prompt engineering — and it still feels like talking to someone with amnesia.

2. **The conversation is not the right container.** Humans don't organize their memories into "Chat #47 with Mom." They remember by *when* something happened and *what it was about*. The conversation list is a UI artifact — not a cognitive model.

Fixing the memory model also fixes the interaction model. If an agent genuinely remembers you across time and topics, you don't need conversation management. You just show up and talk.

---

## Previously, Slice and Strand

Like a TV series that opens each episode with *"Previously on…"*, every time you return, the first thing you see is a timeline of your past. Not a list of chat threads. Not a search bar. A vertical timeline — your story, read top to bottom. The live conversation happens below it. Scroll up to revisit the past. Scroll down to continue where you left off.

A **slice** is one conversation burst — a Markdown file on that timeline. It opens when you start talking, stays active while you're engaged, and closes automatically after 30 minutes of silence. Each slice carries YAML frontmatter with a focus, summary, decisions made, open loops, emotional tone, and tags:

```
memory/episodic/slices/2025/11/21/0825.md
```

Read top to bottom across months and years, slices are your autobiography.

A **strand** is a keyword — like `work`, `family`, `health`, `housing` — that appears across multiple slices. `memory/episodic/strands.json` maps each strand to every slice that carries it. The `work` strand links 30 slices spanning 2022 to 2025 — every conversation about work, across years, in one place. A strand is the semantic layer over the timeline: *"the whole history of that thing."*

> Slice = what happened. Strand = what it was about. Together they give you both episodic and semantic memory — remembering by time, and remembering by topic.

<p align="center">
  <img alt="Timeline view" src="https://raw.githubusercontent.com/LikeDreamwalker/Aftrbrez/main/public/timeline-screenshot.png" width="700">
</p>

<p align="center">
  <img alt="Timeline detail — Now marker, time gaps, and active slice" src="https://raw.githubusercontent.com/LikeDreamwalker/Aftrbrez/main/public/timeline-detail.png" width="700">
</p>

<p align="center">
  <sub>Each slice carries a summary. Time gaps between slices get natural labels — "Now," "Seven months later" — so scrolling the timeline feels like turning pages.</sub>
</p>

---

## Try the demo

A read-only demo is live at **[previously-demo.ldwid.com](https://previously-demo.ldwid.com)**. It's seeded with a fictional persona spanning several years of conversations — you can browse the timeline, scroll through past slices, and chat freely. All memory writes are disabled so everyone shares the same clean starting point; refresh the page and the slate resets.

The demo runs on two models: **DeepSeek V4 Flash** handles the fast recall scan and metadata maintenance, and **DeepSeek V4 Pro** handles the deep reasoning and response generation. Same two-tier architecture described above, running live.

---

## How it works

Slices and strands give you the storage model. The engine that brings them to life is a two-tier recall system modeled on how human memory actually works.

### The file structure

```
memory/episodic/slices/
├── 2022/
│   ├── 01/
│   │   ├── _index.json
│   │   └── 08/
│   │       └── 1130.md    ← "January 8, 11:30 — First intake"
│   └── 02/
│       ├── _index.json
│       └── 11/
│           └── 0020.md    ← "February 11, 00:20 — Late-night check-in"
├── 2023/
│   └── 04/
│       ├── _index.json
│       └── 21/
│           └── 0610.md    ← "April 21, 06:10 — Trust crisis"
├── 2024/
│   └── ...
└── 2025/
    └── 11/
        ├── _index.json
        └── 21/
            └── 0825.md    ← "November 21, 08:25 — Year-end review"
```

Every file is plain Markdown with YAML frontmatter. A slice opens when you start talking and closes after 30 minutes of silence. The tags in each slice feed `memory/episodic/strands.json` — a lightweight index mapping each keyword to every slice that carries it.

Open one up and it looks like this:

```markdown
---
slice_id: 2023-04-21-0610
focus: Housing project delays and trust crisis management
status: closed
start: "2023-04-21T06:10:00.000Z"
end: "2023-04-21T07:18:00.000Z"
timezone: America/Chicago
summary: Contractor qualification and property deed mismatches stalled
  multiple household files, triggering a community trust crisis...
decisions:
  - Prioritize direct phone calls to affected households before public meetings
  - Use 'real blocker plus specific next step' frame in public communication
open_loops:
  - Whether overall community trust can recover after timeline delays
  - How to balance individual calls and collective meetings under tight resources
tags:
  - work-pressure
  - housing-project
  - trust-crisis
  - community-communication
emotional_tone: mixed
---

## Turn 1 — 2023-04-21T06:10:00.000Z (user)

The housing rehab files that were supposed to close this month are
stalled again. At the public meeting last night residents were angry...

## Turn 2 — 2023-04-21T06:13:00.000Z (agent)

That sounds rough. What specifically broke down — contractor
qualification, property deeds, or something else?
```

Human-readable. Git-diffable. Any tool can parse it.

This design is grounded in **Endel Tulving's theory of episodic memory** (1972, *Organization of Memory*) — the distinction between episodic memory (events tied to *when* they happened) and semantic memory (abstract knowledge about *what* something is). Previously implements both: slices are episodic, strands and memory nodes are semantic. The recall system scans *when* first, then retrieves *what*.

The approach is also informed by research on **context-dependent memory** (Godden & Baddeley, 1975; Smith & Vela, 2001) — recall works best when the retrieval context matches the encoding context. By preserving every conversation in its full temporal context, Previously gives the agent the richest possible retrieval cues.

### How recall works

When you send a message, three things happen in sequence:

1. **Flash recall** (~500ms) — a fast, lightweight model scans recent slice summaries and the strand index. It returns *pointers* to relevant slices, not full content. This is the "conditioned reflex" layer — quick, cheap, approximate.

2. **Deep recall** — the main model receives those pointers and decides which slices to read in full. It calls `readMemory` to pull the actual conversation content. If Flash found nothing, the model can explore the directory on its own.

3. **Metadata maintenance** — every round, Flash updates the active slice's summary, focus, open loops, decisions, and emotional tone. The index stays fresh without expensive post-processing.

<p align="center">
  <img alt="Recall phase — Flash found matching slices" src="https://raw.githubusercontent.com/LikeDreamwalker/Aftrbrez/main/public/recall-phase.png" width="700">
</p>

<p align="center">
  <img alt="Agent response after recall" src="https://raw.githubusercontent.com/LikeDreamwalker/Aftrbrez/main/public/recall-response.png" width="700">
</p>

<p align="center">
  <sub>Flash scans the timeline in ~500ms, returns pointers to relevant slices, then Pro reads the full content and writes the response. Fast approximate scan → deep targeted retrieval — in under a second total.</sub>
</p>

---

## Context is the new model

I believe that over the next decade, **context quality will matter more than model capability.** A smaller model with perfect context will outperform a larger model with generic context. The bottleneck isn't reasoning — it's knowing what's relevant.

This conviction shaped two architectural choices that set Previously apart from most AI apps.

### Why edge: an agent you can reach from anywhere

A personal agent shouldn't require carrying a device, keeping a machine running, or installing anything. It should be like checking your email — open a browser tab, and it's there.

Previously runs as a pure cloud agent on edge infrastructure. The deployment compiles to a set of serverless functions distributed globally — cold starts measured in milliseconds, responses streamed from the edge nearest to you. No local GPU. No Docker. No always-on desktop. Just a URL.

The point of putting the agent on the edge isn't performance bragging rights — it's availability. You can reach it from a phone at 2 AM. It can think while you sleep. The agent exists independent of any single device.

### Why GitHub: memory that belongs to you

A personal agent accumulates something more valuable than any model weights — your **context**. Years of conversations. Decisions made. Preferences learned. Open loops and follow-ups. That context shouldn't live inside a platform database, encrypted and locked to one product. It should be yours, in a form you can read, move, and pass to other tools.

So Previously stores everything as plain Markdown files in a GitHub repository. There is no database. No vector store. No proprietary format.

This means four things:

- **You own it.** Every conversation, every fact the agent knows about you — it's all in your GitHub repo. Clone it. Back it up. It's yours.

- **Any agent can read it.** Previously writes memories. Claude Code reads them. Codex extends them. The files are Markdown with YAML frontmatter — no SDK, no lock-in. Your context is portable across the entire ecosystem of AI tools.

- **Version control is free.** Branches for experimental memory exploration. Commits for a complete audit trail. Pull requests for reviewing what the agent learned about you. `git log memory/` is your relationship's full history.

- **Data loss is not the problem.** Storage was never the bottleneck. Your memories are files in a repo — they won't vanish. The hard problem is *recall*: finding the right memory at the right time. That's what Previously works on.

### Where this is going: cloud-light, local-heavy

The cloud agent handles fast responses and continuous awareness — the thin layer that keeps the relationship alive. But heavy work (code generation, multi-file operations, deep research) belongs on local machines with full compute resources.

I'm building toward a **connector** that bridges the cloud agent to local agents (Claude Code, Codex, your own) through GitHub as the shared state layer. The cloud agent stays aware. Local agents do the deep work. Same memory. Different execution environments. Each doing what it does best.

---

## Project status: experimental

**Previously is in active early development and not yet ready for personal or production use.** The core architecture is functional, but many subsystems are still being designed and built. I'm sharing it openly because I believe the ideas are worth discussing and the community's input will shape where it goes.

**This project will be maintained long-term.** It's not a weekend hack or a throwaway prototype — it's a genuine attempt to rethink how humans and AI relate to each other over time.

### What works today

- Streaming chat with tool-call visibility
- Time-slice storage with automatic slicing (30min silence rule)
- Flash recall scanning + deep recall via `readMemory` tool
- Per-round metadata maintenance (summary, focus, decisions, open loops, tags)
- Timeline UI with fade effects for historical slices
- Episodic context assembly in time-grouped format (Now / This Week / Months Ago / Last Year)
- Memory node system (markdown + YAML frontmatter + index graph)
- GitHub file tools with path whitelist security
- Multi-model support (DeepSeek, Anthropic, via AI SDK)
- Internationalization (English & Chinese)

### What I'm building next

See the [Roadmap](#roadmap) below for the full plan.

---

## Quick start

> **Note:** Previously requires a GitHub repository for memory storage and API keys for AI model access. It's designed as a personal deployment, not a SaaS product.

### Prerequisites

- Node.js 20.9+
- pnpm (recommended)
- A GitHub repository (private recommended — this holds your personal memory)
- A GitHub personal access token with `contents` read/write scope
- API keys for your LLM provider (DeepSeek, Anthropic, etc.)

### Installation

```bash
git clone https://github.com/LikeDreamwalker/Aftrbrez.git
cd Aftrbrez
pnpm install
```

### Configuration

Create a `.env.local` file:

```bash
# GitHub — your memory repository
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-memory-repo

# AI Provider — choose one or more
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx

# Optional: demo mode (uses built-in persona data)
DEMO_MODE=true
```

### Development

```bash
pnpm dev          # Start dev server with Turbopack (port 3000)
pnpm build        # Production build
pnpm lint         # Run ESLint
pnpm test         # Run vitest
```

### Deploy

The easiest deployment path is Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/LikeDreamwalker/Aftrbrez)

Set the same environment variables in your Vercel project settings.

---

## Roadmap

> Timelines are indicative, not commitments. This is a one-person research project — velocity depends on what I learn at each stage.

### Short-term — Memory foundations

Solidify the core memory loop: how the agent stores, recalls, and manages what it knows.

- **Unified Flash recall** — single Flash call for intent classification + recall scanning + metadata maintenance (in progress)
- **Parallel timeline indexing** — topic-based cross-references across time slices for faster targeted recall
- **Multi-branch memory** — experimental branches for memory exploration without corrupting the main timeline
- **Memory version control** — git-native diff and review for what the agent learned and when
- **Recall quality metrics** — measure precision/recall of Flash suggestions, build feedback loop for improvement

### Mid-term — Agent capabilities

Fully equip the agent to read, write, and manage the GitHub repository that holds its memory.

- **Complete GitHub toolset** — branch management, diff viewing, PR creation for memory changes
- **Repository awareness** — agent understands repo structure, can navigate code and data together
- **Task loop engine v2** — multi-step autonomous task execution with checkpointing and resume
- **Cross-session continuity** — agent maintains context across days/weeks without losing track of open loops and pending decisions
- **Semantic memory extraction** — automatic extraction of facts, preferences, and patterns from episodic memory into structured knowledge nodes

### Long-term — Cloud-local hybrid

The real vision: a lightweight cloud agent that stays aware, paired with local heavy-lifting agents that do deep work — all reading from the same GitHub memory.

- **Third-party connector framework** — cloud agent bridges to local agents (Claude Code, Codex, custom) via GitHub as the shared state layer
- **Local agent protocol** — standardized interface for local agents to read/write memory, register capabilities, and report results
- **Hybrid task routing** — cloud agent handles quick responses and continuous awareness; local agents take on heavy computation, code generation, and multi-file operations
- **Offline-first memory** — local memory cache with sync to GitHub when online; agent works regardless of connectivity
- **Multi-agent collaboration** — multiple specialized agents (code, research, personal) share the same memory, coordinated through the timeline

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   Browser / Phone                 │
│              (Next.js App Router UI)              │
└────────────────────┬─────────────────────────────┘
                     │  HTTP + Streaming
┌────────────────────▼─────────────────────────────┐
│               Vercel Pro (orchestration)          │
│  ┌──────────────────────────────────────────┐    │
│  │  Chat API (single /api/chat endpoint)    │    │
│  │  1. Housekeeping (30min slice check)     │    │
│  │  2. Flash — unified intent+recall+maintain│   │
│  │  3. M3 Context Assembly                  │    │
│  │  4. Episodic Context → Timeline format   │    │
│  │  5. Pro streaming (recall→reason→reply)  │    │
│  │  6. Snapshot + index update              │    │
│  └──────────────────────────────────────────┘    │
└────────────────────┬─────────────────────────────┘
                     │  Octokit (GitHub REST API)
┌────────────────────▼─────────────────────────────┐
│          GitHub Private Repo (truth source)       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ memory/  │  │  tasks/  │  │sessions/ │       │
│  │ episodic/│  │ *.md     │  │ *.json   │       │
│  │ nodes/   │  │          │  │          │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│  Agent read/write          Agent read-only        │
│                            (src/ off-limits)      │
└──────────────────────────────────────────────────┘
```

### Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| State storage | GitHub Markdown files | Portable, versionable, human-readable, no database |
| Memory model | Episodic (time slices) + Semantic (nodes, strands) | Mirrors human memory; recall by time + topic |
| Agent execution | Stateless, event-driven | Each request independent; state externalized in files |
| Recall architecture | Two-tier: Flash (fast scan) + Pro (deep read) | Cost-efficient; mirrors human recall patterns |
| Slicing rule | Single rule: 30min silence | Simple, predictable, no ML-driven false splits |
| File format | Markdown + YAML frontmatter | Any tool can read it; git-diffable; human-editable |
| Security | Path whitelist; source code read-only | Agents can only touch `memory/`, `tasks/`, `sessions/` |
| Deployment | Vercel (cloud) + GitHub (state) | Zero local setup; state stays with user |

### Tech stack

| Technology | Role |
|-----------|------|
| [Next.js 16](https://nextjs.org) | App Router + API routes on Vercel |
| [Vercel AI SDK 7](https://sdk.vercel.ai) | Multi-model streaming, tool calling, structured output |
| [Octokit](https://github.com/octokit) | GitHub REST API — reads and writes memory files |
| [streamdown](https://streamdown.dev) | Streaming markdown for agent responses |
| [shadcn/ui (Base UI)](https://ui.shadcn.com) | UI primitives |
| [Tailwind CSS 4](https://tailwindcss.com) | Styling |
| [next-intl](https://next-intl-docs.vercel.app) | i18n (English, Chinese) |

---

## Philosophy

A few principles that guide every decision in this project:

1. **A full agent, not just a memory tool.** Previously reads, writes, reasons, and acts. Memory is what makes it feel continuous — but it's not the only thing it does. The goal is a capable cloud agent that happens to never forget.

2. **Memory is the hard problem.** Storing conversations is trivial. Retrieving the right memory at the right moment — with the right depth, in the right context — is genuinely hard. That's where the effort goes.

3. **Your memory belongs to you.** Not in a cloud database, not in a proprietary format. Plain Markdown files in your own GitHub repo — readable by any tool, portable anywhere, version-controlled by git.

4. **Simplicity over sophistication.** One slicing rule (30 minutes), not three. One Flash call, not four. The complexity budget goes to the core loop — store, index, recall — not to configuration or edge cases.

5. **Human memory is the right metaphor.** Episodic vs. semantic. Fast scan vs. deep retrieval. Time-organized, context-rich. Previously doesn't pretend to be a database with a chat interface — it's built to remember the way people remember.

---

## Contributing

This is a personal research project in its early stages. Bug reports, ideas, and discussions are welcome via [GitHub Issues](https://github.com/LikeDreamwalker/Aftrbrez/issues).

If you want to contribute code, please open an issue first to discuss what you'd like to change — the architecture is evolving quickly and some areas may already be in flux.

---

## Author

<p align="center">
  Built with 💙 by
</p>

<p align="center">
  <a href="https://likedreamwalker.space"><img alt="LikeDreamwalker" src="public/ldw.svg" width="220"></a>
</p>

<p align="center">
  <a href="https://likedreamwalker.space">Website</a>
  ·
  <a href="https://github.com/LikeDreamwalker">GitHub</a>
  ·
  <a href="mailto:a@ldwid.com">Email</a>
</p>

---

## Acknowledgments

Built on top of excellent open-source work:

- [**Vercel AI SDK**](https://sdk.vercel.ai) — the foundation for multi-model streaming and tool calling
- [**Open Agents**](https://github.com/vercel/open-agents) — the agent implementation was an important reference
- [**shadcn/ui**](https://ui.shadcn.com) — composable UI primitives
- Everyone thinking seriously about AI memory, context, and the future of human-AI relationships
