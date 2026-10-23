import { DEEPSEEK_MODEL } from "@/lib/models/registry";
export const DEMO_LOCK_DEFAULT_MODEL = DEEPSEEK_MODEL;
export interface DemoModelLock { model: string; thinking: boolean; effort: "low" | "medium" | "high"; }
/** Cloud, demo and local installations share the fixed model/profile. */
export function demoModelLock(): DemoModelLock {
  return { model: DEEPSEEK_MODEL, thinking: true, effort: "high" };
}
