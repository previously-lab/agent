import { setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getDocsNav, type Locale } from "@/lib/docs/manifest";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function DocsLayout({ children, params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const nav = getDocsNav();
  const lang = locale as Locale;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:flex-row lg:gap-12 lg:py-12">
      <aside className="lg:w-56 lg:shrink-0">
        <nav className="flex flex-col gap-6 lg:sticky lg:top-8">
          {nav.map(({ section, pages }) => (
            <div key={section.id} className="flex flex-col gap-1">
              <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.title[lang]}
              </h2>
              {pages.map((page) => (
                <Link
                  key={page.slug}
                  href={`/docs/${page.slug}`}
                  className="rounded-md px-2 py-1 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                >
                  {page.title[lang]}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
