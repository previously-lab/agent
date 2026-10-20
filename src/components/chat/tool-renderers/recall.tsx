"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import {
  parseRecallOutput,
  type ParsedEntry,
  type ParsedRecallOutput,
} from "@/lib/chat/recall-output";
import {
  BookOpenText,
  Inbox,
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
      {entries.map((e) => (
        <li key={e.ref} className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            {e.date && (
              <span className="shrink-0 font-mono text-[10px] leading-tight text-muted-foreground">
                {e.date}
              </span>
            )}
            <span className="min-w-0 truncate text-xs leading-tight text-foreground/90">
              {e.title}
            </span>
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
      ))}
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

  // recallRead's collapsed summary is the ref it read (or the read state).
  const summaryText =
    toolName === "recallRead" && parsed?.kind === "content" && ref
      ? t("recall.summaryRead", { reference: ref })
      : toolName === "recallRead" && parsed?.kind === "content"
        ? parsed.text.split("\n", 1)[0]?.slice(0, 60) ?? ""
        : spec.text;

  const expandedContent = parsed == null ? undefined : buildExpanded(parsed, t);

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
    case "content": {
      // The document body is the server-rendered text — shown verbatim,
      // typeset as reading prose, scrollable inside the card.
      return (
        <div className="font-serif text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
          {parsed.text}
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
