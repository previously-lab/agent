export const NATIVE_DRAFT_EVENT = "previously:native-draft";

export function appendNativeDraft(existing: string, suggestion: string): string {
  const clean = suggestion.trim();
  if (!clean) return existing;
  if (!existing.trim()) return clean;
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${clean}`;
}

export function requestNativeDraftAppend(suggestion: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DRAFT_EVENT, { detail: { suggestion } }));
}
