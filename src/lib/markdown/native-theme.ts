import type { NativeStylesSnapshot } from "@/lib/chat/native-bridge";

/** Static Tailwind source AND the iframe's supported class contract. No palette
 * values live here: rules are selected from the host's compiled CSSOM. */
export const NATIVE_UTILITY_CLASSES = `
block inline inline-block hidden flex inline-flex grid
relative absolute inset-0 overflow-auto overflow-hidden overflow-x-auto
w-full w-auto min-w-0 max-w-full h-auto h-full
flex-row flex-col flex-wrap flex-1 shrink-0 grow
items-start items-center items-end justify-start justify-center justify-end justify-between
grid-cols-1 grid-cols-2 grid-cols-3 grid-cols-4 col-span-2
gap-1 gap-2 gap-3 gap-4 gap-6 gap-8 space-y-2 space-y-3 space-y-4
p-0 p-1 p-2 p-3 p-4 p-6 p-8 px-2 px-3 px-4 px-6 py-1 py-2 py-3 py-4
m-0 mx-auto mt-2 mt-4 mb-2 mb-4
text-xs text-sm text-base text-lg text-xl text-2xl text-3xl
font-normal font-medium font-semibold font-bold font-sans font-serif font-mono
leading-tight leading-normal leading-relaxed text-left text-center text-right
tabular-nums break-words whitespace-pre-wrap truncate
bg-background bg-foreground bg-card bg-muted bg-primary bg-primary/10 bg-primary/90
bg-secondary bg-accent bg-destructive bg-transparent
text-foreground text-card-foreground text-muted-foreground text-primary text-primary-foreground
text-secondary-foreground text-accent-foreground text-destructive
border border-0 border-2 border-t border-b border-border border-input border-primary
rounded rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl rounded-full
shadow-sm shadow-md opacity-50 opacity-75 cursor-pointer cursor-not-allowed
accent-primary underline no-underline underline-offset-4
outline-none ring-2 ring-ring ring-offset-2 ring-offset-background
transition-colors transition-opacity duration-150 duration-200
hover:bg-primary/90 hover:bg-muted hover:bg-accent hover:text-accent-foreground hover:underline
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
disabled:opacity-50 disabled:cursor-not-allowed
sm:grid-cols-2 sm:flex-row md:grid-cols-2 md:grid-cols-3 md:grid-cols-4
motion-reduce:transition-none
`.trim().split(/\s+/);

const utilityNames = new Set(NATIVE_UTILITY_CLASSES);
export const NATIVE_STYLES_MAX_CHARS = 262_144;
export const NATIVE_THEME_MAX_VARIABLES = 1_024;
export const NATIVE_THEME_VALUE_MAX_CHARS = 4_096;

function hasSupportedClass(selector: string): boolean {
  return [...selector.matchAll(/\.((?:\\.|[\w-])+)/g)]
    .some((match) => utilityNames.has(match[1].replace(/\\/g, "")));
}

/** Keep Tailwind's token/property/reset layers and the supported utilities,
 * including media/variant wrappers. Exclude application layouts, font URLs,
 * imports, and unrelated component styles. Never fetch inaccessible sheets. */
