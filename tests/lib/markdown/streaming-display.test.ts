import { describe, expect, it } from "vitest";
import { repairStreamingMarkdown } from "@/lib/markdown/streaming-display";

describe("repairStreamingMarkdown", () => {
  it("appends nothing to already-complete sources", () => {
    for (const source of [
      "",
      "plain text\n",
      "text **bold** and `code`\n",
      "[a](https://example.com) done\n",
      "```ts\nconst a = 1;\n```\n",
      "~~~py\nx = 1\n~~~\n",
      "<div>\n<b>raw html</b>\n",
      "text\n",
      "\\**not bold\\*\n",
      "a **b\nc\n",
      "5 * 3 * 2\n",
    ]) {
      expect(repairStreamingMarkdown(source)).toBe(source);
    }
  });

  it("completes an unclosed trailing bold on the last line only", () => {
    expect(repairStreamingMarkdown("text **bold")).toBe("text **bold**");
    expect(repairStreamingMarkdown("done **bold**\nnext **open")).toBe("done **bold**\nnext **open**");
    // Earlier completed lines are not reanimated or rewritten.
    expect(repairStreamingMarkdown("a **b\nc")).toBe("a **b\nc");
  });

  it("completes unclosed inline code but leaves complete spans alone", () => {
    expect(repairStreamingMarkdown("use `code")).toBe("use `code`");
    expect(repairStreamingMarkdown("use `code`")).toBe("use `code`");
    expect(repairStreamingMarkdown("a `x` and `y")).toBe("a `x` and `y`");
  });

  it("completes an incomplete trailing Markdown link", () => {
    expect(repairStreamingMarkdown("see [docs](https://x")).toBe("see [docs](https://x)");
    expect(repairStreamingMarkdown("see [docs](")).toBe("see [docs]()");
    expect(repairStreamingMarkdown("see [docs](https://x)")).toBe("see [docs](https://x)");
    expect(repairStreamingMarkdown("see [docs]")).toBe("see [docs]");
    // A bold-looking run inside the link destination is left alone.
    expect(repairStreamingMarkdown("see [docs](https://x **")).toBe("see [docs](https://x **)");
  });

  it("closes bold before a trailing link as )** so the URL stays intact", () => {
    expect(repairStreamingMarkdown("open **bold and [link](https://x")).toBe("open **bold and [link](https://x)**");
    expect(repairStreamingMarkdown("plain [link](https://x")).toBe("plain [link](https://x)");
  });

  it("closes an open ordinary backtick fence for display", () => {
    expect(repairStreamingMarkdown("```ts\nconst a")).toBe("```ts\nconst a\n```");
    expect(repairStreamingMarkdown("````\nbody **not-bold\n")).toBe("````\nbody **not-bold\n````");
    expect(repairStreamingMarkdown("```")).toBe("```\n```");
  });

  it("closes an open ordinary tilde fence with a matching tilde run", () => {
    expect(repairStreamingMarkdown("~~~py\nx = 1")).toBe("~~~py\nx = 1\n~~~");
  });

  it("never repairs an explicitly opened html live fence", () => {
    expect(repairStreamingMarkdown("```html live\n<div>")).toBe("```html live\n<div>");
    expect(repairStreamingMarkdown("```html live id=\"chart\"\n<x")).toBe("```html live id=\"chart\"\n<x");
    expect(repairStreamingMarkdown("prose\n```html live")).toBe("prose\n```html live");
  });

  it("never activates or completes quoted samples inside an outer fence", () => {
    const source = "````\n```html live\nsample\n";
    expect(repairStreamingMarkdown(source)).toBe(source + "````");
    const closed = "````\n```html live\nsample\n```\n````\n";
    expect(repairStreamingMarkdown(closed)).toBe(closed);
  });

  it("does not close blockquoted or list-indented fence lookalikes", () => {
    expect(repairStreamingMarkdown("> ```\nquoted")).toBe("> ```\nquoted");
    expect(repairStreamingMarkdown("- item\n  ```\nlisted")).toBe("- item\n  ```\nlisted");
  });

  it("preserves CRLF exactly and only appends after the last line", () => {
    expect(repairStreamingMarkdown("a **b\r\nc")).toBe("a **b\r\nc");
    expect(repairStreamingMarkdown("a\r\n**b")).toBe("a\r\n**b**");
    // The appended fence close reuses the source's most recent line ending.
    expect(repairStreamingMarkdown("```ts\r\nconst a")).toBe("```ts\r\nconst a\r\n```");
    expect(repairStreamingMarkdown("```ts\rconst a")).toBe("```ts\rconst a\r```");
    expect(repairStreamingMarkdown("```ts\nconst a")).toBe("```ts\nconst a\n```");
  });

  it("leaves raw HTML untouched and never makes it executable", () => {
    const source = "<div class=\"x\">\n<b>bold</b>\n";
    expect(repairStreamingMarkdown(source)).toBe(source);
  });

  it("does not repair fence lookalikes inside Markdown HTML blocks", () => {
    for (const source of [
      "<!--\n```ts\nbody **not-bold",
      "<pre>\n```html live\n<button>example</button>",
      "<div>\n```ts\nbody **not-bold",
      "<custom-element>\n```ts\nbody **not-bold",
    ]) {
      expect(repairStreamingMarkdown(source)).toBe(source);
    }
    const after = "<pre>\nhidden\n</pre>\n```ts\nbody";
    expect(repairStreamingMarkdown(after)).toBe(`${after}\n\`\`\``);
  });

  it("never inline-repairs a completed fence's closing delimiter", () => {
    for (const source of ["```ts\nconst a\n```", "~~~py\nx\n~~~", "```\nclosed **already\n```"]) {
      expect(repairStreamingMarkdown(source)).toBe(source);
    }
  });

  it("always preserves the source as an exact prefix", () => {
    const samples = [
      "text **bold",
      "use `code",
      "see [docs](https://x",
      "```ts\nconst a",
      "~~~\nx",
      "```html live\n<div",
      "a **b\nc",
      "plain",
      "a\r\n**b",
      "<div>",
      "x\n",
      "\\**literal",
      "done **bold**\nnext **open",
      "````\n```html live\nsample\n",
      "- item\n  ```\nlisted",
    ];
    for (const sample of samples) {
      const repaired = repairStreamingMarkdown(sample);
      expect(repaired.startsWith(sample)).toBe(true);
      expect(repaired.slice(0, sample.length)).toBe(sample);
    }
  });

  it("is idempotent on repaired output", () => {
    const samples = [
      "text **bold",
      "use `code",
      "see [docs](https://x",
      "open **bold and [link](https://x",
      "```ts\nconst a",
      "~~~py\nx",
      "```html live\n<div",
      "plain text",
      "a **b\nc",
      "```\nclosed **already",
    ];
    for (const sample of samples) {
      const once = repairStreamingMarkdown(sample);
      expect(repairStreamingMarkdown(once)).toBe(once);
    }
  });
});
