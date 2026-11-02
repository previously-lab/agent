import { composerEnterIntent, type ComposerEnterBehavior } from "@/lib/chat/composer-keyboard";
import { isImeKeyboardEvent } from "@/lib/chat/document-mentions";
import { atomicDeletion, createManuscriptHistory, manuscriptAtoms, manuscriptSelection, replaceManuscriptRange,
  type ManuscriptBinding, type ManuscriptSelection, type ManuscriptSnapshot } from "./manuscript-editor-model";
import { readManuscriptDOM, readManuscriptSelection, renderManuscriptDOM, writeManuscriptSelection } from "./manuscript-editor-dom";

export interface ManuscriptControllerOptions {
  value: string;
  scope: string;
  bindings: readonly ManuscriptBinding[];
  enterBehavior?: ComposerEnterBehavior;
  onChange(text: string, selection: ManuscriptSelection): void;
  onSelectionChange?(selection: ManuscriptSelection): void;
  onReferenceSelect?(id: string): void;
  onCompositionChange?(composing: boolean): void;
  onSubmit?(): void;
  onFiles?(files: File[]): void;
}

const caret = (at: number): ManuscriptSelection => ({ start: at, end: at, direction: "none" });

/** Native input is intentionally kept outside React reconciliation. The only
 * rich nodes are non-editable references; the document model is still text. */
