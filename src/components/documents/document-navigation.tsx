"use client";

import {
  createContext,
  useContext,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  formatDocumentLink,
  parseDocumentLink,
  type DocumentLinkLocation,
  type ParsedDocumentLink,
} from "@/lib/documents/document-link";

export type { DocumentLinkLocation } from "@/lib/documents/document-link";

export interface DocumentNavigationValue {
  onOpen: (ref: string, location?: DocumentLinkLocation) => void;
}

const DocumentNavigationContext = createContext<DocumentNavigationValue | null>(null);

export function DocumentNavigationProvider({
  value,
  children,
}: {
  value: DocumentNavigationValue;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <DocumentNavigationContext.Provider value={value}>
      {children}
    </DocumentNavigationContext.Provider>
  );
}

export function useDocumentNavigation(): DocumentNavigationValue | null {
  return useContext(DocumentNavigationContext);
}

function locationOf(link: ParsedDocumentLink): DocumentLinkLocation {
  return {
    ...(link.turnId === undefined ? {} : { turnId: link.turnId }),
    ...(link.role === undefined ? {} : { role: link.role }),
    ...(link.edition === undefined ? {} : { edition: link.edition }),
  };
}

export function DocumentLink({
  href,
  children,
  className,
  title,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}): React.JSX.Element {
  const navigation = useDocumentNavigation();
  const link = parseDocumentLink(href);
  const safeHref = link ? formatDocumentLink(link) : null;
  if (!link || !safeHref || !navigation) {
    return (
      <span className={className} title={title} data-document-unavailable>
        {children}
      </span>
    );
  }
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    navigation.onOpen(link.ref, locationOf(link));
  };
  return (
    <a
      href={safeHref}
      className={className}
      title={title}
      data-document-ref={link.ref}
      data-document-turn={link.turnId}
      data-document-role={link.role}
      data-document-edition={link.edition}
      onClick={open}
    >
      {children}
    </a>
  );
}

export function DocumentOpenButton({
  documentRef,
  location = {},
  children,
  className,
  title,
  ariaLabel,
}: {
  documentRef: string;
  location?: DocumentLinkLocation;
  children: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const navigation = useDocumentNavigation();
  const href = formatDocumentLink(documentRef, location);
  const link = href ? parseDocumentLink(href) : null;
  if (!link || !navigation) {
    return (
      <span className={className} title={title} data-document-unavailable>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={ariaLabel}
      data-document-ref={link.ref}
      data-document-turn={link.turnId}
      data-document-role={link.role}
      data-document-edition={link.edition}
      onClick={() => navigation.onOpen(link.ref, locationOf(link))}
    >
      {children}
    </button>
  );
}
