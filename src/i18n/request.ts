import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

// Static, not the `../../messages/${locale}.json` glob: the glob's JSON module
// was cached separately from this file, so a messages edit did not reach a
// long-running dev server until something happened to re-resolve it. Static
// imports fold the messages into THIS module's compilation, which the watcher
// re-reads on every edit. The locale set is fixed in routing.ts, so the map is
// exhaustive by construction.
const MESSAGES = { en, zh } as const;

export default getRequestConfig(async ({ requestLocale }) => {
  // Typically corresponds to the `[locale]` segment
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: MESSAGES[locale],
  };
});
