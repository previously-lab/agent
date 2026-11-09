import { z } from "zod";
import type { ContentBlockV1, DialogueArtifactRef, PublicUtterance } from "@/lib/chat/dialogue-contract";
import { parseImageAttachments } from "@/lib/chat/image-attachments";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import type { ThinkingProduct } from "@/lib/agents/thinking-product";

const id = z.string().min(1).max(256);
const seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true });
const artifact = z.object({ artifactId: id, sourceOwnerId: id, revision: z.literal(1), sha256: hash,
  kind: z.enum(["native_html", "document"]), mediaType: z.string().max(120), byteSize: seq,
  summary: z.string().max(4000).optional(), width: seq.optional(), height: seq.optional() }).strict();
export function parseDialogueArtifactRef(value: unknown): DialogueArtifactRef | null {
  const parsed = artifact.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const contentBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown"), blockId: id, text: z.string().max(64_000)
    .refine((text) => !parseNativeSections(text).some((section) => section.kind === "native"), "Native HTML belongs in an artifact reference") }).strict(),
  z.object({ kind: z.literal("artifact_ref"), blockId: id, artifact }).strict(),
  z.object({ kind: z.literal("image_ref"), blockId: id, image: z.unknown().transform((image, ctx) => {
    const parsed = parseImageAttachments([image])[0];
    if (parsed) return parsed;
    ctx.addIssue({ code: "custom", message: "Invalid record image identity" });
    return z.NEVER;
  }) }).strict(),
  z.object({ kind: z.literal("citation_ref"), blockId: id, ref: z.string().min(1).max(2048), label: z.string().max(600).optional() }).strict(),
]);
const dialogueTurn = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_input"), inputId: id, userSeq: seq.optional() }).strict(),
  z.object({ kind: z.literal("public_utterance"), publicationId: id, publicSeq: seq, inputIds: z.array(id).max(64),
    sourceResults: z.array(z.object({ resultId: id, productRevision: seq, claimIds: z.array(id).max(32) }).strict()).max(32),
    blocks: z.array(contentBlock).max(32),
  }).strict(),
]);

export type DialogueRecordTurn = z.infer<typeof dialogueTurn>;
const metadataMax = 262_144;

export function encodeDialogueRecordTurn(value: DialogueRecordTurn): string {
  const encoded = encodeURIComponent(JSON.stringify({ v: 1, event: dialogueTurn.parse(value) }));
  if (encoded.length > metadataMax) throw new Error("Dialogue record metadata exceeds its bound");
  return encoded;
}

/** Only an unambiguous host-serialized header can carry public metadata. */
export function decodeDialogueRecordTurn(value: unknown, role: string): DialogueRecordTurn | undefined {
  if (typeof value !== "string" || value.length > metadataMax) return undefined;
  try {
    const envelope = JSON.parse(decodeURIComponent(value));
    if (envelope?.v !== 1) return undefined;
    const parsed = dialogueTurn.safeParse(envelope.event);
    if (!parsed.success) return undefined;
    if (parsed.data.kind === "user_input" ? role !== "user" : role !== "agent" && role !== "assistant") return undefined;
    return parsed.data;
  } catch { return undefined; }
}

export function publicRecordTurn(utterance: PublicUtterance): Extract<DialogueRecordTurn, { kind: "public_utterance" }> {
  const value = dialogueTurn.parse({ kind: "public_utterance", publicationId: utterance.utteranceId,
    publicSeq: utterance.publicSeq, inputIds: utterance.inputIds, sourceResults: utterance.sourceResults, blocks: utterance.blocks });
  if (value.kind !== "public_utterance") throw new Error("Expected a publication");
  return value;
}

/** Paper fallback and original-conversation text do not inline executable artifact bytes. */
export function publicRecordText(blocks: readonly ContentBlockV1[]): string {
  return blocks.flatMap((block) => block.kind === "markdown" ? [block.text] : []).filter(Boolean).join("\n\n");
}


const RECORD_ARTIFACT_PREFIX = "record-artifact=";
const RECORD_BLOCK_PREFIX = "record-block=";
const RECORD_NO_FINAL_NEWLINE = "record-final-newline=0";
const RECORD_TOKEN = /^[a-f0-9]{64}$/;
const utf8 = new TextEncoder();

type RecordArtifactInfo = { artifactId: string; blockId: string; noFinalNewline: boolean };

