"use server";

import { getWorld } from "workflow/runtime";
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
  const page = await (await getWorld()).runs.list({ pagination: { limit: 100 }, resolveData: "none" });
  const matches = page.data.flatMap(row => {
    const entry = row as {
      runId: string; status: string; createdAt?: Date | string;
      attributes?: Record<string, string> | null;
    };
    const attributes = entry.attributes;
    if (attributes?.role !== "thinking" || attributes.scope !== scope ||
        !attributes.work || !attributes.turn) return [];
    const status = entry.status;
    // Workflow status decides recovery eligibility. Terminal work has no live
    // stream to restore and its returnValue must not be read on page entry.
    if (status !== "pending" && status !== "running") return [];
    return [{
      runId: entry.runId,
      workId: attributes.work,
      sourceInputId: attributes.turn,
      status,
      ...(entry.createdAt ? { createdAt: new Date(entry.createdAt).toISOString() } : {}),
    } satisfies DialogueThoughtRecovery];
  });
  return matches;
}
