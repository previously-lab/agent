# Document-System Notation (v0.15 §2)

## Overview

The machine-checkable foundation of the document system: the closed type/kind
enumeration, the file-name discipline (file name IS the identity), the
three-field frontmatter + dated-entry-stream body notation, and reference
normalization. Design: `doc/design/v0.15-document-system.md` (esp. §2, §5, §8).

**This module is pure functions only** — no I/O, no LLM, no module state.
Writers (librarian, 书记段, background stream) and readers (`listDocs` /
`readDoc`) built on top of it own all filesystem access; they hold the
per-doc lock and validate names through `isValidDocFileName` before writing.

## Invariants (the whole point of the module)

- **File name = identity**, set at birth: `<出生日期>-<标题>.md` for the eight
  dated kinds, `<名字>.md` for `topic`. Never renamed / moved / deleted /
  reused. No id system, no index file, no registry.
- **The structural red line** (§5): a document file name must never pass the
  slice-id validation (`YYYY-MM-DD-HHMM`). `isValidDocFileName` enforces it —
  a dated title may not start with four digits, so `2026-09-05-1234.md` is
  rejected. Topic names obey the same rule. Writers MUST validate through it.
- **Machine state is exactly three frontmatter fields** — `status`
  (`active|closed|void`, closed set), `opened`, `updated` — plus the body
  notation: an append-only `## <date> — <条目名>` entry stream and one
  截至块 (`> 截至 <date>：…`). Nothing else: no `id` / `type` / `topics` /
  `superseded_by` / aliases fields, ever (§2.3, §8).
- **Tolerant parsing is a contract**: a broken document always parses —
  problems become `warnings`, unrecognized bytes are kept in `raw` sections
  so re-serialization loses nothing. A document must never be unopenable.
- **Entry stream is append-only**; the 截至块 is the only rewritable body
  region. `void` requires a dated 作废 entry already in the stream.
- References are file names, never paths; a dead reference is visible when
  read, never blocking.

## File Map

| File | Role |
|------|------|
| `types.ts` | Closed enumerations (`DOC_KINDS` nine, `DATED_DOC_KINDS` eight, `DOC_STATUSES` three) and the `ParsedDoc` / `DocEntry` / `DocAsOf` shapes |
| `naming.ts` | File-name discipline: `isValidDocFileName` (the red-line enforcement point), `parseDocFileName`, `buildDocFileName`, `isValidDate` |
| `document.ts` | Body notation: tolerant `parseDoc`, `serializeDoc`, and the pure write-ops `createDocSkeleton` / `appendEntry` / `rewriteAsOf` / `markStatus` |
| `references.ts` | `normalizeDocRef` (any citation text → canonical file name), `docPathCandidates` (docs-root-relative glob candidates for a file name) |
| `index.ts` | Barrel export |

The one-shot migration of the 54 strand entities into `docs/topic/` lives at
`scripts/migrate-strands-to-docs.mjs` (default dry-run; `--apply` to write).

## Export API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `isValidDocFileName` | `(fileName: string, kind: DocKind) => boolean` | **The naming validator / red-line enforcement point.** Legal doc file name? Dated kinds: real `YYYY-MM-DD` + non-empty title not starting with 4 digits; topic: non-empty name not starting with 4 digits. All kinds: `.md` suffix, no path separators/traversal/edge whitespace. |
| `parseDocFileName` | `(fileName: string, kind: DocKind) => ParsedDocFileName \| null` | Split a valid name into `{ date, title }` (`date` null for topic); null when illegal. |
| `buildDocFileName` | `(kind: DocKind, date: string, title: string) => string` | Build + validate a new document's file name; throws on an illegal result (writer's last-resort guard). |
| `isValidDate` | `(date: string) => boolean` | Real calendar day in `YYYY-MM-DD` (rejects 2026-13-40). |
| `startsWithFourDigits` | `(title: string) => boolean` | The single naming rule guarding the slice-id namespace. |
| `parseDoc` | `(raw: string, fileName: string, kind: DocKind) => ParsedDoc` | Tolerant parse — warnings, never exceptions; unrecognized body bytes kept in `raw` sections. |
| `serializeDoc` | `(doc: ParsedDoc) => string` | Emit exactly the three machine frontmatter fields + body; entries verbatim, nothing silently dropped. |
| `createDocSkeleton` | `(input: { fileName, kind, opened, heading? }) => ParsedDoc` | Seed a new doc (status `active`, `updated` = birth date). |
| `appendEntry` | `(doc: ParsedDoc, entry: { date, title, body }) => ParsedDoc` | Append-only entry; never touches existing sections; restamps `updated`. Returns a new doc. |
| `rewriteAsOf` | `(doc: ParsedDoc, asOf: { date, text }) => ParsedDoc` | Rewrite the 截至块 (the only in-place-writable region); restamps `updated`. Returns a new doc. |
| `markStatus` | `(doc: ParsedDoc, status: DocStatus, date: string) => ParsedDoc` | Flip status; `void` throws unless a dated 作废 entry exists; restamps `updated`. Returns a new doc. |
| `normalizeDocRef` | `(ref: string) => string \| null` | Citation text → canonical `<文件名>.md`: strips 《》, directory prefixes, appends `.md`. |
| `docPathCandidates` | `(fileName: string) => string[]` | Docs-root-relative candidates `memory/docs/<kind>/<fileName>` for all nine kinds — glob to resolve (kind is not encoded in the name). |

Constants: `DOC_KINDS` (9), `DATED_DOC_KINDS` (8), `DOC_STATUSES`
(`active|closed|void`), `SLICE_ID_PATTERN` (reference only — the red line is
enforced by `isValidDocFileName`, not by comparing against it).

## Design Decisions

- **Kind is positional, not stored.** The directory under `memory/docs/` is
  the kind; the file carries no `type` field (re-stating it would only
  drift). `parseDoc` takes `kind` from the caller, who learned it from the
  directory.
- **Warnings over exceptions on read, exceptions on write.** Reading must
  never fail (axiom: docs must always open); write-ops throw on contract
  violations (bad date, empty entry title, `void` without a 作废 entry)
  because a writer that can't state its own date is broken, not the doc.
- **Round-trip preserves substance, not bytes.** Frontmatter is re-emitted
  in canonical form (exactly the three fields, dates quoted); the body is
  kept line-faithful through `sections`.
- **Dates in entry bodies are writer-supplied**, validated only for shape
  (`YYYY-MM-DD` + real calendar day). Honesty of dates is a writer
  discipline; the structure makes dishonesty visible, not impossible.
