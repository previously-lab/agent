/**
 * The document desk's pure decisions (v0.22 P1) — the view model the R3F-side
 * scene renders and the two small pieces of logic the shell reuses, kept
 * React-free so vitest covers them in the node environment (the repo's test
 * env renders no components).
 */
import { normalizeCaseRefText, parseCaseRef } from "@/lib/docs/case-refs";
import type { CaseCategory } from "@/lib/docs";
import type { CaseDocContent } from "@/lib/episodic/actions";
import {
  parseDossierRef,
  parseRecordRef,
  type DossierDocName,
} from "@/lib/archive/refs";
import type { ConversationPanelMode } from "@/components/chat/conversation-panel";

/** Which paper the desk is printing, from the ref's vocabulary (refs.ts):
 *  the case grammar's three shapes, a record (a slice's transcript), or a
 *  Dossier self-document. */
export type DeskPaperKind = "case" | "piece" | "legacy" | "record" | "dossier";

/** What one sheet of paper wears, derived from the ref + the fetched
 *  document. `markdown === null` IS the dead-link decision: the desk renders
 *  the not-found paper (visible, never blocking — the case-refs axiom). */
export interface DeskPaperModel {
  /** The printed title — the ref's last segment, `.md` stripped. "" for a
   *  record: the transcript's identity lives entirely in the header (§三:
   *  date + slice id + turn count), the body is the turns alone. */
  title: string;
  /** The running head's left line: the case reference ("research / 手机调研"),
   *  the record's slice id, or null for a legacy ref / a dossier paper (the
   *  dossier prints its fixed English name there instead). */
  caseRef: string | null;
  /** The header's date — the document's `opened`, verbatim. Printed 700
   *  tabular in both heads (the masthead's data line, the runhead's right
   *  slot). */
  date: string;
  /** The bare category the masthead's data line and the footer's right slot
   *  print, or null for a non-case paper (a record wears the records label;
   *  a dossier prints none). */
  category: CaseCategory | null;
  /** The body markdown, or null for a dead link (the not-found paper). */
  markdown: string | null;
  kind: DeskPaperKind;
  /** Record papers: the slice's turn count. */
  turnCount: number | null;
  /** Record papers: the slice's recorded timezone — the letterhead's clock
   *  line prints it next to the wall clock derived from the slice id. */
  timezone: string | null;
  /** Dossier papers: which self-document (drives the fixed English name). */
  dossier: DossierDocName | null;
}

/** The record read carries the turn count and the timezone beyond the case
 *  document shape. */
type DeskDocContent = CaseDocContent & { turnCount?: number; timezone?: string };

/** The dossier's fixed English name (v0.28): the paper's furniture is not
 *  translated — the letterhead prints it uppercased, the running head and
 *  the display title print it as written here. */
export const DOSSIER_NAMES: Record<DossierDocName, string> = {
  previously: "Previously on",
  direction: "Direction",
};

/** The letterhead (v0.28): `Previously` over three tight monospace lines —
 *  the document's clock, its bare category, and its place on the shelf. A
 *  line whose data does not exist is null: the paper OMITS it (a dossier is
 *  honestly three lines), never prints a placeholder. Every word here is
 *  fixed English — the paper's furniture is not translated. */
export function mastheadLines(model: DeskPaperModel): {
  /** Line 2: the stored date, or the record's local wall clock (from the
   *  slice id's digits) with its recorded timezone. */
  clock: string | null;
  /** Line 3: the bare category, uppercased English (RESEARCH / RECORD /
   *  PREVIOUSLY ON). */
  category: string | null;
  /** Line 4: the file's place on the shelf (`research / rsi`,
   *  `records / 2026-10-04`). */
  shelf: string | null;
} {
  if (model.kind === "record") {
    const id = model.caseRef ?? "";
    // The slice id IS the local wall clock at birth (YYYY-MM-DD-HHMM).
    const clock =
      id.length >= 15
        ? `${id.slice(0, 10)} ${id.slice(11, 13)}:${id.slice(13, 15)}${
            model.timezone ? ` · ${model.timezone}` : ""
          }`
        : null;
    return {
      clock,
      category: "RECORD",
      shelf: id.length >= 10 ? `records / ${id.slice(0, 10)}` : null,
    };
  }
  if (model.kind === "dossier") {
    return {
      clock: model.date !== "" ? model.date : null,
      category: model.dossier
        ? DOSSIER_NAMES[model.dossier].toUpperCase()
        : null,
      shelf: null,
    };
  }
  return {
    clock: model.date !== "" ? model.date : null,
    category: model.category ? model.category.toUpperCase() : null,
    shelf: model.caseRef,
  };
}

