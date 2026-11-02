/**
 * The memory-document language rule and house style — the SINGLE SOURCE both
 * writer surfaces reference (the chat agent's writeCase, HQ's role prompt and
 * writeSelfSop, the Previously Agent, the case-writer/scribe/research passes,
 * and the bridge housekeeping contract). Pure constants, no imports: the
 * strings interpolate into prompt template literals, so they must never
 * contain backticks.
 *
 * Distilled from the public-domain document-style-guide (ruanyf): one
 * sentence one meaning, active voice, positive statements, unambiguous
 * pronouns, no piled-up modifiers, consistent terminology — plus the two
 * WRONG→RIGHT pairs that show the register (an investigator's case note,
 * never a work order).
 */

/**
 * Which language a memory document is written in. Prompts/instructions stay
 * English; documents are for the user's re-reading, so they follow the user.
 */
export const DOC_LANGUAGE_RULE =
  "Write every memory document in the user's own language — never mix " +
  "languages within one document. Your analysis and report fields stay English.";

/** The shared epistemic contract for every memory-document writer. */
export const DOC_EPISTEMIC_RULE = `## Evidence and uncertainty

Distinguish what the user reported, what the record directly shows, what an external source verified, your interpretation, and what remains unknown. Grounded questions, competing explanations, and honest first-person concern are welcome when their status is clear; never present an interpretation as an observed fact. Do not invent evidence or external verification. Do not perform emotion, and do not force a rigid research template. Every case category can hold this kind of understanding, not only people. Claims about the user must trace to the user's raw records, not to derived memory alone.

A recorded role establishes who wrote the words, not whether the user endorsed their content. Preserve whether the user was quoting, hypothesizing, denying, or confirming. Assistant suggestions, tool results, titles, summaries, and derived portraits cannot become confirmed user facts through repetition. Confirmation requires explicit user words in context; silence, a successful read, or your own repeated recommendation is not confirmation. Keep contrary evidence and unresolved conflicts visible.`;

/** Shared authorship decisions; storage limits do not decide a document's subject. */
export const DOC_ORGANIZATION_RULE = `## Write for a future reader's question

State the new conclusion, the reader's question, and the newly available evidence before choosing to write. A new turn or a full file is not itself a reason for a new report. Short progress belongs in 1–2 conclusion sentences with records references, not another retelling of the exchange. Check server-verified existing product refs across writing flows, actually read relevant products, and choose covered when they suffice; a directory listing or a model's claim of a prior write is not proof. The same source can legitimately support different reading questions. Do not invent quotas or claim semantic deduplication is automatic.

Before writing, identify what this document will help the reader understand or do, and what new evidence or changed understanding earns the write. The conversation already preserves the exchange. If a document you actually read already covers the material, reuse it without restating it merely to complete a marker.

A case holds a continuing subject; its pieces answer questions worth returning to independently. Inspect the available piece titles, read the relevant pieces, and reuse their exact references before opening another. A directory entry is a reading pointer, never evidence that you read or verified the piece. Different questions can deserve separate pieces from the beginning, even when they are short. A different subject belongs in its own case, connected by a link.

Use a short dated tail for a correction or navigation, not another essay. Put an argument, procedure, comparison, or long source passage in a focused piece and link to it. Preserve quoted source wording and line breaks with its origin; keep your interpretation separate. An opening overview introduces the case and its reading paths; do not duplicate the first piece in the overview.

The current understanding explains what holds now, why, and what remains unresolved, with links for supporting detail. Revise it when evidence changes that understanding or its organization, not to replay the latest conversation. Carry forward still-valid conclusions without repeating their full derivation. Date or evidence-metadata refreshes do not create another historical edition of the same prose. A changed recommendation is still a recommendation until the user explicitly adopts it.`;

/** How a memory document reads — the six rules plus the two before/after pairs. */
export const DOC_HOUSE_STYLE = `## Document house style — how memory documents read

A memory document reads like an investigator's case note, never like a work order. Six rules:
1. One sentence, one meaning. When a sentence runs past ~40 words, split it.
2. Active voice over passive.
3. Positive statements over stacked negations.
4. A pronoun points at exactly one noun — when in doubt, repeat the noun.
5. Cut piled-up adjectives and filler words; when a word changes nothing, delete it.
6. A term appears in full at first use, then stays consistent — never two names for one thing.

WRONG: Regarding the previously discussed matter, it should be noted that the vendor's quotation, which was obtained through the aforementioned research, is not unlikely to be subject to change, and this is important.
RIGHT: 2026-10-05: the panel vendor quoted USD 40/unit (slice 2026-10-04-0610). The quote expires 2026-10-20 — re-confirm before ordering.

WRONG: 用户在沟通中提出了一个想法，agent 经过仔细认真的分析研究之后，觉得可以尝试一下之前被提到过的那个通道，结果发现它其实是可行的，这不是没有意义的。
RIGHT: 2026-10-05：用户让实测读片的 range 过滤。对 2026-10-04-0610 取第 3–5 轮，返回恰好三条——行为与文档一致，已记入 self/工具笔记。

${DOC_EPISTEMIC_RULE}

${DOC_ORGANIZATION_RULE}`;
