/**
 * Attachments (v0.19 §C.1, §B.1, §B.5) — naming, fuses, and the three
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
 * FUSES (engineering, not semantic thresholds). A single binary over 5MB is
 * REFUSED; a case whose attachments would exceed 25MB total is REFUSED.
 * Over-limit = a visible error in the result, NEVER a silent truncation.
 * Images are client-compressed before they ever reach this path
 * (use-image-attachments.ts).
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

// ─── Fuses (§C.1) ──────────────────────────────────────────────────────────

/** Single binary ceiling — enforced again at the io layer, structurally. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Per-case attachments total — the 25MB engineering fuse. */
export const MAX_CASE_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

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
async function freeName(dir: string, fileName: string): Promise<string> {
  const taken = new Set<string>();
  try {
    for (const e of await fsListFiles(dir)) {
      if (e.type === "file") taken.add(e.name);
    }
  } catch {
    // directory does not exist yet — nothing taken
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

// ─── The per-case fuse ─────────────────────────────────────────────────────

/** Current total bytes of a case's attachments (0 when none exist). */
export async function caseAttachmentsBytes(dir: string): Promise<number> {
  try {
    const entries = await fsListFiles(dir);
    let total = 0;
    for (const e of entries) {
      if (e.type === "file" && typeof e.size === "number") total += e.size;
    }
    return total;
  } catch {
    return 0; // no attachments yet
  }
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
 * they were sent in (`records/…/attachments/`, `<turnId>-<name>`), enforcing
 * both fuses. Returns per-file outcomes — a refusal is a visible entry in
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

  let caseTotal = await caseAttachmentsBytes(dir);

  for (const file of files) {
    if (file.data.byteLength > MAX_ATTACHMENT_BYTES) {
      result.skipped.push({
        name: file.name,
        reason:
          `附件超过单文件 5MB 上限（${file.data.byteLength} 字节）——未保存，未截断。`,
      });
      continue;
    }
    if (caseTotal + file.data.byteLength > MAX_CASE_ATTACHMENTS_BYTES) {
      result.skipped.push({
        name: file.name,
        reason:
          `该切片附件合计将超过 25MB 上限（现有 ${caseTotal} 字节）——未保存，未截断。`,
      });
      continue;
    }
    try {
      const finalName = await freeName(dir, recordAttachmentName(turnId, file.name));
      const path = `${dir}/${finalName}`;
      await fsWriteBinaryFile(path, file.data, batch);
      caseTotal += file.data.byteLength;
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
 * Both fuses apply; a refusal throws with a visible reason (the writer pass
 * records it as a skip).
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
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `附件超过单文件 5MB 上限（${data.byteLength} 字节）——未复制，未截断。`,
    );
  }
  const dir = caseAttachmentsDir(category, caseName);
  const caseTotal = await caseAttachmentsBytes(dir);
  if (caseTotal + data.byteLength > MAX_CASE_ATTACHMENTS_BYTES) {
    throw new Error(
      `case ${category}/${caseName} 附件合计将超过 25MB 上限（现有 ${caseTotal} 字节）——未复制，未截断。`,
    );
  }
  const finalName = await freeName(dir, caseAttachmentName(date, originalName));
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

/** Decode a `data:<mime>;base64,<payload>` URL into bytes (null when malformed). */
export function dataUrlToBuffer(dataUrl: string): { data: Buffer; mediaType: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  return { data: Buffer.from(m[2], "base64"), mediaType: m[1] };
}
