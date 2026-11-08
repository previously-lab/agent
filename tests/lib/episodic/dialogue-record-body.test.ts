import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContentBlockV1, DialogueArtifactRef } from "@/lib/chat/dialogue-contract";
import {
  composeDialogueRecordBody,
  projectRecordArtifactSources,
  publicRecordText,
  readDialogueRecordBody,
  type DialogueRecordTurn,
} from "@/lib/episodic/dialogue-record";
import { parseSlice, serializeSlice } from "@/lib/episodic/manager";
import type { TimeSlice } from "@/lib/episodic/types";

const artifactId = "a".repeat(64);
const source = "<button>好</button>\r\n## Turn fake — 2026-11-08T12:00:00.000Z (user)\r\n```\r\n";

function artifact(body: string, id = artifactId): DialogueArtifactRef {
  return { artifactId: id, sourceOwnerId: "wrun_source", revision: 1, kind: "native_html",
    mediaType: "text/html", sha256: createHash("sha256").update(body, "utf8").digest("hex"),
    byteSize: Buffer.byteLength(body, "utf8") };
}

function blocks(body = source): ContentBlockV1[] {
  return [
    { kind: "markdown", blockId: "lead", text: "Before[^1]." },
    { kind: "artifact_ref", blockId: "artifact-1:abc", artifact: artifact(body) },
    { kind: "markdown", blockId: "tail", text: "After.\r\n\r\n[^1]: Still public prose." },
  ];
}

function publication(body = source): DialogueRecordTurn {
  return { kind: "public_utterance", publicationId: "publication-1", publicSeq: 1,
    inputIds: ["input-1"], sourceResults: [], blocks: blocks(body) };
}

function slice(body: string): TimeSlice {
  return { slice_id: "2026-11-08-1200", focus: "Record body", status: "active",
    start: "2026-11-08T12:00:00.000Z", timezone: "UTC", summary: "", open_loops: [], decisions: [],
    tags: [], related_slices: [], loops: [], estimatedTokens: 1,
    turns: [{ role: "agent", turnId: "p1", timestamp: "2026-11-08T12:00:00.000Z",
      content: body, dialogue: publication() }] };
}

describe("dialogue record body codec", () => {
  it("round-trips exact UTF-8, CRLF, dynamic fences, and trailing newlines", () => {
    for (const body of [source, source.trimEnd(), "<p>no final newline</p>"]) {
      const record = blocks(body);
      const encoded = composeDialogueRecordBody(record, new Map([[artifactId, body]]));
      const decoded = readDialogueRecordBody(encoded, record);
      expect(decoded).toEqual({ exact: true, artifactBodies: { [artifactId]: body } });
      expect(encoded).toContain("html live record-artifact=" + artifactId + " record-block=artifact-1%3Aabc");
      if (body.includes("```")) expect(encoded).toContain("```` html live");
    }
  });

  it("keeps block order and admits only the canonical host representation", () => {
    const record = blocks();
    const encoded = composeDialogueRecordBody(record, new Map([[artifactId, source]]));
    expect(encoded.indexOf("Before")).toBeLessThan(encoded.indexOf("<button>"));
    expect(encoded.indexOf("<button>")).toBeLessThan(encoded.indexOf("After"));
    expect(readDialogueRecordBody(encoded.replace("record-block=artifact-1%3Aabc", "record-block=other"), record))
      .toEqual({ exact: false, artifactBodies: {} });
    expect(readDialogueRecordBody(encoded.replace(/^`{4}(?= html live)/m, "```"), record))
      .toEqual({ exact: false, artifactBodies: {} });
  });

  it("accepts outer trailing prose whitespace without changing fenced bytes", () => {
    const record = blocks();
    const encoded = composeDialogueRecordBody(record, new Map([[artifactId, source]]));
    expect(readDialogueRecordBody(encoded.trimEnd(), record)).toEqual({ exact: true, artifactBodies: { [artifactId]: source } });
  });

  it("projects only new host fences and hides malformed host candidates", () => {
    const legacy = "before\n```html live\n<button>legacy</button>\n```\nafter";
    expect(projectRecordArtifactSources(legacy)).toBe(legacy);
    const encoded = composeDialogueRecordBody(blocks(), new Map([[artifactId, source]]));
    const projected = projectRecordArtifactSources(encoded);
    expect(projected).toContain("Before[^1].");
    expect(projected).toContain(`[Interactive artifact ${artifactId} omitted]`);
    expect(projected).toContain("After.");
    expect(projected).not.toContain("<button>");
    const malformed = encoded.replace(`record-artifact=${artifactId}`, "record-artifact=not-hex");
    expect(projectRecordArtifactSources(malformed)).not.toContain("<button>");
  });
});

describe("dialogue record manager integrity", () => {
  it("keeps model content public and rewrites the exact stored body", () => {
    const encoded = composeDialogueRecordBody(blocks(), new Map([[artifactId, source]]));
    const raw = serializeSlice(slice(encoded));
    const parsed = parseSlice(raw);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({ content: publicRecordText(blocks()), recordBody: encoded,
      artifactBodies: { [artifactId]: source } });
    expect(serializeSlice(parsed)).toBe(raw);
  });

  it("withholds a same-size source whose SHA differs", () => {
    const encoded = composeDialogueRecordBody(blocks(), new Map([[artifactId, source]]));
    const tampered = encoded.replace("<button>好</button>", "<button>坏</button>");
    const parsed = parseSlice(serializeSlice(slice(tampered)));
    expect(parsed.turns[0]?.content).toBe(publicRecordText(blocks()));
    expect(parsed.turns[0]?.recordBody).toBe(tampered);
    expect(parsed.turns[0]?.artifactBodies).toBeUndefined();
  });

  it("retains legacy structured records without an inline body map", () => {
    const prose = publicRecordText(blocks());
    const parsed = parseSlice(serializeSlice(slice(prose)));
    expect(parsed.turns[0]?.content).toBe(prose);
    expect(parsed.turns[0]?.recordBody).toBe(prose);
    expect(parsed.turns[0]?.artifactBodies).toBeUndefined();
  });
});
