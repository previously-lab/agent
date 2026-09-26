import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getBriefingIdentity } from "@/lib/episodic/actions";
import { getHomeMemoryState } from "@/lib/home/recap";
import { HomeScreen } from "@/components/home/home-screen";
import { isRecentInterval, relativeBetween } from "@/lib/time/relative-between";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The recap reads memory (local disk / GitHub) — it must be fresh per visit,
// never frozen into a build-time prerender.
export const dynamic = "force-dynamic";

/**
 * The HOME route (v0.13 §3) — the start screen, not a chat window.
 *
 * Pure typography on the field: the product's sentence and the reader's name,
 * the dateline under it (where the last conversation left off — real
 * timestamps via `getHomeMemoryState`, rendered as a relative phrase while the
 * app's own interval ladder still measures minutes/hours/days and as the plain
 * clock beyond that), and the menu — 继续 → `/app`, 设置 → `/settings`. No card,
 * no status line, no uppercase — and no
 * conversation ability, no R3F (nothing in this route's import graph may
 * pull in three.js or the game scene).
 *
 * The name comes from `getBriefingIdentity` — the exact read the header
 * chip's "Previously on {name}" uses, resolved server-side while the page
 * streams (this route is force-dynamic, so it is fresh per visit, unlike
 * the prerendered locale layout the chip has to fetch from).
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

  const [t, format, memory, identity] = await Promise.all([
    getTranslations("home"),
    getFormatter(),
    getHomeMemoryState(),
    // The same read the header chip's "Previously on {name}" resolves —
    // not a second source. This route is force-dynamic, so the name can
    // be fresh per visit without the client fetch the prerendered layout
    // chrome needs.
    getBriefingIdentity(),
  ]);

  const recap = memory.recap;
  let dateline: string | null = null;
  if (recap) {
    const lastAt = new Date(recap.lastAt);
    const now = new Date();
    // WHICH SHAPE, decided by the app's own interval ladder rather than by a
    // threshold grown here: a reading it still counts in minutes/hours/days
    // reads as a phrase ("上次对话 5 小时前" / "Last spoke 5 hours ago"), while
    // anything it would measure in weeks or more is better served by the date
    // itself — `isRecentInterval` is where that line is drawn. The ladder is
    // asked with NOW as the source and the last turn as the destination, the
    // way the travel clock asks it: the reversed order calls the same gap
    // `after`, which is also the reading a future timestamp gets.
    const rel = relativeBetween(now.toISOString(), recap.lastAt);
    if (isRecentInterval(rel)) {
      dateline = t("lastSpoke", { gap: format.relativeTime(lastAt, now) });
    } else {
      // The recap's clock is the slice's own timezone (the reader's, then);
      // an unparseable/invalid one falls back to the locale default rather
      // than failing the whole page.
      try {
        dateline = format.dateTime(lastAt, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: recap.timezone || undefined,
        });
      } catch {
        dateline = format.dateTime(lastAt, {
          dateStyle: "medium",
          timeStyle: "short",
        });
      }
    }
  }

  return (
    <HomeScreen
      eyebrowLead={t("eyebrowLead")}
      eyebrowPreposition={t("eyebrowPreposition")}
      name={identity.name}
      dateline={dateline}
      continueLabel={t("continue")}
      settingsLabel={t("settings")}
    />
  );
}
