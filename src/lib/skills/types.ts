export interface SkillConfig {
  id: string;
  name: string;
  /** The / command that triggers this skill, e.g. "/create-memory" */
  command: string;
  description: string;
  parameters?: Record<string, { type: string; description: string }>;
}

export interface SkillContext {
  writeFile: (path: string, content: string) => Promise<unknown>;
  readFile: (path: string) => Promise<string>;
}
