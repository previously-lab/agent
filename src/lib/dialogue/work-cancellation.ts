import { getWorld } from "workflow/runtime";
import type { DialogueRunInput } from "./transport";

const STOP_ATTRIBUTE = "dialogueStopped";

export function isDialogueWorkStopped(row: { status: string; attributes?: Record<string, string> | null }): boolean {
  return row.status === "cancelled" || row.attributes?.[STOP_ATTRIBUTE] === "1";
}

/** Persist the stop even when an older thinking run completed before its shared Actor. */
export async function markDialogueWorkStopped(runId: string): Promise<void> {
  const { runs } = await getWorld();
  if (!runs.experimentalSetAttributes) throw new Error("Workflow storage cannot record dialogue cancellation");
  await runs.experimentalSetAttributes(runId, [{ key: STOP_ATTRIBUTE, value: "1" }]);
}

export async function stoppedDialogueParents(runIds: string[]): Promise<string[]> {
  const { runs } = await getWorld();
  const unique = [...new Set(runIds)];
  const rows = await Promise.all(unique.map(id => runs.get(id, { resolveData: "none" })));
  return unique.filter((_, index) => isDialogueWorkStopped(rows[index]!));
}

/** Recheck all contributors at the publication boundary. A read failure propagates for retry. */
export async function dialoguePublicationStopped(input: DialogueRunInput): Promise<boolean> {
  const stopped = await stoppedDialogueParents([input.context.parentRunId, ...(input.publicationParentRunIds ?? [])]);
  return stopped.length > 0;
}
