import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { DOC_PAGES, getDocPage, type Locale } from "@/lib/docs/manifest";
import { getDocMarkdown } from "@/lib/docs/content";
import { DocsMarkdown } from "@/components/docs/docs-markdown";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

export function generateStaticParams(): Array<{ locale: string; slug: string }> {
  const params: Array<{ locale: string; slug: string }> = [];
  for (const locale of routing.locales) {
    for (const page of DOC_PAGES) {
      params.push({ locale, slug: page.slug });
    }
  }
  return params;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = getDocPage(slug);
  if (!page) return {};
  return { title: `${page.title[locale as Locale]} · Previously Docs` };
}

export default async function DocPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const page = getDocPage(slug);
  if (!page) notFound();

  const markdown = await getDocMarkdown(locale as Locale, slug);
  if (markdown === null) notFound();

  return (
    <article className="min-w-0">
      <DocsMarkdown content={markdown} />
    </article>
  );
}
