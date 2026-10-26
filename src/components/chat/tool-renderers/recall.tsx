"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import {
  parseRecallOutput,
  type ParsedChangeEntry,
  type ParsedEntry,
  type ParsedRecallOutput,
} from "@/lib/chat/recall-output";
import {
  recallEntryDocumentTarget,
  recallReadDocumentTarget,
  type ToolDocumentTarget,
} from "@/lib/documents/tool-document";
import { DocumentToolActions } from "@/components/documents/document-actions";
import { DocumentOpenButton } from "@/components/documents/document-navigation";
import {
  BookOpenText,
  Inbox,
  ListTree,
  Search,
  SearchX,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface RecallToolRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

type Translator = ReturnType<typeof useTranslations>;

function scopeLabel(t: Translator, scope: string | undefined): string {
  if (!scope || scope === "memory") return t("recall.scope.memory");
  return t(`recall.scope.${scope}`, { defaultValue: scope });
}

interface SummarySpec {
  text: string;
  /** summaryClassName override — the four states read apart at a glance. */
  tone: "hit" | "miss" | "failure" | "muted";
  icon: React.ReactNode;
}

const TONE_CLASS: Record<SummarySpec["tone"], string | undefined> = {
  hit: undefined,
  miss: "text-amber-600 dark:text-amber-400",
  failure: "text-red-500 dark:text-red-400",
  muted: undefined,
};

/** Heading indent per level (outline list) — a real semantic state, keyed. */
const OUTLINE_INDENT: Record<number, string> = {
  1: "pl-0",
  2: "pl-4",
  3: "pl-8",
  4: "pl-12",
  5: "pl-16",
  6: "pl-20",
};

/** The recallSince change glyphs — colored by kind, keyed semantic state. */
const CHANGE_GLYPH: Record<ParsedChangeEntry["change"], { symbol: string; className: string }> = {
  added: { symbol: "+", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { symbol: "~", className: "text-amber-600 dark:text-amber-400" },
  removed: { symbol: "−", className: "text-red-500 dark:text-red-400" },
};

function summarize(
  parsed: ParsedRecallOutput | null,
  t: Translator,
): SummarySpec {
  const first = (entries: ParsedEntry[]) =>
    entries[0] ? entries[0].title : "";
  switch (parsed?.kind) {
    case "entries": {
      const count = parsed.entries.length;
      if (parsed.query !== undefined) {
        return {
          text: t("recall.summarySearch", {
            query: parsed.query,
            count,
          }),
          tone: "hit",
          icon: <Search className="h-3.5 w-3.5" />,
        };
      }
      return {
        text: t("recall.summaryRecent", {
          scope: scopeLabel(t, parsed.scope),
          count,
          first: first(parsed.entries),
        }),
        tone: "hit",
        icon: <Search className="h-3.5 w-3.5" />,
      };
    }
    case "fallback":
      return {
        text: t("recall.summaryFallback", {
          query: parsed.query,
          count: parsed.entries.length,
        }),
        tone: "miss",
        icon: <SearchX className="h-3.5 w-3.5" />,
      };
    case "notFound":
      return {
        text:
          parsed.nearMisses.length > 0
            ? t("recall.summaryMissNear", {
                name: parsed.name,
                count: parsed.nearMisses.length,
              })
            : t("recall.summaryMiss", { name: parsed.name }),
        tone: "miss",
        icon: <SearchX className="h-3.5 w-3.5" />,
      };
    case "readFailure":
      return {
        text: t("recall.summaryReadFailure"),
        tone: "failure",
        icon: <TriangleAlert className="h-3.5 w-3.5" />,
      };
    case "empty":
      return {
        text: t("recall.summaryEmpty", { scope: scopeLabel(t, parsed.scope) }),
        tone: "muted",
        icon: <Inbox className="h-3.5 w-3.5" />,
      };
    case "pastEnd":
      return {
        text: t("recall.summaryPastEnd", { total: parsed.total }),
        tone: "muted",
        icon: <Inbox className="h-3.5 w-3.5" />,
      };
    case "changes":
      return {
        text: t("recall.summaryChanges", {
          since: parsed.since,
          count: parsed.entries.length,
        }),
        tone: parsed.incomplete ? "miss" : "hit",
        icon: <ListTree className="h-3.5 w-3.5" />,
      };
    case "outline":
      // The caller replaces the text with the ref — icon only here.
      return {
        text: "",
        tone: "hit",
        icon: <ListTree className="h-3.5 w-3.5" />,
      };
    case "content":
    case "unknown":
    default:
      // recallRead's happy path — the caller replaces the text with the ref.
      return {
        text: "",
        tone: "hit",
        icon: <BookOpenText className="h-3.5 w-3.5" />,
      };
  }
}

function EntryList({ entries }: { entries: ParsedEntry[] }) {
  return (
    <ul className="space-y-1.5">
      {entries.map((e) => {
        const target = recallEntryDocumentTarget(e.ref, e.title);
        return (
          <li key={e.ref} className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2">
              {e.date && (
                <span className="shrink-0 font-mono text-[10px] leading-tight text-muted-foreground">
                  {e.date}
                </span>
              )}
              {target ? (
                <DocumentOpenButton
                  documentRef={target.ref}
                  location={{ edition: "original" }}
                  className="min-w-0 truncate rounded-md text-left text-xs leading-tight text-foreground/90 underline decoration-border/60 underline-offset-4 hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:text-brand-400"
                >
                  {target.title}
                </DocumentOpenButton>
              ) : (
                <span className="min-w-0 truncate text-xs leading-tight text-foreground/90">
                  {e.title}
                </span>
              )}
              <code className="ml-auto shrink-0 pl-2 font-mono text-[10px] leading-tight text-muted-foreground/70">
                {e.ref}
              </code>
            </div>
            {e.excerpt && (
              <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {e.excerpt}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The v0.36 memory-read verbs (recallRecent / recallFind / recallSearch /
 * recallRead) — one renderer for the whole family, keyed on the result
 * envelope's FIXED wording (src/lib/chat/recall-output.ts). The collapsed
 * row is always a one-line verb + scope + count + first-hit summary; the
 * expanded card keeps the five states visually distinct — a hit list, an
 * amber miss with near matches, a red read failure, a muted empty scope,
 * and an info line for paging — never flattening "miss" / "failure" /
 * "empty" into one "nothing".
 */
export function RecallToolRenderer({
  toolName,
  input,
  output,
  state,
}: RecallToolRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = (input ?? {}) as Record<string, unknown>;
  const ref =
    typeof inp.ref === "string" && inp.ref ? inp.ref : null;

  const parsed = parseRecallOutput(toolName, output);
  const running = state.running && output == null;
  const readTarget: ToolDocumentTarget | null | undefined = toolName === "recallRead"
    ? recallReadDocumentTarget(input, output)
    : undefined;

  const displayName = running
    ? t(`recall.${toolName}`)
    : toolName === "recallRead"
      ? t("recall.nameRead")
      : t(`recall.name.${toolName}`, { defaultValue: toolName });

  // ── Loading: shimmer skeleton in place of the summary line ─────────────
  if (running) {
    return (
      <ToolLayout
        name={displayName}
        icon={<Search className="h-3.5 w-3.5" />}
        summary={
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="h-2.5 w-8 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </span>
        }
        state={state}
      />
    );
  }

  const spec =
    parsed == null
      ? { text: "", tone: "hit" as const, icon: <Search className="h-3.5 w-3.5" /> }
      : summarize(parsed, t);

  const summaryReference = readTarget?.title ?? ref;
  const summaryText =
    toolName === "recallRead" && parsed?.kind === "content" && summaryReference
      ? t("recall.summaryRead", { reference: summaryReference })
      : toolName === "recallRead" && parsed?.kind === "outline" && summaryReference
        ? t("recall.summaryOutline", { reference: summaryReference })
        : toolName === "recallRead" && parsed?.kind === "content"
          ? parsed.text.split("\n", 1)[0]?.slice(0, 60) ?? ""
          : spec.text;

  const expandedContent = parsed == null ? undefined : buildExpanded(parsed, t, readTarget);

  return (
    <ToolLayout
      name={displayName}
      icon={spec.icon}
      summary={summaryText}
      summaryClassName={TONE_CLASS[spec.tone]}
      state={state}
      expandedContent={expandedContent}
    />
  );
}

function buildExpanded(
  parsed: ParsedRecallOutput,
  t: Translator,
  readTarget?: ToolDocumentTarget | null,
): React.ReactNode {
  switch (parsed.kind) {
    case "entries":
    case "fallback":
      return (
        <div className="space-y-2">
          {parsed.kind === "fallback" && (
            <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              {t("recall.fallbackNote", { query: parsed.query })}
            </p>
          )}
          <EntryList entries={parsed.entries} />
          {parsed.kind === "entries" && parsed.note?.kind === "offset" && (
            <p className="border-t border-border/50 pt-1.5 text-[11px] leading-snug text-muted-foreground">
              {t("recall.pageOffset", { offset: parsed.note.nextOffset })}
            </p>
          )}
          {parsed.kind === "entries" && parsed.note?.kind === "capped" && (
            <p className="border-t border-border/50 pt-1.5 text-[11px] leading-snug text-muted-foreground">
              {t("recall.pageCapped", {
                shown: parsed.note.shown,
                scanned: parsed.note.scanned,
              })}
            </p>
          )}
          {parsed.kind === "entries" && parsed.matchedName && (
            <p className="border-t border-border/50 pt-1.5 text-[11px] leading-snug text-muted-foreground">
              {t("recall.matchedName", { name: parsed.matchedName })}
            </p>
          )}
        </div>
      );
    case "empty":
      return (
        <p className="flex items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Inbox className="h-3.5 w-3.5 shrink-0" />
          {t("recall.emptyBody", { scope: scopeLabel(t, parsed.scope) })}
        </p>
      );
    case "notFound":
      return (
        <div className="space-y-1.5">
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
            <SearchX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("recall.missBody", { name: parsed.name })}
          </p>
          {parsed.nearMisses.length > 0 && (
            <div className="flex flex-wrap gap-1 pl-5">
              {parsed.nearMisses.map((m) => (
                <code
                  key={m}
                  className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-tight text-muted-foreground"
                >
                  {m}
                </code>
              ))}
            </div>
          )}
        </div>
      );
    case "pastEnd":
      return (
        <p className="flex items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Inbox className="h-3.5 w-3.5 shrink-0" />
          {t("recall.pastEndBody", {
            offset: parsed.offset,
            total: parsed.total,
          })}
        </p>
      );
    case "readFailure":
      return (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-red-500 dark:text-red-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("recall.readFailureBody")}
            {parsed.note ? ` (${parsed.note})` : ""}
          </span>
        </p>
      );
    case "changes": {
      if (parsed.entries.length === 0) {
        return (
          <p className="flex items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Inbox className="h-3.5 w-3.5 shrink-0" />
            {t("recall.changesEmpty", { since: parsed.since, until: parsed.until })}
          </p>
        );
      }
      return (
        <div className="space-y-2">
          <ul className="space-y-1">
            {parsed.entries.map((e) => {
              const target = e.change === "removed" ? null : recallEntryDocumentTarget(e.ref);
              return (
                <li key={`${e.change}:${e.ref}`} className="flex min-w-0 items-baseline gap-2">
                  <span
                    className={`shrink-0 font-mono text-[11px] leading-tight ${CHANGE_GLYPH[e.change].className}`}
                  >
                    {CHANGE_GLYPH[e.change].symbol}
                  </span>
                  {target ? (
                    <DocumentOpenButton
                      documentRef={target.ref}
                      location={{ edition: "original" }}
                      className="min-w-0 truncate rounded-md text-left text-[11px] leading-tight text-foreground/90 underline decoration-border/60 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {target.title}
                    </DocumentOpenButton>
                  ) : (
                    <code className="min-w-0 truncate font-mono text-[11px] leading-tight text-foreground/90">
                      {e.ref}
                    </code>
                  )}
                  {e.at && (
                    <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] leading-tight text-muted-foreground">
                      {e.at}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {parsed.incomplete && (
            <p className="flex items-start gap-1.5 border-t border-border/50 pt-1.5 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {t("recall.changesIncomplete")}
            </p>
          )}
          {parsed.cursorNote && (
            <p className="border-t border-border/50 pt-1.5 text-[11px] leading-snug text-muted-foreground">
              {t("recall.changesCursor", { cursor: parsed.cursorNote })}
            </p>
          )}
        </div>
      );
    }
    case "outline":
      return (
        <div className="space-y-2">
          {readTarget !== undefined && <DocumentToolActions target={readTarget} />}
          {parsed.headings.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("recall.outlineEmpty")}
            </p>
          ) : (
            <ul className="space-y-1">
              {parsed.headings.map((h) => (
                <li
                  key={`${h.from}-${h.title}`}
                  className={`flex min-w-0 items-baseline gap-2 ${OUTLINE_INDENT[h.level] ?? "pl-20"}`}
                >
                  <span className="shrink-0 font-mono text-[10px] leading-tight text-muted-foreground">
                    L{h.from}-{h.to}
                  </span>
                  <span className="min-w-0 truncate text-xs leading-tight text-foreground/90">
                    {h.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case "content": {
      // The document body is the server-rendered text — shown verbatim,
      // typeset as reading prose, scrollable inside the card. A near-name
      // banner names the stored ref the body actually came from.
      return (
        <div className="space-y-1.5">
          {readTarget !== undefined && <DocumentToolActions target={readTarget} />}
          {parsed.nearName && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("recall.nearNameBanner", { name: parsed.nearName })}
            </p>
          )}
          <div className="font-serif text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
            {parsed.text}
          </div>
        </div>
      );
    }
    case "unknown":
      return (
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {parsed.text.length > 3000 ? parsed.text.slice(0, 3000) + "\n…" : parsed.text}
        </pre>
      );
  }
}
