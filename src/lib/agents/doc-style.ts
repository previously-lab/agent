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
RIGHT: 2026-10-05：用户要求实测 HQ 通道。简报发出后返回 delivered: started（同一 runId）——通道可用，已记入 self/HQ 联动。`;
