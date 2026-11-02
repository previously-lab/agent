import { manuscriptAtoms, manuscriptSelection, type ManuscriptBinding, type ManuscriptSelection } from "./manuscript-editor-model";

function atomText(node: Node): string | null {
  return node instanceof HTMLElement && node.dataset.editorAtom !== undefined ? node.dataset.editorAtom : null;
}

/** Native input may create DIV/P/BR wrappers (especially mobile replacement
 * and browser automation). Serialize those as plain lines, never HTML. */
export function readManuscriptDOM(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
  const atom = atomText(root);
  if (atom !== null) return atom;
  if (root instanceof HTMLElement && root.tagName === "BR") return root.hasAttribute("data-editor-placeholder") ? "" : "\n";
  let text = "";
  for (const child of root.childNodes) {
    const block = child instanceof HTMLElement && /^(DIV|P|LI)$/.test(child.tagName);
    if (block && text && !text.endsWith("\n")) text += "\n";
    text += readManuscriptDOM(child);
    if (block && child.nextSibling && !text.endsWith("\n")) text += "\n";
  }
  return text;
}

function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  // A cloned prefix retains atom attributes, so an endpoint beside an atom
  // counts its serialized marker length, not its accessible button label.
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return readManuscriptDOM(range.cloneContents()).length;
}

export function readManuscriptSelection(root: HTMLElement): ManuscriptSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const anchor = offsetIn(root, selection.anchorNode, selection.anchorOffset);
  const focus = offsetIn(root, selection.focusNode, selection.focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), direction: anchor === focus ? "none" : anchor > focus ? "backward" : "forward" };
}

function pointAt(root: HTMLElement, requested: number): { node: Node; offset: number } {
  let remaining = requested;
  for (const node of root.childNodes) {
    const size = readManuscriptDOM(node).length;
    if (node.nodeType === Node.TEXT_NODE && remaining <= size) return { node, offset: remaining };
    if (atomText(node) !== null && remaining < size) {
      const index = Array.prototype.indexOf.call(root.childNodes, node) as number;
      return { node: root, offset: index + (remaining > 0 ? 1 : 0) };
    }
    remaining -= size;
  }
  const last = root.lastChild;
  return { node: root, offset: root.childNodes.length - (last instanceof HTMLElement && last.hasAttribute("data-editor-placeholder") ? 1 : 0) };
}

export function writeManuscriptSelection(root: HTMLElement, range: ManuscriptSelection) {
  const start = pointAt(root, range.start), end = pointAt(root, range.end);
  const selection = root.ownerDocument.getSelection();
  if (range.direction === "backward") selection?.setBaseAndExtent(end.node, end.offset, start.node, start.offset);
  else selection?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
}

/** React owns only the root. This reconciler owns the small editable subtree;
 * never call during composition. Unchanged typing nodes remain untouched. */
export function renderManuscriptDOM(root: HTMLElement, text: string, bindings: readonly ManuscriptBinding[], selection?: ManuscriptSelection) {
  const atoms = manuscriptAtoms(text, bindings);
  const existing = Array.from(root.querySelectorAll<HTMLElement>("[data-editor-atom]"));
  const canonical = Array.from(root.childNodes).every(node => node.nodeType === Node.TEXT_NODE
    || node instanceof HTMLElement && (node.hasAttribute("data-editor-atom") || node.hasAttribute("data-editor-placeholder")));
  const same = canonical && readManuscriptDOM(root) === text && existing.length === atoms.length
    && existing.every((node, i) => node.dataset.imageReference === atoms[i].id && node.dataset.imageAsset === atoms[i].assetId
      && node.dataset.editorAtom === text.slice(atoms[i].start, atoms[i].end));
  if (!same) {
    const fragment = root.ownerDocument.createDocumentFragment();
    let cursor = 0;
    for (const atom of atoms) {
      fragment.append(root.ownerDocument.createTextNode(text.slice(cursor, atom.start)));
      const badge = root.ownerDocument.createElement("span");
      badge.contentEditable = "false";
      badge.tabIndex = 0;
      badge.setAttribute("role", "button");
      badge.className = "conversation-image-reference";
      badge.dataset.editorAtom = text.slice(atom.start, atom.end);
      badge.dataset.imageReference = atom.id;
      badge.dataset.imageAsset = atom.assetId;
      badge.setAttribute("aria-label", badge.dataset.editorAtom);
      badge.textContent = badge.dataset.editorAtom;
      fragment.append(badge);
      cursor = atom.end;
    }
    fragment.append(root.ownerDocument.createTextNode(text.slice(cursor)));
    if (!text || text.endsWith("\n")) {
      const placeholder = root.ownerDocument.createElement("br");
      placeholder.dataset.editorPlaceholder = "";
      fragment.append(placeholder);
    }
    root.replaceChildren(fragment);
  }
  root.dataset.editorText = text;
  root.dataset.empty = String(!text);
  if (selection) {
    const desired = manuscriptSelection(text, selection, atoms);
    const current = readManuscriptSelection(root);
    if (!current || current.start !== desired.start || current.end !== desired.end || current.direction !== desired.direction)
      writeManuscriptSelection(root, desired);
  }
}
