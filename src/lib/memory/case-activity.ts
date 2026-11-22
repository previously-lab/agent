import { parseCaseCurrent, parseCaseDoc } from "@/lib/docs/case-doc";
import type { CaseCategory } from "@/lib/docs/paths";

export interface CaseActivitySource {
  treeDir: string;
  caseName: string;
  indexPath: string | null;
  currentPath?: string;
}

/** Dates from the two stored documents. Piece dates come directly from the tree. */
export async function readStoredCaseActivity(
  node: CaseActivitySource,
  read: (path: string) => Promise<string>,
): Promise<{ date: string; complete: boolean }> {
  let date = "";
  try {
    if (node.indexPath) {
      const doc = parseCaseDoc(await read(node.indexPath), {
        category: node.treeDir as CaseCategory, caseName: node.caseName, fileName: "index.md",
      });
      date = doc.tail.reduce((at, tail) => at >= tail.date ? at : tail.date, doc.updated.slice(0, 10));
      if (node.currentPath) {
        const current = parseCaseCurrent(await read(node.currentPath));
        if (current.asOf > date) date = current.asOf;
      }
    }
    return { date, complete: true };
  } catch {
    // An unreadable current page still leaves the successfully read index date.
    return { date, complete: false };
  }
}
