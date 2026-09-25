/**
 * The client's current view (v0.13 §5 视野注入) — the shared contract for the
 * `view` request field on POST /api/chat.
 *
 * TYPE-ONLY MODULE: everything here is erased at compile time, so both the
 * client (app-shell/chat-page) and the API layer can import it without
 * pulling runtime code across the wire boundary.
 *
 * The shell owns the navigation cursor (the shared slice address, the settled
 * world, the rung); at SEND time it derives what the reader is currently
 * looking at and the chat transport rides it as a STRUCTURED FIELD — never as
 * text. Two surfaces exist:
 *
 *   room — the reader stands at the slice's door in the hotel (view = game);
 *   card — the reader looks at the slice's card (view = field, slice rung).
 *
 * THE LOBBY (nothing selected, a pile rung, the conversation rung) sends NO
 * view at all: the stable system prompt already states the default, so a
 * missing field needs no explanation and the turn stays byte-identical to a
 * plain chat turn.
 */
export interface CurrentView {
  /** The addressed slice, "yyyy-mm-dd-hhmm" (parseSliceId-strict). */
  sliceId: string;
  /** Which surface the slice is being viewed on — room or card. */
  surface: "room" | "card";
}
