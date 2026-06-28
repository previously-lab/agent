import type { SkillConfig, SkillContext } from "./types";

const registry = new Map<string, SkillConfig>();

export function registerSkill(skill: SkillConfig): void {
  registry.set(skill.command, skill);
}

export function getSkill(command: string): SkillConfig | undefined {
  return registry.get(command);
}

export function getAllSkills(): SkillConfig[] {
  return Array.from(registry.values());
}

export function matchSkills(prefix: string): SkillConfig[] {
  const lower = prefix.toLowerCase();
  return getAllSkills().filter(
    (s) => s.command.toLowerCase().startsWith(lower) || s.name.toLowerCase().includes(lower)
  );
}

// Built-in skills
registerSkill({
  id: "create-memory",
  name: "Create Memory",
  command: "/create-memory",
  description: "Create a new memory node in memory/nodes/",
  parameters: {
    title: { type: "string", description: "Memory title" },
    content: { type: "string", description: "Memory content in Markdown" },
    type: { type: "string", description: "concept | experience | project | people" },
  },
});
