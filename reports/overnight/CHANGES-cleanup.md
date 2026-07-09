# Cleanup Changelog — Dead Code Removal + API Route Migration

Date: 2026-07-10
Branch: `chore/overnight-cleanup`
Scope: Applied `reports/overnight/01-dead-code.md` and `reports/overnight/02-server-actions.md`. Every deletion was re-verified with grep before removal.

## Files deleted (entirely dead)

- `src/components/chat/summary-bar.tsx` — `SummaryBar`, never imported (only self + CLAUDE.md).
- `src/components/chat/dashed-separator.tsx` — `DashedSeparator`, never imported.
- `src/components/chat/time-slice-recovery.tsx` — `TimeSliceRecovery` / `TimeSliceSnapshot`, never wired in.
- `src/components/chat/model-pill.tsx` — `ModelPill`, never imported.
- `src/components/chat/slash-command-dropdown.tsx` — `SlashCommandDropdown`, never wired into ChatInput.
- `src/components/language-selector/index.tsx` (+ dir) — `LanguageSelector`, never placed in any UI shell.
- `src/lib/system-prompt.ts` — `buildSystemPrompt`, superseded by context assembler + identity builder.
- `src/lib/episodic/parallel-timeline.ts` — topic index module, never called by the Flash/Pro pipeline (only a comment reference in `flash.ts`).
- `src/app/[locale]/timeline/page.tsx` (+ dir) — dead duplicate of the home page; no navigation references `/timeline`.
- `tests/lib/episodic/parallel-timeline.test.ts` — tested only the deleted `parallel-timeline` module (follow-on removal; caused a tsc error otherwise).

## Symbols removed (within files that keep other live code)

- `src/components/chat/timeline-panel.tsx` — removed the dead `mode === "page"` branch and the `mode?: "panel" | "page"` prop. Only panel mode is ever rendered; no caller passed `mode`.
- `src/lib/episodic/manager.ts` — removed `updateDynamicSummary()` and `freezeSliceSummary()` (no-op / stub, never imported externally; `freezeSliceSummary` was not actually called by `closeSlice`).
- `src/lib/episodic/types.ts` — removed unused types `FlashSplitInput`, `FlashSplitOutput`, `RecallHint` (the episodic duplicate; the live `RecallHint` in `router/index.ts` is untouched), `MismatchLogEntry`.
- `src/lib/episodic/index.ts` — dropped the now-dead barrel re-exports: `updateDynamicSummary`, `RecallHint`, `MismatchLogEntry`.

## API routes migrated / deleted

- `POST /api/deploy` → **migrated to server action.** Added `src/lib/deploy/actions.ts` (`"use server"` `deploy()` wrapping `triggerDeploy`). Rewired `src/components/settings/settings-form.tsx` to call `deploy()` directly instead of `fetch("/api/deploy")`. Deleted `src/app/api/deploy/route.ts`.
- `GET /api/episodic/state` → **deleted (dead).** Zero callers; all consumers already use the `getEpisodicState()` server action.
- `GET /api/episodic/slices` → **deleted (dead).** Zero callers; all consumers already use the `getMoreSlices()` server action.

## Routes kept as HTTP (per report justification)

- `POST /api/chat` — streaming via `useChat` + `DefaultChatTransport`; server actions cannot stream.
- `POST /api/episodic/flush` — `navigator.sendBeacon` target; cannot call a server action.

## Left in place intentionally (noted, not deleted)

- `SlicingSignal` union members `"flash_high_confidence"` and `"capacity"` — never emitted, but the type is live and referenced; low-impact, left to avoid churn.
- Unused shadcn/Base UI primitives (`avatar`, `command`, `drawer`, `label`, `popover`, `scroll-area`, `select`, `separator`, `sheet`, `switch`, `tabs`, `toggle`) — standard scaffolding marked `needs-check`; left in place.

## Verification

- `npx tsc --noEmit` → **pass (exit 0)** after the changes (stale `.next` generated types cleared).
