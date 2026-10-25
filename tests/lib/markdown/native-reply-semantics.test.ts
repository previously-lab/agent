import { describe, expect, it } from "vitest";
import {
  NATIVE_REPLY_OMISSION_MARKER,
  projectNativeReplySemantics,
} from "@/lib/markdown/native-reply-semantics";

describe("projectNativeReplySemantics", () => {
  it("replaces closed and incomplete native sections while preserving surrounding bytes", () => {
    const closed = "before\r\n```html live id=\"chart\"\r\n<button>generated</button>\r\n```\r\nafter";
    expect(projectNativeReplySemantics(closed, "agent")).toBe(
      `before\r\n${NATIVE_REPLY_OMISSION_MARKER}after`,
    );

    const incomplete = "before\n```html live\n<div>open";
    expect(projectNativeReplySemantics(incomplete, "assistant")).toBe(
      `before\n${NATIVE_REPLY_OMISSION_MARKER}`,
    );
  });

  it("keeps prose after a long native block visible before excerpt truncation", () => {
    const source = `before\n\`\`\`html live\n${"<button>generated</button>\n".repeat(40)}\`\`\`\nafter **decision**`;
    const projected = projectNativeReplySemantics(source, "agent");
    expect(projected).toBe(`before\n${NATIVE_REPLY_OMISSION_MARKER}after **decision**`);
    expect(projected.slice(0, 300)).toContain("after **decision**");
    expect(projected).not.toContain("generated");
  });

  it("replaces every actual native section and nothing else", () => {
    const source = "one\n```html live\nA\n```\ntwo **raw**\n```html live\nB\n```\nthree";
    expect(projectNativeReplySemantics(source, "agent")).toBe(
      `one\n${NATIVE_REPLY_OMISSION_MARKER}two **raw**\n${NATIVE_REPLY_OMISSION_MARKER}three`,
    );
  });

  it("leaves ordinary, nested, escaped, and raw HTML examples unchanged", () => {
    const samples = [
      "```html\n<button>example</button>\n```\n",
      "````text\n```html live\n<button>example</button>\n```\n````\n",
      "~~~html live\n<button>example</button>\n~~~\n",
      "\\```html live\n<button>example</button>\n\\```\n",
      "<!--\n```html live\n<button>example</button>\n```\n-->\n",
      "<pre>\n```html live\n<button>example</button>\n```\n</pre>\n",
      "<div>raw HTML stays text</div>",
    ];
    for (const source of samples) {
      expect(projectNativeReplySemantics(source, "agent")).toBe(source);
    }
  });

  it("keeps user and other non-assistant roles byte-exact", () => {
    const source = "user words\n```html live\n<button>user example</button>\n```\n";
    for (const role of ["user", "system", "tool"]) {
      expect(projectNativeReplySemantics(source, role)).toBe(source);
    }
  });

  it("does not mutate its input and is deterministic across calls", () => {
    const source = "before\n```html live\n<button>generated</button>\n```\nafter";
    const snapshot = source.slice();
    const first = projectNativeReplySemantics(source, "agent");
    const second = projectNativeReplySemantics(source, "agent");
    expect(source).toBe(snapshot);
    expect(first).toBe(second);
  });
});
