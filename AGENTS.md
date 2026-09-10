# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## About

A Next.js web application with a server-side LLM agent and a GitHub-backed episodic memory system (conversation history stored as time slices). The agent operates only on whitelisted data directories; every chat turn runs inside a durable Vercel Workflow run.

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Vercel AI SDK · Vercel Workflow · octokit · sonner · react-markdown

## Commands

- `pnpm dev` — Start dev server with Turbopack (port 3000)
- `pnpm build` — Production build with Turbopack
- `pnpm build:standalone` — Build + dereference all symlinks in `.next/standalone` (see Packaging below)
- `pnpm start` — Start production server
- `pnpm lint` — Run ESLint
- `pnpm test` — Run vitest
- `pnpm test:e2e` — Playwright UI E2E (`tests/e2e/`); boots its own dev server on port 3100 in client + subscription-bridge mode (`PREVIOUSLY_MODE=client`, `PREVIOUSLY_BRAIN=bridge`) against isolated temp `PREVIOUSLY_HOME`/`MEMORY_ROOT` dirs — never the real `~/.previously`. First run needs `npx playwright install chromium`.

## Architecture

Three-layer separation:
- **Browser/Phone** → user interaction surface
- **Vercel (orchestration)** → receive triggers → read GitHub state → LLM decision → execute → write back
- **GitHub repo (truth source)** → code (`src/`) + data (`memory/`, `tasks/`, `sessions/`)

**Key principles**:
- Code + data coexist in one repo. Code is agent-read-only, data directories are agent-read-write.
- Execution is stateless and event-driven. State lives entirely in GitHub files, not in a database.
- The agent's identity constitution (`identity/agent/CHARTER.md`) is bundled at build time via `scripts/generate-identity.mjs`; all memory data (slices, timeline, strands, user card) is fetched at runtime from GitHub/local fs.
- Context is assembled dynamically from a timeline of time slices — no growing prompt window.

Detailed subsystem designs live in `doc/design/` (slicing, system-prompt layering, sub-agents, evolution, client/bridge/BYOK mode, memory UI). `src/lib/episodic/CLAUDE.md` and `src/components/chat/CLAUDE.md` cover their respective modules.

## Packaging (supply chain)

The client deployment ships `.next/standalone`, but Next mirrors the pnpm layout with symlinks — on Windows these come out broken (file-type links to dir targets, absolute links back into the build repo), so the artifact is not relocatable as-built. `scripts/pack-standalone.mjs` replaces every symlink in the standalone tree with the real content of its resolved target, producing a pure file tree (zero symlinks). CI must run `pnpm build:standalone` (build + pack) before packaging the `@previously-lab/kernel` artifact.

`pnpm build:standalone` runs `scripts/build-standalone.mjs`, a cross-platform wrapper (inline env vars in package.json scripts break on Windows cmd) that sets `NEXT_PUBLIC_PREVIOUSLY_TARGET=client`, then spawns `pnpm build` and the pack step.

## Project Documentation

`doc/` is gitignored — it holds local design docs (`doc/design/`, one per milestone) and release notes only.

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- The flush/episodic write path is further constrained to the active slice's timeline files (strict slice-id validation in `src/app/api/episodic/flush/route.ts`)
- API mutation endpoints (`POST /api/chat`, `/api/chat/[runId]/cancel`, `/api/episodic/flush`, `/api/episodic/signal`) are same-origin guarded — see `src/lib/security/origin-guard.ts`; non-browser callers need `x-access-key` when `ACCESS_SECRET` is set
- `src/` directory is agent-read-only — no tool may modify it
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
