export type ComposerState = "idle" | "editing" | "sending";

/** Presentation state for the single persistent manuscript input. Sending is
 * explicit because a reader may keep composing a follow-up during a run. */
export function getComposerState({
  focused,
  value,
  attachmentCount,
  mentionOpen,
  isLoading,
}: {
  focused: boolean;
  value: string;
  attachmentCount: number;
  mentionOpen: boolean;
  isLoading: boolean;
}): ComposerState {
  if (isLoading) return "sending";
  return focused || value.length > 0 || attachmentCount > 0 || mentionOpen
    ? "editing"
    : "idle";
}
