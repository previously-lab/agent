/** Text-only editor bindings, independent of upload/storage schema. The id is
 * supplied by the attachment owner; ordinal is assigned once, never an index. */
export interface ImageMarkerBinding {
  readonly id: string;
  readonly ordinal: number;
}

export interface ImageMarkerMatch extends ImageMarkerBinding {
  readonly start: number;
  readonly end: number;
}

export function imageMarkerText(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new RangeError("Invalid image marker ordinal");
  return `〔图${ordinal}〕`;
}

/** Unknown or ambiguous markers remain ordinary text, never a guessed target. */
export function findImageMarkers(text: string, bindings: readonly ImageMarkerBinding[]): ImageMarkerMatch[] {
  const targets = new Map<number, string | null>();
  for (const { id, ordinal } of bindings) {
    if (!id || !Number.isSafeInteger(ordinal) || ordinal < 1) continue;
    const previous = targets.get(ordinal);
    targets.set(ordinal, previous === undefined || previous === id ? id : null);
  }
  const matches: ImageMarkerMatch[] = [];
  for (const match of text.matchAll(/〔图([1-9]\d*)〕/g)) {
    const ordinal = Number(match[1]);
    const id = targets.get(ordinal);
    if (id) matches.push({ id, ordinal, start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

export function selectedImageMarker(
  text: string,
  selection: { start: number; end: number },
  bindings: readonly ImageMarkerBinding[],
): ImageMarkerMatch | null {
  if (selection.start < 0 || selection.end < selection.start || selection.end > text.length) return null;
  const selected = findImageMarkers(text, bindings).filter(({ start, end }) =>
    selection.start === selection.end
      ? selection.start >= start && selection.start < end
      : selection.start < end && selection.end > start);
  return selected.length === 1 ? selected[0] : null;
}

/** Insert at the caret or AFTER a selected passage, preserving the author's
 * words. Call synchronously at selection time, never after an upload awaits. */
export function insertImageMarker(text: string, selectionEnd: number, ordinal: number): { text: string; caret: number } {
  const end = Math.max(0, Math.min(text.length, Number.isFinite(selectionEnd) ? Math.trunc(selectionEnd) : text.length));
  const marker = imageMarkerText(ordinal);
  return { text: text.slice(0, end) + marker + text.slice(end), caret: end + marker.length };
}
