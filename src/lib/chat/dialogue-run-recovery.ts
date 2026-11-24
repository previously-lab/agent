"use server";

import { getWorld } from "workflow/runtime";
import { workflowRegistryPages } from "./workflow-registry-pages";
import type { DialogueInput } from "./dialogue-contract";
import { resolveDialogueScope } from "@/lib/dialogue/runtime";

export interface DialogueThoughtRecovery {
  runId: string;
  workId: string;
  sourceInputId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt?: string;
  input?: DialogueInput;
}

export async function findDialogueThoughtRuns(persona: string): Promise<DialogueThoughtRecovery[]> {
  const scope = resolveDialogueScope(persona);
  const world = await getWorld();
  const matches = new Map<string, DialogueThoughtRecovery>();
  for (const status of ["pending", "running"] as const) {
    for await (const rows of workflowRegistryPages(world, { status })) {
      for (const entry of rows) {
        const attributes = entry.attributes;
        if (entry.status !== status || attributes?.role !== "thinking" || attributes.scope !== scope ||
            !attributes.work || !attributes.turn) continue;
        matches.set(entry.runId, {
          runId: entry.runId, workId: attributes.work, sourceInputId: attributes.turn, status,
          ...(entry.createdAt ? { createdAt: new Date(entry.createdAt).toISOString() } : {}),
        });
      }
    }
  }
  return [...matches.values()];
}
