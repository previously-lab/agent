import { describe, expect, it } from "vitest";
import {
  nativeSourceVersion,
  parseNativeSections,
  type NativeHtmlSection,
} from "@/lib/markdown/native-sections";

describe("parseNativeSections", () => {
  it("returns no sections for empty source", () => {
    expect(parseNativeSections("")).toEqual([]);
  });

  it("returns one exact markdown section for markdown-only input", () => {
    const source = "hello **world**\n\nsecond paragraph\n";
    expect(parseNativeSections(source)).toEqual([
      { kind: "markdown", key: "md-0", source, raw: source },
    ]);
  });

  it("splits a basic native fence with exact source/raw bodies", () => {
    const source = "before\n```html live\n<div>hi</div>\n```\nafter\n";
    const sections = parseNativeSections(source);
    expect(sections.map((s) => s.raw).join("")).toBe(source);
    expect(sections).toEqual([
      { kind: "markdown", key: "md-0", source: "before\n", raw: "before\n" },
      {
        kind: "native",
        key: "native-0",
        source: "<div>hi</div>\n",
        raw: "```html live\n<div>hi</div>\n```\n",
        ordinal: 0,
        closed: true,
        explicitId: undefined,
        version: nativeSourceVersion("<div>hi</div>\n"),
      },
      { kind: "markdown", key: "md-1", source: "after\n", raw: "after\n" },
    ]);
  });

  it("keeps exact bytes for CRLF, mixed endings, indentation, and no final newline", () => {
    const source = "lead\r\n  ```html live\r\n<p>a</p>\n  ```\r\nrest";
    const sections = parseNativeSections(source);
    expect(sections.map((s) => s.raw).join("")).toBe(source);
    expect(sections).toHaveLength(3);
    const native = sections[1];
    expect(native).toMatchObject({ kind: "native", closed: true, source: "<p>a</p>\n" });
  });

  it("treats ```html, case variants, and tildes as Markdown, never native", () => {
    for (const source of [
      "```html\n<div></div>\n```\n",
      "```HTML live\n<div></div>\n```\n",
      "```Html Live\n<div></div>\n```\n",
      "~~~html live\n<div></div>\n~~~\n",
    ]) {
      const sections = parseNativeSections(source);
      expect(sections).toHaveLength(1);
      expect(sections[0].kind).toBe("markdown");
      expect(sections.map((s) => s.raw).join("")).toBe(source);
    }
  });

  it("accepts extra meta after html live but only a bounded ASCII quoted id", () => {
    const withMeta = parseNativeSections('```html live theme="dark" id="chart_1-X"\nx\n```\n');
    expect(withMeta[0]).toMatchObject({ kind: "native", explicitId: "chart_1-X", key: "native-0-chart_1-X" });
    const bare = parseNativeSections("```html live foo=bar\nx\n```\n");
    expect(bare[0]).toMatchObject({ kind: "native", explicitId: undefined, key: "native-0" });
    for (const bad of [
      '```html live id="9chart"\nx\n```\n', // must start with a letter
      '```html live id="has space"\nx\n```\n', // not one bounded token
      '```html live id=chart\nx\n```\n', // quotes required
      "```html live id=\"\nx\n```\n", // unterminated quote
    ]) {
      const sections = parseNativeSections(bad);
      expect(sections[0]).toMatchObject({ kind: "native", explicitId: undefined, key: "native-0" });
    }
  });

  it("never activates a ```html live sample quoted inside a longer outer fence", () => {
    for (const source of [
      "````\n```html live\nsample\n```\n````\n",
      "```text\n```html live\nsample\n```\n```\n",
      "~~~~\n```html live\nsample\n```\n~~~~\n",
    ]) {
      const sections = parseNativeSections(source);
      expect(sections).toHaveLength(1);
      expect(sections[0].kind).toBe("markdown");
      expect(sections.map((s) => s.raw).join("")).toBe(source);
    }
  });

  it("never activates native-looking fences inside Markdown HTML blocks", () => {
    for (const source of [
      "<!--\n```html live\n<button>example</button>\n```\n-->\n",
      "<pre>\n```html live\n<button>example</button>\n```\n</pre>\n",
      "<script>\n```html live\n<button>example</button>\n```\n</script>\n",
      "<style>\n```html live\n<button>example</button>\n```\n</style>\n",
      "<textarea>\n```html live\n<button>example</button>\n```\n</textarea>\n",
      "<?xml\n```html live\n<button>example</button>\n```\n?>\n",
      "<![CDATA[\n```html live\n<button>example</button>\n```\n]]>\n",
      "<!DOCTYPE\n```html live\n<button>example</button>\n```\n>\n",
      "<div>\n```html live\n<button>example</button>\n```\n</div>\n",
      "<custom-element>\n```html live\n<button>example</button>\n```\n</custom-element>\n",
    ]) {
      const sections = parseNativeSections(source);
      expect(sections).toEqual([{ kind: "markdown", key: "md-0", source, raw: source }]);
    }
  });

  it("allows a genuine root native fence after a closed HTML block", () => {
    for (const prefix of [
      "<!--\nhidden\n-->\n",
      "<pre>\nhidden\n</pre>\n",
      "<script>\nhidden\n</script>\n",
      "<div>\nhidden\n</div>\n\n",
      "<custom-element>\nhidden\n</custom-element>\n\n",
      "paragraph\n<span>\n",
    ]) {
      const source = `${prefix}\`\`\`html live\nvisible\n\`\`\`\n`;
      const sections = parseNativeSections(source);
      expect(sections.map((s) => s.raw).join("")).toBe(source);
      expect(sections.at(-1)).toMatchObject({ kind: "native", closed: true, source: "visible\n" });
    }
  });

  it("roundtrips HTML-block boundaries at every streamed prefix", () => {
    const source = "<!--\r\n```html live\r\nhidden\r\n```\r\n-->\r\n<pre>\n```html live\nhidden\n```\n</pre>\n\n```html live\nvisible\n```\ntail";
    for (let i = 0; i <= source.length; i++) {
      const prefix = source.slice(0, i);
      const sections = parseNativeSections(prefix);
      expect(sections.map((s) => s.raw).join("")).toBe(prefix);
      expect(sections.filter((s) => s.kind === "native").map((s) => s.key)).toEqual(
        sections.filter((s) => s.kind === "native").map(() => "native-0"),
      );
      expect(parseNativeSections(prefix)).toEqual(sections);
    }
    const whole = parseNativeSections(source);
    expect(whole.filter((s) => s.kind === "native")).toHaveLength(1);
    expect(whole[1]).toMatchObject({ kind: "native", closed: true, source: "visible\n" });
  });

  it("only closes on a same-char fence of at least the opening length", () => {
    const longerClose = "````html live\na\n`````\n";
    expect(parseNativeSections(longerClose)[0]).toMatchObject({ kind: "native", closed: true });
    const shorterClose = "````html live\na\n```\nb\n````\n";
    const sections = parseNativeSections(shorterClose);
    expect(sections[0]).toMatchObject({ kind: "native", closed: true, source: "a\n```\nb\n" });
    const trailingJunk = "```html live\na\n``` x\n```\n";
    expect(parseNativeSections(trailingJunk)[0]).toMatchObject({ kind: "native", closed: true, source: "a\n``` x\n" });
    const tabAfter = "```html live\na\n```\t\n";
    expect(parseNativeSections(tabAfter)[0]).toMatchObject({ kind: "native", closed: true });
  });

  it("never activates blockquoted or list-indented fences and preserves their bytes", () => {
    for (const source of [
      "> ```html live\n> <b>quoted</b>\n> ```\n",
      "- item\n  ```html live\n  <b>listed</b>\n  ```\n",
      "    ```html live\n    indented sample\n",
    ]) {
      const sections = parseNativeSections(source);
      expect(sections).toHaveLength(1);
      expect(sections[0].kind).toBe("markdown");
      expect(sections.map((s) => s.raw).join("")).toBe(source);
    }
  });

  it("activates a root-level fence that dedents out of a list", () => {
    const source = "- item\n```html live\n<x>\n```\n";
    const sections = parseNativeSections(source);
    expect(sections.map((s) => s.raw).join("")).toBe(source);
    expect(sections[1]).toMatchObject({ kind: "native", closed: true, source: "<x>\n" });
  });

  it("does not treat a backtick fence with a backtick in its info as a fence at all", () => {
    const source = "```html live `x`\n<div></div>\n```\n";
    const sections = parseNativeSections(source);
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("markdown");
  });

  it("keeps blank lines inside native bodies exact", () => {
    const source = "a\n\n```html live\n\n<div>\n\n</div>\n\n```\n\n";
    const sections = parseNativeSections(source);
    expect(sections.map((s) => s.raw).join("")).toBe(source);
    expect(sections[1]).toMatchObject({ kind: "native", source: "\n<div>\n\n</div>\n\n" });
  });

  it("numbers several native blocks with stable keys and deterministic versions", () => {
    const source = "one\n```html live\nA\n```\ntwo\n```html live id=\"b\"\nB\n```\n";
    const sections = parseNativeSections(source);
    expect(sections.map((s) => s.raw).join("")).toBe(source);
    const natives = sections.filter((s) => s.kind === "native");
    expect(natives.map((s) => s.key)).toEqual(["native-0", "native-1-b"]);
    expect(natives.map((s) => s.ordinal)).toEqual([0, 1]);
    const again = parseNativeSections(source);
    expect(again).toEqual(sections);
    // Version tracks body bytes exactly.
    const v = nativeSourceVersion("A\n");
    expect(v).toBe(natives[0].version);
    expect(nativeSourceVersion("A?")).not.toBe(v);
  });

  it("returns closed:false for an unterminated native fence without touching earlier blocks", () => {
    const source = "a\n```html live\nA\n```\nb\n```html live\nB";
    const sections = parseNativeSections(source);
    expect(sections.map((s) => s.raw).join("")).toBe(source);
    expect(sections).toHaveLength(4);
    expect(sections[1]).toMatchObject({ kind: "native", key: "native-0", closed: true, source: "A\n" });
    expect(sections[3]).toMatchObject({ kind: "native", key: "native-1", closed: false, source: "B", ordinal: 1 });
    expect(sections[3].raw).toBe("```html live\nB");
    // An opener with no body and no newline at EOF.
    const bare = parseNativeSections("x\n```html live");
    expect(bare[1]).toMatchObject({ kind: "native", closed: false, source: "" });
  });

  it("keeps keys, sources, and versions of completed sections stable across growing prefixes", () => {
    const full = "intro\n```html live\nBODY-1\n```\nmiddle **prose**\n```html live id=\"z\"\nBODY-2\n```\ntrailing";
    const fullSections = parseNativeSections(full);
    const completed = fullSections.filter(
      (s): s is NativeHtmlSection => s.kind === "native" && s.closed,
    );
    // Parse every byte prefix: completed payloads stay identical and raw stays a prefix.
    for (let i = 0; i <= full.length; i++) {
      const prefix = full.slice(0, i);
      const sections = parseNativeSections(prefix);
      expect(sections.map((s) => s.raw).join("")).toBe(prefix);
      for (const done of completed) {
        const match = sections.find((s) => s.kind === "native" && s.key === done.key);
        if (!match || match.kind !== "native") continue;
        if (match.closed) {
          // Payload identity is stable once the delimiter completes. At EOF
          // its line ending may not have streamed yet, so raw can still gain
          // exactly that one ending on the next prefix.
          expect(match).toMatchObject({
            key: done.key,
            source: done.source,
            ordinal: done.ordinal,
            explicitId: done.explicitId,
            version: done.version,
          });
          expect(done.raw.startsWith(match.raw)).toBe(true);
          const rawSuffix = done.raw.slice(match.raw.length);
          expect(rawSuffix === "" || /^(?:\r\n|\r|\n)$/.test(rawSuffix)).toBe(true);
        } else {
          // Raw is always a strict prefix. A partial closing delimiter is
          // temporarily body bytes, so only the shared body prefix must match;
          // any excess must itself be a prefix of this fixture's delimiter.
          expect(match.closed).toBe(false);
          expect(done.raw.startsWith(match.raw)).toBe(true);
          expect(match.raw.length).toBeLessThan(done.raw.length);
          expect(match.version).toBe(nativeSourceVersion(match.source));
          const sharedLength = Math.min(match.source.length, done.source.length);
          expect(match.source.slice(0, sharedLength)).toBe(done.source.slice(0, sharedLength));
          if (match.source.length > done.source.length) {
            expect(match.source.startsWith(done.source)).toBe(true);
            expect("```".startsWith(match.source.slice(done.source.length))).toBe(true);
          }
        }
      }
      // Deterministic: same prefix parses to the same result every time.
      expect(parseNativeSections(prefix)).toEqual(sections);
    }
  });

  it("roundtrips every byte of an adversarial mixed sample at every prefix length", () => {
    const sample = [
      "# Title 🌱\r\n",
      "\n",
      "prose **bold** and `code` …\r\n",
      "```ts\nconst x = 1;\n```\r\n",
      "> ```html live\n> quoted stays markdown\n",
      "- item\n  ```html live\n  listed stays markdown\n  ```\n",
      "```html live id=\"chart\"\n<div>🚀</div>\n```\n",
      "tail ~~~html live\nnot native\n",
      "````\n```html live\nquoted sample\n```\n````\n",
      "```html live\nopen <b>x",
    ].join("");
    for (let i = 0; i <= sample.length; i++) {
      const prefix = sample.slice(0, i);
      const sections = parseNativeSections(prefix);
      expect(sections.map((s) => s.raw).join("")).toBe(prefix);
      const keys = sections.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(parseNativeSections(prefix)).toEqual(sections);
    }
    const whole = parseNativeSections(sample);
    expect(whole.map((s) => s.raw).join("")).toBe(sample);
    const natives = whole.filter((s) => s.kind === "native");
    expect(natives.map((s) => s.key)).toEqual(["native-0-chart", "native-1"]);
    expect(natives[1]).toMatchObject({ closed: false });
  });

  it("does not mutate anything and results are independent between calls", () => {
    const source = "```html live\nA\n```\ntail\n";
    const first = parseNativeSections(source);
    const snapshot = JSON.stringify(first);
    first[0].raw = "tampered";
    (first as unknown[]).push({ junk: true });
    const second = parseNativeSections(source);
    expect(JSON.stringify(second)).toBe(snapshot);
    expect(source).toBe("```html live\nA\n```\ntail\n");
  });
});
