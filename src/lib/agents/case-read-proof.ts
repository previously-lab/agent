import type { ModelMessage } from "@/lib/deepseek/types";
import type { CaseCategory } from "@/lib/docs/paths";
import { CaseWriteRefusal } from "@/lib/docs/write-window";
import { createCaseReadScope, readCaseIndexForScope, type CaseReadScope } from "@/lib/episodic/flash/librarian";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import { findCaseReadReceipt } from "@/lib/chat/case-read-receipt";

/** Reconstitute a real storage read, never an empty or model-supplied content copy. */
export async function reconstructCaseReadScope(input: {
  messages: ModelMessage[]; scopeId: string; category: CaseCategory; caseName: string; batch?: WriteBatch;
}): Promise<CaseReadScope | null> {
  const receipt = findCaseReadReceipt(input);
  if (!receipt) return null;
  const read = await readCaseIndexForScope({
    category: input.category, caseName: input.caseName, batch: input.batch, fresh: true,
  });
  if (read.revision !== receipt.revision || read.path !== receipt.path) {
    throw new CaseWriteRefusal("rewrite_conflict",
      `case ${receipt.ref} changed since its successful full read; call recallRead again before adding a piece`);
  }
  const scope = createCaseReadScope();
  scope.recordIndexRead(read);
  return scope;
}
