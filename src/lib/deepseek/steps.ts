import { requestDeepSeek, recoverPartialResponse } from "./http";
import type { ModelCallStreamPart, ModelRequest, ModelResponse } from "./types";

/** No provider class or credential is serialized into the durable event log. */
export async function callModelStep(request: ModelRequest, writable?: WritableStream<ModelCallStreamPart>): Promise<ModelResponse> {
  "use step";
  const writer = writable?.getWriter();
  try {
    await writer?.write({ type: "start-step" });
    return await requestDeepSeek(request, async (part) => { await writer?.write(part); }).catch(recoverPartialResponse);
  } finally { writer?.releaseLock(); }
}
// HTTP dispatch owns bounded pre-response retries. Retrying this durable step
// after it emitted output would bill again and append duplicate stream text.
callModelStep.maxRetries = 0;

export async function writeAgentEventStep(event: ModelCallStreamPart, writable?: WritableStream<ModelCallStreamPart>): Promise<void> {
  "use step";
  if (!writable) return;
  const writer = writable.getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}

export async function closeAgentStreamStep(writable?: WritableStream<ModelCallStreamPart>): Promise<void> {
  "use step";
  await writable?.close();
}
