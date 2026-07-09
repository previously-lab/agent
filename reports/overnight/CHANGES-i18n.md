# CHANGES — i18n externalization (en/zh)

Implements `reports/overnight/03-i18n.md`. All user-facing UI strings on the
high-visibility surfaces (hero handoff, chat input, chat message pipeline,
timeline, settings, sidebar, empty/error states) are now routed through
next-intl. The previously-dead `messages/*.json` keys were replaced with a
domain-grouped catalog; every key is now actually referenced by a component.

## Message catalogs

`messages/en.json` and `messages/zh.json` rewritten from 3 dead namespaces
(`Chat`, `HomePage`, `DateGroup`) into a structured, fully-referenced catalog.
zh translations keep the cinematic "previously on" voice (回忆中 / 片刻之后 /
更早的记忆 / 现在). ICU plurals used for counts (thoughts, seconds, tool items,
gap labels).

Key namespaces added:

- `common.*` — `loading`, `retry`, `date.{year,month,day}`
- `nav.*` — `dashboard, chat, memory, missions, archive, settings, expand, collapse`
- `chat.input.*` — `placeholder, attach, settingsTooltip, stopTooltip, sendTooltip`
- `chat.thinking.*` — `indicator, streaming, completed` (plural), `elapsed` (plural)
- `chat.actions.*` — `copy, copied, copyTooltip, copiedTooltip, regenerate, regenerateTooltip`
- `chat.recall.*` — `streaming, completed`
- `chat.tool.*` — `denied, interrupted, readMemory, listMemory, readIndex, readFile,
  updateFile, createFile, listFiles, lines, items, failed, expandedLabel, conversations`
- `chat.code.*` — `fallbackLanguage, copyTooltip, copiedTooltip`
- `timeline.row.*` — `charCount, collapse, expandAll, loading, viewMore, ongoing,
  decided, collapseMeta, date.{today,yesterday}`
- `timeline.panel.*` — `now, earlier`
- `timeline.gap.*` — `moments, minutes, hours, days, weeks, months` (plural)
- `settings.pageTitle`, `settings.pageSubtitle`
- `settings.form.*` — ~25 keys (API status, model selector, thinking toggle, repo
  config, deploy incl. `<code>` rich text, version check messages)
- `settings.repo.*` — `heading, vercelSource, empty, addedDate, removeTooltip,
  addHeading, addPlaceholder, addButton, addHelp, invalidUrl, addFailed`
- `settings.error.{title,message}`
- `memory.*`, `archive.*`, `missions.*` — `emptyTitle, emptyDesc, placeholderPreview`

## Files touched (24)

Server components (getTranslations):
- `src/app/[locale]/settings/page.tsx` — page title + subtitle

Client components (useTranslations / useLocale):
- `src/app/[locale]/settings/error.tsx`
- `src/components/sidebar/app-sidebar.tsx` — nav labels via `labelKey`, expand/collapse
- `src/components/settings/settings-form.tsx` — full settings form incl. `t.rich` for `[deploy]`
- `src/components/settings/repo-hub.tsx`
- `src/components/chat/chat-input.tsx`
- `src/components/chat/chat-section.tsx`
- `src/components/chat/message-actions.tsx`
- `src/components/chat/recall-phase.tsx`
- `src/components/chat/thinking.tsx` — ICU plurals for thought/second counts
- `src/components/chat/tool-layout.tsx` — denied / interrupted
- `src/components/chat/tool-renderer.tsx` — friendly tool labels
- `src/components/chat/tool-renderers/read-file.tsx`
- `src/components/chat/tool-renderers/write-file.tsx`
- `src/components/chat/tool-renderers/list-files.tsx`
- `src/components/chat/tool-renderers/memory-tool.tsx` — also locale-aware month names
- `src/components/chat/code-block.tsx`
- `src/components/chat/date-group-header.tsx` — 年/月/日 via `common.date`
- `src/components/chat/time-slice-row.tsx` — char count, view-more/collapse, ongoing/decided,
  and `formatSliceDate` refactored to be translator + locale aware (today/yesterday +
  `Intl.DateTimeFormat`), removing hardcoded Chinese
- `src/components/chat/timeline-panel.tsx` — cinematic "N later" gap labels (ICU),
  "更早的记忆" → `earlier`, "现在" → `now`, groupByDate now locale-aware
- `src/components/memory/file-list.tsx`
- `src/components/archive/file-list.tsx`
- `src/components/missions/file-list.tsx`

## Behavioral notes / bug fixes folded in

- `time-slice-row.tsx` and `timeline-panel.tsx` previously hardcoded Chinese
  regardless of locale (a bug flagged in the audit). They now honor the active
  locale — English users get English gap labels and date groups.
- `memory-tool.tsx` month names were hardcoded to `"en"`; now use the active locale.

## Verification

`npx tsc --noEmit` → exit 0 (clean).

## Intentionally left as-is (brand / non-content)

- `"Previously on"` (hero-section.tsx) and `"Previously"` (app-sidebar.tsx) — the
  show's title card / brand mark; kept in English by design, matching the audit's
  "intentionally not translatable" list.
- `DeepSeek`, `DeepSeek Chat`, `DeepSeek Reasoner`, `GitHub`, `Vercel` — product /
  service names.
- `error.message` in `chat-section.tsx` — rendered verbatim from the `Error` object.

## Lower-priority leftovers (report rows without matching source, or outside locale scope)

- Report rows for `language-selector`, `timeline/page.tsx`, `time-slice-recovery.tsx`,
  and `summary-bar.tsx` reference files that do not exist in the tree — skipped.
- `src/app/not-found.tsx` (rows 102–105): the root-level not-found renders outside
  the `[locale]` `NextIntlClientProvider`, so it has no locale/messages context.
  Left hardcoded; would require a locale-scoped not-found to translate.
- `src/app/layout.tsx` `lang="en"` (row 118): the root layout is above `[locale]`
  and has no access to the locale param. Left as-is; correct fix is to move
  `<html lang>` into the locale layout.
- `src/components/ui/message-scroller.tsx` sr-only "Scroll to end/start" (row 117):
  vendored shadcn UI primitive; left untouched to avoid diverging the base component.
