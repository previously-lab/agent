import { createHash } from "node:crypto";
import type { DialogueArtifactRef, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueTypedArtifact } from "@/lib/dialogue/transport";
import { absentDocumentError } from "@/lib/docs/write-validation";
import { parseDialogueArtifactRef } from "./dialogue-record";
import { fsReadFile, fsWriteFile, type WriteBatch } from "./io-helpers";

const ARTIFACT_ID = /^[a-f0-9]{64}$/;
const CHILD_RUN = /^wrun_[A-Za-z0-9]+$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

function archivePaths(artifactId: string): { body: string; reference: string } {
  if (!ARTIFACT_ID.test(artifactId)) throw new Error("Invalid archived artifact id");
  return {
    body: `memory/dialogue-artifacts/${artifactId}`,
    reference: `memory/dialogue-artifacts/${artifactId}.json`,
  };
}

function verifyBody(artifact: DialogueArtifactRef, body: string): void {
  const byteSize = Buffer.byteLength(body, "utf8");
  if (byteSize > MAX_ARTIFACT_BYTES || byteSize !== artifact.byteSize
    || createHash("sha256").update(body, "utf8").digest("hex") !== artifact.sha256) {
    throw new Error("Archived artifact bytes do not match their public identity");
  }
}

/** Archive only bytes already published by a native child, never producer-only output. */
export async function archiveDialogueArtifacts(
  utterance: PublicUtterance | undefined,
  typedArtifacts: readonly DialogueTypedArtifact[] | undefined,
  batch: WriteBatch,
): Promise<void> {
  if (!utterance) return;
  const available = new Map((typedArtifacts ?? []).map((entry) => [`${entry.blockId}:${entry.artifact.artifactId}`, entry]));
  for (const block of utterance.blocks) {
    if (block.kind !== "artifact_ref" || !CHILD_RUN.test(block.artifact.sourceOwnerId)) continue;
    const expected = parseDialogueArtifactRef(block.artifact);
    const typed = available.get(`${block.blockId}:${block.artifact.artifactId}`);
    const actual = parseDialogueArtifactRef(typed?.artifact);
    if (!expected || !ARTIFACT_ID.test(expected.artifactId) || !typed || typeof typed.body !== "string"
      || !actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Published native artifact has no verified archive source");
    }
    verifyBody(expected, typed.body);
    const paths = archivePaths(expected.artifactId);
    await fsWriteFile(paths.reference, JSON.stringify(expected), batch);
    await fsWriteFile(paths.body, typed.body, batch);
  }
}

/** Read the durable background copy after the source Workflow has expired. */
export async function readArchivedDialogueArtifact(
  artifactId: string,
): Promise<{ artifact: DialogueArtifactRef; body: string } | null> {
  if (!ARTIFACT_ID.test(artifactId)) return null;
  const paths = archivePaths(artifactId);
  try {
    const reference = parseDialogueArtifactRef(JSON.parse(await fsReadFile(paths.reference)));
    const body = await fsReadFile(paths.body);
    if (!reference || reference.artifactId !== artifactId || !CHILD_RUN.test(reference.sourceOwnerId)) return null;
    verifyBody(reference, body);
    return { artifact: reference, body };
  } catch (error) {
    if (absentDocumentError(error)) return null;
    throw error;
  }
}
