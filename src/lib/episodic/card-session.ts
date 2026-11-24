/** Fine-grained mutations preserve the complete text and require valid evidence references. */
import { parseCard, serializeCard, type CardDocument } from "./previously-format";

export interface CardSession {
  /** The working document — mutated in place by the session functions. */
  doc: CardDocument;
  /** Compact log of every APPLIED mutation ("addNow: prepping friday interview"). */
  log: string[];
  /** The user's LOCAL calendar date (YYYY-MM-DD) — the default `since` for new Now items. */
  today: string;
}

/**
 * Start a mutation session from the current card content. A legacy (v1) card
 * parses onto the v5 sections; an unparseable document (v3 free-form) starts
 * EMPTY — the raw legacy text stays visible in the agent's prompt and it
 * rebuilds the content through mutations.
 */
export function createCardSession(
  baseContent: string,
  sliceId: string,
  today: string,
  nowIso = new Date().toISOString(),
): CardSession {
  const parsed = baseContent.trim() ? parseCard(baseContent) : null;
  const doc: CardDocument =
    parsed ?? {
      sliceId,
      updated: nowIso,
      identity: [],
      past: { profile: "", anchors: [] },
      now: [],
      horizon: [],
      selfModel: [],
    };
  doc.sliceId = sliceId;
  doc.updated = nowIso;
  return { doc, log: [], today };
}

/** Serialize the session's working document — the final card text. */
export function serializeSession(session: CardSession): string {
  return serializeCard(session.doc);
}

/**
 * Substance comparison — ignores the sliceId/updated stamps, which refresh on
 * every pass. True when identity/past/now/horizon are identical. The legacy
 * selfModel list is compared too, so stripping a legacy `## Self-model`
 * section (the writer never re-emits it) correctly registers as a change.
 */
export function sameCardSubstance(
  a: CardDocument | null,
  b: CardDocument | null,
): boolean {
  const substance = (d: CardDocument | null) =>
    JSON.stringify({
      identity: d?.identity ?? [],
      past: d?.past ?? { profile: "", anchors: [] },
      now: d?.now ?? [],
      horizon: d?.horizon ?? [],
      selfModel: d?.selfModel ?? [],
    });
  return substance(a) === substance(b);
}

// ─── Validation helpers ───────────────────────────────────────────────────

const REF_RE = /^\d{4}\/\d{2}\/\d{2}\/\d{4}(-[A-Za-z0-9]+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Slice ids everywhere else are dash-form (YYYY-MM-DD-HHMM) — the worker
 *  naturally cites them as-is. Accept that form too. */
const REF_DASH_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{4}(-[A-Za-z0-9]+)?)$/;

