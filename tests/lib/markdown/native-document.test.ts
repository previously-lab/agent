import { describe, expect, it } from "vitest";
import {
  buildNativeDocument,
  DEFAULT_NATIVE_THEME,
} from "@/lib/markdown/native-document";

function documentFor(source: string, interactive = true, initialStateJson: string | null = null): string {
  return buildNativeDocument({
    source,
    token: "token",
    theme: DEFAULT_NATIVE_THEME,
    locale: "en",
    interactive,
    initialStateJson,
    fallback: "Readable fallback",
  });
}

describe("native iframe document policy", () => {
  it("places the restrictive CSP before any model source or runtime", () => {
    const source = '<!DOCTYPE html><html><head><script>window.answer=42</script><style>body{color:red}</style></head><body><p>Full</p></body></html>';
    const result = documentFor(source);
    const cspAt = result.indexOf('http-equiv="Content-Security-Policy"');
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(result.indexOf("window.answer"));
    expect(cspAt).toBeLessThan(result.indexOf("previously-native-reply-v1"));
    expect(result).toContain("default-src 'none'");
    expect(result).toContain("connect-src 'none'");
    expect(result).toContain("frame-src 'none'");
    expect(result).toContain("worker-src 'none'");
    expect(result).toContain("object-src 'none'");
    expect(result).toContain("base-uri 'none'");
    expect(result).toContain("form-action 'none'");
    expect(result).toContain("script-src 'unsafe-inline'");
    expect(result).not.toContain("script-src 'self'");
    expect(result).toContain("img-src data: blob:");
    expect(result.endsWith(`${source}</body></html>`)).toBe(true);
  });

  it("keeps fragments intact and disables every script in a static paper document", () => {
    const source = '<figure><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg><script>window.paper=true</script></figure>';
    const result = documentFor(source, false);
    expect(result).toContain("script-src 'none'");
    expect(result).not.toContain("script-src 'unsafe-inline'");
    expect(result).toContain(source);
    expect(result).not.toContain("previously-native-reply-v1");
  });

  it("keeps a readable fallback for script-only sources and hides it behind static content", () => {
    const scriptOnly = '<script>document.body.dataset.scriptOnly="yes"</script>';
    expect(documentFor(scriptOnly)).toContain('<div id="previously-native-fallback" role="status">Readable fallback</div>');
    expect(documentFor(scriptOnly, false)).toContain('<div id="previously-native-fallback" role="status">Readable fallback</div>');
    expect(documentFor("<p>Readable static content</p>", false)).toContain('<div id="previously-native-fallback" role="status" hidden>Readable fallback</div>');
  });

  it("escapes restored JSON inside the runtime script instead of allowing a script breakout", () => {
    const state = JSON.stringify({ controls: [], scroll: { x: 0, y: 0 }, custom: '</script><script>window.injected=true</script>' });
    const result = documentFor("<p>safe</p>", true, state);
    expect(result).toContain("\\u003c/script");
    expect(result).not.toContain("<script>window.injected=true</script>");
    expect(result).toContain('"previously-native-reply-v1"');
  });
});
