import { defaultUrlTransform } from "react-markdown";
import {
  formatDocumentLink,
  parseDocumentLink,
} from "@/lib/documents/document-link";

export function documentUrlTransform(url: string): string {
  if (/^previously:/i.test(url)) {
    const parsed = parseDocumentLink(url);
    return parsed ? formatDocumentLink(parsed) ?? "" : "";
  }
  return defaultUrlTransform(url);
}
