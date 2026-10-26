import {
  SCREEN_CONTEXT_LIMITS,
  screenContextSchema,
  type ScreenContext,
  type ScreenCurrent,
  type ScreenEdition,
  type ScreenEvent,
  type ScreenOrigin,
} from "@/lib/chat/screen-context";

export interface RoomObservation {
  sliceId: string;
  title?: string;
  origin: ScreenOrigin;
}

export interface DocumentStateObservation {
  ref: string;
  title?: string;
  page?: number;
  totalPages?: number;
  excerpt?: string;
  edition?: ScreenEdition;
}

export interface DocumentObservation extends DocumentStateObservation {
  origin: ScreenOrigin;
}

export interface DocumentPassiveObservation extends DocumentStateObservation {
  origin?: "restored" | "observed";
}

export interface DocumentPageObservation {
  ref: string;
  title?: string;
  page: number;
  totalPages?: number;
  excerpt?: string;
  edition?: ScreenEdition;
}

export interface DocumentCloseOptions {
  origin?: "manual" | "observed";
}

export interface TaskObservation {
  ref: string;
  title?: string;
}

export interface ScreenContextTracker {
  roomEntered(input: RoomObservation): void;
  roomLeft(): void;
  routeLeft(): void;
  documentOpened(input: DocumentObservation): void;
  documentObserved(input: DocumentPassiveObservation): void;
  documentPageChanged(input: DocumentPageObservation): void;
  documentClosed(ref?: string, options?: DocumentCloseOptions): void;
  taskPanelViewed(): void;
  taskSelected(input: TaskObservation): void;
  taskPanelClosed(): void;
  getScreenContext(): ScreenContext | undefined;
  reset(): void;
}

