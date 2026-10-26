/**
 * startTurn — the single entry point that fires a durable chat-turn run.
 *
 * The POST /api/chat route converges here. All the request-scoped derivation
 * that needs real Date / config I/O / message conversion (which the
 * deterministic workflow body must NOT do) lives here, in the route layer: load
 * config, resolve model + thinking, convert messages, extract the last user
 * text, stamp the start time. The result is a fully serializable `TurnInput`
 * passed by value into `start(turnWorkflow, …)`.
 *
 * Returns the run so the route can stream `run.readable` back to the client and
 * expose `run.runId` (the reconnect handle) in a response header.
 */
import { start } from "workflow/api";
import crypto from "crypto";
import { convertToModelMessages } from "@/lib/chat/server-stream";
import { type UIMessage } from "@/lib/chat/protocol";
import { turnWorkflow } from "./turn-workflow";
import type { TurnInput } from "@/lib/chat/turn-types";
import {
  parseCurrentView,
  type CurrentView,
} from "@/lib/chat/current-view";
import { loadUserConfig } from "@/lib/config/loader";
import { FIXED_MODEL } from "@/lib/models/registry";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { withGitHubReadBudget } from "@/lib/github/client";
import { screenContextSchema, type ScreenContext } from "@/lib/chat/screen-context";

export interface StartTurnArgs {
  /** Raw UI messages from the client. */
  messages: UIMessage[];
  /** Optional model override; falls back to the user config default. */
  model?: string;
  /** Ignored — thinking is pinned ON server-side (see below). */
  thinking?: boolean;
  /** Ignored — effort is pinned to "high" server-side (see below). */
  effort?: "low" | "medium" | "high";
  /** Client-reported timezone, used when minting a new slice. */
  timezone?: string;
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale?: string;
  /** True on the client regenerate action (SDK trigger "regenerate-message") —
   *  the turn re-runs the previous user message; see TurnInput.regenerate. */
  regenerate?: boolean;
  /** Optional engine-built machine context block (v0.11 §13 — the game
   *  client's visit log). Free text; sanitized + capped server-side, omitted
   *  from TurnInput when absent. */
  machineContext?: string;
  /** The client's current view (v0.13 §5 视野注入) — structured field from
   *  the chat transport; shape-validated + sliceId-checked server-side,
   *  omitted from TurnInput when absent (the lobby default). */
  view?: unknown;
  /** Client-reported app activity, separate from user speech and authorization. */
  screen?: unknown;
  /**
   * The parallel-burst id (v0.38 §2) — the client mints ONE ULID per 连发
   * and stamps every message of the burst with it. Optional: absent
   * (legacy clients, regenerate) falls back to the time-window overlap
   * heuristic at the merge decision. Attribute values: strings ≤256B.
   */
  burstId?: string;
}

