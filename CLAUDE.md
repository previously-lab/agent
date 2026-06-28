# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## About

Aftrbrez (Afterbreeze) — a personal AI commander platform (C2). Human is the commander, cloud agents are the staff. Agents don't initiate contact; they work while you're away, results waiting when you return.

**Core narrative**: Not "I'm always with you" but "I come after you're done."

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Vercel AI SDK · octokit · sonner · streamdown

## Project Architecture

**Three-layer separation**:
- **Browser/Phone** → user interaction surface
- **Vercel Pro (orchestration)** → receive triggers → read GitHub state → LLM decision → execute → write back
- **GitHub private repo (truth source)** → code (`src/`) + data (`memory/`, `tasks/`, `sessions/`)

**Key principles**:
- Code + data coexist in one repo. Code is agent-read-only, data directories are agent-read-write.
- Execution is stateless and event-driven. State lives entirely in GitHub files, not in a database.
- Memory is layered: L0/L1 bundled at build time, L2 fetched on-demand at runtime.

## Commands

- `pnpm dev` — Start dev server with Turbopack (port 3000)
- `pnpm build` — Production build with Turbopack
- `pnpm start` — Start production server
- `pnpm lint` — Run ESLint
- `pnpm test` — Run vitest

## Architecture

### Layout Hierarchy

1. **Root Layout** (`src/app/layout.tsx`): Geist fonts + `ThemeProvider` + `<Toaster />`
2. **Locale Layout** (`src/app/[locale]/layout.tsx`): `NextIntlClientProvider` + `<AppSidebar />` + main content
3. **Route-level**: Each route has `loading.tsx` and `error.tsx` for full state coverage

### Internationalization (next-intl)

- **Routing config**: `src/i18n/routing.ts` — supported locales (`en`, `zh`) and default
- **Translations**: `messages/en.json`, `messages/zh.json`
- **Navigation**: Always use utilities from `@/i18n/navigation` instead of `next/navigation`.

### Theme System

- `next-themes` with `attribute="class"`, `defaultTheme="system"`
- `suppressHydrationWarning` on `<html>` tag
- Geist + Geist Mono fonts via `next/font/google`

### shadcn/ui

- Base UI primitives (shadcn's future direction)
- Components: `src/components/ui/` — 19 components (button, card, dialog, drawer, popover, select, tabs, tooltip, command, skeleton, avatar, separator, switch, label, input, textarea, scroll-area, dropdown-menu, sheet)
- Utilities: `cn()` from `@/lib/utils`
- Toast notifications: `sonner` via `src/components/ui/sonner.tsx`

### Chat Component Architecture

Pattern adapted from Open Agents:

1. **`Chat`** (`index.tsx`) — Main container, useChat hook, streaming state
2. **`ChatMessage`** — Message bubble with collapsible SummaryBar
3. **`ChatInput`** — Text area with image attachments + submit/stop
4. **`ThinkingSteps`** — Reasoning block using ToolLayout
5. **`SummaryBar`** — Tool count + elapsed timer + collapse toggle
6. **`ToolRenderer`** — Dispatches to per-tool renderers
7. **`ToolLayout`** — Shared expandable card with status icon/name/summary/expanded content
8. **`FileNamePill`** — File path pill with icon (used by tool renderers)
9. **`SlashCommandDropdown`** — / command autocomplete
10. **`ModelPill`** — Model name badge

### Skills System

- **File-driven**: Skills defined as `SKILL.md` in `.claude/skills/` directories
- **Discovery**: `src/lib/skills/discovery.ts` — scans directories, parses YAML frontmatter
- **Loading**: `src/lib/skills/loader.ts` — extracts body, substitutes `$ARGUMENTS`
- **Registry**: `src/lib/skills/registry.ts` — programmatic + discovered skills
- **Built-in**: `/create-memory` — creates memory nodes in `memory/nodes/`

### Providers

- **`ExpandedViewProvider`** — collapse/expand toggle context for tool views
- **`ReasoningProvider`** — thinking/reasoning duration tracking per message
- **`TodoViewProvider`** — todo panel visibility toggle

### Path Aliases

- `@/*` → `./src/*`

## Core Modules (Aftrbrez unique designs — not from Open Agents)

| Module | Path | Purpose |
|--------|------|---------|
| Loop Engine | `src/lib/loop/` | File-driven multi-step agent execution with checkpointing |
| GitHub Tools | `src/lib/tools/` | readFile/writeFile/listFiles via Octokit |
| Path Whitelist | `src/lib/whitelist/` | Security boundary: memory/tasks/sessions only |
| Memory System | `src/lib/memory/` | Markdown nodes with YAML frontmatter + scoring |
| Intent Router | `src/lib/router/` | Flash classifier + keyword hybrid intent routing |
| Context Assembler | `src/lib/context/` | 6-layer context assembly with token budget |
| Session Manager | `src/lib/session/` | In-memory session state with sliding window |
| Archive Sync | `src/lib/archive/` | GitHub archive push with retry/backoff |
| Model Registry | `src/lib/models/` | DeepSeek model routing + thinking toggle |

## Project Documentation

| File | Purpose |
|------|---------|
| `doc/project-info.md` | Project soul: one-liner, architecture, current focus |
| `doc/requirements.md` | Feature specs in BDD/Gherkin format |
| `doc/solution.md` | Technical solution with option comparisons |
| `doc/roadmap.md` | Milestone + task breakdown |
| `doc/design/` | Per-milestone design documents |
| `doc/preferences.md` | Development preferences and constraints |
| `doc/dev.md` | Dev commands, references, and development log |
| `doc/progress.md` | Current task status and history |

## Current Phase (M6)

**Goal**: Adopt Open Agents generic capabilities — UI component system, chat rendering patterns, skills discovery, route state coverage, shared utilities — while preserving Aftrbrez's unique file-driven architecture.

Reference: `doc/design/M6-open-agents-adoption.md`

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- `src/` directory is agent-read-only — no tool may modify it
- GitHub token is scoped to a single repository with contents read/write only
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)
