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
  "Write memory prose in the user's own language, including case titles, bodies, tail lines and current views passed through a report tool. " +
  "Keep exact quotations in their source language. Use English for developer-facing reasoning and status reports.";

/** The shared epistemic contract for every memory-document writer. */
export const DOC_EPISTEMIC_RULE = `## Evidence and uncertainty

Distinguish what the user reported, what the record directly shows, what an external source verified, your interpretation, and what remains unknown. Grounded questions, competing explanations, and honest first-person concern are welcome when their status is clear; never present an interpretation as an observed fact. Do not invent evidence or external verification. Do not perform emotion, and do not force a rigid research template. Every case category can hold this kind of understanding, not only people. Claims about the user must trace to the user's raw records, not to derived memory alone.

A recorded role establishes who wrote the words, not whether the user endorsed their content. Preserve whether the user was quoting, hypothesizing, denying, or confirming. Assistant suggestions, tool results, titles, summaries, and derived portraits cannot become confirmed user facts through repetition. Confirmation requires explicit user words in context; silence, a successful read, or your own repeated recommendation is not confirmation. Keep contrary evidence and unresolved conflicts visible.

An observation often stands on its own. When it leaves something consequential hanging, you can briefly say what you wonder, in your own voice beside the observation. “The replacement seal has only been tested cold. I wonder whether it will hold when the kiln reaches firing temperature.” Let the note end when its point is made. A catalogue of things nobody mentioned adds little.

When later evidence answers an earlier question, keep the original note and update what a reader would conclude today. A decision establishes what the person chose; describe completion when it is reported. Give the reason in their words. Naming one reason leaves the weight of other factors unknown. An answer can finish the inquiry. Call an undated note “the earlier note.” A file's opening date or the date of its current view cannot supply a missing observation date.`;

/** Shared authorship decisions; storage limits do not decide a document's subject. */
export const DOC_ORGANIZATION_RULE = `## Write for a future reader's question

Consider what this document will help its reader understand or do, and what the evidence adds. The conversation already preserves the exchange. Read relevant existing products, using their verified references. When a document already covers the material, reuse it. The same original can support a different reading question in another file. A short progress note can give the development and its source in a sentence.

A case holds a continuing subject; its pieces answer questions worth returning to independently. Inspect the available piece titles, read the relevant pieces, and reuse their exact references before opening another. A directory entry is a reading pointer, never evidence that you read or verified the piece. If a subject earns a file of its own, keep its detail there. A broader account can give the connection and a link.

Use a short dated tail for a correction or navigation, not another essay. Put an argument, procedure, comparison, or long source passage in a focused piece and link to it. Preserve quoted source wording and line breaks with its origin; keep your interpretation separate. An opening overview introduces the case and its reading paths; do not duplicate the first piece in the overview.

The current understanding explains what holds now and why, with links for supporting detail. Mention an unknown when it materially affects how a reader should interpret this account. Revise it when evidence changes that understanding or its organization, not to replay the latest conversation. Carry forward still-valid conclusions without repeating their full derivation. Date or evidence-metadata refreshes do not create another historical edition of the same prose. A changed recommendation is still a recommendation until the user explicitly adopts it.`;

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

WRONG: After careful consideration, the previously discussed approach appeared viable and produced a meaningful result.
RIGHT: On October 5 the user asked for a range test. Reading turns 3 through 5 of slice 2026-10-04-0610 returned exactly those three turns.

${DOC_EPISTEMIC_RULE}

${DOC_ORGANIZATION_RULE}`;
