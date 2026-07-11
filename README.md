<p align="center">
  <img alt="Previously" src="https://raw.githubusercontent.com/LikeDreamwalker/previously/main/public/previously-on-you.png" width="600">
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

Most AI agents split your life into chat threads. Each new thread starts cold. Memory is siloed, fragile, lossy. The conversation list — a UI artifact from messaging apps — became the default interaction model for AI, even though human relationships don't work that way.

Previously replaces chat threads with **time slices**: episodic memory organized the way human memory actually works — by _when_ something happened, then _what_ it was about. You don't manage conversations. You just show up and talk. And because context is assembled dynamically from the timeline rather than crammed into a growing prompt window, there's no point where the agent suddenly "forgets" the beginning of a long exchange.

The name comes from how TV series recap previous episodes: _"Previously on…"_ — a brief reminder of what happened last time, just enough context to pick up where you left off.

### Why this matters

Two problems that are really one:

1. **Memory across conversations is broken.** Cross-conversation recall requires vector databases, RAG pipelines, and fragile prompt engineering — and it still feels like talking to someone with amnesia.

2. **The conversation is not the right container.** Humans don't organize their memories into "Chat #47." They remember by _when_ something happened and _what it was about_. The conversation list is a UI artifact — not a cognitive model.

Fixing the memory model fixes the interaction model. If an agent genuinely remembers you across time and topics, you don't need conversation management. You just show up and talk.

---

## Previously, Slice and Strand

Like a TV series that opens each episode with a recap, every time you return, you see a timeline of your past — not a list of chat threads. Scroll up to revisit. Scroll down to continue where you left off.

A **slice** is one conversation burst — a Markdown file on the timeline. It opens when you start talking, closes after 30 minutes of silence. Each slice carries a summary, decisions, open loops, and tags in YAML frontmatter. Read top to bottom across months and years, slices are your autobiography.

A **strand** is a keyword — like `work`, `family`, `health` — that appears across multiple slices. A lightweight index maps each strand to every slice that carries it: the whole history of that topic.

> Slice = what happened. Strand = what it was about. Together they give you both episodic and semantic memory — remembering by time, and remembering by topic.

<p align="center">
  <img alt="Timeline view" src="https://raw.githubusercontent.com/LikeDreamwalker/previously/main/public/timeline-screenshot.png" width="700">
</p>

<p align="center">
  <img alt="Timeline detail — Now marker, time gaps, and active slice" src="https://raw.githubusercontent.com/LikeDreamwalker/previously/main/public/timeline-detail.png" width="700">
</p>

<p align="center">
  <sub>Each slice carries a summary. Time gaps between slices get natural labels — "Now," "Seven months later" — so scrolling the timeline feels like turning pages.</sub>
</p>

