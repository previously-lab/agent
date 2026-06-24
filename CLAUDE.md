# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## About

Aftrbrez (Afterbreeze) — a personal AI commander platform (C2). Human is the commander, cloud agents are the staff. Agents don't initiate contact; they work while you're away, results waiting when you return.

**Core narrative**: Not "I'm always with you" but "I come after you're done."

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · Zustand 5 · next-intl · Vercel AI SDK · octokit

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

## Architecture

### Layout Hierarchy

1. **Root Layout** (`src/app/layout.tsx`): `ThemeProvider` + `StoreProvider` (global)
2. **Locale Layout** (`src/app/[locale]/layout.tsx`): `NextIntlClientProvider` (per-locale)

### Internationalization (next-intl)

- **Routing config**: `src/i18n/routing.ts` — supported locales (`en`, `zh`) and default
- **Translations**: `messages/en.json`, `messages/zh.json`
- **Navigation**: Always use utilities from `@/i18n/navigation` instead of `next/navigation`.

### State Management (Zustand)

- **Store**: `src/stores/store.ts` — `AppState`, `AppActions`, `createAppStore` factory
- **Provider**: `src/providers/store-provider.tsx` — creates store per request via `useRef`
- **Usage**: `import { useAppStore } from "@/providers/store-provider"`

### Theme System

- `next-themes` with `attribute="class"`, `defaultTheme="system"`
- `suppressHydrationWarning` on `<html>` tag

### shadcn/ui

- Style: `base-nova` · Base color: `neutral` · CSS variables enabled
- Components: `src/components/ui/` (auto-installed via CLI)
- Utilities: `cn()` from `@/lib/utils`

### Path Aliases

- `@/*` → `./src/*`

## Project Documentation

| File | Purpose |
|------|---------|
| `doc/project-info.md` | Project soul: one-liner, architecture, current focus (read at session start) |
| `doc/requirements.md` | Feature specs in BDD/Gherkin format |
| `doc/solution.md` | Technical solution with option comparisons |
| `doc/roadmap.md` | Milestone + task breakdown |
| `doc/design/` | Per-milestone design documents |
| `doc/preferences.md` | Development preferences and constraints |
| `doc/dev.md` | Dev commands, references, and development log |
| `doc/progress.md` | Current task status and history |

## Phase 1 (Current — M1)

**Goal**: Validate that agents can autonomously read/write GitHub repo files through chat.

**Tasks**:
- M1.1: Project scaffold + AI SDK + octokit setup
- M1.2: GitHub tools (readFile, writeFile, listFiles) with path whitelist
- M1.3: Chat API endpoint (Vercel AI SDK streamText)
- M1.4: Chat UI (streaming + tool call visibility)
- M1.5: Integration test
- M1.6: Vercel deployment

**Verification**: chat → "write test.md to memory/" → GitHub file appears → "read it back" → correct content → "update it" → file changes

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- `src/` directory is agent-read-only — no tool may modify it
- GitHub token is scoped to a single repository with contents read/write only
- All path validation is server-side; client is untrusted
