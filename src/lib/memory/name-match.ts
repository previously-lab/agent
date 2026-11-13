/**
 * Punctuation the NFKC fold does not touch, mapped to a canonical ASCII
 * form: 、。… the dash family, and the CJK quote marks. (NFKC itself already
 * folds the full-width ASCII shapes （），：；！？ to half-width.)
 */
const CJK_PUNCT_MAP: Record<string, string> = {
  "、": ",",
  "。": ".",
  "…": ".",
  "—": "-",
  "–": "-",
  "―": "-",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "−": "-",
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
};

/**
 * The name-normalization both sides go through before comparison: NFKC,
 * case fold, CJK punctuation map, collapse runs of identical punctuation,
 * strip ALL whitespace. Pure and total.
 */
export function normalizeRecallName(s: string): string {
  const folded = s.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of folded) out += CJK_PUNCT_MAP[ch] ?? ch;
  return out
    .replace(/([\p{P}\p{S}])\1+/gu, "$1")
    .replace(/\s+/g, "");
}

/** Levenshtein beyond this length is skipped — bigram dice covers long names. */
const NAME_SCORE_LEN_CAP = 64;

/** Char-bigram Dice coefficient — the CJK-friendly similarity signal. */
function bigramDice(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

/** 1 − (edit distance / max length), two-row DP, bounded by NAME_SCORE_LEN_CAP. */
function levenshteinRatio(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (Math.max(n, m) > NAME_SCORE_LEN_CAP) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= m; j += 1) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[m]! / Math.max(n, m);
}

/**
 * Similarity of two ALREADY-normalized names in [0, 1] — the strongest of:
 * substring containment (length-weighted), char-bigram Dice, Levenshtein
 * ratio. Every signal is O(len²) at worst and length-capped.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  let score = 0;
  if (a.includes(b) || b.includes(a)) {
    const short = Math.min(a.length, b.length);
    const long = Math.max(a.length, b.length);
    score = 0.55 + 0.45 * (short / long);
  }
  return Math.max(score, bigramDice(a, b), levenshteinRatio(a, b));
}

/** Score public names and paths; return zero for unrelated candidates. */
export function navigationNameScore(candidate: string, query: string): number {
  const a = normalizeRecallName(candidate);
  const b = normalizeRecallName(query);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const fit = b.length / a.length;
  if (a.startsWith(b)) return 0.88 + 0.1 * fit;
  if (a.includes(b)) return 0.72 + 0.15 * fit;
  if (Array.from(b).length < 3 || Array.from(a).length < 3) return 0;
  const score = Math.max(bigramDice(a, b), levenshteinRatio(a, b));
  return score >= 0.56 ? Math.min(0.71, score * 0.8) : 0;
}
