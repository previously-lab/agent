/** Small server-authored write receipts, committed with their product; never model declarations. */
import { fsListFiles, fsReadFile, fsWriteFile, type WriteBatch } from "./io-helpers";
import { historyDigest, isHistoryArchiveFileName } from "@/lib/docs/history-archive";
import { isAuthoredDocumentPath } from "@/lib/docs/write-limits";
import { absentDocumentError } from "@/lib/docs/write-validation";
export interface DocumentProductScope { sliceId: string; turnIds: string[] }
interface ProductReceipt extends DocumentProductScope { v: 1; path: string; revision: string }
function receiptDirectory(sliceId: string): string {
  if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(sliceId)) throw new Error("Invalid document receipt slice");
  return `memory/config/document-products/${sliceId}`;
}
export async function stageDocumentProduct(batch: WriteBatch, scope: DocumentProductScope, path: string): Promise<void> {
  if (!isAuthoredDocumentPath(path) || isHistoryArchiveFileName(path) || !scope.turnIds.length) return;
  const raw = await fsReadFile(path, batch, { fresh: true });
  const receipt: ProductReceipt = { v: 1, sliceId: scope.sliceId, turnIds: [...new Set(scope.turnIds)].sort(), path, revision: historyDigest(raw) };
  const content = JSON.stringify(receipt);
  await fsWriteFile(`${receiptDirectory(scope.sliceId)}/${historyDigest(content)}.json`, content + "\n", batch);
}
export async function confirmedDocumentProducts(scopes: readonly DocumentProductScope[], batch?: WriteBatch): Promise<string> {
  const products = new Set<string>();
  for (const scope of scopes) {
    if (!scope.turnIds.length) continue;
    const dir = receiptDirectory(scope.sliceId);
    const paths = new Set<string>();
    try { for (const file of await fsListFiles(dir)) if (file.type === "file") paths.add(`${dir}/${file.name}`); }
    catch (error) { if (!absentDocumentError(error)) continue; }
    for (const [path, content] of batch?.entries ?? []) if (path.startsWith(`${dir}/`) && content !== null) paths.add(path);
    for (const path of paths) {
      try {
        const raw = await fsReadFile(path, batch, { fresh: true });
        const receipt = JSON.parse(raw) as ProductReceipt;
        if (receipt.v !== 1 || receipt.sliceId !== scope.sliceId || !Array.isArray(receipt.turnIds) ||
          !receipt.turnIds.some((id) => scope.turnIds.includes(id)) || !isAuthoredDocumentPath(receipt.path) || isHistoryArchiveFileName(receipt.path) ||
          path !== `${dir}/${historyDigest(JSON.stringify(receipt))}.json`) continue;
        const product = await fsReadFile(receipt.path, batch, { fresh: true });
        if (historyDigest(product) !== receipt.revision) continue;
        products.add(`${receipt.path.replace(/^memory\//, "").replace(/\.md$/, "")} (${batch?.entries.has(receipt.path) ? "server-queued in this batch" : "committed"}; source turns ${receipt.turnIds.join(", ")})`);
      } catch { /* Missing/stale/corrupt receipt grants no coverage. */ }
    }
  }
  return "SERVER-VERIFIED DOCUMENT PRODUCTS — discovery, not proof of semantic coverage or user endorsement. Read the actual document before covered; another reading purpose may justify another product.\n" +
    ([...products].sort().join("\n") || "(none verified)");
}
