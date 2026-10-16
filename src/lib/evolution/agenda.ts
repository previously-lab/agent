/**
 * The reflection unit's agenda (v0.34 §6) — `memory/self/agenda.md`, the
 * unit's own work pad: hypotheses to re-check, judgments to revisit,
 * questions it left itself. Pure module — line format, parsing, formatting;
 * NO fs (unit-testable, sandbox-safe).
 *
 * Line format (mechanically scannable + prose-readable, same family as the
 * mailbox markers):
 *
 *   - [due: 2026-10-18] 复查 hypotheses/厄尔尼诺…：看新片是否证伪（据片 2026-10-14-1858）
 *
 * The `- [due: YYYY-MM-DD]` prefix is the ONLY mechanical contract. The
 * provenance (据片 <sliceId>) is prompt-enforced, not parsed. Parsing is
 * tolerant by design: any line that does not match the prefix is skipped
 * (headers, prose, a malformed date) and parseAgenda never throws — a
 * hand-edited or half-written agenda must never take a round down.
 *
 * Due judgment (§6.2): an item is due when `due <= the round's date`
 * (string compare — YYYY-MM-DD sorts lexicographically). Delivery of due
 * items into the round's docket (`agendaDue`) is a later batch's job; this
 * module is the shared pure half both sides build on.
 */

/** Where the agenda lives — self/ is the unit's own way of working (§6.1). */
export const AGENDA_PATH = "memory/self/agenda.md";

export interface AgendaItem {
  /** YYYY-MM-DD — due when `due <=` the round's date. */
  due: string;
  /** The one-line note, everything after the `[due: …]` prefix (trimmed). */
  text: string;
}

const AGENDA_LINE_RE = /^- \[due: (\d{4}-\d{2}-\d{2})\]\s+(.+)$/;

/**
 * Parse the agenda document into its due-dated items, in file order.
 * Tolerant degradation: blank lines, prose, and malformed lines are skipped;
 * null/garbage input yields []; never throws.
 */
export function parseAgenda(content: string | null | undefined): AgendaItem[] {
  if (!content) return [];
  const items: AgendaItem[] = [];
  for (const raw of content.split("\n")) {
    const match = AGENDA_LINE_RE.exec(raw.trim());
    if (!match) continue;
    const text = match[2].trim();
    if (!text) continue;
    items.push({ due: match[1], text });
  }
  return items;
}

/** Render one item as its agenda line. */
export function formatAgendaItem(item: AgendaItem): string {
  return `- [due: ${item.due}] ${item.text}`;
}

/**
 * Serialize items into the agenda document (one line each, trailing
 * newline; empty agenda → empty document). Round-trips with parseAgenda.
 */
export function serializeAgenda(items: AgendaItem[]): string {
  if (items.length === 0) return "";
  return items.map(formatAgendaItem).join("\n") + "\n";
}

/** The items due by `date` (YYYY-MM-DD), file order preserved (§6.2). */
export function dueAgendaItems(items: AgendaItem[], date: string): AgendaItem[] {
  return items.filter((item) => item.due <= date);
}
