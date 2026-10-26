import type { DocumentTurnRole } from "./document-link";

export interface RecordAnchorTurn {
  index: number;
  turnId?: string;
  role: DocumentTurnRole;
}

export type RecordAnchorMatch =
  | { status: "found"; index: number }
  | { status: "missing" | "ambiguous" };

export function resolveRecordTurnAnchor(
  turns: readonly RecordAnchorTurn[],
  turnId: string,
  role?: DocumentTurnRole,
): RecordAnchorMatch {
  const matches = turns.filter((turn) => turn.turnId === turnId && (!role || turn.role === role));
  if (matches.length === 1) return { status: "found", index: matches[0].index };
  return { status: matches.length === 0 ? "missing" : "ambiguous" };
}

export function paperPageForPoint(input: {
  pagesLeft: number;
  targetLeft: number;
  pageWidth: number;
  zoom: number;
}): number | null {
  const { pagesLeft, targetLeft, pageWidth, zoom } = input;
  if (
    !Number.isFinite(pagesLeft) ||
    !Number.isFinite(targetLeft) ||
    !Number.isFinite(pageWidth) ||
    !Number.isFinite(zoom) ||
    pageWidth <= 0 ||
    zoom <= 0
  ) {
    return null;
  }
  const documentX = (targetLeft - pagesLeft) / zoom;
  return Math.max(1, Math.floor(documentX / pageWidth) + 1);
}
