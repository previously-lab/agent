import {
  formatDocumentLink,
  parseCanonicalDocumentRef,
  parseDocumentLink,
  type DocumentLinkLocation,
} from "@/lib/documents/document-link";

export type ConversationPanelMode = "pill" | "fullscreen";
export type WorkspaceSurface = "conversation" | "library" | "reader" | "game" | "utility";
export type ConversationIntent = "send" | "jump" | "explicit";
export type DeskOpenOptions = DocumentLinkLocation;

export interface WorkspaceDocumentTarget {
  ref: string;
  options: DeskOpenOptions;
}

export interface DeskNavigationState {
  epoch: number;
  focus: boolean;
}

export function reduceDeskNavigation(
  current: DeskNavigationState,
  focus: boolean,
): DeskNavigationState {
  return focus
    ? { epoch: current.epoch + 1, focus: true }
    : { epoch: current.epoch, focus: false };
}

export function shouldFocusSyncedDocument(pending: boolean, restoring: boolean): boolean {
  return pending || !restoring;
}

export const DESK_HISTORY_KEY = "__previouslyWorkspaceDesk";
export const PANEL_MODE_HISTORY_KEY = "__previouslyWorkspacePanel";

export function isWorkspaceDocumentRef(ref: string): boolean {
  return parseCanonicalDocumentRef(ref) !== null;
}

export function normalizeDeskOpenOptions(
  options: DeskOpenOptions | undefined,
): DeskOpenOptions | null {
  const formatted = formatDocumentLink("dossier/previously", options ?? {});
  const parsed = formatted ? parseDocumentLink(formatted) : null;
  if (!parsed) return null;
  return {
    ...(parsed.turnId === undefined ? {} : { turnId: parsed.turnId }),
    ...(parsed.role === undefined ? {} : { role: parsed.role }),
    ...(parsed.edition === undefined ? {} : { edition: parsed.edition }),
  };
}

export function deskOptionsEqual(a: DeskOpenOptions, b: DeskOpenOptions): boolean {
  return a.turnId === b.turnId && a.role === b.role && a.edition === b.edition;
}

export function deskTargetEqual(
  a: WorkspaceDocumentTarget | null,
  b: WorkspaceDocumentTarget | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.ref === b.ref && deskOptionsEqual(a.options, b.options);
}

export function workspaceDocumentTarget(
  ref: string,
  options?: DeskOpenOptions,
): WorkspaceDocumentTarget | null {
  const canonical = parseCanonicalDocumentRef(ref);
  if (!canonical) return null;
  const normalized = normalizeDeskOpenOptions(options);
  return normalized === null ? null : { ref: canonical, options: normalized };
}

export function parseWorkspaceDocumentTarget(search: string): WorkspaceDocumentTarget | null {
  const params = new URLSearchParams(search);
  if (["doc", "turn", "role", "edition"].some((key) => params.getAll(key).length > 1)) {
    return null;
  }
  const ref = params.get("doc");
  if (ref === null) return null;
  const turnId = params.get("turn") ?? undefined;
  const role = params.get("role") ?? undefined;
  const edition = params.get("edition") ?? undefined;
  return workspaceDocumentTarget(ref, {
    ...(turnId === undefined ? {} : { turnId }),
    ...(role === undefined ? {} : { role: role as DeskOpenOptions["role"] }),
    ...(edition === undefined ? {} : { edition: edition as DeskOpenOptions["edition"] }),
  });
}

function retainedParams(search: string): URLSearchParams {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const persona = current.get("persona");
  if (persona) next.set("persona", persona);
  return next;
}

function hrefWithParams(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function buildDocumentHref(target: WorkspaceDocumentTarget, search = ""): string {
  const params = retainedParams(search);
  params.set("doc", target.ref);
  if (target.options.turnId) params.set("turn", target.options.turnId);
  if (target.options.role) params.set("role", target.options.role);
  if (target.options.edition) params.set("edition", target.options.edition);
  return hrefWithParams("/app", params);
}

export function buildLibraryHref(search = "", history = false): string {
  const params = retainedParams(search);
  params.set("view", "field");
  if (history) params.set("history", "1");
  return hrefWithParams("/app", params);
}

export function buildConversationHref(search = ""): string {
  return hrefWithParams("/app", retainedParams(search));
}

export function buildGameHref(search = ""): string {
  return hrefWithParams("/game", retainedParams(search));
}

export function workspaceSurface(pathname: string, search = ""): WorkspaceSurface {
  if (pathname === "/game") return "game";
  if (pathname !== "/app") return "utility";
  const params = new URLSearchParams(search);
  if (params.get("view") === "game") return "game";
  if (parseWorkspaceDocumentTarget(search)) return "reader";
  if (params.has("doc") || params.get("view") === "field" || params.get("history") === "1") {
    return "library";
  }
  return "conversation";
}

export function panelModeForSurface(surface: WorkspaceSurface): ConversationPanelMode {
  return surface === "conversation" ? "fullscreen" : "pill";
}

export function requestedPanelMode(
  surface: WorkspaceSurface,
  current: ConversationPanelMode,
  requested: ConversationPanelMode,
  intent: ConversationIntent,
): ConversationPanelMode {
  if (intent === "explicit" || intent === "jump" || requested === "pill") return requested;
  return surface === "conversation" ? requested : current;
}

interface DeskHistoryMarker {
  version: 1;
  target: string;
}

export function markDeskHistoryState<T>(state: T, target: string): T {
  const previous = state && typeof state === "object" ? state : {};
  return {
    ...previous,
    [DESK_HISTORY_KEY]: { version: 1, target } satisfies DeskHistoryMarker,
  } as T;
}

export function markOriginPanelMode<T>(
  state: T,
  mode: ConversationPanelMode,
): T {
  const previous = state && typeof state === "object" ? state : {};
  return { ...previous, [PANEL_MODE_HISTORY_KEY]: mode } as T;
}

export function deskHistoryOwnsTarget(state: unknown, target: string): boolean {
  if (!state || typeof state !== "object") return false;
  const marker = (state as Record<string, unknown>)[DESK_HISTORY_KEY];
  if (!marker || typeof marker !== "object") return false;
  const value = marker as Partial<DeskHistoryMarker>;
  return value.version === 1 && value.target === target;
}

export function originPanelModeFromHistory(state: unknown): ConversationPanelMode | null {
  if (!state || typeof state !== "object") return null;
  const mode = (state as Record<string, unknown>)[PANEL_MODE_HISTORY_KEY];
  return mode === "pill" || mode === "fullscreen" ? mode : null;
}

export function hasHistoryEntrance(items: readonly { kind: string }[]): boolean {
  return items.some((item) => item.kind === "seam" || item.kind === "history-turn");
}
