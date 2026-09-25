import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link, redirect } from "@/i18n/navigation";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The HOME route (v0.13 §3) — the start screen, not a chat window.
 *
 * Deliberately THIN: one identity line and three entries — 继续 (into the
 * app, `/app`), 进入世界 (straight into the hotel, `/app?view=game`), and a
 * small settings link in the footer. No R3F, no conversation ability (the
 * reader's ruling: the home has no pill, no subtitle, no fullscreen — it is
 * a start screen), and no card design work; the real card is a later batch
 * and only ever changes THIS file, never the structure.
 *
 * The home appears on cold boot and when the reader 收工 from the world (§3's
 * one-way door); it is not a tab of the app.
 *
 * LEGACY PARAMS. The app surface used to live ON this route, so old links
 * carry its one-shot params (`?view=game`, `?at=`, `?atStart=`, `?z=`). They
 * are forwarded to `/app` verbatim — a shared `/?at=…` link still lands on
 * its slice, just through the new address. A bare visit (or `?persona=`
 * alone, the demo switcher) stays on the home.
 */
export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const sp = await searchParams;
  const isDemo = resolveDataSource() === "demo";
  if (isDemo) {
    const persona = typeof sp.persona === "string" ? sp.persona : "";
    setDemoPersona(persona || "user");
  }

  const carriesAppParam = ["view", "at", "atStart", "z"].some(
    (key) => sp[key] !== undefined,
  );
  if (carriesAppParam) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) {
      if (typeof value === "string") query.set(key, value);
    }
    redirect({ href: `/app?${query.toString()}`, locale });
  }

  const t = await getTranslations("home");

  return (
    <main className="relative flex h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-muted-foreground">
        {t("identity")}
      </p>
      <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
        {t("tagline")}
      </p>
      <nav className="mt-12 flex flex-col items-center gap-5">
        <Link
          href="/app"
          className="text-lg font-medium transition-colors hover:text-brand"
        >
          {t("continue")}
        </Link>
        <Link
          href="/app?view=game"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("enterWorld")}
        </Link>
      </nav>
      {/* 设置不进卡的主体 — 内容是内容，设施是设施 (§3): a small footer link,
          not an entry of the card. */}
      <Link
        href="/settings"
        className="absolute bottom-6 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        {t("settings")}
      </Link>
    </main>
  );
}