/** Extract the latest user message text from raw UI messages. */
function extractLastUserText(msg: UIMessage | undefined): string {
  if (!msg) return "";
  const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (Array.isArray(parts)) {
    const textPart = parts.find(
      (p) => p.type === "text" && typeof p.text === "string"
    );
    if (textPart?.text) return textPart.text;
  }
  const content = (msg as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

/** Max image attachments extracted per turn when the main model lacks vision. */
const MAX_IMAGE_ATTACHMENTS = 4;

/**
 * Upper bound for the optional machine context block (v0.11 §13). A visit log
 * is a few hundred characters by construction (visit-log.ts caps its own
 * trail); this is the safety valve against a misbehaving client, in the same
 * spirit as MAX_HISTORY_MESSAGES.
 */
export const MAX_MACHINE_CONTEXT_CHARS = 2000;

/**
 * Sanitize the optional machine context block: trim, drop when empty, cap.
 * Pure. Returns undefined when nothing usable was sent, so the TurnInput
 * field is OMITTED and the turn stays byte-identical to a plain chat turn.
 */
export function sanitizeMachineContext(
  raw: string | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // A mid-string cut can split the block's closing fence — acceptable: the
  // workflow's own injection section closes the context regardless.
  return trimmed.slice(0, MAX_MACHINE_CONTEXT_CHARS);
}

/**
 * Validate the client's current view (v0.13 §5 视野注入) — a STRUCTURED
 * field, never text. Strict shape check + a parseSliceId-strict slice id:
 * a malformed id can be neither rendered nor described, so the whole field
 * drops (the turn then carries no block, exactly like the lobby default).
 * Pure. Returns undefined when nothing usable was sent, so the TurnInput
 * field is OMITTED and the turn stays byte-identical to a plain chat turn.
 */
export function sanitizeView(raw: unknown): CurrentView | undefined {
  try {
    return parseCurrentView(raw);
  } catch {
    return undefined;
  }
}

export function sanitizeScreen(raw: unknown): ScreenContext | undefined {
  const parsed = screenContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * For non-vision main models: extract image file parts into a per-turn
 * attachments array and replace each stripped image with a text placeholder
 * telling the model to call `viewImage`. Non-image file parts are dropped.
 *
 * The data URLs ride the workflow step boundary via ToolContext.imageAttachments,
 * so viewImage can resolve `attachment:N`. They are capped to keep the payload
 * bounded (client-side 1568px compression + a 4-image count cap).
 */
export function extractImageAttachments(
  messages: UIMessage[],
  locale: string,
): { messages: UIMessage[]; attachments: string[] } {
  const attachments: string[] = [];
  const placeholder = (idx: number) =>
    locale === "zh"
      ? `[用户附带了一张图片（附件 #${idx}）。你当前无法直接查看图片——调用 viewImage，source 填 "attachment:${idx}"，question 描述你想知道什么。]`
      : `[The user attached an image (attachment #${idx}). You cannot see it directly right now — call viewImage with source "attachment:${idx}" and use question to say what you want to know.]`;

  const out = messages
    .map((m) => {
      if (m.role !== "user" || attachments.length >= MAX_IMAGE_ATTACHMENTS) {
        return m;
      }
      const newParts: UIMessage["parts"] = [];
      for (const p of m.parts ?? []) {
        if (p.type !== "file") {
          newParts.push(p);
          continue;
        }
        const mediaType = (p as { mediaType?: string }).mediaType ?? "";
        const url = (p as { url?: string }).url ?? "";
        if (
          !mediaType.startsWith("image/") ||
          attachments.length >= MAX_IMAGE_ATTACHMENTS ||
          !url
        ) {
          // Drop non-image files and excess/unloadable images.
          continue;
        }
        const idx = attachments.length;
        attachments.push(url);
        newParts.push({ type: "text", text: placeholder(idx) });
      }
      return { ...m, parts: newParts };
    })
    .filter((m) => (m.parts ?? []).length > 0);

  return { messages: out, attachments };
}

/**
 * Summarize a converted ModelMessage's content as plain text for recentTurns.
 * NEVER JSON.stringify array content here: file/image parts carry base64 data
 * URLs, which would embed megabytes into the prompt context. Text parts keep
 * their text; file parts become [image]/[file]; everything else (tool-call,
 * tool-result, …) collapses to a short [type] placeholder.
 */
export function summarizeModelContent(
  content: unknown,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string; mediaType?: string };
      if (p.type === "text") return p.text ?? "";
      if (p.type === "file" || p.type === "image") {
        return p.mediaType?.startsWith("image/") ? "[image]" : "[file]";
      }
      return `[${p.type ?? "part"}]`;
    })
    .join("\n");
}

