/**
 * Attachments (v0.19 §C.1, §B.1, §B.5) — naming and the three
 * identity landing paths.
 *
 * LAYOUT & NAMING. A case's attachments live in its `attachments/` directory
 * (a records case too). Names are `<yyyy-mm-dd>-<净化原名>` in case
 * attachments, `<turnId>-<净化原名>` in a records case — the prefix makes a
 * name collision structurally impossible (attachments are born, never
 * renamed; a same-name same-turn repeat gets a deterministic `-<n>` suffix).
 * The sanitize step SHARES the unsafe-chars discipline of
 * src/lib/docs/naming.ts (`sanitizeNameComponent`) — applied as净化
 * (replace, not just reject) because an attachment's original name is user
 * input, not an identity the system chose.
 *
 * THE THREE IDENTITIES.
 * - Evidence (file/image): the user's in-conversation files land in the
 *   records case of the slice they were sent in — `persistEvidenceAttachments`
 *   (wired into the turn pipeline by the lane that owns steps.ts; this module
 *   is the mechanism + the tested contract).
 * - Evidence (long text): stays in core.md by default; ONLY a marker
 *   (noteForSediment with `body`) makes the scribe open a case whose 正文
 *   carries the full text with its origin stamped (librarian.ts).
 * - Asset: copied INTO the document case that needs it (case self-contained;
 *   evidence is never copied — documents point at records).
 */
