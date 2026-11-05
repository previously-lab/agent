import { createHash } from "node:crypto";
import type { ContentBlockV1, DialogueArtifactRef } from "@/lib/chat/dialogue-contract";
import type { DialogueRows } from "./rows";
import type { DraftContentBlock } from "./types";

export const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const ARTIFACT_BYTES = 2 * 1024 * 1024;

export async function storeResultBlocks(rows: DialogueRows, owner: string, drafts: DraftContentBlock[]): Promise<ContentBlockV1[]> {
  const used = new Set<string>();
  const blocks: ContentBlockV1[] = [];
  for (const draft of drafts) {
    if (used.has(draft.blockId)) throw new Error("Duplicate result block id");
    used.add(draft.blockId);
    if (draft.kind === "artifact_ref") throw new Error("A producer cannot assert artifact ownership");
    if (draft.kind !== "artifact_source") { blocks.push(draft); continue; }
    const byteSize = Buffer.byteLength(draft.body, "utf8");
    if (byteSize > ARTIFACT_BYTES) throw new Error("Dialogue artifact exceeds its storage budget");
    const sha256 = digest(draft.body);
    const artifactId = digest(JSON.stringify([rows.scope, owner, draft.blockId, draft.artifactKind, sha256]));
    const artifact: DialogueArtifactRef = {
      artifactId, sourceOwnerId: owner, revision: 1, sha256, byteSize, kind: draft.artifactKind,
      mediaType: draft.mediaType, ...(draft.summary ? { summary: draft.summary.slice(0, 400) } : {}),
    };
    if (!(await rows.get("blob", sha256))) await rows.put("blob", sha256, draft.body);
    if (!(await rows.get("artifact", artifactId))) await rows.put("artifact", artifactId, artifact);
    blocks.push({ kind: "artifact_ref", blockId: draft.blockId, artifact });
  }
  return blocks;
}

export async function authorizePublishedArtifacts(rows: DialogueRows, blocks: ContentBlockV1[]): Promise<void> {
  for (const block of blocks) {
    if (block.kind !== "artifact_ref") continue;
    const stored = await rows.get<DialogueArtifactRef>("artifact", block.artifact.artifactId);
    if (!stored || JSON.stringify(stored.value) !== JSON.stringify(block.artifact)) throw new Error("Artifact is not owned by this result scope");
    if (stored.state !== "published") await rows.put("artifact", stored.id, stored.value, 0, "published");
  }
}

export async function readScopedArtifact(rows: DialogueRows, id: string): Promise<{ artifact: DialogueArtifactRef; body: string } | null> {
  const stored = await rows.get<DialogueArtifactRef>("artifact", id);
  // Bytes may be durable before a result is public. The public resolver needs
  // the marker written by the publication transaction, not just a known id.
  if (!stored || stored.state !== "published") return null;
  return readArtifactBody(rows, stored.value);
}

/** Internal producer reads are owner-bound and do not confer public access. */
export async function readOwnedArtifact(rows: DialogueRows, owner: string, id: string): Promise<{ artifact: DialogueArtifactRef; body: string } | null> {
  const stored = await rows.get<DialogueArtifactRef>("artifact", id);
  if (!stored || stored.value.sourceOwnerId !== owner) return null;
  return readArtifactBody(rows, stored.value);
}

async function readArtifactBody(rows: DialogueRows, artifact: DialogueArtifactRef): Promise<{ artifact: DialogueArtifactRef; body: string }> {
  const body = await rows.get<string>("blob", artifact.sha256);
  if (!body || digest(body.value) !== artifact.sha256) throw new Error("Dialogue artifact storage is incomplete");
  return { artifact, body: body.value };
}
