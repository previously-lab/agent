import { getWorld } from "workflow/runtime";
import { workflowRegistryPages } from "@/lib/chat/workflow-registry-pages";
import { parseRecordImageRef, type ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { parseSlice } from "@/lib/episodic/manager";
import type { TimeSlice } from "@/lib/episodic/types";
import { readSlicePartResolved } from "@/lib/episodic/paths";
import { locateSummaryRecords } from "@/lib/chat/summary-records";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { readRecordImage } from "@/lib/tools/attachments";
import { ImageAttachmentError, inspectImage } from "@/lib/tools/image-validation";
import { digest } from "./artifacts";
import { listDialogueEvents } from "./workflow-offers";

const unavailable = () => new ImageAttachmentError("original_images_unavailable", "Could not verify the images from the original message", 409);

/** Hints locate a run or a record page. Only its verified original user turn selects the files. */
export async function restoreDialogueImages(scope: string, inputId: string, runHint: unknown, hints: ImageAttachmentSnapshot[]) {
  if (!/^[a-f0-9]{24}$/.test(inputId)) throw unavailable();
  const owns = (clientId: string | undefined) => !!clientId && digest(JSON.stringify([scope, clientId])).slice(0, 24) === inputId;
  async function fromRecord(slice: TimeSlice) {
    const original = slice.turns.find(turn => turn.role === "user" && turn.turnId === inputId &&
      turn.dialogue?.kind === "user_input" && turn.dialogue.inputId === inputId && owns(turn.clientMessageId));
    if (original?.attachments?.length && original.clientMessageId) {
      const images = await Promise.all(original.attachments.map(async snapshot => {
        const record = parseRecordImageRef(snapshot.ref);
        if (record?.sliceId !== slice.slice_id || !record.fileName.startsWith(`${inputId}-${snapshot.assetId}.`)) throw unavailable();
        const { data } = await readRecordImage(snapshot.ref);
        if (inspectImage(data).mediaType !== snapshot.mediaType || snapshot.byteSize !== undefined && data.length !== snapshot.byteSize) throw unavailable();
        return { snapshot, dataBase64: data.toString("base64") };
      }));
      return { text: original.content, clientMessageId: original.clientMessageId, acceptedAt: original.timestamp, images };
    }
  }

  const page = hints.map(image => parseRecordImageRef(image.ref)?.sliceId).find(Boolean);
  if (page) {
    const core = await readSlicePartResolved(page, "core", undefined, { fresh: true });
    if (core) {
      const recovered = await fromRecord(parseSlice(core.content));
      if (recovered) return recovered;
      throw unavailable();
    }
  }

  const isOriginal = (attributes?: Record<string, string> | null) => attributes?.scope === scope &&
    attributes.role === "thinking" && attributes.turn === inputId && attributes.work === inputId;
  try {
    const world = await getWorld();
    const hinted = typeof runHint === "string" && /^wrun_[a-z0-9]{1,120}$/i.test(runHint)
      ? await world.runs.get(runHint, { resolveData: "none" }).catch(() => undefined) : undefined;
    // Older clients sent no run hint; retries of retries can also point at a later attempt.
    let row = isOriginal(hinted?.attributes) ? hinted : undefined;
    if (!row) {
      for await (const rows of workflowRegistryPages(world)) {
        const original = rows.find(candidate => isOriginal(candidate.attributes));
        if (original) {
          row = original;
          break;
        }
      }
    }
    if (row) {
      const start = (await listDialogueEvents(row.runId)).find(event => event.type === "thought_started" &&
        event.runId === row.runId && event.workId === inputId && event.sourceInputId === inputId && event.input.inputId === inputId);
      if (start?.type === "thought_started" && owns(start.input.clientMessageId) && start.record.images?.length) {
        return { text: start.input.text, clientMessageId: start.input.clientMessageId, acceptedAt: start.input.acceptedAt, images: start.record.images };
      }
    }
  } catch { /* A retired workflow or a failed lookup can still be recovered from the original user record. */ }
  const { saved } = await locateSummaryRecords({ ...getRepoConfig(), useGithub: resolveDataSource() === "github", sliceId: "" },
    [{ turnId: inputId, userText: "" }]);
  const originalSlice = saved.get(inputId);
  if (originalSlice) {
    const recovered = await fromRecord(originalSlice);
    if (recovered) return recovered;
  }
  throw unavailable();
}
