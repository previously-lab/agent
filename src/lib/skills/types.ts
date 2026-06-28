import { z } from "zod";

/** Frontmatter schema matching Open Agents SKILL.md format */
export const skillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  "disable-model-invocation": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  "allowed-tools": z.array(z.string()).optional(),
  context: z.enum(["fork"]).optional(),
  agent: z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface SkillOptions {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  context?: "fork";
  agent?: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  filename: string;
  options: SkillOptions;
}

export interface SkillConfig {
  id: string;
  name: string;
  /** The / command that triggers this skill, e.g. "/create-memory" */
  command: string;
  description: string;
  parameters?: Record<string, { type: string; description: string }>;
  /** Path to SKILL.md file (file-driven skills) */
  skillPath?: string;
}

export interface SkillContext {
  writeFile: (path: string, content: string) => Promise<unknown>;
  readFile: (path: string) => Promise<string>;
}

/** Convert kebab-case frontmatter keys to camelCase options */
export function frontmatterToOptions(fm: SkillFrontmatter): SkillOptions {
  return {
    disableModelInvocation: fm["disable-model-invocation"],
    userInvocable: fm["user-invocable"],
    allowedTools: fm["allowed-tools"],
    context: fm.context,
    agent: fm.agent,
  };
}
