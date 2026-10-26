import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "@/components/chat/markdown";
import { DocumentNavigationProvider } from "@/components/documents/document-navigation";
import { formatDocumentLink } from "@/lib/documents/document-link";
import en from "../../../messages/en.json";

function render(
  content: string,
  options: {
    isStreaming?: boolean;
    nativeMode?: "interactive" | "paper";
    nativeTurnId?: string;
    nativeOrdinalOffset?: number;
  } = {},
): string {
  return renderToString(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <MarkdownRenderer content={content} {...options} />
    </NextIntlClientProvider>,
  );
}

function renderWithNavigation(content: string): string {
  return renderToString(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <DocumentNavigationProvider value={{ onOpen: () => undefined }}>
        <MarkdownRenderer content={content} />
      </DocumentNavigationProvider>
    </NextIntlClientProvider>,
  );
}

describe("MarkdownRenderer SSR regressions", () => {
  it("preserves ordered starts, nested lists and GFM task-list props", () => {
    const html = render('2. alpha\n   - nested one\n   - nested two\n3. omega\n\n- [x] finished\n- [ ] pending');
    expect(html).toContain('<ol start="2">');
    expect(html).toContain("<ul>");
    expect(html).toContain("contains-task-list");
    expect(html).toContain("task-list-item");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("disabled");
  });

  it("renders a no-language fenced block as one CodeBlock, not inline code or a removed pre", () => {
    const html = render("```\nplain <text>\n```");
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).toContain("language-text");
    expect(html).toContain("plain &lt;text&gt;");
    expect(html).toContain(en.chat.code.fallbackLanguage);
  });

  it("keeps filename metadata, table overflow, math, and ordinary links", () => {
    const html = render("```ts:src/example.ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$x^2$\n\n[relative](./doc)");
    expect(html).toContain("src/example.ts");
    expect(html).toContain("typeset-scroll");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("katex");
    expect(html).toContain('href="./doc"');
    expect(html).not.toContain('href="./doc" target="_blank"');
  });

  it("switches a completed Mermaid fence out of the streaming source branch", () => {
    const complete = render("```mermaid\ngraph TD; A-->B;\n```", { isStreaming: false });
    expect(complete).toContain("code-block");
    expect(complete).not.toContain(en.chat.code.copyTooltip);
    expect(complete).not.toContain("<pre");
    const incomplete = render("```mermaid\ngraph TD; A-->", { isStreaming: true });
    expect(incomplete).toContain(en.chat.code.copyTooltip);
    expect(incomplete).toContain("language-mermaid");
    expect(incomplete).toContain("<pre");
  });

  it("repairs the streaming display tail without activating an unfinished destination", () => {
    const source = "A **bold** tail and [docs](https://example.com";
    const html = render(source, { isStreaming: true });
    expect(source).toBe("A **bold** tail and [docs](https://example.com");
    expect(html).toContain("<span>docs</span>");
    expect(html).not.toContain('href="https://example.com"');
    expect(html).toContain("<strong>bold</strong>");
    expect(render(`${source})`, { isStreaming: true })).toContain('href="https://example.com"');
    const bold = render("A **partial", { isStreaming: true });
    expect(bold).toContain("<strong>partial</strong>");
  });

  it("keeps reference links and one footnote definition semantic across a native island", () => {
    const html = render("See [source][ref] and a note.[^extra]\n\n```html live\n<p>visual</p>\n```\n\n[ref]: https://example.com/primary\n[^extra]: Footnote after native.", {
      nativeMode: "interactive",
      nativeTurnId: "turn-references",
    });
    expect(html).toContain('href="https://example.com/primary"');
    expect(html).toContain('data-native-block="native-0"');
    expect(html.match(/data-footnote-ref=/g)).toHaveLength(1);
    expect(html.match(/id="user-content-fn-extra"/g)).toHaveLength(1);
    expect(html.match(/Footnote after native\./g)).toHaveLength(1);
  });

  it("forwards GFM table alignment to header and body cells", () => {
    const html = render("| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |");
    expect(html.match(/style="text-align:center"/g)).toHaveLength(2);
    expect(html.match(/style="text-align:right"/g)).toHaveLength(2);
  });

  it("keeps raw HTML and every native-looking fence inert without assistant opt-in", () => {
    const html = render('<script>window.inert=true</script>\n\n```html live\n<button>also code</button>\n```\n\n```html\n<b>ordinary code</b>\n```');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("data-native-block");
    expect(html).toContain("language-html");
    expect(html).toContain("also code");
    expect(html).toContain("ordinary code");
  });

  it("activates only explicit native sections in assistant mode and preserves surrounding prose", () => {
    const html = render('Before **prose**.\n\n```html live\n<section><button>Run</button><script>window.native=true</script></section>\n```\n\nAfter prose.', {
      nativeMode: "interactive",
      nativeTurnId: "turn-1",
      nativeOrdinalOffset: 4,
    });
    expect(html).toContain("Before <strong>prose</strong>");
    expect(html).toContain("After prose.");
    expect(html).toContain('data-native-block="native-4"');
    expect(html).not.toContain("window.native=true");
  });

  it("shows a quiet pending state while open and a readable fallback at terminal EOF", () => {
    const source = "```html live\n<script>window.partial=true</script>";
    const pending = render(source, { isStreaming: true, nativeMode: "interactive", nativeTurnId: "turn" });
    expect(pending).toContain(en.chat.native.generating);
    expect(pending).not.toContain("window.partial=true");
    const ended = render(source, { isStreaming: false, nativeMode: "interactive", nativeTurnId: "turn" });
    expect(ended).toContain(en.chat.native.incomplete);
    expect(ended).toContain("data-native-incomplete");
    expect(ended).not.toContain("window.partial=true");
  });

  it("keeps an EOF closing candidate inert until EOL or terminal completion", () => {
    const source = "```html live\n<script>window.candidate=true</script>\n```";
    for (const streamed of [source, `${source}x\n`]) {
      const pending = render(streamed, { isStreaming: true, nativeMode: "interactive", nativeTurnId: "turn" });
      expect(pending).toContain(en.chat.native.generating);
      expect(pending).not.toContain("data-native-block");
      expect(pending).not.toContain("window.candidate=true");
    }
    const ended = render(`${source}\n`, { isStreaming: true, nativeMode: "interactive", nativeTurnId: "turn" });
    expect(ended).toContain('data-native-block="native-0"');
    const terminal = render(source, { isStreaming: false, nativeMode: "interactive", nativeTurnId: "turn" });
    expect(terminal).toContain('data-native-block="native-0"');
    const invalid = render(`${source}x\n`, { isStreaming: false, nativeMode: "interactive", nativeTurnId: "turn" });
    expect(invalid).toContain("data-native-incomplete");
    expect(invalid).not.toContain("window.candidate=true");
  });

  it("uses the static paper representation for native paper content", () => {
    const html = render("```html live\n<p>Paper</p>\n```", { nativeMode: "paper", nativeTurnId: "doc" });
    expect(html).toContain('data-native-mode="paper"');
    expect(html).not.toContain('data-native-mode="chat"');
  });

  it("opens only parsed semantic internal links through document navigation", () => {
    const html = renderWithNavigation("[那次讨论](previously:records/2026-10-12-1430?turn=a3fk2w&role=user)");
    expect(html).toContain(">那次讨论</a>");
    expect(html).toContain('data-document-ref="records/2026-10-12-1430"');
    expect(html).toContain('data-document-turn="a3fk2w"');
    expect(html).toContain('data-document-role="user"');
    expect(html).toContain('href="previously:records/2026-10-12-1430?turn=a3fk2w&amp;role=user"');
  });

  it("round-trips a formatted legal unmatched parenthesis through the actual Markdown parser", () => {
    const destination = formatDocumentLink("research/手机)评测(正式");
    expect(destination).toBe("previously:research/手机%29评测%28正式");
    const html = renderWithNavigation(`[完整标题](${destination})`);
    expect(html).toContain(">完整标题</a>");
    expect(html).toContain('data-document-ref="research/手机)评测(正式"');
    expect(html).toContain('href="previously:research/手机%29评测%28正式"');
  });

  it("keeps unsafe internal URLs, arbitrary schemes, and code out of trusted navigation", () => {
    for (const destination of [
      "previously:memory/docs/topic/topic",
      "previously:research/phone%2Fother",
      "previously:research/phone?role=system",
      "javascript:alert(1)",
    ]) {
      const html = renderWithNavigation(`[not an entrance](${destination})`);
      expect(html).toContain("not an entrance");
      expect(html).not.toContain("data-document-ref=");
      expect(html).not.toContain(`href="${destination}`);
    }
    const code = renderWithNavigation("`previously:records/2026-10-12-1430`");
    expect(code).toContain("<code>previously:records/2026-10-12-1430</code>");
    expect(code).not.toContain("data-document-ref=");
  });

  it("leaves ordinary external and relative link behavior untouched", () => {
    const external = renderWithNavigation("[external](https://example.com/a?x=1&y=2)");
    expect(external).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');
    const relative = renderWithNavigation("[relative](./doc)");
    expect(relative).toContain('href="./doc"');
    expect(relative).not.toContain("data-document-ref=");
  });
});
