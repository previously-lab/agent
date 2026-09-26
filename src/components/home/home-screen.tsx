import { Link } from "@/i18n/navigation";
import type { SubtitleRun } from "@/lib/chat/subtitle-line";
import type { HomeRecap } from "@/lib/home/recap";

/**
 * The home (v0.13 §3) — pure typography on the field. No card, no box, no
 * stamps, no file numbers: sentence case, and weight + two hairline rules
 * carry the hierarchy. Zones, top to bottom:
 *
 *   TITLE    "Previously on" (the product's sentence, weight-split) and the
 *            reader's name — the biggest thing on the page.
 *   RECAP    where the last conversation left off: a fixed-width mono
 *            speaker column + the spoken lines in serif (two display lines,
 *            emphasis painted from the subtitle parser's runs — no marker
 *            ever leaks), then the slice's own clock and the real gap.
 *   ACTIONS  one row: 接着说 → `/app` (the old 继续, the reader's wording),
 *            进入世界 → `/app?view=game`, 设置 at the right end.
 *
 * Purely presentational: every fact arrives formatted from the server page,
 * so this file stays locale- and clock-free. No R3F anywhere in the import
 * graph.
 */

// ─── The tuning table ──────────────────────────────────────────────────────
// Every size, space and width the layout uses, in one place: change one
// number here, the whole page follows.

/** The column's full width — both hairlines span exactly this. */
export const HOME_COLUMN_MAX_WIDTH_REM = 24;

/** Line 1 ("Previously on") — small, muted ink, the lead a touch heavier. */
export const HOME_EYEBROW_SIZE_PX = 16;

/** Line 2 (the reader's name) — the biggest thing on the page. */
export const HOME_NAME_SIZE_PX = 44;
export const HOME_NAME_LINE_HEIGHT = 1.15;

/** Hairline 1 — the air above it is the title's, below it the recap's. */
export const HOME_RULE_TITLE_GAP_PX = 40;
export const HOME_RULE_RECAP_GAP_PX = 24;

/** Hairline 2 — below the recap's clock line, above the actions. */
export const HOME_RULE_ACTIONS_GAP_PX = 32;
export const HOME_RULE_NAV_GAP_PX = 24;

/** The recap's fixed-width speaker column (`你` / `Previously`). */
export const HOME_SPEAKER_WIDTH_REM = 6;
export const HOME_SPEAKER_SIZE_PX = 11;

/** The spoken lines — serif, at most two display lines with an ellipsis. */
export const HOME_QUOTE_SIZE_PX = 15;
export const HOME_QUOTE_LINE_HEIGHT = 1.75;

/** The clock line — mono, muted. */
export const HOME_TIME_SIZE_PX = 12;
export const HOME_TIME_GAP_PX = 16;

/** The one row of actions: primary full ink, then muted, smaller. */
export const HOME_ACTION_SIZE_PX = 18;
export const HOME_SECONDARY_SIZE_PX = 13;
export const HOME_SETTINGS_SIZE_PX = 12;

/** Inks — the semantic palette the zones draw on. */
export const HOME_INK_FULL = "text-foreground";
export const HOME_INK_MUTED = "text-muted-foreground";
export const HOME_INK_FAINT = "text-muted-foreground/70";
export const HOME_INK_BRAND = "text-brand";
export const HOME_RULE_CLASS = "border-t border-border";

export interface HomeScreenProps {
  /** Line 1, weight-split parts — the product's own sentence. */
  eyebrowLead: string;
  eyebrowPreposition: string;
  /** Line 2 — the reader's name, from the same read the header chip uses. */
  name: string;
  recap: {
    /** Localized wall-clock of the last exchange, in the slice's timezone. */
    when: string;
    /** Localized gap since then ("3 days ago" / "3 天前"). */
    gap: string;
    youLabel: string;
    agentLabel: string;
    lastUser: HomeRecap["lastUser"];
    lastAgent: HomeRecap["lastAgent"];
  } | null;
  continueLabel: string;
  enterWorldLabel: string;
  settingsLabel: string;
}

