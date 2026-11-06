/** Server-side scope and work binding shared by preview stream/artifact routes. */
import {
  dialogueResponseError,
  getDialogueStore,
  guardDialogueRead,
  resolveDialogueScope,
} from "@/lib/dialogue/runtime";
import type { DialogueStore } from "@/lib/dialogue/store";
import type { DialogueWorkRecord } from "@/lib/dialogue/types";

export interface AuthorizedWorkPreview {
  store: DialogueStore;
  scope: string;
  work: DialogueWorkRecord;
}

const notFound = () => Response.json(
  { code: "dialogue_not_found", error: "Work preview unavailable" },
  { status: 404 },
);

export async function authorizeWorkPreview(
  request: Request,
  workId: string,
): Promise<Response | AuthorizedWorkPreview> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  if (!/^[a-z0-9-]{1,128}$/i.test(workId)) return notFound();
  try {
    const scope = resolveDialogueScope(new URL(request.url).searchParams.get("persona"));
    const store = await getDialogueStore();
    const work = await store.work(scope, workId);
    return work ? { store, scope, work } : notFound();
  } catch (error) {
    return dialogueResponseError(error);
  }
}

export { notFound as workPreviewNotFound };
