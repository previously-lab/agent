"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { getDocsNav, type Locale } from "@/lib/docs/manifest";

export function DocsSidebar({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false);
  const nav = getDocsNav();

  const links = nav.map(({ section, pages }) => (
    <div key={section.id} className="flex flex-col gap-1">
      <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {section.title[locale]}
      </h2>
      {pages.map((page) => (
        <Link
          key={page.slug}
          href={`/docs/${page.slug}`}
          onClick={() => setOpen(false)}
          className="rounded-md px-2 py-1 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
        >
          {page.title[locale]}
        </Link>
      ))}
    </div>
  ));

  return (
    <>
      {/* Hamburger — mobile only */}
      <button
        onClick={() => setOpen(true)}
        className="fixed top-14 right-4 z-40 h-8 w-8 rounded-full bg-background border border-border flex items-center justify-center shadow-sm lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>

      {/* Desktop sidebar */}
      <aside className="hidden lg:block lg:w-56 lg:shrink-0">
        <nav className="flex flex-col gap-6 lg:sticky lg:top-20">{links}</nav>
      </aside>

      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute left-0 top-0 bottom-0 w-64 bg-background border-r border-border p-4 pt-16 overflow-y-auto shadow-xl">
            <button
              onClick={() => setOpen(false)}
              className="absolute top-14 right-3 h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
            <nav className="flex flex-col gap-6">{links}</nav>
          </aside>
        </div>
      )}
    </>
  );
}