export function deskPaperModel(
  ref: string,
  doc: DeskDocContent | null,
): DeskPaperModel {
  // The non-case vocabularies route FIRST (refs.ts — a record ref's last
  // segment would otherwise pass the case grammar's legacy fallback).
  const record = parseRecordRef(ref);
  if (record) {
    return {
      title: "",
      caseRef: record.sliceId,
      date: doc?.opened ?? "",
      category: null,
      markdown: doc === null ? null : doc.markdown,
      kind: "record",
      turnCount: doc?.turnCount ?? null,
      timezone: doc?.timezone ?? null,
      dossier: null,
    };
  }
  const dossier = parseDossierRef(ref);
  if (dossier) {
    return {
      title: dossier.name,
      caseRef: null,
      date: doc?.opened ?? "",
      category: null,
      markdown: doc === null ? null : doc.markdown,
      kind: "dossier",
      turnCount: null,
      timezone: null,
      dossier: dossier.name,
    };
  }

  const parsed = parseCaseRef(ref);
  const bare = normalizeCaseRefText(ref);
  const lastSegment = bare.split("/").pop() ?? bare;

  let title = lastSegment || ref;
  let caseRef: string | null = null;
  let category: CaseCategory | null = null;
  let kind: DeskPaperKind = "legacy";
  if (parsed?.kind === "case") {
    title = parsed.caseName;
    caseRef = `${parsed.category} / ${parsed.caseName}`;
    category = parsed.category;
    kind = "case";
  } else if (parsed?.kind === "piece") {
    title = parsed.pieceFileName.replace(/\.md$/, "");
    caseRef = `${parsed.category} / ${parsed.caseName}`;
    category = parsed.category;
    kind = "piece";
  } else if (parsed?.kind === "legacy") {
    title = parsed.name;
  }

  return {
    title,
    caseRef,
    date: doc?.opened ?? "",
    category,
    markdown: doc === null ? null : doc.markdown,
    kind,
    turnCount: null,
    timezone: null,
    dossier: null,
  };
}

// ─── Pagination (v0.24, cyclic in v0.29) — the pure half of the paged
// reader. The DOM half (multicol layout, column counting) needs a real
// layout engine and lives in desk-field.tsx; everything decidable without a
// browser is here and vitest-covered. Model: one sheet = one page; the
// flowed markdown renders in full inside each CONTENT shell and is
// translated to the shell's page, so a shell's visible page derives purely
// from (page, depth). The stack is a CYCLE (the owner's ruling): turning
// forward past the last page returns to the first, back past the first
// returns to the last — like turning a held stack of paper over.

/** Keep a requested page inside [1, total] (resize re-pagination can shrink
 *  the count out from under the reader). */
export function clampPage(page: number, total: number): number {
  const t = Number.isFinite(total) && total >= 1 ? Math.floor(total) : 1;
  const p = Number.isFinite(page) ? Math.round(page) : 1;
  return Math.min(Math.max(1, p), t);
}

/** The cycle's step: page ± n wrapped into [1, total]. */
export function wrapPage(page: number, total: number): number {
  const t = Number.isFinite(total) && total >= 1 ? Math.floor(total) : 1;
  if (t <= 1) return 1;
  const p = Number.isFinite(page) ? Math.round(page) : 1;
  return ((((p - 1) % t) + t) % t) + 1;
}

/** Which document page a stack slot carries, given the reader's current
 *  page — the deck invariant (top-down slots):
 *
 *    [k][k+1][blank][blank][k-1]   ← 5 slots, only 3 carry content
 *
 *  Slot 0 = the visible top sheet; slot 1 = the next page (the reveal target
 *  when the top is taken away); the last slot = the previous page (the
 *  prev-turn traveler). The neighbours wrap (the stack is a cycle), so at
 *  the document's ends the reveal is the other end's page — never a blank
 *  sheet standing in for a page that exists. The middle slots stay blank
 *  paper — edges peek, nothing lies about pages that are not the current,
 *  next, or previous one. Null = blank. */
export function pageForShellSlot(
  page: number,
  total: number,
  slot: number,
  shellCount: number,
): number | null {
  if (slot === 0) return clampPage(page, total);
  if (slot === 1) return wrapPage(clampPage(page, total) + 1, total);
  if (slot === shellCount - 1) {
    return wrapPage(clampPage(page, total) - 1, total);
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
