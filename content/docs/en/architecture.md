# Architecture

Previously is a single HTTP endpoint on Vercel that reads GitHub files, calls two LLMs, and streams one response back — no database, no cron, no persistent server.

## The Three Layers

The system is split into three layers, each with a distinct responsibility and a hard boundary between them:

| Layer | What it is | What it does |
|-------|------------|--------------|
| **Browser / Phone** | Next.js App Router UI | Renders the chat surface. Captures input. Streams the response. That is all — no business logic, no state machine, no local memory. |
| **Vercel Orchestration** | A single `POST /api/chat` handler | Reads GitHub state, calls DeepSeek-chat for Flash and DeepSeek-chat (or client-selected model) for Pro, writes back. No cron. No worker. No queue. One request = one response. |
| **GitHub Private Repo** | The single source of truth | Holds everything: `src/` (agent-read-only), `memory/`, `tasks/`, `sessions/` (agent-read-write). Code and data coexist in one repo. |

The diagram from the README puts it simply: you interact on your phone, Vercel orchestrates the pipeline, and every durable fact lives in a git commit.

> **Key takeaway: no database, no always-on agent, no persistent connection.** Previously runs entirely inside the Vercel request lifecycle. You send a message, the route fires the pipeline, and the response streams back. When the response ends, there is no background process, no heartbeat, no loop.

## The Single `/api/chat` Pipeline

The whole agent is `src/app/api/chat/route.ts` — one `export async function POST(request: Request)`. Every user message triggers these six steps in order:

### 1. Housekeeping

Resolve or recover the active time slice. If no slice is open, `tryLoadTodaySlice()` recovers the last-known slice from disk. The 30-minute silence rule (`checkTimeSilence` in `src/lib/episodic/slicer.ts`) tests whether the user has been inactive that long; if so, the old slice closes (`closeSlice(slice, 'time_silence')`) and a new one opens via `createSlice()`. The incoming user turn is appended. First-turn new slices are snapshotted and indexed immediately.

### 2. Unified Flash

One call to DeepSeek-chat (`deepseek('deepseek-chat')`, temperature 0.1, `toolChoice: 'required'`) that returns structured output through a single `flashOutput` tool with a Zod schema containing:

- **intent** — one of `code_debug`, `code_write`, `explain`, `chat`, `review`, `clarify`
- **confidence** — a float
- **recall_hits** — up to 5 pointers (`slice_id`, `relevance`, `reason`) drawn from the 15 most recent closed-slice summaries
- **metadata_updates** — patches to the slice's focus, summary, open_loops, decisions, tags, and emotional_tone

This replaces the older pattern of separate intent classification + recall + maintenance calls. `readRecentSummaries(15)` feeds the Flash model the material it needs. On failure, the call retries once after 300ms; if both attempts fail, safe defaults return (`intent: 'chat'`, confidence 0.3, no updates).

### 3. Context Assembly

`listNodes()` (`src/lib/memory/manager.ts`) pulls candidate memory nodes filtered to types `['concept', 'experience']`, capped at 24 (`max_nodes * 3`). `rankNodes()` (`src/lib/memory/scorer.ts`) scores each node against the user input and the Flash intent, keeping the top 8. The context assembler (`src/lib/context/assembler.ts`) packs a layered prompt under an 8,000-token budget:

| Layer | Content | Budget Rule |
|-------|---------|-------------|
| 0 | System prompt (identity + directives + episodic grounding) | Full, always included |
| 1 | Core memory nodes (full content) | 70% of budget |
| 2 | Session summary + recent turns | Truncated |
| 3 | Extended nodes (summary only) | First paragraph only |
| 4 | Reference nodes | File path stems only |

Token estimation is `ceil(chars / 4)` — a heuristic, not a true tokenizer.

### 4. Episodic Timeline Formatting

Recall hits from Flash are rendered into a structured `## Episodic Memory Timeline` block. The current slice appears under "Now — Current Session" (with its ID, turn count, focus, summary, open loops, and decisions). Recall hits are bucketed into time groups — Today / This Week, This Month, A Few Months Ago, Last Year, Earlier — sorted by relevance, capped at `MAX_RECALL_HITS = 12`. Timestamps use relative labels: "just now / N min ago / yesterday / Nmo ago".

### 5. Pro Streaming

The main model (`deepseek(model)`, with `thinking: { type: 'enabled' }` and `reasoningEffort: 'medium'` when thinking is requested) streams text and tool calls back to the UI. `stopWhen: stepCountIs(20)` caps the conversation. Reasoning duration is measured server-side and emitted as a `data-reasoning` part in the stream; a `data-flash` part carries the recall card with phase, duration, tags, reasoning, and the recall hits.

Pro has five tools at its disposal:

- **readMemory** — read a file inside `memory/`
- **listMemory** — list directories inside `memory/`
- **readIndex** — read a monthly `_index.json`
- **writeMemory** — create or update memory notes/nodes (guarded by path whitelist and protected-system-path checks)
- **updateUserProfile** — patch `memory/user/profile.md` via `applyProfilePatch`

When `GITHUB_TOKEN` is set, these tools use Octokit (`src/lib/tools/readFile.ts` etc.). Otherwise they fall back to local filesystem access.

