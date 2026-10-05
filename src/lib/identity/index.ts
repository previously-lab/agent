/**
 * Agent constitution — the single CHARTER.md, bundled into the build via
 * scripts/generate-identity.mjs (imported as a compiled string, never read
 * from disk at runtime). This makes the agent's identity immutable while
 * running: a bad edit or a mistaken agent write to the repo can't change a
 * live deployment, and the source file sits outside the tool whitelist so
 * the agent can't rewrite its own charter.
 *
 * The charter is the bedrock layer (mission + the two documents' contract +
 * protocols + guardrails) — nothing in the evolved data outranks it. The
 * user's profile is deliberately NOT here — it's mutable, agent-editable
 * data loaded live from memory/. See ./user-profile.ts.
 */
import matter from "gray-matter";
import { CHARTER_MD } from "./agent-prompt.generated";
import { buildAssistingBlock } from "./assisting-block";
import type { UserProfile } from "./user-profile";

const charter = matter(CHARTER_MD);
const charterName =
  typeof charter.data.name === "string" ? charter.data.name : "Previously";
const charterBody = charter.content.trim();

/**
 * Compose the agent's base system prompt: the bundled charter + who you're
 * assisting. The caller passes the already-loaded user profile and appends
 * the evolved layers (direction, card) and the frozen context blocks.
 * Composed from charter + buildAssistingBlock so the workflow can also split
 * the two apart (see ./assisting-block.ts) — the output bytes are unchanged.
 */
export function buildAgentIdentityPrompt(profile: UserProfile | null): string {
  const base =
    charterBody ||
    `You are ${charterName}, a personal AI agent that remembers everything the user does.`;
  const assisting = buildAssistingBlock(profile);
  return assisting ? `${base}\n\n${assisting}` : base;
}

export {
  loadUserProfile,
  getUserName,
  parseIdentityFromPreviously,
} from "./user-profile";
export type { UserProfile } from "./user-profile";
