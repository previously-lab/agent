import { dirname, join } from "node:path";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueResult } from "@/lib/dialogue/types";
import type { DialogueTypedArtifact } from "@/lib/dialogue/transport";
import type { ImageAttachmentEvidence, ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { COMMIT_PREFIX } from "@/lib/chat/commit-contract";
import { judgeSliceLanding, type SliceLandingConfig } from "@/lib/chat/slice-landing";
import { locateSummaryRecords } from "@/lib/chat/summary-records";
import { caseStorageRevision } from "@/lib/docs/case-doc";
import { absentDocumentError } from "@/lib/docs/write-validation";
import { withGitHubReadView, seedGitHubReadHead } from "@/lib/github/read-view";
import { persistImageAttachments } from "@/lib/tools/attachments";
import { settleStagedImages } from "@/lib/tools/staged-images";
import { appendTurn, closeSlice, createSlice, parseSlice, saveSliceSnapshot, tryLoadTodaySlice } from "./manager";
import { slicePartPath } from "./paths";
import { createBatch, flushBatch, fsReadFile, fsWriteFile, type WriteBatch } from "./io-helpers";
import { withSliceLock } from "./slice-mutex";
import { deterministicSliceMark } from "./slice-mark";
import { parseSliceId } from "./turn-parser";
import type { TimeSlice } from "./types";
import { composeDialogueRecordBody, dialogueResearchMaterialId, encodeDialogueResearchRecord, makeDialogueResearchRecord, publicRecordText, publicRecordTurn, readDialogueResearchRecords } from "./dialogue-record";
import { readArchivedDialogueArtifact, verifiedDialogueRecordArtifacts } from "./dialogue-artifact-archive";

export interface DialogueProjectionInput {
  inputs: Array<{ input: DialogueInput; turnId: string; sliceId?: string; images?: ImageAttachmentEvidence[];
    reflectUserOnly?: boolean }>;
  result?: DialogueResult;
  work?: import("@/lib/chat/turn-types").DialogueWorkResult;
  utterance?: PublicUtterance;
  typedArtifacts?: DialogueTypedArtifact[];
  useGithub: boolean;
  useDemo?: boolean;
  owner: string;
  repo: string;
  timezone: string;
  slicing?: SliceLandingConfig;
}
export interface DialogueProjectionReceipt {
  sliceId: string;
  inputIds: string[];
  utteranceIds: string[];
  inputLandings: Array<{ inputId: string; turnId: string; sliceId: string }>;
  /** Legacy user turns or exact internal result material ids, never publications. */
  reflection: Array<{ sliceId: string; turnIds: string[] }>;
  commitSha: string | null;
}

async function readOptional(path: string, batch: WriteBatch): Promise<string | null> {
  try { return await fsReadFile(path, batch, { fresh: true }); }
  catch (error) { if (absentDocumentError(error)) return null; throw error; }
}

async function readCore(sliceId: string, batch: WriteBatch): Promise<TimeSlice | null> {
  const raw = await readOptional(slicePartPath(sliceId, "core"), batch);
  return raw === null ? null : parseSlice(raw);
}

function atMinute(timestamp: string, offset = 0): string {
  const iso = new Date(Date.parse(timestamp) + offset * 60_000).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 16).replace(":", "")}`;
}

const REFLECT_PREFIX = "[reflection-input-v1] ";

/** Project accepted inputs/results/publications onto Git records. The control
 * store supplies only accepted events. A successful return is not a user read
 * or an acknowledgment that the research was publicly spoken. */
export async function projectDialogueRecords(input: DialogueProjectionInput): Promise<DialogueProjectionReceipt | null> {
  "use step";
  if (input.useDemo) return null;
  return withSliceLock("summary:local-storage", () => withGitHubReadView(async () => {
    const batch = createBatch();
    const bodies = verifiedDialogueRecordArtifacts(input.utterance, input.typedArtifacts);
    const entries = [...input.inputs].sort((a, b) => a.input.userSeq - b.input.userSeq);
    if (!entries.length) throw new Error("A dialogue projection needs its accepted source input");
    if (entries.some((entry) => !/^[A-Za-z0-9_-]{1,128}$/.test(entry.turnId))) throw new Error("Invalid source turn identity");
    const edgeHint = entries[0].sliceId ?? input.result?.sliceId ?? atMinute(entries[0].input.acceptedAt);
    if (!parseSliceId(edgeHint)) throw new Error("Invalid dialogue slice binding");
    // Exact input identity lookup keeps a replay on its original page after
    // capacity/idle rollovers. The Git read view pins the later CAS basis.
    const located = await locateSummaryRecords({ useGithub: input.useGithub, owner: input.owner, repo: input.repo, sliceId: edgeHint },
      entries.map((entry) => ({ turnId: entry.turnId, clientMessageId: entry.input.clientMessageId, userText: entry.input.text })));
    if (input.useGithub && located.commitSha) {
      batch.baseHeadSha = located.commitSha;
      seedGitHubReadHead(input.repo, input.owner, { headSha: located.commitSha });
    }
    const slices = new Map<string, TimeSlice>();
    const touched = new Set<string>();
    const settled: ImageAttachmentSnapshot[] = [];
    const landings: DialogueProjectionReceipt["inputLandings"] = [];
    const reflection = new Map<string, Set<string>>();
    let edge: TimeSlice | null | undefined;

    const attach = (slice: TimeSlice): TimeSlice => {
      const existing = slices.get(slice.slice_id);
      if (existing) return existing;
      slices.set(slice.slice_id, slice);
      return slice;
    };
    for (const entry of entries) {
      const event = entry.input;
      const existing = located.saved.get(entry.turnId);
      let slice = existing ? attach(existing) : null;
      if (!slice) {
        if (edge === undefined) edge = await tryLoadTodaySlice(batch);
        const at = Date.parse(event.acceptedAt);
        if (!Number.isFinite(at)) throw new Error("Invalid accepted input time");
        const landing = input.slicing ? judgeSliceLanding(edge ? { sliceId: edge.slice_id, start: edge.start,
          lastTurnAt: edge.turns.at(-1)?.timestamp ?? null, turnCount: edge.turns.length } : null, at, input.slicing) : null;
        const bound = entry.sliceId ? await readCore(entry.sliceId, batch) : null;
        if (landing?.kind === "continue-edge" && edge) slice = attach(edge);
        else if (!landing && bound) slice = attach(bound);
        else {
          const checkpoint = landing?.kind === "open-new" && landing.checkpoint ? edge?.slice_id : undefined;
          if (landing?.kind === "open-new" && edge) {
            edge = attach(edge);
            const mark = deterministicSliceMark(edge);
            edge.focus ||= mark.focus; edge.summary ||= mark.summary;
            await closeSlice(edge, landing.signal, batch);
          }
          let sliceId = entry.sliceId && parseSliceId(entry.sliceId) && !bound ? entry.sliceId : atMinute(event.acceptedAt);
          // A capacity checkpoint can occur in the same minute; never replace
          // an already occupied core with the new page.
          for (let offset = 1; slices.has(sliceId) || await readCore(sliceId, batch); offset++) {
            if (offset > 64) throw new Error("Unable to allocate an unused record slice");
            sliceId = atMinute(event.acceptedAt, offset);
          }
          slice = createSlice(event.text, input.timezone, entry.turnId, checkpoint);
          slice.slice_id = sliceId;
          slice.start = event.acceptedAt;
          slice.turns[0].timestamp = event.acceptedAt;
          attach(slice);
          touched.add(sliceId);
        }
        edge = slice;
      }
      let user = slice.turns.find((turn) => turn.role === "user" && (turn.turnId === entry.turnId ||
        turn.clientMessageId === event.clientMessageId || turn.dialogue?.kind === "user_input" && turn.dialogue.inputId === event.inputId));
      if (!user) {
        user = { role: "user", timestamp: event.acceptedAt, content: event.text, turnId: entry.turnId };
        appendTurn(slice, user);
        touched.add(slice.slice_id);
      }
      if (user.content.trim() !== event.text.trim() || user.dialogue?.kind === "user_input" && user.dialogue.inputId !== event.inputId) {
        throw new Error("Accepted input conflicts with its stored record identity");
      }
      if (!user.dialogue) {
        user.dialogue = { kind: "user_input", inputId: event.inputId };
        user.clientMessageId = event.clientMessageId;
        if (event.documentContext?.length) user.documentContext = event.documentContext;
        touched.add(slice.slice_id);
      }
      if (!user.attachments?.length && (entry.images?.length || event.attachments?.length)) {
        if (!entry.images?.length && event.attachments?.some((image) => image.ref.startsWith("drafts/"))) {
          throw new Error("Draft image projection requires verified staged bytes");
        }
        user.attachments = entry.images?.length ? await persistImageAttachments({
          sliceId: slice.slice_id, turnId: user.turnId ?? entry.turnId, images: entry.images, batch,
        }) : event.attachments;
        touched.add(slice.slice_id);
      }
      settled.push(...(user.attachments ?? []));
      landings.push({ inputId: event.inputId, turnId: user.turnId ?? entry.turnId, sliceId: slice.slice_id });
    }

    const agentText = new Map<string, string>();
    const readAgent = async (sliceId: string): Promise<string> => {
      if (agentText.has(sliceId)) return agentText.get(sliceId)!;
      return await readOptional(slicePartPath(sliceId, "agent"), batch) ?? "";
    };
    const appendAgent = async (sliceId: string, line: string) => {
      const old = await readAgent(sliceId);
      agentText.set(sliceId, `${old.trimEnd()}${old.trimEnd() ? "\n\n" : ""}${line}\n`);
    };
    const owe = async (landing: DialogueProjectionReceipt["inputLandings"][number], result?: DialogueResult) => {
      const materialId = result ? dialogueResearchMaterialId({ sourceTurnId: landing.turnId,
        resultId: result.resultId, productRevision: result.productRevision }) : landing.turnId;
      const marker = `${REFLECT_PREFIX}${JSON.stringify({ inputId: landing.inputId, turnId: landing.turnId,
        ...(result ? { resultId: result.resultId, productRevision: result.productRevision, materialId } : {}) })}`;
      if (!(await readAgent(landing.sliceId)).split("\n").includes(marker)) await appendAgent(landing.sliceId, marker);
      const set = reflection.get(landing.sliceId) ?? new Set<string>();
      set.add(materialId);
      reflection.set(landing.sliceId, set);
    };
    const work = input.work;
    const result = input.result ?? (work ? {
      resultId: `${work.workId}:1`, productRevision: 1, workId: work.workId,
      inputIds: [work.source.inputId], producerRunId: work.producerRunId,
      sliceId: work.record.sliceId ?? atMinute(work.source.acceptedAt), availableAt: work.product.asOf,
      product: work.product, claims: [], blocks: [],
    } satisfies DialogueResult : undefined);
    if (result) {
      const landing = landings.find((entry) => result.inputIds.includes(entry.inputId));
      if (!landing) throw new Error("Research result has no projected source input");
      let output: { outputRef: string; outputSha256: string } | undefined;
      if (work) {
        const serialized = `${JSON.stringify({
          kind: "dialogue_work_result", version: 1, resultId: result.resultId,
          productRevision: result.productRevision, workId: work.workId, sourceTurnId: landing.turnId,
          producerRunId: work.producerRunId, asOf: work.product.asOf,
          text: work.text, ...(work.report ? { report: work.report } : {}), product: work.product,
          artifacts: result.blocks.flatMap((block) => block.kind === "artifact_ref" ? [block.artifact] : []),
        }, null, 2)}\n`;
        const outputRef = `works/${caseStorageRevision(result.resultId)}.json`;
        const outputPath = join(dirname(slicePartPath(landing.sliceId, "agent")), outputRef);
        const previous = await readOptional(outputPath, batch);
        if (previous !== null && previous !== serialized) throw new Error("Immutable work output changed");
        if (previous === null) await fsWriteFile(outputPath, serialized, batch);
        output = { outputRef, outputSha256: caseStorageRevision(serialized) };
      }
      const record = makeDialogueResearchRecord({ resultId: result.resultId, productRevision: result.productRevision,
        sourceTurnId: landing.turnId, product: result.product,
        artifacts: result.blocks.flatMap((block) => block.kind === "artifact_ref" ? [block.artifact] : []),
        ...(output ?? {}) });
      const old = readDialogueResearchRecords(await readAgent(landing.sliceId)).find((entry) =>
        entry.resultId === record.resultId && entry.productRevision === record.productRevision);
      if (old && encodeDialogueResearchRecord(old) !== encodeDialogueResearchRecord(record)) throw new Error("Immutable research result changed");
      if (!old) await appendAgent(landing.sliceId, encodeDialogueResearchRecord(record));
      await owe(landing, result);
    }
    for (const entry of entries) if (entry.reflectUserOnly) await owe(landings.find((landing) => landing.inputId === entry.input.inputId)!);

    const utteranceIds: string[] = [];
    if (input.utterance) {
      const utterance = input.utterance;
      const landing = landings.find((entry) => utterance.inputIds.includes(entry.inputId));
      if (!landing) throw new Error("Public utterance has no projected source input");
      const slice = slices.get(landing.sliceId)!;
      const dialogue = publicRecordTurn(utterance);
      const turnId = `p${caseStorageRevision(utterance.utteranceId).slice(0, 31)}`;
      const old = slice.turns.find((turn) => turn.turnId === turnId ||
        turn.dialogue?.kind === "public_utterance" && turn.dialogue.publicationId === utterance.utteranceId);
      if (old && JSON.stringify(old.dialogue) !== JSON.stringify(dialogue)) throw new Error("Immutable publication changed");
      const content = publicRecordText(dialogue.blocks);
      const recordBody = bodies.size ? composeDialogueRecordBody(dialogue.blocks, bodies) : undefined;
      if (old && recordBody !== undefined &&
        (old.recordBody !== recordBody.trimEnd() || [...bodies].some(([id, source]) => old.artifactBodies?.[id] !== source))) {
        // A retry of a legacy record leaves it as it was. A partial or changed
        // inline body is not a successful replay of the immutable publication.
        if (old.recordBody !== content.trimEnd() || old.artifactBodies) throw new Error("Immutable publication body changed");
        for (const block of dialogue.blocks) {
          if (block.kind !== "artifact_ref" || block.artifact.kind !== "native_html" ||
            !/^wrun_[A-Za-z0-9]+$/.test(block.artifact.sourceOwnerId)) continue;
          const archived = await readArchivedDialogueArtifact(block.artifact.artifactId);
          if (!archived || JSON.stringify(archived.artifact) !== JSON.stringify(block.artifact) ||
            archived.body !== bodies.get(block.artifact.artifactId)) throw new Error("Immutable publication body missing");
        }
      }
      if (!old) {
        appendTurn(slice, { role: "agent", turnId, timestamp: utterance.committedAt,
          content, replyTo: landing.turnId, dialogue,
          ...(recordBody !== undefined ? { recordBody, artifactBodies: Object.fromEntries(bodies) } : {}) });
        touched.add(slice.slice_id);
      }
      utteranceIds.push(utterance.utteranceId);
    }

    for (const sliceId of touched) await saveSliceSnapshot(slices.get(sliceId)!, batch);
    for (const [sliceId, text] of agentText) await fsWriteFile(slicePartPath(sliceId, "agent"), text, batch);
    const ranges = [...reflection].map(([sliceId, ids]) => ({ sliceId, turnIds: [...ids] }));
    const sliceId = landings[0].sliceId;
    const message = ranges.length ? COMMIT_PREFIX.summary(sliceId) + "\n\n" + ranges.flatMap((range) =>
      range.turnIds.flatMap((id) => [`- reflection source ${id}`, `- record ${id} in ${range.sliceId}`])).join("\n")
      : `Dialogue projection — ${sliceId}`;
    const commitSha = batch.entries.size ? await flushBatch(batch, message) : located.commitSha ?? null;
    await settleStagedImages(settled).catch((error) => console.warn("[Dialogue] image cleanup needs retry", error));
    return { sliceId, inputIds: landings.map((entry) => entry.inputId), utteranceIds, inputLandings: landings,
      reflection: ranges, commitSha: commitSha ?? null };
  }, { fresh: true }));
}
