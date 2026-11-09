import type {
  DialogueRecordRequest,
  DialogueTypedArtifact,
} from "@/lib/dialogue/transport";
import { DIALOGUE_ARTIFACT_CHUNK } from "@/lib/dialogue/transport";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueProjectionReceipt } from "@/lib/episodic/dialogue-records";
import { projectDialogueRecords } from "@/lib/episodic/dialogue-records";
import { ringReflection } from "./steps";
import { getRun } from "workflow/api";

/** Recover only the public artifacts' exact bytes, after the public handoff. */
async function readDialogueRecordArtifactsStep(utterance?: PublicUtterance): Promise<DialogueTypedArtifact[]> {
  "use step";
  const expected = (utterance?.blocks ?? []).flatMap((block) =>
    block.kind === "artifact_ref" && /^wrun_[A-Za-z0-9]+$/.test(block.artifact.sourceOwnerId)
      ? [{ blockId: block.blockId, artifact: block.artifact }] : []);
  const remaining = new Map(expected.map((entry) =>
    [`${entry.artifact.sourceOwnerId}:${entry.blockId}:${entry.artifact.artifactId}`, entry]));
  const found = new Map<string, DialogueTypedArtifact>();
  for (const runId of new Set(expected.map((entry) => entry.artifact.sourceOwnerId))) {
    const readable = getRun(runId).getReadable({ startIndex: 0 });
    const tail = await readable.getTailIndex();
    const reader = readable.getReader();
    try {
      for (let read = 0; read <= tail; read++) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value as { type?: unknown; data?: unknown };
        if (chunk.type !== DIALOGUE_ARTIFACT_CHUNK || !chunk.data || typeof chunk.data !== "object") continue;
        const value = chunk.data as DialogueTypedArtifact;
        const key = `${runId}:${value.blockId}:${value.artifact?.artifactId}`;
        if (!remaining.has(key) || value.artifact.sourceOwnerId !== runId || typeof value.body !== "string") continue;
        const previous = found.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
          throw new Error("Native child emitted conflicting artifact bytes");
        }
        found.set(key, value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* Already released. */ }
    }
  }
  if (found.size !== expected.length) throw new Error("Published native artifact is missing from its child Workflow");
  return expected.map((entry) => found.get(`${entry.artifact.sourceOwnerId}:${entry.blockId}:${entry.artifact.artifactId}`)!);
}

/** Background memory flow: private work, actual public output, or a user-only failure. */
export async function dialogueRecordWorkflow(
  request: DialogueRecordRequest,
): Promise<DialogueProjectionReceipt | null> {
  "use workflow";
  const typedArtifacts = await readDialogueRecordArtifactsStep(request.utterance);
  const receipt = await projectDialogueRecords({
    inputs: [{
      input: request.source,
      turnId: request.sourceTurnId,
      ...(request.environment.sliceId ? { sliceId: request.environment.sliceId } : {}),
      ...(request.environment.images?.length ? { images: request.environment.images } : {}),
      reflectUserOnly: !request.work,
    }],
    ...(request.work ? { work: request.work } : {}),
    ...(request.utterance ? { utterance: request.utterance } : {}),
    typedArtifacts,
    useGithub: request.environment.useGithub,
    useDemo: request.environment.useDemo,
    owner: request.environment.owner,
    repo: request.environment.repo,
    timezone: request.environment.timezone,
    slicing: request.environment.slicing,
  });
  if (receipt) {
    for (const range of receipt.reflection) await ringReflection(range.sliceId, range);
  }
  return receipt;
}
