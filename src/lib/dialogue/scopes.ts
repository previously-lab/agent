import { parseCanonicalDocumentRef } from "@/lib/documents/document-link";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";
import { digest } from "./artifacts";

/**
 * Host-owned work-scope bindings. ONLY pointers the user explicitly attached
 * (the validated document context) enter the saved work scope — no inferred
 * entity resolution, no classification model. Each trusted ref becomes its
 * own independent scope, so a later correction bound to the same ref rebuts
 * only claims scoped to that ref: the independent speaker task is never
 * voided by the fruit correction (T02), and the host only ever verifies
 * explicit scope.
 *
 * Versioning: the bindings ride the stored launch. A regenerate work copies
 * the original launch, so the retry is judged against the ORIGINAL
 * source/work/task versions, never the retry attempt's.
 */
export interface WorkScopeBindings {
  /** One independent scope per trusted ref (`scope-<refDigest>`). */
  independentScopes: ReadonlyArray<{ id: string; refs: readonly string[] }>;
}

export function deriveWorkScopeBindings(
  documentContext: DocumentContextSnapshot | undefined,
): WorkScopeBindings {
  const refs = (documentContext ?? [])
    .map((entry) => parseCanonicalDocumentRef(entry.ref))
    .filter((ref): ref is string => typeof ref === "string");
  return {
    independentScopes: refs.map((ref) => ({
      id: `scope-${digest(ref).slice(0, 16)}`,
      refs: [ref],
    })),
  };
}