export function selectNativeStyleRules(rules: CSSRuleList | readonly CSSRule[]): string {
  return Array.from(rules).map((rule): string => {
    const text = rule.cssText;
    if (/^@(?:import|font-face|charset)\b/i.test(text)) return "";
    if (/^@property\s/.test(text) || /^@layer\s+(?:theme|properties|base)\s*\{/.test(text)) return text;
    if ("selectorText" in rule) {
      return hasSupportedClass(String(rule.selectorText)) ? text : "";
    }
    if ("cssRules" in rule) {
      const inner = selectNativeStyleRules((rule as CSSGroupingRule).cssRules);
      return inner ? `${text.slice(0, text.indexOf("{"))}{${inner}}` : "";
    }
    return /^@layer\s+[^{}]+;$/.test(text) ? text : "";
  }).filter(Boolean).join("\n");
}

interface StyleCache {
  dirty: boolean;
  sheets: CSSStyleSheet[];
  lengths: number[];
  snapshot: NativeStylesSnapshot;
  subscribers: Set<() => void>;
}
const styleCaches = new WeakMap<Document, StyleCache>();

function cacheFor(doc: Document): StyleCache {
  let cache = styleCaches.get(doc);
  if (cache) return cache;
  cache = { dirty: true, sheets: [], lengths: [], snapshot: { id: "", cssText: "" }, subscribers: new Set() };
  styleCaches.set(doc, cache);
  const notify = () => {
    cache.dirty = true;
    for (const subscriber of cache.subscribers) subscriber();
  };
  // One observer per document, not one stylesheet serialization per iframe.
  // Theme/root class changes do not invalidate CSS: only stylesheet changes do.
  if (doc.head && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver((changes) => {
      if (changes.some((change) => {
        const element = change.target instanceof Element ? change.target : change.target.parentElement;
        if (element?.closest("style,link[rel=stylesheet]")) return true;
        return [...change.addedNodes, ...change.removedNodes].some((node) =>
          node instanceof Element && (node.matches("style,link[rel=stylesheet]") || !!node.querySelector("style,link[rel=stylesheet]")));
      })) notify();
    });
    observer.observe(doc.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "media", "disabled"] });
    doc.head.addEventListener("load", (event) => {
      if (event.target instanceof Element && event.target.matches("link[rel=stylesheet]")) notify();
    }, true);
  }
  return cache;
}

function styleId(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `native-css-${text.length}-${(hash >>> 0).toString(36)}`;
}

/** Cached, filtered copies of the CSS actually loaded by this deployment. */
export function readNativeStyles(doc: Document = document): NativeStylesSnapshot {
  const cache = cacheFor(doc);
  const sheets = [...Array.from(doc.styleSheets), ...Array.from(doc.adoptedStyleSheets ?? [])].filter((sheet) => !sheet.disabled);
  const rules = sheets.map((sheet) => { try { return sheet.cssRules; } catch { return null; } });
  const lengths = rules.map((list) => list?.length ?? -1);
  if (!cache.dirty && sheets.length === cache.sheets.length &&
      sheets.every((sheet, index) => sheet === cache.sheets[index] && lengths[index] === cache.lengths[index])) return cache.snapshot;
  let cssText = "@layer theme, base, components, utilities;\n";
  for (let index = 0; index < rules.length; index++) {
    const list = rules[index];
    if (!list) continue;
    const selected = selectNativeStyleRules(list);
    const media = sheets[index].media?.mediaText;
    cssText += media ? `@media ${media}{${selected}}\n` : `${selected}\n`;
  }
  if (cssText.length > NATIVE_STYLES_MAX_CHARS) throw new Error("Native theme stylesheet exceeds its bounded snapshot size");
  cache.dirty = false;
  cache.sheets = sheets;
  cache.lengths = lengths;
  if (cache.snapshot.cssText !== cssText) cache.snapshot = { id: styleId(cssText), cssText };
  return cache.snapshot;
}

/** CSS hot updates and newly loaded sheets; callers send only a changed id. */
export function subscribeNativeStyles(listener: () => void, doc: Document = document): () => void {
  const cache = cacheFor(doc);
  cache.subscribers.add(listener);
  return () => { cache.subscribers.delete(listener); };
}

export function readNativeCssVariables(styles: CSSStyleDeclaration): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const name of Array.from(styles)) {
    if (!/^--[a-zA-Z0-9_-]+$/.test(name) || Object.keys(variables).length >= NATIVE_THEME_MAX_VARIABLES) continue;
    const value = styles.getPropertyValue(name).trim();
    if (value && value.length <= NATIVE_THEME_VALUE_MAX_CHARS) variables[name] = value;
  }
  return variables;
}

/** Custom properties normally resolve var() in computed style already. Keep
 * a bounded fallback for font-token chains in older engines/test surfaces. */
export function resolveNativeCssValue(value: string, styles: CSSStyleDeclaration): string {
  let current = value;
  for (let depth = 0; depth < 12 && /var\(/.test(current); depth++) {
    const next = current.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
      (_match, name: string, fallback?: string) => styles.getPropertyValue(name).trim() || fallback || "");
    if (next === current) break;
    current = next;
  }
  return current;
}
