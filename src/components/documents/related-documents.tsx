"use client";

import { useLocale } from "next-intl";
import type { VerifiedRef } from "@/lib/archive/actions";
import type { RelatedDocument } from "@/lib/documents/related-documents";
import { deskCurrentTexts } from "@/components/desk/desk-current-texts";
import { DocumentOpenButton } from "./document-navigation";

export function RelatedDocuments({
  documents,
  status,
}: {
  documents: readonly RelatedDocument[];
  status: ReadonlyMap<string, VerifiedRef>;
}): React.JSX.Element | null {
  const texts = deskCurrentTexts(useLocale());
  if (documents.length === 0) return null;
  return (
    <section className="document-related" data-no-selection>
      <h2>{texts.relatedHeading}</h2>
      <ul>
        {documents.map((document) => {
          const key = JSON.stringify([
            document.ref,
            document.location.turnId,
            document.location.role,
            document.location.edition,
          ]);
          const verified = status.get(document.ref);
          if (!verified?.alive) {
            return (
              <li key={key}>
                <span data-document-unavailable>
                  {document.title}
                  <small className="document-related-status">
                    {verified?.alive === false ? texts.relatedNotFound : texts.relatedUnavailable}
                  </small>
                </span>
              </li>
            );
          }
          return (
            <li key={key}>
              <DocumentOpenButton documentRef={document.ref} location={document.location}>
                {document.title}
              </DocumentOpenButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
