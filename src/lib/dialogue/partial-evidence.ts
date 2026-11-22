import { readReceipt, substantiveThinkingReadCheckpoint, unwrapThinkingRead, type ThinkingRead } from "@/lib/agents/thinking-read-receipt";
import { parseCaseReadEnvelope } from "@/lib/chat/case-read-receipt";
import type { NativeMessage, ToolResult } from "@/lib/deepseek/types";
import { parseCanonicalDocumentRef } from "@/lib/documents/document-link";
import { partialEvidenceProse } from "@/lib/memory/partial-evidence-prose";

interface Passage { id: string; text: string }

const maxPassages = 6;
const maxPassageChars = 1_200;
const maxTotalChars = 4_000;

function eligible(read: ThinkingRead) {
  return read.sourceKind === "semantic_document" && read.edition === "current" &&
    /^[a-f0-9]{64}$/.test(read.revision ?? "") && parseCanonicalDocumentRef(read.ref) === read.ref &&
    /^(?:people|events|things|places|orgs|research|hypotheses|tasks)\//.test(read.ref) && !/^people\/user(?:\/|$)/i.test(read.ref) &&
    !read.role && !read.turnId && read.turnIndex === undefined && !read.range;
}

/** Isolate the documented edition before considering any prose as source text. */
function readBody(text: string, mixedEditions: boolean): string {
  let body = text.split(/^\s*SOURCE NAVIGATION ONLY —/m, 1)[0]!.trim();
  body = body.replace(/^\(matched the near-name "[^\r\n]*" — read it under that stored name\)\r?\n\r?\n/, "");
  body = body.replace(/^CASE PIECES —[^\r\n]*(?:\r?\n[^\r\n]+)*?(?:\r?\n\r?\n|$)/, "");
  if (mixedEditions) {
    const current = /^CURRENT UNDERSTANDING \(_current\.md\)\r?\nas-of: [^\r\n]*\r?\nevidence: [^\r\n]*\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---\r?\n\r?\n(?:HISTORICAL SOURCE —|CURRENT-VIEW HISTORY \(|PRESERVED HISTORICAL INDEX \()/.exec(body);
    return current?.[1]?.trim() ?? "";
  }
  // A missing closing delimiter must not turn machine metadata into ordinary prose.
  if (/^\uFEFF?---[ \t]*\r?\n/.test(body)) {
    const header = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?$(?:\n|$)/m.exec(body);
    if (!header) return "";
    body = body.slice(header[0].length);
  }
  return body.split(/^\s*—— 尾部 ——\s*$/m, 1)[0]!.trim();
}

function sourcePassages(result: ToolResult, scopeId: string): Passage[] {
  const { output, toolName, toolCallId } = result;
  if (result.error !== undefined || typeof output !== "string" ||
      !substantiveThinkingReadCheckpoint(output, scopeId, toolName, toolCallId)) return [];
  const receipt = readReceipt(output)!;
  if (toolName === "recallSearch" && !parseCaseReadEnvelope(output)) {
    return receipt.reads.filter(read => eligible(read) && read.partialEvidenceEligible)
      .map(read => ({ id: read.evidenceId, text: read.excerpt! }));
  }
  if (toolName !== "recallRead") return [];
  const current = receipt.reads.filter(read => eligible(read) && read.coverage === "full");
  if (current.length !== 1) return [];
  const read = current[0]!;
  const semantic = receipt.reads.filter(other => other.sourceKind === "semantic_document");
  if (semantic.some(other => other.ref !== read.ref) || receipt.reads.some(other =>
    other.sourceKind !== "semantic_document" && other.sourceKind !== "navigation")) return [];
  const outer = parseCaseReadEnvelope(output);
  if (!outer && read.ref.split("/").length !== 3) return [];
  if (outer && (outer.receipt.scopeId !== scopeId || outer.receipt.toolCallId !== toolCallId ||
      outer.receipt.ref !== read.ref || outer.receipt.path !== "memory/" + read.ref + "/index.md" ||
      outer.receipt.revision !== semantic[0]?.revision)) return [];
  const text = readBody(unwrapThinkingRead(outer?.body ?? output), semantic.some(other => other.edition === "original"));
  return [{ id: read.evidenceId, text }];
}


/** Only the runner's paired, executed tool results from a single step belong here. */
export function collectPartialEvidence(results: readonly ToolResult[], scopeId: string): Passage[] {
  const ids = new Set<string>();
  const repeated = new Set<string>();
  for (const { toolCallId } of results) {
    if (ids.has(toolCallId)) repeated.add(toolCallId);
    ids.add(toolCallId);
  }
  const passages: Passage[] = [];
  const seen = new Set<string>();
  let remaining = maxTotalChars;
  for (const result of results) {
    if (!scopeId || repeated.has(result.toolCallId)) continue;
    for (const source of sourcePassages(result, scopeId)) {
      // Keep adjacent context together when it fits. Bound longer reads at complete paragraphs.
      const blocks = partialEvidenceProse(source.text).flatMap(text => text.length <= maxPassageChars
        ? [text] : text.split(/\r?\n[ \t]*\r?\n/));
      for (const [index, block] of blocks.entries()) {
        const text = block.trim();
        if (!text || !/\p{L}/u.test(text) || /^\s*#{1,6}[^\r\n]*$/.test(text) || seen.has(text) ||
            text.length > maxPassageChars || text.length > remaining) continue;
        passages.push({ id: source.id + "." + (index + 1), text });
        seen.add(text);
        remaining -= text.length;
        if (passages.length === maxPassages) return passages;
      }
    }
  }
  return passages;
}

const extractionInstruction = "Extract facts from the supplied passages. List each independently requested fact once. Preserve who or what the question refers to and the status it asks about. A proposal or application establishes what was proposed or requested; it does not establish approval, signature or completion. For each fact return its question, a short directAnswer copied from the source, and the shortest complete verbatimEvidence passage establishing that answer. If the source does not directly answer that question, both values are null. Do not infer from related subjects or silence. Return a JSON array of objects with only question, directAnswer, verbatimEvidence.";

export function partialEvidencePrompt(question: string, passages: readonly Passage[]): NativeMessage[] {
  return [
    { role: "system", content: extractionInstruction },
    { role: "user", content: JSON.stringify({ request: question, passages: passages.map(p => p.text) }) },
  ];
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
}

function saidBefore(value: string, history: readonly string[]): boolean {
  const target = normalized(value);
  if (!target) return true;
  const leftEdge = /^[a-z0-9]/.test(target);
  const rightEdge = /[a-z0-9]$/.test(target);
  return history.some(prior => {
    for (let at = prior.indexOf(target); at >= 0; at = prior.indexOf(target, at + 1)) {
      if (leftEdge && /[a-z0-9]/.test(prior.charAt(at - 1))) continue;
      if (rightEdge && /[a-z0-9]/.test(prior.charAt(at + target.length))) continue;
      return true;
    }
    return false;
  });
}

/** A model supplies the question/answer association. Only literal source prose may leave this gate. */
export function candidatePartialAnswer(modelText: string, passages: readonly Passage[], alreadySaid: readonly string[]): string | null {
  if (modelText.length > 16_000) return null;
  let rows: unknown;
  try { rows = JSON.parse(modelText.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")); }
  catch { return null; }
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 12) return null;
  const questions = new Set<string>();
  const handoff = new Set<string>();
  const history = alreadySaid.map(normalized);
  let unresolved = false;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== "directAnswer,question,verbatimEvidence" ||
        typeof row.question !== "string") return null;
    const question = normalized(row.question);
    if (!question || questions.has(question)) return null;
    questions.add(question);
    const { directAnswer, verbatimEvidence } = row;
    if (directAnswer === null && verbatimEvidence === null) { unresolved = true; continue; }
    if (typeof directAnswer !== "string" || !directAnswer.trim() || typeof verbatimEvidence !== "string" ||
        !verbatimEvidence.includes(directAnswer)) return null;
    const matches = passages.filter(p => p.text.includes(verbatimEvidence));
    if (matches.length !== 1) return null;
    if (saidBefore(directAnswer, history) || saidBefore(verbatimEvidence, history)) continue;
    // Preserve qualifiers even when the model selects only a fragment of a sentence.
    const source = matches[0]!.text;
    const paragraphs = source.split(/\r?\n[ \t]*\r?\n/);
    handoff.add(paragraphs.find(paragraph => paragraph.includes(verbatimEvidence))?.trim() ?? source);
  }
  const text = [...handoff].join("\n\n");
  return unresolved && text.length > 0 && text.length <= 2_400 ? text : null;
}
