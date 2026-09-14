/**
 * Cached `Intl` formatters.
 *
 * WHY. Constructing an `Intl.DateTimeFormat` is not cheap — the spec has the
 * implementation resolve locale data on construction, and V8 does real work
 * every time. The chat stream built a fresh one inside the RENDER path of
 * every seam and every scroll-transient indicator update, which put
 * `formatSeamDate` among the top self-time entries of a scroll CPU profile
 * even though the formatting it performs is trivial. The formatter is the
 * cost; the format is not.
 *
 * WHAT IS CACHED. The formatter, keyed by locale plus the option SHAPE — not
 * the formatted string. Formatting still happens per call, because the input
 * (a timestamp) changes every time; what is being reused is the resolved
 * locale data behind it.
 *
 * THE CACHE IS NEVER EVICTED, which is safe because the key is a SHAPE rather
 * than a value. Every option in this app is either a literal (`month: "short"`)
 * or one of two low-cardinality runtime values — `timeZone` (a user has one)
 * and a `sameYear` flag that is folded into the shape on purpose. So the key
 * space is (locales × shapes × timezones in use) and does not grow with the
 * data being formatted.
 *
 * The invariant to hold when adding a call site: nothing that varies per
 * FORMATTED VALUE may go into the options. A date does not; a locale does not.
 * If you need such a value, branch on it OUTSIDE the options object and pass
 * the branch as a boolean, the way `sameYear` does — that keeps the shape
 * count fixed and makes the two shapes explicit at the call site.
 */

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The cache key: the locale plus the option shape, with keys sorted so that
 * two callers writing the same options in a different order share one entry.
 * `undefined` values are dropped — they mean the same as absent, and keeping
 * them would split the shape in two.
 */
function keyOf(locale: string, options: Intl.DateTimeFormatOptions): string {
  const parts: string[] = [];
  for (const name of Object.keys(options).sort()) {
    const value = options[name as keyof Intl.DateTimeFormatOptions];
    if (value === undefined) continue;
    parts.push(`${name}=${String(value)}`);
  }
  return `${locale}${parts.join(",")}`;
}

/**
 * `new Intl.DateTimeFormat(locale, options)`, reused across calls with the
 * same locale and option shape. A drop-in replacement — see the module note
 * for the invariant that keeps the cache bounded.
 */
export function dateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = keyOf(locale, options);
  const hit = dateTimeCache.get(key);
  if (hit) return hit;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeCache.set(key, formatter);
  return formatter;
}

/** How many formatters are held — for tests, and for a caller that wants to
 *  assert its own cache discipline rather than trust it. */
export function formatterCacheSize(): number {
  return dateTimeCache.size;
}