import {
  caseAttachmentsPath,
  isCaseCategory,
  isValidCaseName,
  type CaseCategory,
} from "@/lib/docs";
import { sanitizeNameComponent } from "@/lib/docs/naming";
import {
  fsListFiles,
  fsReadBinaryFile,
  fsWriteBinaryFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { sliceDir } from "@/lib/episodic/paths";
import { recordImageRef, parseRecordImageRef, isAttachmentFileName, parseImageAttachments,
  type ImageAttachmentEvidence, type ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { inspectImage, ImageAttachmentError } from "./image-validation";

// ─── Naming (§C.1) ─────────────────────────────────────────────────────────

/**
 * Purify an attachment's original name — the shared unsafe-chars discipline
 * lives in src/lib/docs/naming.ts (`sanitizeNameComponent`); this wrapper
 * only owns the fallback so the name is never blank.
 */
export function sanitizeAttachmentName(raw: string): string {
  return sanitizeNameComponent(raw) || "attachment";
}

/** `<yyyy-mm-dd>-<净化原名>` — case attachments (date = the write day). */
export function caseAttachmentName(date: string, originalName: string): string {
  return `${date}-${sanitizeAttachmentName(originalName)}`;
}

/** `<turnId>-<净化原名>` — records evidence (turnId prefix = collision-proof). */
export function recordAttachmentName(turnId: string, originalName: string): string {
  return `${turnId}-${sanitizeAttachmentName(originalName)}`;
}

/**
 * Resolve the final file name inside `dir`, accounting for births only: when
 * the exact name is taken (same file twice in one turn), a deterministic
 * `-2`, `-3`, … suffix lands before the extension — never an overwrite,
 * never randomness.
 */
async function freeName(dir: string, fileName: string, batch?: WriteBatch): Promise<string> {
  const taken = new Set<string>();
  try {
    for (const e of await fsListFiles(dir)) {
      if (e.type === "file") taken.add(e.name);
    }
  } catch {
    // directory does not exist yet — nothing taken
  }
  for (const [path, content] of batch?.entries ?? []) {
    if (!path.startsWith(dir + "/")) continue;
    const name = path.slice(dir.length + 1);
    if (content === null) taken.delete(name);
    else taken.add(name);
  }
  if (!taken.has(fileName)) return fileName;
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ─── Landing directories (§B.1 / §B.5) ─────────────────────────────────────

/** `memory/<分类>/<case名>/attachments` — the case's attachment directory. */
export function caseAttachmentsDir(category: CaseCategory, caseName: string): string {
  return caseAttachmentsPath(category, caseName);
}

/** `records/YYYY/MM/DD/HHMM/attachments` — the slice's evidence directory. */
export function recordAttachmentsDir(sliceId: string): string {
  return `${sliceDir(sliceId)}/attachments`;
}

// ─── Identity 1: evidence — files/images into the records case ─────────────

export interface EvidenceAttachmentInput {
  /** Original file name (user-facing, purified onto the final name). */
  name: string;
  /** The file's bytes (already client-compressed for images). */
  data: Buffer;
}

export interface EvidenceAttachmentResult {
  /** What landed: final file names + repo-relative paths. */
  saved: Array<{ name: string; path: string }>;
  /** What was refused — visible reasons, never thrown, never truncated. */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Persist the files/images the user sent in this turn into the records case
 * they were sent in (`records/…/attachments/`, `<turnId>-<name>`). Returns per-file outcomes — a refusal is a visible entry in
 * `skipped`, not an exception. The caller (the turn pipeline) records the
 * landed file names in the turn; `core.md` itself is steps.ts territory.
 */
export async function persistEvidenceAttachments(input: {
  sliceId: string;
  turnId: string;
  files: EvidenceAttachmentInput[];
  batch?: WriteBatch;
}): Promise<EvidenceAttachmentResult> {
  const { sliceId, turnId, files, batch } = input;
  const dir = recordAttachmentsDir(sliceId);
  const result: EvidenceAttachmentResult = { saved: [], skipped: [] };
  if (files.length === 0) return result;

  for (const file of files) {
    try {
      const finalName = await freeName(dir, recordAttachmentName(turnId, file.name), batch);
      const path = `${dir}/${finalName}`;
      await fsWriteBinaryFile(path, file.data, batch);
      result.saved.push({ name: finalName, path });
    } catch (e) {
      result.skipped.push({
        name: file.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

// ─── Identity 3: asset — copied into the document case ─────────────────────

/**
 * Copy a file INTO a document case's attachments (the case stays
 * self-contained). Evidence is never copied — documents point at records.
 * A storage failure is reported to the writer.
 */
export async function copyAssetAttachment(input: {
  category: CaseCategory;
  caseName: string;
  /** Where the bytes currently live (any whitelisted path). */
  sourcePath: string;
  /** The name the copy carries (purified + date-prefixed). */
  originalName: string;
  /** The write day (yyyy-mm-dd) — the name prefix. */
  date: string;
  batch?: WriteBatch;
}): Promise<{ name: string; path: string }> {
  const { category, caseName, sourcePath, originalName, date, batch } = input;
  if (!isCaseCategory(category)) {
    throw new Error(`unknown category: ${JSON.stringify(category)}`);
  }
  if (!isValidCaseName(caseName)) {
    throw new Error(`illegal case name: ${JSON.stringify(caseName)}`);
  }

  const data = await fsReadBinaryFile(sourcePath);
  const dir = caseAttachmentsDir(category, caseName);
  const finalName = await freeName(dir, caseAttachmentName(date, originalName), batch);
  const path = `${dir}/${finalName}`;
  await fsWriteBinaryFile(path, data, batch);
  return { name: finalName, path };
}

// ─── Reading (§C.1 — the viewImage doc: source) ────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

/** The media type an attachment's extension implies (octet-stream fallback). */
export function attachmentMediaType(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Whether the attachment is an image (the shelf renders these inline). */
export function isImageAttachmentName(fileName: string): boolean {
  return attachmentMediaType(fileName).startsWith("image/");
}

/**
 * Read one attachment of a case back as bytes + media type. `fileName` must
 * be a PLAIN file name — anything containing a separator is refused
 * (traversal guard at the read surface too).
 */
export async function readCaseAttachment(input: {
  category: CaseCategory;
  caseName: string;
  fileName: string;
}): Promise<{ data: Buffer; mediaType: string }> {
  const { category, caseName, fileName } = input;
  if (!isCaseCategory(category)) {
    throw new Error(`unknown category: ${JSON.stringify(category)}`);
  }
  if (!isValidCaseName(caseName)) {
    throw new Error(`illegal case name: ${JSON.stringify(caseName)}`);
  }
  if (
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName !== fileName.trim() ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("\0")
  ) {
    throw new Error(`illegal attachment name: ${JSON.stringify(fileName)}`);
  }
  const data = await fsReadBinaryFile(
    `${caseAttachmentsDir(category, caseName)}/${fileName}`,
  );
  return { data, mediaType: attachmentMediaType(fileName) };
}

/** Record reads are confined to the attachment directory of a real UTC slice. */
export async function readRecordImage(ref: string): Promise<{ data: Buffer; mediaType: string }> {
  const parsed = parseRecordImageRef(ref);
  if (!parsed) throw new ImageAttachmentError("invalid_reference", "Invalid record image reference");
  const data = await fsReadBinaryFile(`${recordAttachmentsDir(parsed.sliceId)}/${parsed.fileName}`);
  return { data, mediaType: attachmentMediaType(parsed.fileName) };
}

/** Stage all evidence into the summary's existing batch. Deterministic names
 * make a retry after partial local I/O reuse the same binary, never -2 copies.
 * Verify every image before staging any of its bytes. */
export async function persistImageAttachments(input: {
  sliceId: string; turnId: string; images: ImageAttachmentEvidence[]; batch: WriteBatch;
}): Promise<ImageAttachmentSnapshot[]> {
  const { sliceId, turnId, images, batch } = input;
  if (!isAttachmentFileName(turnId)) throw new Error("Invalid attachment turn identity");
  const dir = recordAttachmentsDir(sliceId);
  const snapshots = parseImageAttachments(images.map((image) => image.snapshot));
  if (snapshots.length !== images.length) throw new Error("Invalid attachment snapshots");
  const existing = new Set<string>();
  const entries = await fsListFiles(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { status?: number }).status === 404 || /^Directory not found:/.test((error as Error).message)) return [];
    throw error;
  });
  for (const entry of entries) if (entry.type === "file") existing.add(entry.path);
  for (const [path, content] of batch.entries) {
    if (path.startsWith(`${dir}/`) && batch.encodings?.get(path) === "base64" && content !== null) existing.add(path);
  }
  const writes: Array<{ path: string; data: Buffer; snapshot: ImageAttachmentSnapshot }> = [];
  for (const image of images) {
    const data = Buffer.from(image.dataBase64, "base64"), format = inspectImage(data);
    if (data.length !== image.snapshot.byteSize || format.mediaType !== image.snapshot.mediaType) throw new Error("Attachment bytes do not match their snapshot");
    const fileName = `${turnId}-${image.snapshot.assetId}.${format.extension}`;
    const path = `${dir}/${fileName}`;
    if (existing.has(path)) {
      const queued = batch.entries.get(path);
      const previous = typeof queued === "string" && batch.encodings?.get(path) === "base64" ? Buffer.from(queued, "base64") : await fsReadBinaryFile(path);
      if (!previous.equals(data)) throw new Error("Stored attachment identity has different bytes");
    }
    writes.push({ path, data, snapshot: { ...image.snapshot, ref: recordImageRef(sliceId, fileName) } });
  }
  for (const write of writes) await fsWriteBinaryFile(write.path, write.data, batch);
  return writes.map((write) => write.snapshot);
}

/** Decode a `data:<mime>;base64,<payload>` URL into bytes (null when malformed). */
export function dataUrlToBuffer(dataUrl: string): { data: Buffer; mediaType: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  return { data: Buffer.from(m[2], "base64"), mediaType: m[1] };
}
