import { IMAGE_ATTACHMENT_LIMITS, type ImageAttachmentSnapshot } from "./image-attachments";

export const IMAGE_INPUT_MAX_BYTES = 10 * 1024 * 1024;

export interface DraftImage {
  readonly localClientId: string;
  readonly ordinal: number;
  readonly file: File;
  readonly status: "preparing" | "uploading" | "ready" | "error";
  readonly attachment?: Readonly<ImageAttachmentSnapshot>;
  readonly error?: string;
}

interface DraftImageState {
  readonly images: readonly DraftImage[];
  readonly removed: DraftImage | null;
  readonly limitReached: boolean;
}

/** Own async image work outside render. A response can update only the exact
 * operation that started it; late successful uploads are cancelled, not shown. */
export function createImageAttachmentDraft(deps: {
  prepare: (file: File) => Promise<File>;
  upload: (file: File, signal: AbortSignal) => Promise<ImageAttachmentSnapshot>;
  cancel: (assetId: string) => Promise<void>;
  mintId: () => string;
}) {
  let state: DraftImageState = { images: [], removed: null, limitReached: false };
  let nextOrdinal = 1;
  const operations = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const publish = (next: DraftImageState) => {
    state = Object.freeze({ ...next, images: Object.freeze(next.images) });
    for (const listener of listeners) listener();
  };
  const cancel = (assetId: string) => { void deps.cancel(assetId).catch(() => {}); };
  const update = (id: string, patch: Partial<DraftImage>) => publish({ ...state,
    images: state.images.map(image => image.localClientId === id ? Object.freeze({ ...image, ...patch }) : image) });
  const start = async (image: DraftImage) => {
    const operation = new AbortController();
    operations.set(image.localClientId, operation);
    const current = () => operations.get(image.localClientId) === operation && !operation.signal.aborted;
    try {
      if (image.file.size > IMAGE_INPUT_MAX_BYTES) throw new Error("original-too-large");
      const file = await deps.prepare(image.file);
      if (!current()) return;
      if (file.size > IMAGE_ATTACHMENT_LIMITS.maxBytes) throw new Error("too-large");
      update(image.localClientId, { status: "uploading" });
      const attachment = await deps.upload(file, operation.signal);
      if (!current()) { cancel(attachment.assetId); return; }
      update(image.localClientId, { status: "ready", attachment: Object.freeze({ ...attachment, ordinal: image.ordinal }), error: undefined });
    } catch (error) {
      if (current()) update(image.localClientId, { status: "error", error: error instanceof Error ? error.message : "upload-failed" });
    } finally {
      if (operations.get(image.localClientId) === operation) operations.delete(image.localClientId);
    }
  };
  const stop = (image: DraftImage) => {
    operations.get(image.localClientId)?.abort();
    operations.delete(image.localClientId);
    if (image.attachment) cancel(image.attachment.assetId);
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    add(files: readonly File[]): readonly DraftImage[] {
      const imageFiles = files.filter(file => file.type.startsWith("image/"));
      const count = Math.max(0, IMAGE_ATTACHMENT_LIMITS.maxPerTurn - state.images.length);
      const added = imageFiles.slice(0, count).filter(() => nextOrdinal <= IMAGE_ATTACHMENT_LIMITS.maxOrdinal)
        .map(file => Object.freeze({ localClientId: deps.mintId(), ordinal: nextOrdinal++, file, status: "preparing" as const }));
      publish({ ...state, images: [...state.images, ...added], limitReached: added.length !== imageFiles.length });
      for (const image of added) void start(image);
      return added;
    },
    retry(id: string) {
      const image = state.images.find(image => image.localClientId === id);
      if (!image || image.status !== "error") return;
      update(id, { status: "preparing", error: undefined });
      void start(image);
    },
    remove(id: string) {
      const image = state.images.find(image => image.localClientId === id);
      if (!image) return;
      stop(image);
      publish({ images: state.images.filter(item => item !== image), removed: image, limitReached: false });
    },
    undo() {
      if (!state.removed) return;
      if (state.images.length >= IMAGE_ATTACHMENT_LIMITS.maxPerTurn) { publish({ ...state, limitReached: true }); return; }
      const image: DraftImage = Object.freeze({ localClientId: state.removed.localClientId, ordinal: state.removed.ordinal, file: state.removed.file, status: "preparing" });
      publish({ images: [...state.images, image].sort((a, b) => a.ordinal - b.ordinal), removed: null, limitReached: false });
      void start(image);
    },
    /** Transfer only this frozen set. A newly added/retried image remains in
     * the next draft; accepted assets must never be cancelled on cleanup. */
    accept(submitted: readonly DraftImage[]) {
      const images = state.images.filter(image => !submitted.some(sent => sent.attachment && sent.localClientId === image.localClientId && sent.attachment.assetId === image.attachment?.assetId));
      const removed = state.removed && submitted.some(sent => sent.localClientId === state.removed?.localClientId && sent.attachment?.assetId === state.removed?.attachment?.assetId)
        ? null : state.removed;
      publish({ images, removed, limitReached: false });
      if (!images.length && !removed) nextOrdinal = 1;
    },
    dispose() {
      for (const image of state.images) stop(image);
      // No permanent disposed flag: React's development effect replay may
      // release an initially empty controller and then reuse it.
    },
  };
}
