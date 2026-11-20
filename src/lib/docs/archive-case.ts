import { createHash } from "node:crypto";
import { archiveCaseDirPath, caseIndexPath, isArchivedCaseName, isCaseCategory, type CaseCategory } from "./paths";
import { parseCaseRef } from "./case-refs";
import { flushBatch, fsDeleteFile, fsReadBinaryFile, fsReadFile, fsWriteBinaryFile, fsWriteFile, type WriteBatch } from "@/lib/episodic/io-helpers";
import { enumerateTreeFiles } from "@/lib/episodic/timeline/enumerate";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import type { CaseReadScope } from "@/lib/episodic/flash/librarian";
import { absentDocumentError } from "./write-validation";
import { forkWriteBatch, mergeWriteBatch } from "./write-batch";
import { isHistoryArchiveFileName } from "./history-archive";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import { seedGitHubReadHead, withGitHubReadView } from "@/lib/github/read-view";

export const ARCHIVE_NOTE_NAME = "_ARCHIVED.md";

/** A direct old ref reports archival without exposing it to default discovery. */
export function archivedCaseRefPaths(ref: string): string[] {
  const parsed = parseCaseRef(ref);
  if (!parsed || parsed.kind === "legacy") return [];
  const directory = archiveCaseDirPath(parsed.category, parsed.caseName);
  return parsed.kind === "case"
    ? [`${directory}/index.md`]
    : [`${directory}/${parsed.pieceFileName}`, `${directory}/index.md`];
}

export interface ArchiveCaseResult {
  ok: true;
  path: string;
  files: number;
  noop?: boolean;
}

/** Move one complete case byte-for-byte into the inactive archive, atomically. */
export async function archiveCaseDocument(input: {
  category: CaseCategory;
  caseName: string;
  reason: string;
  date: string;
}, options: { batch?: WriteBatch; readScope?: CaseReadScope } = {}): Promise<ArchiveCaseResult> {
  const { category, caseName } = input;
  if (!isCaseCategory(category) || (category === "people" && caseName.toLowerCase() === "user")) {
    throw new Error("The live user model cannot be archived");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("Archive requires a short reason");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Archive date must be YYYY-MM-DD");
  if (isArchivedCaseName(caseName)) return { ok: true, path: `memory/${category}/${caseName}`, files: 0, noop: true };
  const sourceDir = `memory/${category}/${caseName}`;
  const sourceIndex = caseIndexPath(category, caseName);
  const targetDir = archiveCaseDirPath(category, caseName);
  const targetIndex = `${targetDir}/index.md`;
  return withSliceLock(`doc:${category}/${caseName}`, () => withGitHubReadView(async () => {
    const batch = forkWriteBatch(options.batch);
    let current: string;
    try {
      current = await fsReadFile(sourceIndex, batch, { fresh: true });
    } catch (error) {
      if (!absentDocumentError(error)) throw error;
      try {
        await fsReadFile(targetIndex, batch, { fresh: true });
        return { ok: true, path: targetDir, files: 0, noop: true };
      } catch (targetError) {
        if (!absentDocumentError(targetError)) throw targetError;
        throw new Error(`Case not found: ${category}/${caseName}`);
      }
    }
    const required = options.readScope?.getIndexRead(category, caseName);
    if (options.readScope && !required) throw new Error("Read the full current case before archiving it");
    const indexRevision = createHash("sha256").update(current, "utf8").digest("hex");
    if (required && indexRevision !== required.revision) {
      throw new Error("The case changed after it was read; read it again before archiving");
    }
    // The index fresh-read sets the GitHub commit basis. Enumerate and copy
    // files from exactly that revision even when another turn moves HEAD.
    if (resolveDataSource() === "github") {
      if (!batch.baseHeadSha) throw new Error("Case archive requires a GitHub commit basis");
      const { repo, owner } = getRepoConfig();
      seedGitHubReadHead(repo, owner, { headSha: batch.baseHeadSha });
    }
    if ([...batch.entries.keys()].some(path => path.startsWith(sourceDir + "/") || path.startsWith(targetDir + "/"))) {
      throw new Error("This case has pending changes in the round; archive its committed version after those changes land");
    }
    if ((await enumerateTreeFiles(targetDir)).length) {
      throw new Error(`Archive already contains an active-source collision: ${category}/${caseName}`);
    }
    const files = (await enumerateTreeFiles(sourceDir)).sort();
    if (!files.includes(sourceIndex)) throw new Error(`Case inventory is incomplete: ${category}/${caseName}`);
    const currentPath = `${sourceDir}/_current.md`;
    if (required?.currentRevision && !files.includes(currentPath)) throw new Error("The current case view changed; read it again");
    if (files.some(path => path.toLowerCase() === `${sourceDir}/${ARCHIVE_NOTE_NAME}`.toLowerCase())) {
      throw new Error("Source already contains the reserved archive note");
    }
    const bases = batch.documentBases ??= new Map();
    for (const source of files) {
      const bytes = await fsReadBinaryFile(source);
      const target = `${targetDir}/${source.slice(sourceDir.length + 1)}`;
      // Guard delayed local publication as well as GitHub's commit-wide CAS.
      const revision = createHash("sha256").update(bytes).digest("hex");
      const expected = source === sourceIndex ? indexRevision : source === currentPath ? required?.currentRevision : undefined;
      if (expected !== undefined && revision !== expected) {
        throw new Error("The case changed during archival; read it again");
      }
      bases.set(source, revision);
      bases.set(target, null);
      const text = /\.md$/i.test(source) ? bytes.toString("utf8") : undefined;
      if (text !== undefined && bytes.equals(Buffer.from(text, "utf8"))) await fsWriteFile(target, text, batch);
      else await fsWriteBinaryFile(target, bytes, batch);
    }
    bases.set(`${targetDir}/${ARCHIVE_NOTE_NAME}`, null);
    await fsWriteFile(`${targetDir}/${ARCHIVE_NOTE_NAME}`,
      `---\noriginal: ${category}/${caseName}\narchived: ${input.date}\n---\n\n${reason}\n`, batch);
    // An immutable shard can be cited by its original path, including from
    // another shard. Preserve that address as well as the archived copy.
    for (const source of files) if (!isHistoryArchiveFileName(source)) await fsDeleteFile(source, batch);
    if (options.batch) mergeWriteBatch(options.batch, batch);
    else await flushBatch(batch, `Archive ${category}/${caseName}`);
    return { ok: true, path: targetDir, files: files.length };
  }));
}
