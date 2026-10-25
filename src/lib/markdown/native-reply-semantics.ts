import { parseNativeSections } from "./native-sections";

export const NATIVE_REPLY_OMISSION_MARKER = "[Interactive visual omitted]";

/** Replace only executable native replies in assistant-derived memory excerpts. */
export function projectNativeReplySemantics(content: string, role: string): string {
  if (role !== "agent" && role !== "assistant") return content;
  const sections = parseNativeSections(content);
  if (!sections.some((section) => section.kind === "native")) return content;
  return sections
    .map((section) => (section.kind === "native" ? NATIVE_REPLY_OMISSION_MARKER : section.raw))
    .join("");
}
