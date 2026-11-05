/**
 * Dialogue outbox entry points. The context-free sweep is shared by request
 * after() callbacks, Workflow steps, the recovery cron and the local interval.
 * Serverless deployments never start an in-process scheduler.
 */
import { dispatchDialogueStore } from "@/lib/dialogue/dispatch";
import { DialogueUnavailable, getDialogueStore, sharedDialogueRuntime } from "@/lib/dialogue/runtime";
import { serverDialogueRunner } from "./runner";

const TICK_MS = 1_000;

let host: { stop(): void } | null | undefined;

export interface DialogueDispatchOptions {
  scopeLimit?: number;
  jobsPerScope?: number;
}

/**
 * Run one bounded sweep of already-persisted due scopes. This is plain Node
 * code: it reads no request context and calls no Next request APIs, so a route
 * may pass it to `after(() => dispatchDialogueDueScopes())`, while a Workflow
 * step may directly `await dispatchDialogueDueScopes()` after a durable write.
 * The caller chooses the appropriate execution context; this function never
 * starts a timer or a resident service. Store leases/CAS remain the only
 * concurrency control when independent callers overlap.
 */
export async function dispatchDialogueDueScopes(
  options: DialogueDispatchOptions = {},
): Promise<{ scopes: number; ran: number; failed: number }> {
  const store = await getDialogueStore();
  return dispatchDialogueStore(store, serverDialogueRunner, console, options);
}

export function ensureDialogueDispatch(): void {
  if (host !== undefined) return;
  host = null;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (sharedDialogueRuntime()) return;
  let stopped = false;
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await dispatchDialogueDueScopes();
    } catch (error) {
      if (error instanceof DialogueUnavailable) {
        stopped = true; // demo/read-only deployment — nothing to dispatch
      } else {
        console.warn(
          "[Dialogue] dispatch tick failed (ignored):",
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  host = {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
  void tick();
}