For implementation details — the two-tier recall pipeline (Flash scan + Pro deep-read), file structure, YAML schemas, and the cognitive science foundations — see the [Memory Model](https://previously-demo.ldwid.com/docs/memory-model) and [Architecture](https://previously-demo.ldwid.com/docs/architecture) docs.

---

## Try the demo

A read-only demo is live at **[previously-demo.ldwid.com](https://previously-demo.ldwid.com)**. It's seeded with a fictional persona spanning several years of conversations — browse the timeline, scroll through past slices, and chat freely. All memory writes are disabled; refresh the page and the slate resets.

The demo runs on two models: **DeepSeek V4 Flash** handles the fast recall scan and metadata maintenance, and **DeepSeek V4 Pro** handles deep reasoning and response generation. Same two-tier architecture, live.

---

## Documentation

Full docs are at **[previously-demo.ldwid.com/docs](https://previously-demo.ldwid.com/docs)** — plain Markdown, readable on GitHub, browsable in-app at `/docs`, and consumable by any AI tool. Key pages:

- [Introduction](https://previously-demo.ldwid.com/docs/introduction) — what Previously is and how it works
- [Slices & Strands](https://previously-demo.ldwid.com/docs/slices) — the core memory model
- [Architecture](https://previously-demo.ldwid.com/docs/architecture) — pipeline, modules, tech stack, design decisions
- [Deployment](https://previously-demo.ldwid.com/docs/deployment) — fork, configure, deploy
- [FAQ](https://previously-demo.ldwid.com/docs/faq)

Docs live in [`content/docs/`](content/docs/) — readable directly on GitHub. AI tools can also use [`llms.txt`](public/llms.txt) for structured access.

---

## Quick start

1. **Fork this repo** → set to **private** (your memory lives here). Fork creates a copy under your GitHub account. Updates from upstream are one click away — see the Sync button on your repo page.

2. **Import to Vercel** — [Import this repo](https://vercel.com/new). Set these environment variables:
   - `GITHUB_TOKEN` — GitHub personal access token with contents read/write scope
   - `GITHUB_REPO_OWNER` — your GitHub username
   - `GITHUB_REPO_NAME` — your private fork's repo name
   - `DEEPSEEK_API_KEY` — DeepSeek API key

3. **Alternative: Deploy Button** — one click, but note: "Fastest path to a running instance. Updates from upstream require manual git steps — see the Updating section in docs."

4. **Local dev** — `git clone` your fork, `pnpm install`, `pnpm dev`.

---

## Project status: experimental

**Previously is in active early development and not yet ready for personal or production use.** The core architecture is functional, but many subsystems are still being designed and built. This project will be maintained long-term — it's a genuine attempt to rethink how humans and AI relate to each other over time.

### What works today

- Streaming chat with tool-call visibility
- Time-slice storage with automatic slicing (30min silence rule)
- Flash recall scanning + deep recall via `readMemory` tool
- Per-round metadata maintenance (summary, focus, decisions, open loops, tags)
- Timeline UI with fade effects for historical slices
- Episodic context assembly in time-grouped format
- Memory node system (markdown + YAML frontmatter + index graph)
- GitHub file tools with path whitelist security
- Multi-model support (DeepSeek, Anthropic, via AI SDK)
- Internationalization (English & Chinese)

For the full roadmap, see the [Architecture docs](https://previously-demo.ldwid.com/docs/architecture) or the [Memory Model docs](https://previously-demo.ldwid.com/docs/memory-model).

---

## Philosophy

A few principles that guide every decision:

1. **A full agent, not just a memory tool.** Previously reads, writes, reasons, and acts. Memory is what makes it feel continuous — but it's not the only thing it does. The goal is a capable cloud agent that happens to never forget.

2. **Memory is the hard problem.** Storing conversations is trivial. Retrieving the right memory at the right moment — with the right depth, in the right context — is genuinely hard. That's where the effort goes.

3. **Your memory belongs to you.** Not in a cloud database, not in a proprietary format. Plain Markdown files in your own GitHub repo — readable by any tool, portable anywhere, version-controlled by git.

4. **Simplicity over sophistication.** One slicing rule (30 minutes), not three. One Flash call, not four. The complexity budget goes to the core loop — store, index, recall — not to configuration or edge cases.

5. **Human memory is the right metaphor.** Episodic vs. semantic. Fast scan vs. deep retrieval. Time-organized, context-rich. Previously doesn't pretend to be a database with a chat interface — it's built to remember the way people remember.

Previously runs as a pure cloud agent on edge infrastructure — no install, no GPU, no Docker — so it's reachable from any device. Your context lives in your GitHub repo, portable by `git clone`. For a deeper discussion of these design decisions, see the [Why docs](https://previously-demo.ldwid.com/docs/why) and [Architecture docs](https://previously-demo.ldwid.com/docs/architecture).

---

## Acknowledgments

Thanks to [Vercel AI SDK](https://sdk.vercel.ai), [shadcn/ui](https://ui.shadcn.com), and the [Open Agents](https://github.com/open-agents) community.

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
