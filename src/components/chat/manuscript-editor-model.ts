import { IMAGE_ASSET_ID, isImageOrdinal } from "@/lib/chat/image-attachments";
import { findImageMarkers, type ImageMarkerMatch } from "@/lib/chat/image-markers";

/** The upload owner supplies identities. A local filename or prose alone is
 * never enough to turn text into an attachment capability. */
export interface ManuscriptBinding {
  readonly id: string;
  readonly ordinal: number;
  readonly assetId?: string;
}
export interface ManuscriptSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}
export interface ManuscriptSnapshot { text: string; selection: ManuscriptSelection }
export interface ManuscriptAtom extends ImageMarkerMatch { assetId: string }

export function manuscriptAtoms(text: string, bindings: readonly ManuscriptBinding[]): ManuscriptAtom[] {
  const valid = bindings.filter(binding => binding.id && isImageOrdinal(binding.ordinal)
    && typeof binding.assetId === "string" && IMAGE_ASSET_ID.test(binding.assetId));
  // Conflicting identities must remain literal even if one ordinal happens to
  // have the same local UI id. Never choose the first of ambiguous bindings.
  const ambiguous = new Set(valid.filter(a => valid.some(b => a.ordinal === b.ordinal
    && (a.id !== b.id || a.assetId !== b.assetId))).map(binding => binding.ordinal));
  return findImageMarkers(text, valid.filter(binding => !ambiguous.has(binding.ordinal)))
    .map(match => ({ ...match, assetId: valid.find(binding => binding.id === match.id && binding.ordinal === match.ordinal)!.assetId! }));
}

export function manuscriptSelection(text: string, selection: ManuscriptSelection, atoms: readonly ManuscriptAtom[] = []): ManuscriptSelection {
  const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(text.length, Math.trunc(n))) : text.length;
  let start = clamp(selection.start), end = Math.max(start, clamp(selection.end));
  for (const atom of atoms) {
    if (start === end && start > atom.start && start < atom.end) {
      start = end = start - atom.start < atom.end - start ? atom.start : atom.end;
    } else if (start !== end) {
      if (start > atom.start && start < atom.end) start = atom.start;
      if (end > atom.start && end < atom.end) end = atom.end;
    }
  }
  return { start, end, direction: start === end ? "none" : selection.direction };
}

/** Returns a whole-node deletion only when an edit actually touches a badge.
 * Ordinary text deletion stays browser-owned (graphemes, words, mobile IME). */
export function atomicDeletion(text: string, selection: ManuscriptSelection, bindings: readonly ManuscriptBinding[], backward: boolean): ManuscriptSelection | null {
  const atoms = manuscriptAtoms(text, bindings);
  const range = manuscriptSelection(text, selection, atoms);
  if (range.start !== range.end) {
    return atoms.some(atom => range.start < atom.end && range.end > atom.start) ? range : null;
  }
  const atom = atoms.find(item => backward ? item.end === range.start : item.start === range.end);
  return atom ? { start: atom.start, end: atom.end, direction: "none" } : null;
}

export function replaceManuscriptRange(snapshot: ManuscriptSnapshot, inserted: string, bindings: readonly ManuscriptBinding[], afterSelection = false): ManuscriptSnapshot {
  const range = manuscriptSelection(snapshot.text, snapshot.selection, manuscriptAtoms(snapshot.text, bindings));
  const start = afterSelection ? range.end : range.start;
  const normalized = inserted.replace(/\r\n?/g, "\n");
  const caret = start + normalized.length;
  return { text: snapshot.text.slice(0, start) + normalized + snapshot.text.slice(range.end),
    selection: { start: caret, end: caret, direction: "none" } };
}

/** One history owns native edits, badge operations and composition commits.
 * External draft replacement/scope changes reset it; accepted prose must not
 * unexpectedly reappear through browser-native undo in a new draft. */
export function createManuscriptHistory(initial: ManuscriptSnapshot, limit = 100) {
  let current = initial;
  let undo: ManuscriptSnapshot[] = [], redo: ManuscriptSnapshot[] = [];
  const clone = (value: ManuscriptSnapshot): ManuscriptSnapshot => ({ text: value.text, selection: { ...value.selection } });
  return {
    get: () => clone(current),
    select(selection: ManuscriptSelection) { current = { ...current, selection: { ...selection } }; },
    reset(value: ManuscriptSnapshot) { current = clone(value); undo = []; redo = []; },
    commit(value: ManuscriptSnapshot) {
      if (value.text !== current.text) { undo.push(clone(current)); undo = undo.slice(-limit); redo = []; }
      current = clone(value);
    },
    undo() { const previous = undo.pop(); if (!previous) return null; redo.push(clone(current)); current = previous; return clone(current); },
    redo() { const next = redo.pop(); if (!next) return null; undo.push(clone(current)); current = next; return clone(current); },
  };
}