function recordInfoTokens(raw: string): string[] | null {
  if (raw.startsWith(" ") || raw.startsWith("\t")) return null;
  const firstLine = /^`{3,}([^\r\n]*)/.exec(raw)?.[1];
  if (!firstLine) return null;
  const tokens = firstLine.trim().split(/[ \t]+/).filter(Boolean);
  return tokens[0] === "html" && tokens[1] === "live" ? tokens : null;
}

function isRecordArtifactCandidate(raw: string): boolean {
  return recordInfoTokens(raw)?.some((token) => token === "record-artifact" || token.startsWith(RECORD_ARTIFACT_PREFIX)) ?? false;
}

function readRecordArtifactInfo(raw: string): RecordArtifactInfo | null {
  const tokens = recordInfoTokens(raw);
  if (!tokens || (tokens.length !== 4 && tokens.length !== 5)) return null;
  const artifactId = tokens[2]?.startsWith(RECORD_ARTIFACT_PREFIX) ? tokens[2].slice(RECORD_ARTIFACT_PREFIX.length) : "";
  const encodedBlock = tokens[3]?.startsWith(RECORD_BLOCK_PREFIX) ? tokens[3].slice(RECORD_BLOCK_PREFIX.length) : "";
  if (!RECORD_TOKEN.test(artifactId) || !encodedBlock || (tokens.length === 5 && tokens[4] !== RECORD_NO_FINAL_NEWLINE)) return null;
  try {
    return { artifactId, blockId: decodeURIComponent(encodedBlock), noFinalNewline: tokens.length === 5 };
  } catch { return null; }
}

function artifactFence(artifactId: string, blockId: string, body: string): string {
  if (!RECORD_TOKEN.test(artifactId)) throw new Error("Dialogue artifact id cannot be written as a record token");
  let longestRun = 0;
  for (const match of body.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const noFinalNewline = !body.endsWith("\n");
  const info = `html live record-artifact=${artifactId} record-block=${encodeURIComponent(blockId)}` +
    (noFinalNewline ? ` ${RECORD_NO_FINAL_NEWLINE}` : "");
  return `${fence} ${info}\n${body}${noFinalNewline ? "\n" : ""}${fence}`;
}

/** Store public prose and verified native source together in the original
 * reply. The marker carries identity, never authority: the structured block
 * metadata remains the reference used by the existing SHA/size verifier. */
export function composeDialogueRecordBody(
  blocks: readonly ContentBlockV1[],
  verifiedBodies: ReadonlyMap<string, string>,
): string {
  return blocks.flatMap((block) => {
    if (block.kind === "markdown") return block.text ? [block.text] : [];
    if (block.kind !== "artifact_ref" || block.artifact.kind !== "native_html") return [];
    const body = verifiedBodies.get(block.artifact.artifactId);
    if (body === undefined) throw new Error(`Missing verified dialogue artifact ${block.artifact.artifactId}`);
    if (utf8.encode(body).byteLength !== block.artifact.byteSize) throw new Error(`Dialogue artifact size differs for ${block.artifact.artifactId}`);
    return [artifactFence(block.artifact.artifactId, block.blockId, body)];
  }).join("\n\n");
}

/** Read only the exact representation emitted by composeDialogueRecordBody.
 * A malformed or mismatched body yields no sources; public prose still comes
 * from metadata and the legacy artifact archive remains the display fallback. */
export function readDialogueRecordBody(
  raw: string,
  blocks: readonly ContentBlockV1[],
): { exact: boolean; artifactBodies: Record<string, string> } {
  const artifactBodies: Record<string, string> = {};
  const expected = blocks.flatMap((block) => block.kind === "artifact_ref" && block.artifact.kind === "native_html" ? [block] : []);
  let ordinal = 0;
  try {
    for (const section of parseNativeSections(raw)) {
      if (section.kind !== "native") continue;
      const info = section.closed ? readRecordArtifactInfo(section.raw) : null;
      const block = expected[ordinal++];
      if (!info || !block || info.artifactId !== block.artifact.artifactId || info.blockId !== block.blockId) {
        return { exact: false, artifactBodies: {} };
      }
      let body = section.source;
      if (info.noFinalNewline) {
        if (!body.endsWith("\n")) return { exact: false, artifactBodies: {} };
        body = body.slice(0, -1);
      }
      artifactBodies[info.artifactId] = body;
    }
    if (ordinal !== expected.length) return { exact: false, artifactBodies: {} };
    const verified = new Map(Object.entries(artifactBodies));
    if (composeDialogueRecordBody(blocks, verified).trimEnd() !== raw.trimEnd()) return { exact: false, artifactBodies: {} };
    return { exact: true, artifactBodies };
  } catch { return { exact: false, artifactBodies: {} }; }
}

/** Ordinary record readers get prose plus a short omission marker. Legacy
 * html-live fences have no host record marker and remain byte-identical. */
export function projectRecordArtifactSources(raw: string): string {
  return parseNativeSections(raw).map((section) => {
    if (section.kind !== "native" || !isRecordArtifactCandidate(section.raw)) return section.raw;
    const artifactId = readRecordArtifactInfo(section.raw)?.artifactId;
    const ending = section.raw.endsWith("\r\n") ? "\r\n" : section.raw.endsWith("\n") || section.raw.endsWith("\r") ? section.raw.slice(-1) : "";
    return `[Interactive artifact${artifactId ? ` ${artifactId}` : ""} omitted]${ending}`;
  }).join("");
}

const RESEARCH_PREFIX = "[research-result-v1] ";
const researchResult = z.object({
  kind: z.literal("research_result"), resultId: id, productRevision: seq, workId: id,
  inputIds: z.array(id).max(64), sourceTurnId: id, asOf: at,
  sourceRevision: z.string().max(256).nullable(), status: z.enum(["complete", "incomplete"]),
  artifacts: z.array(artifact).max(16),
  outputRef: z.string().regex(/^works\/[a-f0-9]{64}\.json$/).optional(),
  outputSha256: hash.optional(),
  delta: z.object({ readerQuestion: z.string().max(400), newInformation: z.string().max(600),
    targetRefs: z.array(z.string().max(2048)).max(4),
    claims: z.array(z.object({ claimId: id, text: z.string().max(600), kind: z.string().max(64),
      decision: z.enum(["proposed", "confirmed", "rejected", "unresolved"]).optional(),
      uncertainty: z.string().max(600).optional(),
      sources: z.array(z.object({ ref: z.string().max(2048), revision: z.string().max(256).nullable(),
        role: z.enum(["user", "assistant"]).optional(), turnId: id.optional() }).strict()).max(8),
    }).strict()).max(8),
  }).strict().optional(),
}).strict();
export type DialogueResearchRecord = z.infer<typeof researchResult>;

const MATERIAL_SEPARATOR = "@research:";

/** Reflection material is an exact internal result, not another public turn. */
export function dialogueResearchMaterialId(record: Pick<DialogueResearchRecord, "sourceTurnId" | "resultId" | "productRevision">): string {
  return `${record.sourceTurnId}${MATERIAL_SEPARATOR}${encodeURIComponent(record.resultId)}:${record.productRevision}`;
}

/** Map a material id back to the real user turn used for record excerpts. */
export function dialogueSourceTurnId(materialId: string): string {
  return materialId.split(MATERIAL_SEPARATOR, 1)[0] || materialId;
}

/** Select only owed versions. Legacy turn wakes retain their latest-result behavior. */
export function selectDialogueResearchProducts(
  records: readonly DialogueResearchRecord[],
  materialIds: readonly string[],
): DialogueResearchRecord[] {
  const selected: DialogueResearchRecord[] = [];
  const legacySeen = new Set<string>();
  const include = (record: DialogueResearchRecord): boolean => {
    if (selected.some((item) => item.resultId === record.resultId && item.productRevision === record.productRevision)) return false;
    selected.push(record);
    return selected.length >= 8;
  };
  for (const materialId of materialIds) {
    const exact = materialId.includes(MATERIAL_SEPARATOR);
    const matches = records.filter((record) => record.delta &&
      (exact ? dialogueResearchMaterialId(record) === materialId : record.sourceTurnId === materialId));
    const ordered = exact ? matches : [...matches].sort((a, b) => b.productRevision - a.productRevision);
    for (const record of ordered) {
      if (!exact && legacySeen.has(record.resultId)) continue;
      if (!exact) legacySeen.add(record.resultId);
      if (include(record)) return selected;
    }
  }
  return selected;
}

/** Index one immutable work result; the optional output file carries full text and product. */
export function makeDialogueResearchRecord(input: { resultId: string; productRevision: number; sourceTurnId: string;
  product: ThinkingProduct; artifacts?: readonly DialogueArtifactRef[]; outputRef?: string; outputSha256?: string }): DialogueResearchRecord {
  const product = input.product;
  const proposed = product.memoryDelta;
  const delta = proposed && {
    readerQuestion: proposed.readerQuestion, newInformation: proposed.newInformation, targetRefs: proposed.targetRefs,
    claims: product.claims.filter((claim) => proposed.claimIds.includes(claim.claimId) && claim.allowedPublicMode === "finding")
      .map((claim) => ({ claimId: claim.claimId, text: claim.text.slice(0, 600), kind: claim.kind,
        ...(claim.decision ? { decision: claim.decision } : {}), ...(claim.uncertainty ? { uncertainty: claim.uncertainty } : {}),
        sources: product.readSet.filter((read) => claim.evidenceIds.includes(read.evidenceId)).slice(0, 8)
          .map(({ ref, revision, role, turnId }) => ({ ref, revision, ...(role ? { role } : {}), ...(turnId ? { turnId } : {}) })),
      })),
  };
  return researchResult.parse({ kind: "research_result", resultId: input.resultId, productRevision: input.productRevision,
    workId: product.inputScope.workId, inputIds: product.inputScope.inputIds, sourceTurnId: input.sourceTurnId,
    asOf: product.asOf, sourceRevision: product.sourceRevision, status: product.status, artifacts: input.artifacts ?? [],
    ...(input.outputRef ? { outputRef: input.outputRef, outputSha256: input.outputSha256 } : {}),
    ...(delta?.claims.length ? { delta } : {}) });
}

export function encodeDialogueResearchRecord(value: DialogueResearchRecord): string {
  return RESEARCH_PREFIX + JSON.stringify(researchResult.parse(value));
}

export function readDialogueResearchRecords(raw: string): DialogueResearchRecord[] {
  return raw.split("\n").flatMap((line) => {
    if (!line.startsWith(RESEARCH_PREFIX) || line.length > 64_000) return [];
    try {
      const parsed = researchResult.safeParse(JSON.parse(line.slice(RESEARCH_PREFIX.length)));
      return parsed.success ? [parsed.data] : [];
    } catch { return []; }
  });
}
