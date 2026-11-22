import { projectLivePreviously } from "@/lib/episodic/previously-format";

/** The live fold and the retired standalone Direction skeletons both used H1 titles. */
const directionHeading = /^# (?:Portrait\b|Hypotheses\b|Anti-goals\b|[^\r\n]*\bDirection\b)/i;

export function splitUserModel(full: string): { card: string; direction: string | null } {
  const text = full.trim();
  if (directionHeading.test(text)) return { card: "", direction: text };

  // A divider belongs to the fold only immediately before a Direction heading
  // in prose. Markdown examples may quote the entire on-disk format.
  let divider = -1;
  let fence = "";
  for (const line of text.matchAll(/^[^\r\n]+/gm)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line[0]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
      divider = -1;
      continue;
    }
    if (fence || !line[0].trim()) continue;
    if (divider >= 0 && directionHeading.test(line[0])) {
      return { card: text.slice(0, divider).trim(), direction: text.slice(line.index) };
    }
    divider = /^---[ \t]*$/.test(line[0]) ? line.index : -1;
  }
  return { card: text, direction: null };
}

/** The two reader-facing papers are projections of a single stored document. */
export function dossierViews(full: string) {
  const { card, direction } = splitUserModel(full);
  return { previously: projectLivePreviously(card).trim(), direction: direction ?? "" };
}
