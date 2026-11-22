import { z } from "zod";
import { extractSemanticDocumentLinks } from "@/lib/archive/ref-tokens";
import {
  appendTail, parseCaseCurrent, parseCaseDoc, serializeCaseCurrent, serializeCaseDoc,
  serializeCaseTail, serializeTailEntries,
} from "@/lib/docs/case-doc";
import { isValidCaseName, isValidPieceFileName } from "@/lib/docs/case-naming";
import { isHistoryArchiveFileName } from "@/lib/docs/history-archive";
import { isCaseCategory, isUserModelCase } from "@/lib/docs/paths";
import { isCapabilitySopCase } from "@/lib/evolution/paths";
import { assertDocumentWrite, assertTailBudget } from "@/lib/docs/write-limits";
import { formatDocumentLink } from "@/lib/documents/document-link";
import { fsReadFile, fsWriteFile, type WriteBatch } from "./io-helpers";
import { parseTurns, type ParsedTurn } from "./turn-parser";

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

/** A user attribution is valid only for one unambiguous source turn. */
export function originalUserCard(turns: readonly ParsedTurn[], turnId: string): ParsedTurn | undefined {
  const matching = turns.filter(turn => turn.turnId === turnId &&
    (turn.role === "user" || turn.boundary === "ambiguous" && turn.sourceRole === "user"));
  return matching.length === 1 && matching[0].role === "user" && matching[0].boundary !== "ambiguous"
    ? matching[0] : undefined;
}

/** Prove one exact user message, independent of the surrounding slice. */
export function validateCardSource(source: CardLinkSource, raw: string): void {
  cardLinkSourceSchema.parse(source);
  if (!formatDocumentLink(`records/${source.sliceId}`)) throw new Error("Invalid card slice");
  const turn = originalUserCard(parseTurns(raw).turns, source.turnId);
  if (!turn || !source.quote.trim() || !turn.content.includes(source.quote)) {
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
  if (isUserModelCase(category, caseName)) throw new Error("Use evolveProfile to connect evidence to the user model.");
  if (isCapabilitySopCase(category, caseName)) throw new Error("Use writeSelfSop to connect evidence to a capability SOP.");
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
