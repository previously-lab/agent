import type { Node, Parent } from "unist";
import type { ContentBlockV1 } from "@/lib/chat/dialogue-contract";
import type { ImageMarkerMatch } from "@/lib/chat/image-markers";

/** Keep Markdown's single semantic document (including definitions and
 * footnotes). Place typed blocks only at host-created source offsets. */
export function composeDialogueMarkdown(blocks: readonly ContentBlockV1[]) {
  const slots = new Map<number, string>();
  let content = "";
  for (const block of blocks) {
    if (content) content += "\n\n";
    if (block.kind === "markdown") content += block.text;
    else {
      slots.set(content.length, block.blockId);
      content += "~~~previously-content-slot\n~~~";
    }
  }
  return { content, slots };
}

export function remarkDialogueSlots(slots: ReadonlyMap<number, string>) {
  return (tree: Node) => {
    for (const child of (tree as Parent).children) {
      const offset = child.position?.start.offset;
      if (offset === undefined || child.type !== "code") continue;
      const id = slots.get(offset);
      if (!id) continue;
      child.type = "dialogueSlot";
      child.data = { hName: "dialogue-slot", hProperties: { "data-content-block": id } };
    }
  };
}

/** Resolve only parser-owned text nodes. Code, unknown ordinals and ambiguous
 * asset bindings remain literal, while a known marker uses the same asset id
 * as its typed photo block. */
export function remarkDialogueImageSlots(matches: readonly ImageMarkerMatch[]) {
  return (tree: Node) => {
    const visit = (parent: Parent) => {
      for (const child of [...parent.children]) {
        if (child.type !== "text") {
          if ("children" in child) visit(child as Parent);
          continue;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        const value = (child as Node & { value: string }).value;
        const inside = matches.filter(match => match.start >= start && match.end <= end);
        if (!inside.length) continue;
        const replacement: Node[] = [];
        let cursor = start;
        for (const match of inside) {
          if (match.start > cursor) replacement.push({ type: "text", value: value.slice(cursor - start, match.start - start) } as Node & { value: string });
          replacement.push({ type: "dialogueSlot", data: {
            hName: "dialogue-slot", hProperties: { "data-content-block": `image:${match.start}` },
          } });
          cursor = match.end;
        }
        if (cursor < end) replacement.push({ type: "text", value: value.slice(cursor - start) } as Node & { value: string });
        const index = parent.children.indexOf(child);
        if (index >= 0) parent.children.splice(index, 1, ...replacement);
      }
    };
    visit(tree as Parent);
  };
}