### 6. Snapshot + Index Update

On finish reason `'stop'`, the agent turn is appended, the slice snapshot is saved, and monthly index entries are ensured. On interruption, the partial response text is saved with a `[partial]` prefix.

## Core Modules

The `src/lib/` directory contains many modules, but not all are wired into the live chat route. Here is the honest breakdown:

### Shipped and wired into `/api/chat`

| Module | Path | Purpose |
|--------|------|---------|
| Path Whitelist | `src/lib/whitelist/` | Security boundary: `memory/ tasks/ sessions/` only |
| Memory System | `src/lib/memory/` | Manager (list, load, create nodes) + scorer (relevance ranking) |
| Context Assembler | `src/lib/context/` | 5-layer prompt builder under token budget |
| GitHub Tools | `src/lib/tools/` | Octokit-backed readFile/writeFile/listFiles with local-fs fallback |
| Episodic Subsystem | `src/lib/episodic/` | Time-slice management, unified Flash, strand indexing |

### Defined but not wired into the chat route (standalone / experimental)

These modules are referenced as types or imported by nothing at all. The CLAUDE.md core-modules table lists them as active, but the live request path does not use them:

| Module | Path | Status |
|--------|------|--------|
| Loop Engine | `src/lib/loop/engine.ts` | Imported only as a type by Archive Sync. Not called by the chat route. |
| Session Manager | `src/lib/session/manager.ts` | In-memory `Map` with 5-turn sliding window. Imported only as a type by Archive Sync. Not called by the chat route. |
| Archive Sync | `src/lib/archive/sync.ts` | Fire-and-forget GitHub push with 3-try exponential backoff. Imported by no file. |
| Model Registry | `src/lib/models/registry.ts` | Declares `deepseek-chat` and `deepseek-reasoner` (plus an unused provider union for Anthropic/OpenAI). Imported by no file. The chat route hardcodes `deepseek(model)` directly. |

### Partially wired

The Intent Router (`src/lib/router/`) contributes only `classifyIntentKeywords` — a keyword/fallback classifier that returns `'clarify'` when no keyword matches. The hybrid Flash classifier `classifyIntentHybrid` was superseded by the unified Flash call in `episodic/maintenance.ts` and is not called in the live path.

### Multi-model claim

The README describes "Multi-model support (DeepSeek, Anthropic)." In the shipped code, `src/lib/models/registry.ts` lists only `deepseek-chat` and `deepseek-reasoner`. No Anthropic model is registered or reachable through the chat route today. The provider union allows Anthropic, but no entry exists.

## Stateless Execution (With Nuance)

The README calls execution "stateless, event-driven." The intent is correct: GitHub is the durable source of truth, and the system recovers its state from disk on every request. However, two in-memory variables exist:

- The **active time slice** is a module-level variable in `episodic/manager.ts`. On cold start or page refresh, `tryLoadTodaySlice()` recovers it from disk.
- **Sessions** live in an in-memory `Map` in `session/manager.ts`.

These are caches, not authoritative state. GitHub/disk is the source of truth. If the process restarts, the next request recovers what it needs from the filesystem.

## Security Model

Security is enforced entirely in TypeScript at the tool boundary — no Rust, no WASM, no sidecar.

### Path Whitelist

`src/lib/whitelist/index.ts` defines the only three writable directories:

```
memory/   tasks/   sessions/
```

`normalizePath()` decodes URI components, converts backslashes to forward slashes, resolves `./` and `../` segments, and strips leading slashes. `isPathAllowed()` rejects:

- Empty paths
- Absolute Unix paths (starting with `/`)
- Absolute Windows paths (drive letters like `A:`)

Then it checks the path starts with one of the three allowed prefixes.

### Protected System Paths

Within the whitelist, certain paths are readable but **not writable** by the generic `writeFile` tool:

- `memory/episodic/` — system-owned slices and indexes
- Any `_index.json` file
- `strands.json`
- `memory/user/profile.md` — editable only via its dedicated `updateUserProfile` tool

### `src/` Is Agent-Read-Only

The `src/` directory simply does not appear in the whitelist. No agent tool can write there. The agent can read `src/` through git (it is in the repo), but it cannot modify it — the path whitelist rejects write attempts. This keeps the codebase integrity independent of the agent's execution.

### GitHub Token Scope

The `GITHUB_TOKEN` is scoped to a single repository with contents read/write. The agent operates on exactly one repo: the one defined by `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME`. There is no cross-repo access.

All path validation is server-side — the client is untrusted. The browser never constructs file paths or makes storage decisions.

## What Comes Next (Roadmap)

The following are not yet built or are experimental:

- Parallel / topic timeline indexing for recall (`src/lib/episodic/parallel-timeline.ts` exists but is not read for recall)
- Multi-branch memory
- Recall-quality metrics
- Complete GitHub toolset (branches, diffs, PRs)
- Task Loop Engine v2
- Cloud-local connector framework

The project status badge is **experimental**.

## Related

- [Memory Model](/content/docs/en/memory-model) — how slices, strands, and nodes work
- [Whitelist & Security](/content/docs/en/security) — path validation and access control in depth
- [Agent Loop](/content/docs/en/agent-loop) — how the agent executes multi-step tasks
