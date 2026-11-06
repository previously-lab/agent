/**
 * GET /api/chat/dialogue?persona=&after= — the manuscript page.
 *
 * The client polls this independently of every work attempt: the accepted
 * input log, work/result states, committed publications and the expression
 * lease state all ride one cursor (`after`). A read is never blocked by a
 * running or dead research/expression run — the control store is the
 * recovery surface.
 */
import { getDialogueStore, guardDialogueRead, dialogueResponseError, resolveDialogueScope } from "@/lib/dialogue/runtime";

export async function GET(request: Request): Promise<Response> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  const url = new URL(request.url);
  const persona = url.searchParams.get("persona");
  const rawAfter = Number(url.searchParams.get("after") ?? "0");
  const after = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  try {
    const store = await getDialogueStore();
    const page = await store.page(resolveDialogueScope(persona), after, 100);
    return Response.json(page);
  } catch (error) {
    return dialogueResponseError(error);
  }
}
