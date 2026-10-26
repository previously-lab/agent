export type DocumentMentionRange = {
  start: number;
  end: number;
  query: string;
};

export const DOCUMENT_MENTION_QUERY_LIMIT = 120;

export function findDocumentMentionRange(
  value: string,
  caret: number,
): DocumentMentionRange | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
  const beforeCaret = value.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s([{‘“'"<]/.test(value[at - 1])) return null;
  const query = beforeCaret.slice(at + 1);
  if (query.length > DOCUMENT_MENTION_QUERY_LIMIT || /[\r\n@]/.test(query)) return null;
  return { start: at, end: caret, query };
}

export function removeDocumentMentionRange(
  value: string,
  range: DocumentMentionRange,
): string {
  return `${value.slice(0, range.start)}${value.slice(range.end)}`;
}

export function isImeKeyboardEvent(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function nextDocumentMentionIndex(
  current: number,
  count: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const safeCurrent = current >= 0 && current < count ? current : key === "ArrowDown" ? -1 : 0;
  return key === "ArrowDown"
    ? (safeCurrent + 1) % count
    : (safeCurrent - 1 + count) % count;
}