/** One side of the last exchange — mono speaker, serif words, emphasis kept. */
function QuoteRow({
  speaker,
  speakerClass,
  runs,
}: {
  speaker: string;
  speakerClass: string;
  runs: SubtitleRun[];
}) {
  return (
    <div className="flex gap-3">
      <dt
        className={`shrink-0 font-mono ${speakerClass}`}
        style={{
          width: HOME_SPEAKER_WIDTH_REM * 16,
          fontSize: HOME_SPEAKER_SIZE_PX,
        }}
      >
        {speaker}
      </dt>
      <dd
        className={`min-w-0 flex-1 font-serif text-foreground/90 line-clamp-2`}
        style={{
          fontSize: HOME_QUOTE_SIZE_PX,
          lineHeight: HOME_QUOTE_LINE_HEIGHT,
        }}
      >
        {runs.map((run, index) =>
          run.emphasis === "strong" ? (
            <strong key={index} className={`font-semibold ${HOME_INK_FULL}`}>
              {run.text}
            </strong>
          ) : run.emphasis === "code" ? (
            <code
              key={index}
              className="rounded-sm bg-foreground/10 px-1 font-mono text-[0.85em]"
            >
              {run.text}
            </code>
          ) : (
            run.text
          ),
        )}
      </dd>
    </div>
  );
}

export function HomeScreen({
  eyebrowLead,
  eyebrowPreposition,
  name,
  recap,
  continueLabel,
  enterWorldLabel,
  settingsLabel,
}: HomeScreenProps) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center overflow-y-auto px-6">
      <div className="w-full" style={{ maxWidth: HOME_COLUMN_MAX_WIDTH_REM * 16 }}>
        {/* TITLE — the product's sentence, then the reader's name. Sentence
            case, no tracking: the NAME carries the weight split (lead heavier
            than the preposition), the name itself is the page's largest ink. */}
        <header>
          <p
            className={`font-serif ${HOME_INK_MUTED}`}
            style={{ fontSize: HOME_EYEBROW_SIZE_PX }}
          >
            <span className="font-medium text-foreground/75">
              {eyebrowLead}
            </span>{" "}
            {eyebrowPreposition}
          </p>
          <h1
            className={`mt-1 font-serif font-semibold ${HOME_INK_FULL}`}
            style={{
              fontSize: HOME_NAME_SIZE_PX,
              lineHeight: HOME_NAME_LINE_HEIGHT,
            }}
          >
            {name}
          </h1>
        </header>

        {/* HAIRLINE 1 — the title's only frame. No box anywhere: the rule,
            not a border, is what separates the name from the memory. */}
        <hr
          aria-hidden
          className={HOME_RULE_CLASS}
          style={{
            marginTop: HOME_RULE_TITLE_GAP_PX,
            marginBottom: HOME_RULE_RECAP_GAP_PX,
          }}
        />

        {/* 前情提要 — where the last conversation left off. The clock line
            sits UNDER the words, the way a dateline closes a passage. */}
        {recap && (
          <section>
            <dl className="space-y-2.5">
              {recap.lastUser && (
                <QuoteRow
                  speaker={recap.youLabel}
                  speakerClass={HOME_INK_FAINT}
                  runs={recap.lastUser}
                />
              )}
              {recap.lastAgent && (
                <QuoteRow
                  speaker={recap.agentLabel}
                  speakerClass={HOME_INK_BRAND}
                  runs={recap.lastAgent}
                />
              )}
            </dl>
            <p
              className={`font-mono ${HOME_INK_FAINT}`}
              style={{ fontSize: HOME_TIME_SIZE_PX, marginTop: HOME_TIME_GAP_PX }}
            >
              {recap.when}
              <span className="opacity-50"> · </span>
              {recap.gap}
            </p>
          </section>
        )}

        {/* HAIRLINE 2 — under the dateline, above the doors. */}
        <hr
          aria-hidden
          className={HOME_RULE_CLASS}
          style={{
            marginTop: HOME_RULE_ACTIONS_GAP_PX,
            marginBottom: HOME_RULE_NAV_GAP_PX,
          }}
        />

        {/* THE DOORS — one row. 接着说 IS the old 继续 (same `/app` door):
            the reader's wording, the hero, its arrow in the brand ink. */}
        <nav className="flex items-baseline gap-8">
          <Link
            href="/app"
            className={`font-medium ${HOME_INK_FULL} transition-colors hover:text-brand`}
            style={{ fontSize: HOME_ACTION_SIZE_PX }}
          >
            {continueLabel}
            <span aria-hidden className={HOME_INK_BRAND}>
              {" "}
              →
            </span>
          </Link>
          <Link
            href="/app?view=game"
            className={`${HOME_INK_MUTED} transition-colors hover:${HOME_INK_FULL}`}
            style={{ fontSize: HOME_SECONDARY_SIZE_PX }}
          >
            {enterWorldLabel}
          </Link>
          <Link
            href="/settings"
            className={`ml-auto ${HOME_INK_FAINT} transition-colors hover:${HOME_INK_FULL}`}
            style={{ fontSize: HOME_SETTINGS_SIZE_PX }}
          >
            {settingsLabel}
          </Link>
        </nav>
      </div>
    </main>
  );
}
