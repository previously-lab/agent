# Previously On

Your conversations become a memory you can actually *read* — a vertical timeline
of your own past, recapped like the "previously on…" before a new episode. One
continuous relationship with an agent that remembers, not a drawer full of
disconnected chats.

**Not "I'm always with you." It's "I come after you're done."**

> ⚠️ **Experimental.** This is an early, opinionated prototype — a showcase of
> the *shape*, not something ready for daily or commercial use yet. It is being
> **actively and long-term maintained**. See [Status](#status).

---

## Why we're building this

Today's AI agents split your life into **separate conversations**. Each new
thread starts cold. Memory features help, but carrying context *across*
conversations is still hard and lossy — the model forgets, or recalls the wrong
slice of you.

We didn't want that. We wanted to try something with **no concept of "a
conversation" at all**: a single, persistent entity you keep talking to over
time — one relationship, not a hundred throwaway threads.

Once you drop "conversations," you need another axis to organize everything. We
chose **time**. Your history becomes a **timeline**, and recall is modeled on
how people actually remember — **episodically**.

## The idea

**Why "Previously On."** Like a TV series, each new episode opens with a recap of
what came before. That *is* the core interaction here: you come back, and your
past is played back to you — *previously on… you* — before you continue. The
live chat is almost secondary; the timeline is the product.

**Timeline & time-slices.** Everything is stored as **time slices** —
`memory/episodic/slices/YYYY/MM/DD/HHMM.md`, one file per burst of activity (a
slice closes after 30 minutes of silence). Read top to bottom, they are your
story.

**Episodic memory, not a pile of facts.** Cognitive science distinguishes
*episodic* memory — events tied to *when and where* they happened — from
*semantic* memory, decontextualized facts (Endel Tulving's classic 1972 split).
Human autobiographical memory is largely episodic and time-organized. Most AI
"memory" throws the episodes away and keeps only extracted facts ("user likes
X"). We keep the episodes, intact, in time — and treat that as the primary
substrate.

**Strands — a semantic layer, done losslessly.** A *strand* is a keyword woven
through the slices that carry it (`memory/episodic/strands.json`): "the whole
history of that thing" across months and years. It is a semantic **index into**
the episodes — a lens, not a replacement. Where a vector database compresses your
text into embeddings you can never read back, a strand just points at the
original, legible files.

**Context is the moat, not the model.** We believe context will matter *more*
than the model itself — perhaps far more. So your context is not ours to hold:

- It lives entirely in a **GitHub repository** — plain Markdown you own, in the
  cloud and/or cloned to your own disk.
- Because it is just files in git, **anything can use it.** Previously On reads
  and writes it; so can a local agent like **Claude Code** or **Codex**, pointed
  at the same repo. Your memory is not locked to this app.
- You get **version control for free** — branches, commits, diffs, full history.
  Fork your memory, roll it back, keep parallel lines of your own story.
- Nothing is ever *physically* lost. Storage was never the hard part — **recall**
  is: how do you find your way back into everything you've stored? That is the
  problem this project actually works on.

## Why the cloud

We deliberately built this as a **lightweight cloud agent**, not a desktop app.
You don't set up a local environment, install anything, or keep a machine
running. You open **your own page**, talk, and it remembers — from a phone,
anywhere.

The long game isn't "chat in a browser." It's a **cloud-light + local-heavy**
split: a fast, always-there cloud agent for thinking and memory that can reach
*down* into a heavy local agent (Claude Code / Codex on your machine) for real
work. That connector is on the [roadmap](#roadmap); the shared git-repo
foundation it needs is already here.

## Try it

**[▶ Live demo](https://example.com)** — read a fictional person's years of
history as a timeline. The demo is **read-only**: explore and chat freely, but
nothing you write is saved (a banner tells you so).

## How it works

- **Files are the truth source.** Memory is Markdown in a GitHub repo. Agents
  read/write only through a path whitelist (`memory/`, `tasks/`, `sessions/`);
  `src/` and the agent's own identity are off-limits, enforced server-side.
- **No vector database.** Recall is time- and keyword-driven over legible files.
- **Flash + Pro.** Each request runs a fast model (intent classification + recall
  scan + metadata upkeep in one round-trip) and a reasoning model (the response).
  Flash is fallible by design; Pro continues if it fails.
- **Bundled soul, live profile.** The agent's identity and operating rules
  (`identity/agent/*.md`) are compiled into the build — immutable at runtime, so
  a bad edit or a stray write can't hijack it. Your profile
  (`memory/user/profile.md`) is loaded live and editable by you or the agent.

## Status

Honest about where this is:

- **Experimental.** A showcase v1 — *not* ready for real personal-daily or
  commercial use.
- **Long-term maintained.** A direction we're committed to, not a weekend demo.
- **No authentication.** Single-user by design; don't expose a writable instance
  publicly.
- **Cold start.** A fresh deployment starts with empty memory — the recap only
  becomes compelling once you've accumulated history.
- A fresh fork ships **clean** (no data); the demo persona lives on the
  `demo/personal-14` branch, not `main`.

## Self-hosting

### Prerequisites

- Node.js 20.9+ and pnpm
- A [DeepSeek API key](https://platform.deepseek.com)
- A [GitHub fine-grained PAT](https://github.com/settings/tokens) with contents
  read/write on your repo

### Setup

```bash
git clone https://github.com/LikeDreamwalker/Aftrbrez.git
cd Aftrbrez
pnpm install
```

Create `.env.local`:

```env
DEEPSEEK_API_KEY=sk-...
GITHUB_TOKEN=github_pat_...
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-repo
```

```bash
pnpm dev        # http://localhost:3000
```

Without `GITHUB_TOKEN`, the app runs in local-filesystem mode (reads/writes the
local `memory/` directory instead of GitHub).

### Running a read-only demo

To deploy a public, read-only demo of a seeded persona, deploy the
`demo/personal-14` branch with:

```env
DEMO_MODE=true                 # redirects reads to the persona; makes ALL writes no-op
DEMO_REF=demo/personal-14      # the branch reads are pinned to (never the default branch)
GITHUB_TOKEN=...               # a read-only token is enough
GITHUB_REPO_OWNER=...
GITHUB_REPO_NAME=...
```

In demo mode every write is accepted but never persisted, so a visitor's session
is ephemeral and resets on reload.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 6 |
| UI | React 19, Tailwind CSS 4, shadcn/ui (Base UI), motion |
| AI | Vercel AI SDK v7 · DeepSeek (Flash + reasoning) |
| Storage | GitHub REST API (octokit) · local FS for dev |
| i18n | next-intl (English, Chinese) |
| Theme | next-themes (system-aware dark mode) |

## Architecture

```
Browser / Phone   →  you interact
Vercel            →  read GitHub state → Flash + Pro → stream → write back
GitHub repo       →  truth source: code (src/, read-only) + data (memory/, tasks/, sessions/)
```

Per-request flow: housekeeping (open/close the active slice) → unified Flash
(intent + recall) → context assembly → multi-phase stream (recall → reasoning →
response) → write back the turn.

Key modules:

| Path | Purpose |
|---|---|
| `src/lib/episodic/` | Time-slice CRUD, time-based slicing, unified Flash, the strand index |
| `src/lib/identity/` | Bundled agent constitution + live user profile |
| `src/lib/context/` | Prompt assembly with a token budget |
| `src/lib/tools/` · `src/lib/whitelist/` | GitHub/local file I/O behind a path whitelist |
| `src/lib/demo/` | Demo-mode path redirect + pinned-branch reads |
| `src/components/chat/` | Timeline + three-phase message rendering (recall → reasoning → response) |

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Dev server (Turbopack) |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |

## Roadmap

Rough horizons, not fixed dates.

- **Short term** — strengthen the foundation. Better agent memory storage and
  recall, plus multi-branch management and memory version control. Get the
  memory substrate solid before building up.
- **Mid term** — flesh out the agent itself. Full read/write over memory *and*
  the GitHub repository, with repo-level operations (branches, commits, PRs) as
  first-class agent capabilities.
- **Long term** — a third-party **connector**. Let the cloud agent remotely reach
  a local agent (Claude Code / Codex) on your machine: cloud-light thinking and
  memory + local-heavy work and development, combined into one workflow.

## Contributing

Early and moving fast — issues, ideas, and discussion are very welcome. If a
piece of the vision resonates (or you think we're wrong about something), open an
issue.

## License

MIT
