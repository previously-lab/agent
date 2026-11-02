import { describe, expect, it } from "vitest";
import { buildNativeContainer } from "@/lib/markdown/native-container";

describe("trusted native container", () => {
  it("keeps authored markup inside the opaque child instead of the trusted relay", () => {
    const document = '<script>parent.document.body.remove()</script><p title="example">Readable</p>';
    const html = buildNativeContainer({ document, token: '</script><script>forged()</script>', title: 'Figure "one"', interactive: true });
    expect(html).toContain("frame-src 'none'");
    expect(html).not.toContain("navigate-to");
    expect(html).not.toContain(document);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const assignment = html.match(/frame\.srcdoc=(.*);/);
    expect(JSON.parse(assignment![1])).toBe(document);
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-popups");
    expect(html).not.toContain("allow-top-navigation");
  });
  it("makes static copies script-free at both document and iframe boundaries", () => {
    const html = buildNativeContainer({ document: '<p>Print</p><script>run()</script>', token: "unused", title: '<img src="bad">', interactive: false });
    expect(html).toContain("script-src 'none'");
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("allow-scripts");
  });
});
