/**
 * POST /api/companion — the mouth (design v0.11 §5).
 *
 * The product's second stream: given a slice id, stream a warm retrospective
 * narration about that time slice, as if Previously were sitting next to the
 * user re-watching their past together. Deliberately NOT a durable workflow —
 * plain AI SDK streamText, ephemeral, read-only; an interrupted narration
 * just restarts.
 *
 * Contract (frozen — the client is built against it):
 *   body:  { sliceId: string, event: "narrate", locale?: "zh" | "en", timezone?: string }
 *   200:   text/plain; charset=utf-8 stream. Clean close WITHOUT a terminal
 *          marker = complete narration. Genuine provider errors append a terminal marker.
 *   400:   { error } — invalid JSON body / unknown event / bad sliceId format
 *   403:   { error } — origin guard (see src/lib/security/origin-guard.ts)
 *   501:   { error } — the resolved model is the bridge brain (no tool calls)
 */
import { z } from "zod";
import { guardRequest } from "@/lib/security/origin-guard";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import { narrateSlice } from "./narrate";

const companionRequestSchema = z.object({
  sliceId: z.string(),
  event: z.literal("narrate"),
  locale: z.enum(["zh", "en"]).optional(),
  timezone: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = companionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Strict slice-id validation BEFORE any memory read.
  const { sliceId, locale, timezone } = parsed.data;
  if (!parseSliceId(sliceId)) {
    return Response.json(
      { error: "Invalid sliceId — expected YYYY-MM-DD-HHMM" },
      { status: 400 },
    );
  }

  try {
    return await narrateSlice({ sliceId, locale, timezone }, { signal: request.signal });
  } catch (error) {
    console.error(
      "[companion] POST /api/companion:",
      error instanceof Error ? error.message : error,
    );
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
