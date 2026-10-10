/**
 * remark-doc-refs — the render half of the paper's reference links (v0.22
 * §7). Walks the mdast tree and splits every TEXT node on the archive's
 * tokenizer (src/lib/archive/ref-tokens.ts — the SAME grammar the verify
 * pass pre-flights), wrapping each candidate span in a `docRef` node whose
 * hast mapping renders as <doc-ref data-ref="…">:
 *
 *   "详见 research/手机调研 的结论"
 *   → text("详见 ") + docRef("research/手机调研") + text(" 的结论")
 *
 * WHAT IS NEVER TOUCHED: code (fenced and inline — its text is literal),
 * existing links and images (a citation inside a link's text stays text),
 * and every non-text node. The docRef node is INERT without a reader: the
 * MarkdownRenderer's component for it renders plain children unless a
 * DocRefProvider (the desk) supplies liveness + an open action, so the chat
 * pipeline sharing this plugin sees zero behavior change.
 */
import { visit } from "unist-util-visit";
import type { Node, Parent } from "unist";
import { tokenizeRefText } from "@/lib/archive/ref-tokens";

/** The custom mdast node: children hold the cited text verbatim; the hast
 *  mapping carries the normalized ref as a data attribute. */
interface DocRefNode extends Node {
  type: "docRef";
  children: { type: "text"; value: string }[];
  data: {
    hName: "doc-ref";
    hProperties: { "data-ref": string };
  };
}

interface TextNode extends Node {
  type: "text";
  value: string;
}

/** Node types whose text is never prose the paper may link. */
const SKIP_PARENTS = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "html",
]);

/** Split a text node on its candidate spans; null when it carries none. */
function splitTextNode(node: TextNode): (TextNode | DocRefNode)[] | null {
  const tokens = tokenizeRefText(node.value);
  if (tokens.length === 0) return null;
  const out: (TextNode | DocRefNode)[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      out.push({ type: "text", value: node.value.slice(cursor, token.start) });
    }
    out.push({
      type: "docRef",
      children: [{ type: "text", value: node.value.slice(token.start, token.end) }],
      data: {
        hName: "doc-ref",
        hProperties: { "data-ref": token.ref },
      },
    });
    cursor = token.end;
  }
  if (cursor < node.value.length) {
    out.push({ type: "text", value: node.value.slice(cursor) });
  }
  return out;
}

export function remarkDocRefs() {
  return (tree: Node) => {
    visit(
      tree,
      "text",
      (node: Node, index: number | undefined, parent: Parent | undefined) => {
        if (!parent || index === undefined) return;
        if (SKIP_PARENTS.has(parent.type)) return;
        const replacement = splitTextNode(node as TextNode);
        if (replacement === null) return;
        parent.children.splice(index, 1, ...replacement);
        // Skip past the inserted nodes — none of their text re-tokenizes.
        return index + replacement.length;
      },
    );
  };
}
