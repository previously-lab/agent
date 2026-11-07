"use server";

import { getArrivalState, getSlicePageWithContent, type ArrivalState, type SliceWithContent } from "./actions";

export interface ConversationWindow {
  arrival: ArrivalState;
  previous: SliceWithContent[];
}

/** The chat reads exactly one preceding record, plus the resumable current
 * conversation. Older records are opened in the document library. Both parts
 * arrive together so history cannot repeatedly prepend itself on first load. */
export async function getConversationWindow(persona?: string): Promise<ConversationWindow> {
  const arrival = await getArrivalState(persona);
  const page = await getSlicePageWithContent(arrival.mode === "resume" ? arrival.sliceId : null, 1, persona);
  return { arrival, previous: page.slices };
}
