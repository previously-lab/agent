/** Immutable, independently readable Markdown shards. Payload bytes are never normalized. */
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { caseDirPath, type CaseCategory } from "./paths";
import { documentSize, exceededSize } from "./write-limits";

export const HISTORY_ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}-history-v1-(index|current)-[a-f0-9]{16}-\d{4,}\.md$/i;
export function isHistoryArchiveFileName(path: string): boolean { return HISTORY_ARCHIVE_NAME.test(path.split("/").at(-1) ?? ""); }
export function historyDigest(raw: string): string { return createHash("sha256").update(raw, "utf8").digest("hex"); }
export interface HistoryArchiveMetadata {
  version: 1; source: "index.md" | "_current.md"; source_revision: string;
  kind: "source-snapshot" | "current-revision"; part: number; parts: number;
  byte_start: number; byte_end: number; payload_sha256: string; next: string | null;
}
export interface HistoryArchive { metadata: HistoryArchiveMetadata; payload: string }
function serializeArchive(payload: string, metadata: HistoryArchiveMetadata, date: string, updated: string): string {
  // JSON values are valid YAML; avoid a Markdown serializer that trims/appends payload newlines.
  return `---\nopened: ${JSON.stringify(date)}\nupdated: ${JSON.stringify(updated)}\nhistory_archive: ${JSON.stringify(metadata)}\n---\n${payload}`;
}
export function parseHistoryArchive(raw: string): HistoryArchive | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) return null;
  try {
    const metadata = matter(match[0]).data.history_archive as HistoryArchiveMetadata | undefined;
    if (!metadata || metadata.version !== 1 || !["index.md", "_current.md"].includes(metadata.source) ||
      !["source-snapshot", "current-revision"].includes(metadata.kind) ||
      !/^[a-f0-9]{64}$/.test(metadata.source_revision) || !/^[a-f0-9]{64}$/.test(metadata.payload_sha256) ||
      !Number.isSafeInteger(metadata.part) || !Number.isSafeInteger(metadata.parts) || metadata.part < 1 || metadata.parts < metadata.part ||
      !Number.isSafeInteger(metadata.byte_start) || !Number.isSafeInteger(metadata.byte_end) || metadata.byte_start < 0 || metadata.byte_end < metadata.byte_start ||
      (metadata.next !== null && typeof metadata.next !== "string")) return null;
    const payload = raw.slice(match[0].length);
    if (historyDigest(payload) !== metadata.payload_sha256 || Buffer.byteLength(payload, "utf8") !== metadata.byte_end - metadata.byte_start) return null;
    return { metadata, payload };
  } catch { return null; }
}
export function planHistoryArchive(input: {
  category: CaseCategory; caseName: string; source: "index.md" | "_current.md"; sourceRaw: string;
  date: string; updated: string; kind: HistoryArchiveMetadata["kind"]; previousHead?: string | null;
}): { headRef: string; entries: { path: string; content: string }[]; sourceRevision: string } {
  const prefix = caseDirPath(input.category, input.caseName);
  const sourceRevision = historyDigest(input.sourceRaw);
  const stem = `${input.date}-history-v1-${input.source === "index.md" ? "index" : "current"}-${sourceRevision.slice(0, 16)}-`;
  const pathAt = (part: number) => `${prefix}/${stem}${String(part).padStart(4, "0")}.md`;
  const refAt = (part: number) => pathAt(part).slice("memory/".length, -3);
  // Reserve ample metadata space, then validate the complete serialized shard below.
  const chunks: string[] = [];
  let chunk = "";
  let characters = 0, bytes = 0, breaks = 0;
  for (const character of input.sourceRaw) {
    const addedBytes = Buffer.byteLength(character, "utf8");
    const addedBreak = character === "\r" || (character === "\n" && !chunk.endsWith("\r")) ? 1 : 0;
    if (chunk && (characters + 1 > 8_000 || bytes + addedBytes > 24 * 1024 || breaks + addedBreak > 249)) {
      // Prefer a complete line/paragraph, carrying the remainder forward byte-identically.
      const boundary = chunk.lastIndexOf("\n") + 1;
      const cut = boundary > chunk.length / 2 ? boundary : chunk.length;
      chunks.push(chunk.slice(0, cut)); chunk = chunk.slice(cut);
      const remaining = documentSize(chunk);
      characters = remaining.characters; bytes = remaining.bytes;
      breaks = chunk.match(/\r\n|\r|\n/g)?.length ?? 0;
    }
    breaks += character === "\r" || (character === "\n" && !chunk.endsWith("\r")) ? 1 : 0;
    chunk += character; characters++; bytes += addedBytes;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  let offset = 0;
  const entries = chunks.map((payload, index) => {
    const end = offset + Buffer.byteLength(payload, "utf8");
    const metadata: HistoryArchiveMetadata = { version: 1, source: input.source, source_revision: sourceRevision, kind: input.kind,
      part: index + 1, parts: chunks.length, byte_start: offset, byte_end: end, payload_sha256: historyDigest(payload),
      next: index + 1 < chunks.length ? refAt(index + 2) : input.previousHead ?? null };
    offset = end;
    // Day precision is deliberate: retrying the same source later that day is byte-identical.
    const content = serializeArchive(payload, metadata, input.date, input.date);
    if (exceededSize(documentSize(content)).length) throw new Error("History archive metadata exceeds the document budget");
    return { path: pathAt(index + 1), content };
  });
  return { headRef: refAt(1), entries, sourceRevision };
}
