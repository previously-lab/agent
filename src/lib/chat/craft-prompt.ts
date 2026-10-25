const MAIN_CRAFT_BEGIN = "<!-- PREVIOUSLY_MAIN_CRAFT -->";
const MAIN_CRAFT_END = "<!-- /PREVIOUSLY_MAIN_CRAFT -->";

/** The two markers, their newlines, and the system prompt's join separator. */
export const MAIN_CRAFT_HOST_RESERVED_CHARS = MAIN_CRAFT_BEGIN.length + MAIN_CRAFT_END.length + 4;

export function createMainCraftBlock(guidance: string): string | undefined {
  const text = guidance.trim();
  if (!text) return undefined;
  return `${MAIN_CRAFT_BEGIN}\n${text}\n${MAIN_CRAFT_END}`;
}

export function replaceMainCraftBlock(
  baseSystemPrompt: string | undefined,
  roleGuidance: string,
): string {
  const base = baseSystemPrompt?.trim() ?? "";
  const pattern = /<!-- PREVIOUSLY_MAIN_CRAFT -->[\s\S]*?<!-- \/PREVIOUSLY_MAIN_CRAFT -->/g;
  const inherited = base.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
  const guidance = roleGuidance.trim();
  if (!inherited) return guidance;
  return guidance ? `${inherited}\n\n${guidance}` : inherited;
}
