/**
 * The document desk's pure decisions (v0.22 P1) — the view model the R3F-side
 * scene renders and the two small pieces of logic the shell reuses, kept
 * React-free so vitest covers them in the node environment (the repo's test
 * env renders no components).
 */
import { normalizeCaseRefText, parseCaseRef } from "@/lib/docs/case-refs";
import type { CaseCategory } from "@/lib/docs";
import type { CaseDocContent } from "@/lib/episodic/actions";
import type { ConversationPanelMode } from "@/components/chat/conversation-panel";

/** What one sheet of paper wears, derived from the ref + the fetched
 *  document. `markdown === null` IS the dead-link decision: the desk renders
 *  the not-found paper (visible, never blocking — the case-refs axiom). */
export interface DeskPaperModel {
  /** The printed title — the ref's last segment, `.md` stripped. */
  title: string;
  /** The header's top-left case reference ("research / 手机调研"), or null
   *  for a legacy ref that names no case. */
  caseRef: string | null;
  /** The header's top-right date — the document's `opened`, verbatim. */
  date: string;
  /** The footer's bottom-right category, or null for a legacy ref. */
  category: CaseCategory | null;
  /** The body markdown, or null for a dead link (the not-found paper). */
  markdown: string | null;
}

export function deskPaperModel(
  ref: string,
  doc: CaseDocContent | null,
): DeskPaperModel {
  const parsed = parseCaseRef(ref);
  const bare = normalizeCaseRefText(ref);
  const lastSegment = bare.split("/").pop() ?? bare;

  let title = lastSegment || ref;
  let caseRef: string | null = null;
  let category: CaseCategory | null = null;
  if (parsed?.kind === "case") {
    title = parsed.caseName;
    caseRef = `${parsed.category} / ${parsed.caseName}`;
    category = parsed.category;
  } else if (parsed?.kind === "piece") {
    title = parsed.pieceFileName.replace(/\.md$/, "");
    caseRef = `${parsed.category} / ${parsed.caseName}`;
    category = parsed.category;
  } else if (parsed?.kind === "legacy") {
    title = parsed.name;
  }

  return {
    title,
    caseRef,
    date: doc?.opened ?? "",
    category,
    markdown: doc === null ? null : doc.markdown,
  };
}

// ─── Pagination (v0.24) — the pure half of the paged reader ──────────────
// The DOM half (multicol layout, column counting) needs a real layout engine
// and lives in desk-field.tsx; everything decidable without a browser is
// here and vitest-covered. Model: one sheet = one page; the flowed markdown
// renders in full inside each CONTENT shell and is translated to the shell's
// page, so a shell's visible page derives purely from (page, depth).

/** Pages a column container must hold at minimum: the natural content height
 *  over the page height, rounded up. Break-avoid rules can only push content
 *  LATER (never earlier), so this is a true lower bound; the layout loop in
 *  desk-field reads the exact count off the column overflow and widens to
 *  it. */
export function pageCountLowerBound(
  naturalH: number,
  pageH: number,
): number {
  if (!Number.isFinite(naturalH) || !Number.isFinite(pageH) || pageH <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(naturalH / pageH));
}

/** Keep a requested page inside [1, total] (resize re-pagination can shrink
 *  the count out from under the reader). */
export function clampPage(page: number, total: number): number {
  const t = Number.isFinite(total) && total >= 1 ? Math.floor(total) : 1;
  const p = Number.isFinite(page) ? Math.round(page) : 1;
  return Math.min(Math.max(1, p), t);
}

/** Which document page a stack slot carries, given the reader's current
 *  page — the deck invariant (top-down slots):
 *
 *    [k][k+1][blank][blank][k-1]   ← 5 slots, only 3 carry content
 *
 *  Slot 0 = the visible top sheet; slot 1 = the next page (the reveal target
 *  when the top is taken away); the last slot = the previous page (the
 *  prev-turn traveler). Everything else is blank paper — edges peek, nothing
 *  lies about pages that are not the current, next, or previous one.
 *  Null = blank. */
export function pageForShellSlot(
  page: number,
  total: number,
  slot: number,
  shellCount: number,
): number | null {
  if (slot === 0) return clampPage(page, total);
  if (slot === 1) {
    const next = clampPage(page, total) + 1;
    return next <= total ? next : null;
  }
  if (slot === shellCount - 1) {
    const prev = clampPage(page, total) - 1;
    return prev >= 1 ? prev : null;
  }
  return null;
}

/** The stack's slot count: the top + the next + two blanks + the bottom. */
export const SHELL_COUNT = 5;

/** How deep the peek goes: each slot behind the top slips down-right a
 *  little further (the card field's cumulative-cascade idiom, calmer — a
 *  neat document stack, not a fanned deck). px / degrees, applied from JS
 *  as --sx/--sy/--sr. */
const SHELL_STEP = { x: 5, y: 4, r: 0.35 } as const;

/** The slot's rest pose: slot 0 (top) sits at (0,0,0°); every slot beneath
 *  slips further down-right. */
export function shellOffsetForSlot(slot: number): {
  x: number;
  y: number;
  r: number;
} {
  const peek = Math.max(0, slot);
  return { x: peek * SHELL_STEP.x, y: peek * SHELL_STEP.y, r: peek * SHELL_STEP.r };
}

/** The turn beat, milliseconds — `desk-travel` / `desk-close-rank` in
 *  desk.css match this. */
export const TURN_MS = 480;

/** openDesk folds a fullscreen conversation back to the pill first (v0.22
 *  §3): fullscreen freezes the world's frame loop and covers the canvas the
 *  desk renders in. */
export function panelModeForDeskOpen(
  mode: ConversationPanelMode,
): ConversationPanelMode {
  return mode === "fullscreen" ? "pill" : mode;
}
