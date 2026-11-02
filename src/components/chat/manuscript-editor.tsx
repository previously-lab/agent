"use client";

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { createManuscriptController, type ManuscriptControllerOptions } from "./manuscript-editor-controller";
import type { ManuscriptSelection } from "./manuscript-editor-model";
export type { ManuscriptBinding, ManuscriptSelection } from "./manuscript-editor-model";

export interface ManuscriptEditorHandle {
  readonly element: HTMLDivElement | null;
  focus(options?: FocusOptions): void;
  getText(): string;
  getSelection(): ManuscriptSelection;
  setSelection(selection: ManuscriptSelection): void;
  insertAtCaret(text: string, options?: { afterSelection?: boolean }): void;
  isComposing(): boolean;
  /** Call on HTTP acceptance even when a new draft retained identical text. */
  clearHistory(): void;
}
export interface ManuscriptEditorProps extends ManuscriptControllerOptions,
  Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "onSubmit" | "onCompositionStart" | "onCompositionEnd" | "onInput" | "onBeforeInput" | "onPaste" | "onDrop" | "children"> {
  placeholder?: string;
}

/** A stable editing host. React never reconciles browser-owned prose/IME
 * nodes; source/persona scope and accepted-draft history are explicit. */
export const ManuscriptEditor = forwardRef<ManuscriptEditorHandle, ManuscriptEditorProps>(function ManuscriptEditor({
  value, scope, bindings, enterBehavior, onChange, onSelectionChange, onReferenceSelect, onCompositionChange, onSubmit, onFiles,
  placeholder, onKeyDown, role = "textbox", style, ...attributes
}, ref) {
  const element = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createManuscriptController> | null>(null);
  useLayoutEffect(() => {
    if (!element.current) return;
    const options = { value, scope, bindings, enterBehavior, onChange, onSelectionChange, onReferenceSelect, onCompositionChange, onSubmit, onFiles };
    if (!controller.current) controller.current = createManuscriptController(element.current, options);
    else controller.current.update(options);
  });
  useLayoutEffect(() => () => { controller.current?.dispose(); controller.current = null; }, []);
  useImperativeHandle(ref, () => ({
    get element() { return element.current; },
    focus: options => controller.current?.focus(options),
    getText: () => controller.current?.getText() ?? "",
    getSelection: () => controller.current?.getSelection() ?? { start: 0, end: 0, direction: "none" },
    setSelection: selection => controller.current?.setSelection(selection),
    insertAtCaret: (text, options) => controller.current?.insertAtCaret(text, options),
    isComposing: () => controller.current?.isComposing() ?? false,
    clearHistory: () => controller.current?.clearHistory(),
  }), []);
  return <div {...attributes} ref={element} role={role} aria-multiline="true"
    contentEditable suppressContentEditableWarning data-testid="manuscript-editor" data-manuscript-input=""
    data-placeholder={placeholder} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...style }}
    onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) controller.current?.keydown(event.nativeEvent); }} />;
});