/** Normalize one ref to the canonical slash form; null when unrecognizable. */
function normalizeRef(ref: string): string | null {
  if (REF_RE.test(ref)) return ref;
  const m = REF_DASH_RE.exec(ref.trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}

function checkField(field: string, text: string): string | null {
  if (!text.trim()) return `REJECTED: ${field} is empty.`;
  if (text.includes("\n"))
    return `REJECTED: ${field} must be a single line (${text.length} chars incl. a line break).`;
  return null;
}

function checkRefs(refs: string[]): string | null {
  if (refs.length === 0)
    return "REJECTED: refs are required — cite the evidence slice (e.g. [\"2026/08/07/0709\"]). No evidence, no write.";
  // Validate + normalize IN PLACE: dash-form slice ids become slash-form, so a
  // ref copied verbatim from the slice id no longer bounces.
  for (let i = 0; i < refs.length; i++) {
    const normalized = normalizeRef(refs[i]);
    if (!normalized)
      return `REJECTED: malformed ref "${refs[i]}" — expected the evidence slice id (YYYY-MM-DD-HHMM, optionally -turnId).`;
    refs[i] = normalized;
  }
  return null;
}

function checkDup(existing: string[], text: string, section: string): string | null {
  const norm = (s: string) => s.trim().toLowerCase();
  if (existing.some((t) => norm(t) === norm(text)))
    return `REJECTED: this ${section} entry is already on the card — merge or edit in place instead of duplicating.`;
  return null;
}

/**
 * Find items whose text contains `match` (case-insensitive). On no match the
 * caller returns a rejection listing the current entries so the agent can fix
 * its match string instead of guessing.
 */
function findMatch<T extends { text: string }>(
  items: T[],
  match: string,
): T | undefined {
  const m = match.trim().toLowerCase();
  if (!m) return undefined;
  return items.find((it) => it.text.toLowerCase().includes(m));
}

function previewList(items: Array<{ text: string }>): string {
  if (items.length === 0) return "(none)";
  return items.map((i) => `"${i.text.slice(0, 60)}"`).join(", ");
}

function noMatch(section: string, match: string, items: Array<{ text: string }>): string {
  return `REJECTED: no ${section} entry contains "${match}". Current entries: ${previewList(items)}. Retry with a substring of the entry you mean.`;
}

const IDENTITY_LABELS = {
  name: "Name",
  address_as: "Address them as",
  pronouns: "Pronouns",
  alias: "Alias",
} as const;

export type IdentityField = keyof typeof IDENTITY_LABELS;

export function sessionSetIdentity(
  session: CardSession,
  field: IdentityField,
  value: string,
): string {
  const error = checkField("Identity", value);
  if (error) return error;
  const effective = value.trim();
  const label = IDENTITY_LABELS[field];
  const line = `${label}: ${effective}`;
  const idx = session.doc.identity.findIndex((l) =>
    l.toLowerCase().startsWith(label.toLowerCase() + ":"),
  );
  if (idx >= 0) {
    session.doc.identity[idx] = line;
    session.log.push(`setIdentity: ${label} updated`);
    return `OK — ${label} updated in place.`;
  }
  session.doc.identity.push(line);
  session.log.push(`setIdentity: ${label} added`);
  return `OK — ${label} added.`;
}

// ─── Past ─────────────────────────────────────────────────────────────────

export function sessionUpdatePastProfile(session: CardSession, text: string): string {
  const error = checkField("Past profile", text);
  if (error) return error;
  session.doc.past.profile = text.trim();
  session.log.push("updatePastProfile: profile rewritten");
  return `OK — Past profile updated (${text.trim().length} chars).`;
}

export function sessionAddPastAnchor(
  session: CardSession,
  text: string,
  refs: string[],
): string {
  const effective = text.trim();
  const err = checkField("Past anchor", text) ??
    checkRefs(refs) ??
    checkDup(session.doc.past.anchors.map((a) => a.text), effective, "Past anchor");
  if (err) return err;
  session.doc.past.anchors.push({ text: effective, refs });
  session.log.push(`addPastAnchor: ${effective.slice(0, 50)}`);
  return `OK — anchor added (${session.doc.past.anchors.length}).`;
}

export function sessionRemovePastAnchor(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.past.anchors, match);
  if (!hit)
    return noMatch("Past anchor", match, session.doc.past.anchors);
  session.doc.past.anchors = session.doc.past.anchors.filter((a) => a !== hit);
  session.log.push(`removePastAnchor: ${hit.text.slice(0, 50)}`);
  return `OK — anchor removed: "${hit.text.slice(0, 60)}".`;
}

// ─── Now ──────────────────────────────────────────────────────────────────

export function sessionAddNow(
  session: CardSession,
  text: string,
  refs: string[],
  since?: string,
): string {
  const effective = text.trim();
  const err = checkField("Now item", text) ??
    checkRefs(refs) ??
    checkDup(session.doc.now.map((r) => r.text), effective, "Now");
  if (err) return err;
  const date = since ?? session.today;
  if (!DATE_RE.test(date))
    return `REJECTED: since must be YYYY-MM-DD (got "${date}") — use the user's local date given in the prompt.`;
  session.doc.now.unshift({ text: effective, refs, since: date });
  session.log.push(`addNow: ${effective.slice(0, 50)}`);
  return `OK — Now item added (${session.doc.now.length}), since: ${date}.`;
}

export function sessionRemoveNow(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.now, match);
  if (!hit)
    return noMatch("Now", match, session.doc.now);
  session.doc.now = session.doc.now.filter((r) => r !== hit);
  session.log.push(`removeNow: ${hit.text.slice(0, 50)}`);
  return `OK — Now item removed: "${hit.text.slice(0, 60)}".`;
}

/**
 * Promote a Now item to a durable Past anchor (keeps its refs). For folding
 * the substance into the profile PARAGRAPH instead, use updatePastProfile +
 * removeNow.
 */
export function sessionPromoteNowToPast(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.now, match);
  if (!hit) return noMatch("Now", match, session.doc.now);
  session.doc.now = session.doc.now.filter((r) => r !== hit);
  session.doc.past.anchors.push({ text: hit.text, refs: hit.refs });
  session.log.push(`promoteNowToPast: ${hit.text.slice(0, 50)}`);
  return `OK — promoted to Past anchors: "${hit.text.slice(0, 60)}".`;
}

// NOTE: there are deliberately NO Self-model or task/Horizon session mutations —
// the card is a pure background memory pool (Identity/Past/Now); user patterns
// live in the evolution direction's Portrait (src/lib/evolution/direction-agent.ts),
// and commitments live in the authoritative task ledger and tasks/ cases.
// parseCard still fills doc.selfModel from a LEGACY card so the old lines
// survive until the evolution agent migrates them; serializeSession never
// writes the section back.
