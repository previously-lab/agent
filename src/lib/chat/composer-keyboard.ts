import { isImeKeyboardEvent } from "./document-mentions";

export type ComposerEnterBehavior = "newline" | "send";
export const DEFAULT_COMPOSER_ENTER_BEHAVIOR: ComposerEnterBehavior = "send";

/** Return an intent before the caller cancels an event. IME confirmation and
 * native newline/selection behavior must remain entirely browser-owned. */
export function composerEnterIntent(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">,
  options: { enterBehavior?: ComposerEnterBehavior; mentionOpen?: boolean; composing?: boolean } = {},
): "native" | "submit" | "select-mention" {
  if (event.key !== "Enter" || options.composing || isImeKeyboardEvent(event)) return "native";
  if (event.shiftKey || event.altKey) return "native";
  if (event.ctrlKey || event.metaKey) return "submit";
  if (options.mentionOpen) return "select-mention";
  return (options.enterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR) === "send" ? "submit" : "native";
}
