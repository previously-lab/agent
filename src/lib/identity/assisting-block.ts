/**
 * The "Who you're assisting" block — the identity-head half of the agent
 * identity prompt, split out of the charter so the workflow can place it
 * with the user-model layers (L1a, after the direction block) instead of
 * inside the L0 charter.
 *
 * Pure module: the only import is a TYPE (erased at compile time), so the
 * workflow bundle stays free of Node modules. buildAgentIdentityPrompt in
 * ./index.ts composes charter + this block, keeping its output bytes exactly
 * what the unsplit builder produced — the companion narrate and other
 * callers that need the whole prompt are unaffected.
 */
import type { UserProfile } from "./user-profile";

/** The header line the assisting block starts with — also the split marker. */
export const ASSISTING_BLOCK_HEADER = "## Who you're assisting";

/**
 * Build the assisting block from the user profile: the structured identity
 * head lines plus the free-text body. Returns "" when the profile carries
 * nothing worth a block.
 */
export function buildAssistingBlock(profile: UserProfile | null): string {
  if (!profile) return "";
  const lines: string[] = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.aliases?.length) lines.push(`Aliases: ${profile.aliases.join(", ")}`);
  if (profile.addressAs) lines.push(`Address them as: ${profile.addressAs}`);
  if (profile.pronouns) lines.push(`Pronouns: ${profile.pronouns}`);
  if (profile.timezone) lines.push(`Timezone: ${profile.timezone}`);
  if (lines.length === 0 && !profile.body) return "";
  let block = `${ASSISTING_BLOCK_HEADER}\n${lines.join("\n")}`;
  if (profile.body) block += `\n\n${profile.body}`;
  return block.trim();
}

/**
 * Split a full identity prompt (charter + assisting tail) back into its two
 * parts: everything before the assisting header is the charter, everything
 * from the header on is the assisting block. A prompt with no tail yields
 * assisting "". Round-trips exactly: charter + (assisting ? "\n\n" + assisting : "").
 */
export function splitIdentityPrompt(identityPrompt: string): {
  charter: string;
  assisting: string;
} {
  const at = identityPrompt.indexOf(`\n\n${ASSISTING_BLOCK_HEADER}`);
  if (at === -1) return { charter: identityPrompt, assisting: "" };
  return {
    charter: identityPrompt.slice(0, at),
    assisting: identityPrompt.slice(at + 2),
  };
}
