"use server";

import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { DialogueInput } from "./dialogue-contract";
import type { TurnRunResult } from "./turn-types";
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
    if (status !== "pending" && status !== "running" && status !== "completed" &&
        status !== "failed" && status !== "cancelled") return [];
    return [{
      runId: entry.runId,
      workId: attributes.work,
      sourceInputId: attributes.turn,
      status,
      ...(entry.createdAt ? { createdAt: new Date(entry.createdAt).toISOString() } : {}),
    } satisfies DialogueThoughtRecovery];
  });
  return Promise.all(matches.map(async entry => {
    if (entry.status !== "completed") return entry;
    try {
      const result = await getRun<TurnRunResult>(entry.runId).returnValue;
      return result?.dialogueWork?.source ? { ...entry, input: result.dialogueWork.source } : entry;
    } catch {
      return entry;
    }
  }));
}
