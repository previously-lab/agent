import { forkWriteBatch, mergeWriteBatch } from "@/lib/docs/write-batch";
/** Explicit recovery for an oversized runtime card; never used for the user's own profile.md. */
import type { CaseReadScope } from "@/lib/episodic/flash/librarian";
import { fsReadFile, fsWriteFile, type WriteBatch } from "@/lib/episodic/io-helpers";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { composeUserModel, splitUserModel } from "./store";
import { caseStorageRevision, createDoc, parseCaseDoc, serializeCaseDoc } from "@/lib/docs/case-doc";
import { casePiecePath } from "@/lib/docs/paths";
import { documentSize, exceededSize, assertDocumentWrite } from "@/lib/docs/write-limits";
import { planHistoryArchive } from "@/lib/docs/history-archive";
import { absentDocumentError } from "@/lib/docs/write-validation";
import { WriteRefusal } from "@/lib/docs/write-window";
import { parseCard } from "@/lib/episodic/previously-format";
import { validateDirectionProposal } from "./direction-agent";

export const USER_MODEL_HISTORY_PATH = "memory/config/user-model-history.json";
export async function reorganizeUserModel(input: {
  card: string; direction: string | null; pieces: { title: string; body: string }[]; evidence: string[]; date: string;
}, scope: CaseReadScope, batch: WriteBatch): Promise<{ path: string; pieces: string[] }> {
  return withSliceLock("evolution", async () => {
    const path = "memory/people/user/index.md";
    const read = scope.getIndexRead("people", "user");
    if (!read || !input.evidence.some((ref) => ref.startsWith("records/")) || input.evidence.some((ref) => !scope.hasEvidence(ref))) throw new WriteRefusal("rewrite_conflict", "Read people/user and the actual records evidence before reorganizeUserModel");
    const pending = forkWriteBatch(batch);
    const old = await fsReadFile(path, pending, { fresh: true });
    if (caseStorageRevision(old) !== read.revision) throw new WriteRefusal("rewrite_conflict", "The user model changed; re-read before reorganizing");
    if (!exceededSize(documentSize(old)).length) throw new Error("Use evolveProfile for an in-budget user model");
    if (!parseCard(input.card)) throw new Error("Preserve the runtime Previously On card grammar");
    if (splitUserModel(old).direction && !input.direction?.trim()) throw new Error("Preserve the existing direction half; do not erase it to meet the size cap");
    const directionValidation = input.direction === null ? null : validateDirectionProposal(input.direction, null, { mode: "migrate" });
    if (directionValidation && !directionValidation.ok) throw new Error(`Preserve the direction grammar/evidence: ${directionValidation.reason}`);
    const next = composeUserModel(input.card, input.direction);
    if (!next.trim() || exceededSize(documentSize(next)).length) throw new Error("The reorganized card plus direction must fit the document budget; move independently useful evidence to pieces");
    assertDocumentWrite(path, next, old, true);
    let previousHead: string | null = null;
    try {
      const metadata = JSON.parse(await fsReadFile(USER_MODEL_HISTORY_PATH, pending, { fresh: true }));
      if (metadata.v === 1 && typeof metadata.history_head === "string") previousHead = metadata.history_head;
    } catch (error) { if (!absentDocumentError(error)) throw error; }
    const archive = planHistoryArchive({ category: "people", caseName: "user", source: "index.md", sourceRaw: old,
      date: input.date, updated: input.date, kind: "source-snapshot", previousHead });
    const pieces: string[] = [];
    for (const piece of input.pieces) {
      const doc = createDoc({ category: "people", caseName: "user", date: input.date, ...piece });
      const piecePath = casePiecePath("people", "user", doc.fileName);
      let previous: string | null = null;
      try { previous = await fsReadFile(piecePath, pending, { fresh: true }); }
      catch (error) { if (!absentDocumentError(error)) throw error; }
      if (previous !== null && parseCaseDoc(previous, { category: "people", caseName: "user", fileName: doc.fileName }).body !== doc.body) throw new WriteRefusal("already_exists", `Existing user-model piece differs: ${piecePath}`);
      if (previous === null) await fsWriteFile(piecePath, serializeCaseDoc(doc), pending);
      pieces.push(piecePath);
    }
    for (const entry of archive.entries) await fsWriteFile(entry.path, entry.content, pending);
    pending.maintenance!.set(path, { sourceRevision: archive.sourceRevision, archiveHeadRef: archive.headRef });
    await fsWriteFile(path, next, pending);
    await fsWriteFile(USER_MODEL_HISTORY_PATH, JSON.stringify({ v: 1, history_head: archive.headRef, evidence: input.evidence }) + "\n", pending);
    mergeWriteBatch(batch, pending);
    return { path, pieces };
  });
}
