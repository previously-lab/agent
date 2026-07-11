import { setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { DocsSidebar } from "@/components/docs/docs-sidebar";
import type { Locale } from "@/lib/docs/manifest";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function DocsLayout({ children, params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const lang = locale as Locale;

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 px-4 pt-16 pb-8 sm:px-6 lg:gap-12 lg:pt-20 lg:pb-12">
      <DocsSidebar locale={lang} />

      <main className="min-w-0 flex-1">
        <nav className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Chat
          </Link>
        </nav>
        {children}
      </main>
    </div>
  );
}
