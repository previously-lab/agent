import type { Node, Parent } from "unist";
import type { NativeHtmlSection, NativeSection } from "./native-sections";

export interface RemarkNativeSectionsOptions {
  source: string;
  sections: readonly NativeSection[];
}

interface NativeIsland {
  section: NativeHtmlSection;
  start: number;
}

function sameFenceStart(source: string, mdastStart: number, nativeStart: number): boolean {
  if (mdastStart === nativeStart) return true;
  const from = Math.min(mdastStart, nativeStart);
  const to = Math.max(mdastStart, nativeStart);
  return to - from <= 3 && /^ *$/.test(source.slice(from, to));
}

export function remarkNativeSections(options: RemarkNativeSectionsOptions) {
  return (tree: Node) => {
    const islands: NativeIsland[] = [];
    let offset = 0;
    for (const section of options.sections) {
      if (section.kind === "native") islands.push({ section, start: offset });
      offset += section.raw.length;
    }
    if (islands.length === 0) return;

    const root = tree as Parent;
    let next = 0;
    for (const child of root.children) {
      if (child.type !== "code" || next >= islands.length) continue;
      const start = child.position?.start.offset;
      if (start === undefined) continue;
      const island = islands[next];
      if (!sameFenceStart(options.source, start, island.start)) continue;
      next += 1;
      const { section } = island;
      child.type = "nativeHtml";
      child.data = {
        ...child.data,
        hName: "native-html",
        hProperties: {
          "data-native-source": section.source,
          "data-native-version": section.version,
          "data-native-ordinal": String(section.ordinal),
          "data-native-explicit-id": section.explicitId ?? "",
          "data-native-closed": section.closed ? "true" : "false",
          "data-native-close-ended": /[\r\n]$/.test(section.raw) ? "true" : "false",
        },
      };
    }
  };
}