export function createManuscriptController(root: HTMLDivElement, initial: ManuscriptControllerOptions) {
  let options = initial;
  const history = createManuscriptHistory({ text: initial.value, selection: caret(initial.value.length) });
  let composing = false, compositionScope = initial.scope, clearAfterComposition = false;
  let queuedPaste = "", queuedFiles: File[] = [];
  let selectedReference: string | undefined;
  let alive = true;
  const active = () => root.contains(root.ownerDocument.activeElement);
  const render = (restore = active()) => {
    if (composing) return;
    const snapshot = history.get();
    renderManuscriptDOM(root, snapshot.text, options.bindings, restore ? snapshot.selection : undefined);
  };
  const select = (range: ManuscriptSelection, restore = false) => {
    const snapshot = history.get();
    const atoms = manuscriptAtoms(snapshot.text, options.bindings);
    const normalized = manuscriptSelection(snapshot.text, range, atoms);
    history.select(normalized);
    if (restore && !composing) writeManuscriptSelection(root, normalized);
    options.onSelectionChange?.(normalized);
    const referenced = atoms.filter(atom => normalized.start === normalized.end
      ? normalized.start >= atom.start && normalized.start < atom.end
      : normalized.start < atom.end && normalized.end > atom.start);
    const id = referenced.length === 1 ? referenced[0].id : undefined;
    if (id !== selectedReference) { selectedReference = id; if (id) options.onReferenceSelect?.(id); }
    return normalized;
  };
  const remember = () => {
    if (composing) return history.get().selection;
    const selected = readManuscriptSelection(root);
    return selected ? select(selected) : history.get().selection;
  };
  const publish = () => {
    const snapshot = history.get();
    options.onChange(snapshot.text, snapshot.selection);
    options.onSelectionChange?.(snapshot.selection);
  };
  const commit = (snapshot: ManuscriptSnapshot, restore = true) => {
    history.commit(snapshot);
    render(restore);
    publish();
  };
  const insert = (text: string, afterSelection = false) => {
    if (composing) { queuedPaste += text; return; }
    remember();
    commit(replaceManuscriptRange(history.get(), text, options.bindings, afterSelection));
  };
  const undo = (redo = false) => {
    const snapshot = redo ? history.redo() : history.undo();
    if (snapshot) { render(); publish(); }
  };
  const atomFor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-editor-atom]") : null;
  const selectBadge = (badge: HTMLElement) => {
    const nodes = Array.from(root.querySelectorAll("[data-editor-atom]"));
    const atom = manuscriptAtoms(history.get().text, options.bindings)[nodes.indexOf(badge)];
    if (!atom) return;
    select({ start: atom.start, end: atom.end, direction: "forward" }, true);
  };
  const remove = (backward: boolean, forceSelection = false): boolean => {
    const snapshot = history.get();
    const range = forceSelection && snapshot.selection.start !== snapshot.selection.end ? snapshot.selection
      : atomicDeletion(snapshot.text, snapshot.selection, options.bindings, backward);
    if (!range) return false;
    commit(replaceManuscriptRange({ ...snapshot, selection: range }, "", options.bindings));
    return true;
  };
  const beforeInput = (event: InputEvent) => {
    if (composing || event.isComposing) return;
    remember();
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault(); undo(event.inputType === "historyRedo"); return;
    }
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      if (event.inputType === "insertParagraph" && (options.enterBehavior ?? "send") === "send") options.onSubmit?.();
      else insert("\n");
      return;
    }
    if (event.inputType.startsWith("format")) { event.preventDefault(); return; }
    if (event.inputType.startsWith("delete") && remove(event.inputType.endsWith("Backward"))) event.preventDefault();
  };
  const input = (event: InputEvent) => {
    if (composing || event.isComposing) return;
    const text = readManuscriptDOM(root);
    const range = readManuscriptSelection(root) ?? caret(text.length);
    commit({ text, selection: manuscriptSelection(text, range, manuscriptAtoms(text, options.bindings)) });
  };
  const compositionStart = () => {
    remember(); composing = true; compositionScope = options.scope;
    options.onCompositionChange?.(true);
  };
  const compositionEnd = () => {
    composing = false;
    if (compositionScope === options.scope) input(new InputEvent("input"));
    else render(false);
    if (clearAfterComposition) { history.reset(history.get()); clearAfterComposition = false; }
    // Composition is one history entry. Flush clipboard/file operations only
    // after the browser has finished its final composition input event.
    options.onCompositionChange?.(false);
    const scope = options.scope;
    queueMicrotask(() => {
      if (!alive || composing || options.scope !== scope) return;
      const text = queuedPaste, files = queuedFiles;
      queuedPaste = ""; queuedFiles = [];
      if (text) insert(text);
      if (files.length) options.onFiles?.(files);
    });
  };
  const paste = (event: ClipboardEvent) => {
    event.preventDefault(); event.stopPropagation();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
    if (composing) { queuedPaste += text; queuedFiles.push(...files); return; }
    if (text) insert(text);
    if (files.length) options.onFiles?.(files);
  };
  const copy = (event: ClipboardEvent) => {
    if (composing || !event.clipboardData) return;
    remember();
    const { text, selection } = history.get();
    if (selection.start === selection.end) return;
    event.preventDefault(); event.stopPropagation();
    event.clipboardData.setData("text/plain", text.slice(selection.start, selection.end));
    if (event.type === "cut") remove(false, true);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    const files = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith("image/"));
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (composing) { queuedFiles.push(...files); queuedPaste += text; return; }
    // Drop at the visible hit position when available; toolbar/file pickers
    // instead retain the last authored caret. Never scroll to focus it.
    const doc = root.ownerDocument as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
    const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range && root.contains(range.startContainer)) {
      const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); remember();
    }
    if (text && !files.length) insert(text);
    if (files.length) options.onFiles?.(files);
  };
  const click = (event: MouseEvent) => {
    const badge = atomFor(event.target);
    if (badge) { event.preventDefault(); root.focus({ preventScroll: true }); selectBadge(badge); }
    else remember();
  };
  const focus = (event: FocusEvent) => { const badge = atomFor(event.target); if (badge) selectBadge(badge); };
  const selectionChange = () => { if (active() && !composing) remember(); };
  const dragover = (event: DragEvent) => event.preventDefault();
  const handlers = { beforeinput: beforeInput, input, compositionstart: compositionStart, compositionend: compositionEnd,
    paste, copy, cut: copy, drop, dragover, click, focusin: focus };
  for (const [name, handler] of Object.entries(handlers)) root.addEventListener(name, handler as EventListener);
  root.ownerDocument.addEventListener("selectionchange", selectionChange);
  render(false);

  return {
    update(next: ManuscriptControllerOptions) {
      const changedScope = next.scope !== options.scope;
      options = next;
      // Selectionchange is queued by browsers. An upload/theme rerender can
      // arrive first, so sample the actual caret before reconciling badges.
      if (!changedScope && !composing && next.value === history.get().text && active()) remember();
      if (changedScope) {
        queuedFiles = []; queuedPaste = "";
        selectedReference = undefined;
        history.reset({ text: next.value, selection: caret(next.value.length) });
      } else if (!composing && next.value !== history.get().text) {
        history.reset({ text: next.value, selection: manuscriptSelection(next.value, history.get().selection) });
      }
      render(!changedScope && active());
    },
    keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || composing || isImeKeyboardEvent(event)) return;
      const badge = atomFor(event.target);
      if (badge) {
        if (event.key === "Backspace" || event.key === "Delete") root.focus({ preventScroll: true });
        selectBadge(badge);
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); return; }
      } else remember();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
        event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === "y"); return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (composerEnterIntent(event, { enterBehavior: options.enterBehavior }) === "submit") options.onSubmit?.();
        else insert("\n");
      } else if ((event.key === "Backspace" || event.key === "Delete") && remove(event.key === "Backspace")) event.preventDefault();
    },
    getText: () => composing && compositionScope === options.scope ? readManuscriptDOM(root) : history.get().text,
    getSelection: remember,
    setSelection(range: ManuscriptSelection) { select(range, true); },
    insertAtCaret(text: string, config?: { afterSelection?: boolean }) { insert(text, config?.afterSelection); },
    focus(config: FocusOptions = { preventScroll: true }) { root.focus(config); if (!composing) writeManuscriptSelection(root, history.get().selection); },
    isComposing: () => composing,
    clearHistory() { history.reset(history.get()); clearAfterComposition = composing; },
    dispose() {
      alive = false;
      for (const [name, handler] of Object.entries(handlers)) root.removeEventListener(name, handler as EventListener);
      root.ownerDocument.removeEventListener("selectionchange", selectionChange);
    },
  };
}
