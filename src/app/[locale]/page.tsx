import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getHomeMemoryState } from "@/lib/home/recap";
import { HomeCard } from "@/components/home/home-card";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The recap reads memory (local disk / GitHub) — it must be fresh per visit,
// never frozen into a build-time prerender.
export const dynamic = "force-dynamic";

/**
 * The HOME route (v0.13 §3) — the start screen, not a chat window.
 *
 * One card: the identity line, the 前情提要 (where the last conversation
 * left off — real timestamps, real gap, the last exchange's own words, via
 * `getHomeMemoryState`), the two doors (继续 → `/app`, 进入世界 →
 * `/app?view=game`), and the settings fine print. No input box, no message
 * stream, no conversation ability (the reader's ruling: the home is a start
 * screen), and no R3F — nothing in this route's import graph may pull in
 * three.js or the game scene.
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

  const [t, format, memory] = await Promise.all([
    getTranslations("home"),
    getFormatter(),
    getHomeMemoryState(),
  ]);

  const recap = memory.recap;
  let recapProps = null;
  if (recap) {
    const lastAt = new Date(recap.lastAt);
    // The recap's clock is the slice's own timezone (the reader's, then);
    // an unparseable/invalid one falls back to the locale default rather
    // than failing the whole card.
    let when: string;
    try {
      when = format.dateTime(lastAt, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: recap.timezone || undefined,
      });
    } catch {
      when = format.dateTime(lastAt, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    }
    recapProps = {
      label: t("recapLabel"),
      when,
      gap: format.relativeTime(lastAt, new Date()),
      youLabel: t("youLabel"),
      agentLabel: t("agentLabel"),
      lastUser: recap.lastUser,
      lastAgent: recap.lastAgent,
    };
  }

  return (
    <HomeCard
      identity={t("identity")}
      stateLine={
        memory.sliceCount > 0
          ? t("state", { count: memory.sliceCount })
          : t("stateEmpty")
      }
      recap={recapProps}
      continueLabel={t("continue")}
      enterWorldLabel={t("enterWorld")}
      settingsLabel={t("settings")}
    />
  );
}
