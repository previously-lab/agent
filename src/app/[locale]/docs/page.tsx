import { redirect } from "@/i18n/navigation";
import { DEFAULT_DOC_SLUG } from "@/lib/docs/manifest";

/** /docs → canonical first page. */
export default async function DocsIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: `/docs/${DEFAULT_DOC_SLUG}`, locale });
}
