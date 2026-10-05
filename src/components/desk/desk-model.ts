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

/** The recess-type intensity for the pointer's height over the paper
 *  (v0.22 §12.2): 1 at mid-page, stronger toward the upper-left light,
 *  bounded 0.7–1.3. This locally scoped `--recess-i` is the ONLY dynamic
 *  light modulation the desk is allowed — it touches nothing global. */
export function recessIntensityFor(relY: number): number {
  if (!Number.isFinite(relY)) return 1;
  const clamped = Math.min(1, Math.max(0, relY));
  return Math.min(1.3, Math.max(0.7, 1 + (0.5 - clamped) * 0.6));
}

/** openDesk folds a fullscreen conversation back to the pill first (v0.22
 *  §3): fullscreen freezes the world's frame loop and covers the canvas the
 *  desk renders in. */
export function panelModeForDeskOpen(
  mode: ConversationPanelMode,
): ConversationPanelMode {
  return mode === "fullscreen" ? "pill" : mode;
}
