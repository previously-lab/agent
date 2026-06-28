/**
 * Skill Loader — reads and processes SKILL.md files.
 * Adapted from Open Agents packages/agent/skills/loader.ts
 */
import { readFileSync } from "fs";

/**
 * Extract the markdown body from a SKILL.md file (strip YAML frontmatter).
 */
export function extractSkillBody(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (endIndex === -1) return content;

  return lines.slice(endIndex + 2).join("\n").trim();
}

/**
 * Substitute $ARGUMENTS placeholder with provided args string.
 */
export function substituteArguments(body: string, args?: string): string {
  if (!args) return body;
  return body.replace(/\$ARGUMENTS/g, args);
}

/**
 * Inject skill directory path into the skill body header.
 */
export function injectSkillDirectory(body: string, skillDir: string): string {
  return `Skill directory: ${skillDir}\n\n${body}`;
}

/**
 * Load a skill from a SKILL.md file path.
 * Returns the full processed markdown content ready to inject into system prompt.
 */
export function loadSkill(skillPath: string, args?: string): string | null {
  try {
    const raw = readFileSync(skillPath, "utf-8");
    const body = extractSkillBody(raw);
    const substituted = substituteArguments(body, args);
    return substituted;
  } catch {
    return null;
  }
}
