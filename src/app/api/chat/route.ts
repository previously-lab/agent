/**
 * POST /api/chat — durable chat turn.
 *
 * Every turn now runs inside a Vercel Workflow run (see ./turn-workflow). This
 * handler is intentionally thin: parse + validate the request, hand off to
 * `startTurn` (which builds the serializable input and starts the run), and
 * stream the run's output back. The run id is exposed in the
 * `x-workflow-run-id` header so a disconnected client can reconnect later
 * (Phase 2). All memory I/O happens inside the run's steps, writing to GitHub —
 * the Workflow holds only ephemeral execution state.
 */
import { createUIMessageStreamResponse } from "@/lib/chat/server-stream";
import { type UIMessage } from "@/lib/chat/protocol";
import { startTurn } from "./start-turn";
import { createMixedStreamTransform } from "./mixed-stream-transform";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { guardRequest } from "@/lib/security/origin-guard";
import { reserveStagedImages, type ImageReservation } from "@/lib/tools/staged-images";
import { legacyMessageImages, withVerifiedImages } from "@/lib/tools/chat-image-input";
import { ImageAttachmentError } from "@/lib/tools/image-validation";

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  let reservation: ImageReservation | undefined;
  let accepted = false;
  try {
    const body = (await request.json()) as {
      messages?: unknown;
      model?: unknown;
      timezone?: unknown;
      locale?: unknown;
      regenerate?: unknown;
      machineContext?: unknown;
      view?: unknown;
      screen?: unknown;
      documentContext?: unknown;
      burstId?: unknown;
      stagedAttachments?: unknown;
      persona?: unknown;
    };

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages array is required and must not be empty" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Older clients used content instead of parts. Preserve the text-only
    // wire shape deliberately, without accepting malformed explicit parts or
    // inventing client identity (legacy regeneration relies on its absence).
    const normalizedMessages = messages.map((message) => message && typeof message === "object"
      && message.parts === undefined && typeof message.content === "string"
      ? { ...message, parts: [{ type: "text", text: message.content }] }
      : message);
    if (normalizedMessages.some((message) => !message || !["user", "assistant", "system"].includes(message.role)
      || !Array.isArray(message.parts) || message.parts.some((part: unknown) => !part || typeof part !== "object"))) {
      return Response.json({ error: "Invalid message structure" }, { status: 400 });
    }
    const typedMessages = normalizedMessages as UIMessage[];
    const latestUser = typedMessages.findLast((message) => message.role === "user");
    if (!latestUser) return Response.json({ error: "A user message is required" }, { status: 400 });
    const legacyImages = body.stagedAttachments === undefined ? legacyMessageImages(typedMessages) : [];
    reservation = await reserveStagedImages(body.stagedAttachments, latestUser.id, body.persona);
    const verifiedImages = [...reservation.attachments, ...legacyImages];

    const run = await startTurn({
      messages: withVerifiedImages(typedMessages, verifiedImages),
      originalUserText: latestUser.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      ...(verifiedImages.length ? { verifiedImages } : {}),
      model: typeof body.model === "string" ? body.model : undefined,
      // thinking/effort are deliberately NOT read from the body — startTurn
      // pins thinking ON at low effort server-side (demo lock wins).
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      locale:
        typeof body.locale === "string" &&
        ["en", "zh"].includes(body.locale)
          ? body.locale
          : undefined,
      regenerate: body.regenerate === true,
      // Optional engine-built machine context (v0.11 §13) — same optional-string
      // style as timezone; sanitized + capped in startTurn, omitted when absent.
      machineContext:
        typeof body.machineContext === "string"
          ? body.machineContext
          : undefined,
      // Optional current view (v0.13 §5 视野注入) — the structured field the
      // chat transport sends when a slice is selected; shape-validated in
      // startTurn, omitted when absent (the lobby default).
      view: body.view,
      screen: body.screen,
      documentContext: body.documentContext,
      // Optional parallel-burst id (v0.38 §2) — the client's ULID for a
      // 连发; becomes a start attribute (`burst`) and the writer's
      // [burst {id}] turn header. Absent = overlap-heuristic fallback.
      burstId: typeof body.burstId === "string" ? body.burstId : undefined,
    });
    accepted = true;
    // The workflow already owns the verified bytes. Never roll its reservation
    // back after acceptance, even if sending this HTTP response fails.
    await reservation.confirm().catch((error) => console.error("[Images] accepted turn confirmation needs recovery", { runId: run.runId, error }));

    return createUIMessageStreamResponse({
      stream: run.readable.pipeThrough(createMixedStreamTransform()),
      headers: { "x-workflow-run-id": run.runId },
    });
  } catch (error) {
    if (!accepted) await reservation?.release().catch((cleanupError) => console.error("[Images] reservation rollback needs recovery", cleanupError));
    if (error instanceof ImageAttachmentError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) {
      return new Response(JSON.stringify({ error: "Invalid JSON in request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (error instanceof Error && error.message.includes("environment variables")) {
      console.error("[chat] Configuration error:", error.message);
      return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    // v0.8: full diagnostic trail for anything the request handler didn't
    // handle (startTurn failures, workflow-start errors, stream-setup throws).
    console.error("[chat] POST /api/chat unhandled:", formatErrorDetail(error));
    throw error;
  }
}