const VALIDATION_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function optionalText(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const clipped = trimmed.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function validCurrent(current: ScreenCurrent): boolean {
  return screenContextSchema.safeParse({
    capturedAt: VALIDATION_TIMESTAMP,
    current,
    recent: [],
  }).success;
}

function validEvent(event: ScreenEvent): boolean {
  return screenContextSchema.safeParse({
    capturedAt: VALIDATION_TIMESTAMP,
    recent: [event],
  }).success;
}

function cloneFrozen<T extends object>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

function eventKey(event: ScreenEvent): string {
  switch (event.kind) {
    case "room-entered":
      return `${event.kind}:${event.sliceId}`;
    case "document-opened":
    case "document-closed":
      return `${event.kind}:${event.ref}:${event.edition ?? ""}`;
    case "task-selected":
      return `${event.kind}:${event.ref}`;
    case "document-page-changed":
      return `${event.kind}:${event.ref}:${event.edition ?? ""}:${event.page}`;
    case "task-panel-viewed":
    case "task-panel-closed":
      return event.kind;
  }
}

export function createScreenContextTracker(
  now: () => number = Date.now,
): ScreenContextTracker {
  let current: ScreenCurrent | undefined;
  let suspended: ScreenCurrent[] = [];
  let recent: ScreenEvent[] = [];

  const timestamp = (): string => new Date(now()).toISOString();
  const remember = (event: ScreenEvent): void => {
    if (!validEvent(event)) return;
    const key = eventKey(event);
    recent = [...recent.filter((candidate) => eventKey(candidate) !== key), event]
      .slice(-SCREEN_CONTEXT_LIMITS.recentEvents);
  };
  const suspend = (scene: ScreenCurrent): void => {
    suspended = [
      ...suspended.filter((candidate) => candidate.kind !== scene.kind),
      { ...scene },
    ].slice(-2);
  };
  const restoreSuspended = (): void => {
    current = suspended.pop();
  };
  const removeBackground = (kind: ScreenCurrent["kind"]): void => {
    suspended = suspended.filter((scene) => scene.kind !== kind);
  };
  const leave = (kind: ScreenCurrent["kind"]): void => {
    removeBackground(kind);
    if (current?.kind === kind) restoreSuspended();
  };
  const openDocument = (input: DocumentObservation): void => {
    const title = optionalText(input.title, SCREEN_CONTEXT_LIMITS.title);
    const excerpt = optionalText(input.excerpt, SCREEN_CONTEXT_LIMITS.excerpt);
    const page = input.page ?? 1;
    const next: ScreenCurrent = {
      kind: "document",
      ref: input.ref,
      ...(title === undefined ? {} : { title }),
      page,
      ...(input.totalPages === undefined ? {} : { totalPages: input.totalPages }),
      ...(excerpt === undefined ? {} : { excerpt }),
      ...(input.edition === undefined ? {} : { edition: input.edition }),
      origin: input.origin,
    };
    if (!validCurrent(next)) return;
    removeBackground("document");
    if (current && current.kind !== "document") suspend(current);
    current = next;
    if (input.origin === "manual") {
      remember({
        kind: "document-opened",
        at: timestamp(),
        ref: input.ref,
        ...(title === undefined ? {} : { title }),
        page,
        ...(input.totalPages === undefined ? {} : { totalPages: input.totalPages }),
        ...(input.edition === undefined ? {} : { edition: input.edition }),
      });
    }
  };

  return {
    roomEntered(input) {
      const title = optionalText(input.title, SCREEN_CONTEXT_LIMITS.title);
      const next: ScreenCurrent = {
        kind: "room",
        sliceId: input.sliceId,
        ...(title === undefined ? {} : { title }),
        origin: input.origin,
      };
      if (!validCurrent(next)) return;
      suspended = [];
      current = next;
      if (input.origin === "manual") {
        remember({
          kind: "room-entered",
          at: timestamp(),
          sliceId: input.sliceId,
          ...(title === undefined ? {} : { title }),
        });
      }
    },

    roomLeft() {
      leave("room");
    },

    routeLeft() {
      current = undefined;
      suspended = [];
    },

    documentOpened(input) {
      openDocument(input);
    },

    documentObserved(input) {
      const previous = current?.kind === "document" && current.ref === input.ref
        ? current
        : suspended.find((scene) => scene.kind === "document" && scene.ref === input.ref);
      // A reader's late settle callback can only update an existing scene.
      // It cannot reopen a closed paper or replace a foreground task panel.
      if (previous?.kind !== "document") return;
      const page = input.page ?? previous.page;
      const edition = input.edition ?? previous.edition;
      const surfaceChanged = previous.page !== page || previous.edition !== edition;
      const title = input.title === undefined
        ? previous.title
        : optionalText(input.title, SCREEN_CONTEXT_LIMITS.title);
      const excerpt = input.excerpt === undefined
        ? surfaceChanged
          ? undefined
          : previous.excerpt
        : optionalText(input.excerpt, SCREEN_CONTEXT_LIMITS.excerpt);
      const totalPages = input.totalPages ?? previous.totalPages;
      const next: ScreenCurrent = {
        kind: "document",
        ref: input.ref,
        ...(title === undefined ? {} : { title }),
        page,
        ...(totalPages === undefined ? {} : { totalPages }),
        ...(excerpt === undefined ? {} : { excerpt }),
        ...(edition === undefined ? {} : { edition }),
        origin: input.origin ?? "observed",
      };
      if (!validCurrent(next)) return;
      if (current === previous) current = next;
      else suspended = suspended.map((scene) => scene === previous ? next : scene);
    },

    documentPageChanged(input) {
      if (current?.kind !== "document" || current.ref !== input.ref) return;
      const previous = current;
      if (input.edition && previous.edition && input.edition !== previous.edition) return;
      const pageChanged = previous.page !== input.page;
      const edition = input.edition ?? previous.edition;
      const surfaceChanged = pageChanged || edition !== previous.edition;
      const title = input.title === undefined
        ? previous.title
        : optionalText(input.title, SCREEN_CONTEXT_LIMITS.title);
      const totalPages = input.totalPages ?? previous.totalPages;
      const excerpt = input.excerpt === undefined
        ? surfaceChanged
          ? undefined
          : previous.excerpt
        : optionalText(input.excerpt, SCREEN_CONTEXT_LIMITS.excerpt);
      const next: ScreenCurrent = {
        kind: "document",
        ref: previous.ref,
        ...(title === undefined ? {} : { title }),
        page: input.page,
        ...(totalPages === undefined ? {} : { totalPages }),
        ...(excerpt === undefined ? {} : { excerpt }),
        ...(edition === undefined ? {} : { edition }),
        origin: previous.origin,
      };
      if (!validCurrent(next)) return;
      current = next;
      if (!pageChanged) return;
      remember({
        kind: "document-page-changed",
        at: timestamp(),
        ref: previous.ref,
        ...(title === undefined ? {} : { title }),
        page: input.page,
        ...(totalPages === undefined ? {} : { totalPages }),
        ...(edition === undefined ? {} : { edition }),
      });
    },

    documentClosed(ref, options) {
      const visible = current?.kind === "document" && (ref === undefined || current.ref === ref)
        ? current
        : undefined;
      const background = suspended.find(
        (scene) => scene.kind === "document" && (ref === undefined || scene.ref === ref),
      );
      const closed = visible ?? (background?.kind === "document" ? background : undefined);
      if (!closed) return;
      leave("document");
      if (options?.origin === "observed") return;
      remember({
        kind: "document-closed",
        at: timestamp(),
        ref: closed.ref,
        ...(closed.edition === undefined ? {} : { edition: closed.edition }),
      });
    },

    taskPanelViewed() {
      removeBackground("task");
      if (current && current.kind !== "task") suspend(current);
      current = { kind: "task", view: "panel" };
      remember({ kind: "task-panel-viewed", at: timestamp() });
    },

    taskSelected(input) {
      const title = optionalText(input.title, SCREEN_CONTEXT_LIMITS.title);
      const next: ScreenCurrent = {
        kind: "task",
        view: "selection",
        ref: input.ref,
        ...(title === undefined ? {} : { title }),
      };
      if (!validCurrent(next)) return;
      if (current?.kind !== "task") {
        removeBackground("task");
        if (current) suspend(current);
      }
      current = next;
      remember({
        kind: "task-selected",
        at: timestamp(),
        ref: input.ref,
        ...(title === undefined ? {} : { title }),
      });
    },

    taskPanelClosed() {
      const visible = current?.kind === "task";
      const background = suspended.some((scene) => scene.kind === "task");
      if (!visible && !background) return;
      leave("task");
      remember({ kind: "task-panel-closed", at: timestamp() });
    },

    getScreenContext() {
      if (!current && recent.length === 0) return undefined;
      const snapshot: ScreenContext = {
        capturedAt: timestamp(),
        ...(current ? { current: cloneFrozen(current) } : {}),
        recent: Object.freeze(recent.map((event) => cloneFrozen(event))) as ScreenEvent[],
      };
      if (!screenContextSchema.safeParse(snapshot).success) return undefined;
      return Object.freeze(snapshot);
    },

    reset() {
      current = undefined;
      suspended = [];
      recent = [];
    },
  };
}