export async function startTurn(
  args: StartTurnArgs
): Promise<Awaited<ReturnType<typeof start>>> {
  // Bounded by the shared GitHub read budget: a degraded API fails the POST
  // fast instead of hanging it to the platform's wall-clock limit.
  const config = await withGitHubReadBudget(() => loadUserConfig());
  // Demo mode: model + thinking intensity are pinned server-side (the demo
  // runs on the maintainer's key) — client/config preferences are ignored.
  const modelConfig = FIXED_MODEL;
  const model = FIXED_MODEL.id;
  const thinking = true;
  const reasoningEffort = "high";
  const clientTimezone = args.timezone ?? "UTC";
  // UI locale for relative-time annotations — only zh/en are supported; any
  // other value (or none) falls back to English.
  const locale = args.locale === "zh" ? "zh" : "en";
  const { owner, repo } = getRepoConfig();
  const dataSource = resolveDataSource();

  // Generate turn identity early — shared by user turn, agent turn, and
  // agent.md cognition record. 4 random bytes → 6-char base64url, unique
  // within a slice (and collision probability across 2^32 ≈ 4.3B values is
  // negligible for a time slice's lifetime).
  const turnId = crypto.randomBytes(4).toString("base64url");

  // The full client history goes to the WORKFLOW — the slice-aligned window
  // is cut there (sliceAlignedWindow in turn-workflow.ts, v0.9 Phase 1.4).
  // This is only a broad payload cap guarding against a misbehaving client.
  const MAX_HISTORY_MESSAGES = 200;
  let inbound = args.messages;
  let imageAttachments: string[] = [];
  if (!modelConfig.capabilities.vision) {
    const hasImageFiles = args.messages.some((m) =>
      (m.parts ?? []).some(
        (p) => p.type === "file" && (p as { mediaType?: string }).mediaType?.startsWith("image/"),
      ),
    );
    if (hasImageFiles) {
      console.warn(`[Turn] model=${model} has no vision — extracting image attachments`);
      const extracted = extractImageAttachments(args.messages, locale);
      inbound = extracted.messages;
      imageAttachments = extracted.attachments;
    }
  }
  const fullMessages = await convertToModelMessages(inbound);
  const cappedMessages = fullMessages.slice(-MAX_HISTORY_MESSAGES);
  // Never begin a provider request with an orphaned tool result.
  const firstUser = cappedMessages.findIndex(message => message.role === "user");
  const modelMessages = firstUser >= 0 ? cappedMessages.slice(firstUser) : [];
  const recentTurns = modelMessages.map((m) => ({
    role: m.role as string,
    // Array content must be summarized, not stringified — see
    // summarizeModelContent (base64 leak).
    content: summarizeModelContent(m.content),
  }));

  const userMessages = inbound.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserMessage = extractLastUserText(lastUser);
  // The client's own UIMessage id for the answered message — the orchestrator
  // (v0.31) stamps it as the first bubble's anchorId (see TurnInput).
  const clientMessageId =
    lastUser && typeof lastUser.id === "string" && lastUser.id
      ? lastUser.id
      : undefined;

  // Optional machine context block (v0.11 §13) — sanitized once here so the
  // field is OMITTED from TurnInput when the client sent none (a plain chat
  // turn's input stays unchanged).
  const machineContext = sanitizeMachineContext(args.machineContext);

  // Optional current view (v0.13 §5 视野注入) — validated once here so the
  // field is OMITTED from TurnInput when the client sent none or a malformed
  // one (the lobby default carries no per-turn block).
  const view = sanitizeView(args.view);
  const screen = sanitizeScreen(args.screen);

  const input: TurnInput = {
    modelMessages,
    recentTurns,
    lastUserMessage,
    model,
    modelConfig,
    thinking,
    reasoningEffort,
    clientTimezone,
    locale,
    config,
    owner,
    repo,
    useGithub: dataSource === "github",
    useDemo: dataSource === "demo",
    startedAtIso: new Date().toISOString(),
    turnId,
    imageAttachments,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(args.regenerate === true ? { regenerate: true } : {}),
    ...(machineContext ? { machineContext } : {}),
    ...(view ? { view } : {}),
    ...(screen ? { screen } : {}),
    ...(args.burstId ? { burstId: args.burstId } : {}),
  };

  // Pin the run to Hong Kong. The run's state, queue dispatch and streams live
  // in this region for the run's whole lifetime — Workflow locks a run's region
  // at creation and never migrates it. This is the workflow half of the region
  // move; the functions themselves have to be deployed to hkg1 as well (Vercel
  // project settings), because `region` only decides where the DATA lives, not
  // where steps execute. Region-local execution needs both.
  //
  // This is the whole reason for the Workflow 5 upgrade: 4.x had no such
  // option and always stored runs in iad1, which is exactly the cross-region
  // layout the maintainers list as slow.
  const run = await start(turnWorkflow, [input], {
    region: "hkg1",
    // v0.38 §2 — the burst id is a START attribute (registry-visible at
    // creation, the spike-verified shape): batch membership is enumerable
    // from the registry while the burst lives, and from the record (the
    // writer's [burst {id}] turn header) ever after.
    // v0.43 — `role`/`turn` ride the SAME start call: the workflow panel
    // groups live runs by role, and attributes stamped inside a step arrive
    // too late to be seen (observed: a 15s turn was already finishing when
    // its role first appeared).
    attributes: {
      role: "turn",
      turn: input.turnId,
      ...(input.burstId ? { burst: input.burstId } : {}),
    },
  });

  return run;
}
