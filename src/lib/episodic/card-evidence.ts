import { z } from "zod";
import { extractSemanticDocumentLinks } from "@/lib/archive/ref-tokens";
import {
  appendTail, parseCaseCurrent, parseCaseDoc, serializeCaseCurrent, serializeCaseDoc,
  serializeCaseTail, serializeTailEntries,
} from "@/lib/docs/case-doc";
import { isValidCaseName, isValidPieceFileName } from "@/lib/docs/case-naming";
import { isHistoryArchiveFileName } from "@/lib/docs/history-archive";
import { isCaseCategory } from "@/lib/docs/paths";
import { assertDocumentWrite, assertTailBudget } from "@/lib/docs/write-limits";
import { formatDocumentLink } from "@/lib/documents/document-link";
import { fsReadFile, fsWriteFile, type WriteBatch } from "./io-helpers";
import { parseTurns } from "./turn-parser";

export const cardLinkSourceSchema = z.object({
  sliceId: z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{4}$/),
  turnId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  quote: z.string().min(1).max(4000),
}).strict();
export type CardLinkSource = z.infer<typeof cardLinkSourceSchema>;

/** Recognize only the standalone footer written by this module. */
export function isCaseCardCitation(text: string): boolean {
  const trimmed = text.trim();
  if (!/^\[原话\]\(previously:records\/[^)]+\)$/.test(trimmed)) return false;
  const [{ link } = {}] = extractSemanticDocumentLinks(trimmed);
  if (!link?.turnId || link.role !== "user") return false;
  const href = formatDocumentLink(link.ref, { turnId: link.turnId, role: "user" });
  return trimmed === `[原话](${href})`;
}

/** A repeated summary keeps its citations without producing a fake revision. */
export function preserveCaseCardCitationsOnSameBody(previous: string, incoming: string): string {
  const sections = previous.trim().split(/\n\s*\n/);
  let count = sections.length;
  while (count > 1 && isCaseCardCitation(sections[count - 1])) count--;
  if (count === sections.length) return incoming;
  const citationStart = previous.trim().lastIndexOf(sections[count]);
  return previous.trim().slice(0, citationStart).trim() === incoming.trim() ? previous : incoming;
}

/** Prove one exact user message, independent of the surrounding slice. */
export function validateCardSource(source: CardLinkSource, raw: string): void {
  cardLinkSourceSchema.parse(source);
  if (!formatDocumentLink(`records/${source.sliceId}`)) throw new Error("Invalid card slice");
  const turns = parseTurns(raw).turns.filter((turn) => turn.turnId === source.turnId &&
    (turn.role === "user" || turn.boundary === "ambiguous" && turn.sourceRole === "user"));
  if (turns.length !== 1 || turns[0].role !== "user" || !source.quote.trim() ||
      !turns[0].content.includes(source.quote)) {
    throw new Error("Card source must quote one uniquely identified original user message");
  }
}

/** Cite original speech in the document being filed, without copying it. */
export async function stageCaseCardCitation(
  batch: WriteBatch, documentPath: string, source: CardLinkSource, raw: string, date: string,
): Promise<void> {
  const [root, category, caseName, fileName, ...rest] = documentPath.split("/");
  if (root !== "memory" || !category || !isCaseCategory(category) || !caseName || !isValidCaseName(caseName)
    || !fileName || rest.length || isHistoryArchiveFileName(fileName)
    || (fileName !== "index.md" && fileName !== "_current.md" && !isValidPieceFileName(fileName))) {
    throw new Error("Card citations require a canonical case document");
  }
  validateCardSource(source, raw);
  const ref = `records/${source.sliceId}`;
  const href = formatDocumentLink(ref, { turnId: source.turnId, role: "user" });
  if (!href) throw new Error("Invalid card citation");
  const citation = `[原话](${href})`;
  const current = await fsReadFile(documentPath, batch, { fresh: true });
  const hasCitation = (markdown: string) => extractSemanticDocumentLinks(markdown).some(({ link }) =>
    link.ref === ref && link.turnId === source.turnId && link.role === "user");
  let next: string;
  if (fileName === "_current.md") {
    const doc = parseCaseCurrent(current);
    if (hasCitation(doc.body)) return;
    next = serializeCaseCurrent({ ...doc, body: `${doc.body}\n\n${citation}` });
  } else {
    if (hasCitation(current)) return;
    const doc = appendTail(parseCaseDoc(current, { category, caseName, fileName }), { date, text: citation });
    assertTailBudget(documentPath, serializeTailEntries([{ date, text: citation }]) + "\n", serializeCaseTail(doc.tail) + "\n");
    next = serializeCaseDoc(doc);
  }
  assertDocumentWrite(documentPath, next, current);
  await fsWriteFile(documentPath, next, batch);
}
