import { hashString } from "./seed";

export const ROOM_PROFILE_VERSION = 1 as const;
export const ROOM_PROFILE_RULE_VERSION = "room-activity-rules-v1" as const;

export const ROOM_ACTIVITIES = [
  "neutral",
  "writing",
  "research",
  "making",
  "planning",
  "conversation",
  "reflection",
] as const;

export type RoomActivity = (typeof ROOM_ACTIVITIES)[number];
export type FunctionalRoomActivity = Exclude<RoomActivity, "neutral">;

export const FUNCTIONAL_ROOM_ACTIVITIES = ROOM_ACTIVITIES.filter(
  (activity): activity is FunctionalRoomActivity => activity !== "neutral",
);

export const ROOM_PRIMARY_MODULES = [
  "study",
  "reading-room",
  "workshop",
  "living",
  "sunroom",
] as const;

export type RoomPrimaryModule = (typeof ROOM_PRIMARY_MODULES)[number];

export const ROOM_PRIMARY_MODULE_BY_ACTIVITY: Readonly<
  Record<RoomActivity, RoomPrimaryModule | null>
> = {
  neutral: null,
  writing: "study",
  research: "reading-room",
  making: "workshop",
  planning: "study",
  conversation: "living",
  reflection: "sunroom",
};

export const ROOM_EVIDENCE_SOURCES = [
  "focus",
  "summary",
  "tags",
  "decisions",
  "open_loops",
  "user_turns",
] as const;

export type RoomEvidenceSource = (typeof ROOM_EVIDENCE_SOURCES)[number];
export type RoomEvidenceLabel = `${RoomEvidenceSource}:${FunctionalRoomActivity}`;

export const ROOM_EVIDENCE_LABELS: readonly RoomEvidenceLabel[] =
  ROOM_EVIDENCE_SOURCES.flatMap((source) =>
    FUNCTIONAL_ROOM_ACTIVITIES.map(
      (activity) => `${source}:${activity}` as RoomEvidenceLabel,
    ),
  );

export interface RoomProfile {
  readonly version: typeof ROOM_PROFILE_VERSION;
  readonly ruleVersion: typeof ROOM_PROFILE_RULE_VERSION;
  readonly activity: RoomActivity;
  readonly primaryModule: RoomPrimaryModule | null;
  readonly revision: string;
  readonly evidence: readonly RoomEvidenceLabel[];
}

export interface RoomProfileTurn {
  readonly role: string;
  readonly content: string;
}

export interface RoomProfileInput {
  readonly focus?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly decisions?: readonly string[];
  readonly open_loops?: readonly string[];
  readonly openLoops?: readonly string[];
  /** Already-read user text only; agent/system/tool turns are never inferred. */
  readonly userTurns?: readonly string[];
  /** A TimeSlice can be passed directly; only its user turns are considered. */
  readonly turns?: readonly RoomProfileTurn[];
}

const EVIDENCE_ORDER = new Map<RoomEvidenceLabel, number>(
  ROOM_EVIDENCE_LABELS.map((label, index) => [label, index]),
);
const ACTIVITY_IDS = new Set<string>(ROOM_ACTIVITIES);
const PRIMARY_MODULE_IDS = new Set<string>(ROOM_PRIMARY_MODULES);
const EVIDENCE_IDS = new Set<string>(ROOM_EVIDENCE_LABELS);
const PROFILE_KEYS = new Set([
  "version",
  "ruleVersion",
  "activity",
  "primaryModule",
  "revision",
  "evidence",
]);

function canonicalEvidence(
  evidence: readonly RoomEvidenceLabel[],
): RoomEvidenceLabel[] {
  return [...evidence].sort(
    (a, b) => (EVIDENCE_ORDER.get(a) ?? 0) - (EVIDENCE_ORDER.get(b) ?? 0),
  );
}

function revisionFor(
  activity: RoomActivity,
  evidence: readonly RoomEvidenceLabel[],
): string {
  if (activity === "neutral") return `v${ROOM_PROFILE_VERSION}-neutral`;
  const semantic = [
    ROOM_PROFILE_RULE_VERSION,
    activity,
    ...canonicalEvidence(evidence),
  ].join("|");
  return `v${ROOM_PROFILE_VERSION}-${hashString(semantic)
    .toString(16)
    .padStart(8, "0")}`;
}

function makeProfile(
  activity: FunctionalRoomActivity,
  evidence: readonly RoomEvidenceLabel[],
): RoomProfile {
  const canonical = canonicalEvidence(evidence);
  return Object.freeze({
    version: ROOM_PROFILE_VERSION,
    ruleVersion: ROOM_PROFILE_RULE_VERSION,
    activity,
    primaryModule: ROOM_PRIMARY_MODULE_BY_ACTIVITY[activity],
    revision: revisionFor(activity, canonical),
    evidence: Object.freeze(canonical),
  });
}

export const NEUTRAL_ROOM_PROFILE: RoomProfile = Object.freeze({
  version: ROOM_PROFILE_VERSION,
  ruleVersion: ROOM_PROFILE_RULE_VERSION,
  activity: "neutral",
  primaryModule: null,
  revision: revisionFor("neutral", []),
  evidence: Object.freeze([]),
});

export function primaryModuleForActivity(
  activity: RoomActivity,
): RoomPrimaryModule | null {
  return ROOM_PRIMARY_MODULE_BY_ACTIVITY[activity];
}

function profileProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "expected an object";
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== PROFILE_KEYS.size || keys.some((key) => !PROFILE_KEYS.has(key))) {
    return "unknown or missing fields";
  }
  if (candidate.version !== ROOM_PROFILE_VERSION) return "unknown schema version";
  if (candidate.ruleVersion !== ROOM_PROFILE_RULE_VERSION) return "unknown rule version";
  if (
    typeof candidate.activity !== "string" ||
    candidate.activity.length > 24 ||
    !ACTIVITY_IDS.has(candidate.activity)
  ) {
    return "unknown activity";
  }
  const activity = candidate.activity as RoomActivity;
  if (
    candidate.primaryModule !== null &&
    (typeof candidate.primaryModule !== "string" ||
      candidate.primaryModule.length > 32 ||
      !PRIMARY_MODULE_IDS.has(candidate.primaryModule))
  ) {
    return "unknown primary module";
  }
  if (candidate.primaryModule !== ROOM_PRIMARY_MODULE_BY_ACTIVITY[activity]) {
    return "primary module does not match activity";
  }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length > ROOM_EVIDENCE_SOURCES.length) {
    return "invalid evidence payload";
  }
  if (activity === "neutral" && candidate.evidence.length !== 0) {
    return "neutral profile cannot carry evidence";
  }
  if (activity !== "neutral" && candidate.evidence.length === 0) {
    return "functional profile needs evidence";
  }
  const seen = new Set<string>();
  for (const label of candidate.evidence) {
    if (
      typeof label !== "string" ||
      label.length > 48 ||
      !EVIDENCE_IDS.has(label) ||
      seen.has(label) ||
      !label.endsWith(`:${activity}`)
    ) {
      return "unknown or inconsistent evidence";
    }
    seen.add(label);
  }
  const evidence = candidate.evidence as RoomEvidenceLabel[];
  if (
    typeof candidate.revision !== "string" ||
    candidate.revision.length > 64 ||
    candidate.revision !== revisionFor(activity, evidence)
  ) {
    return "invalid semantic revision";
  }
  return null;
}

export function validateRoomProfile(value: unknown): value is RoomProfile {
  return profileProblem(value) === null;
}

/** Parse an untrusted CurrentView-style snapshot into a fresh bounded value. */
export function parseRoomProfile(value: unknown): RoomProfile {
  if (!validateRoomProfile(value)) {
    throw new Error("Invalid RoomProfile snapshot");
  }
  if (value.activity === "neutral") return NEUTRAL_ROOM_PROFILE;
  return makeProfile(value.activity, value.evidence);
}

interface ActivityRule {
  readonly pattern: RegExp;
  readonly weight: 1 | 2;
}

const WRITING_OBJECTS =
  "(?:essay|article|story|novel|manuscript|paper|chapter|poem|fiction|prose|ending)";
const WRITING_DETERMINER = "(?:an?|the|my|your|our|his|her|their|this|that)";

const RULES: Readonly<Record<FunctionalRoomActivity, readonly ActivityRule[]>> = {
  writing: [
    {
      pattern: /写\s*作|创\s*作|撰\s*写|撰\s*稿|写\s*稿|写\s*(?:小说|文章|论文|书稿|章节|故事|散文|诗歌)|书\s*稿|润\s*色/,
      weight: 2,
    },
    {
      pattern: new RegExp(
        `\\b(?:write|writes|wrote|draft|compose|author)\\s+(?:${WRITING_DETERMINER}\\s+)?${WRITING_OBJECTS}\\b`,
      ),
      weight: 2,
    },
    {
      pattern: new RegExp(
        `\\b(?:writing|drafting|authoring|composing)\\s+(?:${WRITING_DETERMINER}\\s+)?${WRITING_OBJECTS}\\b`,
      ),
      weight: 2,
    },
    {
      pattern: new RegExp(
        `\\b(?:rewrite|rewriting|revise|revising|edit|editing)\\s+(?:${WRITING_DETERMINER}\\s+)?${WRITING_OBJECTS}\\b`,
      ),
      weight: 2,
    },
    { pattern: /\bwriting\b(?!\s+(?:code|software|tests?|functions?))/, weight: 2 },
    { pattern: /\b(?:manuscript|draft|drafting)\b/, weight: 1 },
    { pattern: /稿\s*件/, weight: 1 },
  ],
  research: [
    {
      pattern: /阅\s*读|查\s*阅|查\s*找\s*资料|研\s*读|文\s*献|参\s*考\s*书|资\s*料\s*(?:检\s*索|查\s*找|对\s*比|比\s*较|分\s*析)/,
      weight: 2,
    },
    {
      pattern: /调\s*研|研\s*究|比\s*较|对\s*比|理\s*解\s*(?:资料|文章|文献|论文|概念|代码)/,
      weight: 2,
    },
    {
      pattern: /\b(?:read|reading|research|researching|compare|comparing|comparison|literature|references)\b/,
      weight: 2,
    },
    { pattern: /\b(?:study|studying|understand|understanding|review|reviewing)\b/, weight: 1 },
  ],
  making: [
    {
      pattern: /制\s*作|开\s*发|修\s*复|修\s*理|调\s*试|实\s*现|编\s*程|写\s*代码|构\s*建|编\s*译|排\s*错|改\s*装|做\s*项\s*目/,
      weight: 2,
    },
    {
      pattern: /\b(?:build|building|develop|developing|implement|implementing|fix|fixing|repair|repairing|debug|debugging|code|coding|program|programming|refactor|refactoring)\b/,
      weight: 2,
    },
    { pattern: /手\s*工|维\s*护|代\s*码|工\s*作\s*台/, weight: 1 },
    { pattern: /\b(?:make|making|hack|hacking|prototype|prototyping)\b/, weight: 1 },
  ],
  planning: [
    {
      pattern: /计\s*划|规\s*划|安\s*排|日\s*程|决\s*策|决\s*定|优\s*先\s*级|路\s*线\s*图|待\s*办|筹\s*备|取\s*舍/,
      weight: 2,
    },
    {
      pattern: /\b(?:plan|planning|schedule|scheduling|roadmap|prioriti[sz]e|prioriti[sz]ing|decision|decide|deciding|itinerary|agenda)\b/,
      weight: 2,
    },
  ],
  conversation: [
    {
      pattern: /聊\s*天|聊\s*聊|沟\s*通|交\s*流|关\s*系|相\s*处|倾\s*诉|陪\s*伴|人\s*际|友\s*谊|感\s*情|争\s*执|分\s*歧/,
      weight: 2,
    },
    {
      pattern: /讨\s*论\s*(?:关系|相处|沟通|感情|友谊|家庭|人际|分歧)/,
      weight: 2,
    },
    {
      pattern: /\b(?:chat|chatting|talk|talking|conversation|relationship|relationships|communicate|communication|friendship|vent|venting)\b/,
      weight: 2,
    },
    { pattern: /朋\s*友|家\s*人|伴\s*侣|父\s*母|同\s*事/, weight: 1 },
    {
      pattern: /\b(?:friend|friends|family|partner|parents|colleague|coworker|listen|listening)\b/,
      weight: 1,
    },
  ],
  reflection: [
    {
      pattern: /回\s*顾|反\s*思|日\s*记|复\s*盘|回\s*忆|自\s*省|往\s*事|整\s*理\s*(?:经历|回忆|日记|思绪|过去)|总\s*结\s*(?:今天|这一天|过去|经历)/,
      weight: 2,
    },
    {
      pattern: /\b(?:reflect|reflecting|reflection|journal|journaling|diary|retrospective|memories)\b/,
      weight: 2,
    },
    { pattern: /\b(?:look|looking)\s+back\b/, weight: 2 },
    { pattern: /\b(?:recall|recalling)\b/, weight: 1 },
  ],
};

const CJK_NEGATION =
  "(?:不\\s*想|不\\s*要|不\\s*再|不\\s*是|没\\s*有|别|停\\s*止|不\\s*(?!只\\s*是|仅))\\s*(?:想\\s*)?";
const EN_NEGATION =
  "\\b(?:don\\s*t\\s+(?:want\\s+to\\s+)?|do\\s+not\\s+(?:want\\s+to\\s+)?|never\\s+|stop\\s+|not\\s+(?!only\\b))";

function negationFor(cjk: string, english: string): RegExp {
  return new RegExp(`(?:${CJK_NEGATION}(?:${cjk}))|(?:${EN_NEGATION}(?:${english}))`);
}

const NEGATIONS: Readonly<Record<FunctionalRoomActivity, RegExp>> = {
  writing: negationFor(
    "写\\s*作|创\\s*作|撰\\s*写|写\\s*稿|写\\s*(?:小说|文章|论文|书|代码)|润\\s*色",
    "write|writing|draft|drafting|author|authoring|compose|composing|rewrite|rewriting|revise|revising|edit|editing",
  ),
  research: negationFor(
    "阅\\s*读|查\\s*阅|调\\s*研|研\\s*究|查\\s*找\\s*资料|比\\s*较|对\\s*比|理\\s*解",
    "read|reading|research|researching|compare|comparing|study|studying|understand|understanding|review|reviewing",
  ),
  making: negationFor(
    "工\\s*作|制\\s*作|开\\s*发|修\\s*复|修\\s*理|调\\s*试|实\\s*现|编\\s*程|写\\s*代码|构\\s*建|维\\s*护|手\\s*工",
    "work|working|make|making|build|building|develop|developing|implement|implementing|fix|fixing|repair|repairing|debug|debugging|code|coding|program|programming|refactor|refactoring",
  ),
  planning: negationFor(
    "计\\s*划|规\\s*划|安\\s*排|做\\s*决\\s*定|决\\s*定|决\\s*策",
    "plan|planning|schedule|scheduling|decide|deciding|decision|roadmap|prioriti[sz]e|prioriti[sz]ing|itinerary|agenda",
  ),
  conversation: negationFor(
    "聊\\s*天|聊\\s*聊|沟\\s*通|交\\s*流|讨\\s*论|倾\\s*诉",
    "chat|chatting|talk|talking|conversation|communicate|communication|relationship|friendship|vent|venting",
  ),
  reflection: negationFor(
    "回\\s*顾|反\\s*思|日\\s*记|复\\s*盘|回\\s*忆|自\\s*省",
    "reflect|reflecting|journal|journaling|look\\s+back|diary|retrospective|recall|recalling",
  ),
};

const SOURCE_WEIGHTS: Readonly<Record<RoomEvidenceSource, number>> = {
  focus: 4,
  summary: 3,
  tags: 2,
  decisions: 2,
  open_loops: 2,
  user_turns: 2,
};

const MINIMUM_SCORE = 4;
const MINIMUM_MARGIN = 2;

const USER_TURN_LIMIT = 4;
const USER_TURN_SCAN_LIMIT = 12;
const CLAUSE_SEPARATOR_RE = /[。！？；，.!?;,\n]+/;
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\\\\|\/)?(?:[\w.-]+[\\/])+[\w.-]+/g;
const FUNCTION_CALL_RE = /\b[A-Za-z_$][\w$]*\([^()\n]{0,160}\)/g;
const DOTTED_IDENTIFIER_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g;
const SNAKE_IDENTIFIER_RE = /\b[A-Za-z_$][\w$]*_[\w$]+\b/g;

function maskSemanticNoise(value: string): string {
  return value
    .replace(PATH_TOKEN_RE, " ")
    .replace(FUNCTION_CALL_RE, " ")
    .replace(DOTTED_IDENTIFIER_RE, " ")
    .replace(SNAKE_IDENTIFIER_RE, " ");
}

function normalizeClause(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function semanticClauses(value: string, limit: number): string[] {
  return maskSemanticNoise(value.slice(0, limit))
    .split(CLAUSE_SEPARATOR_RE)
    .map(normalizeClause)
    .filter((clause) => clause.length > 0);
}

function normalizeEntries(
  values: readonly string[] | undefined,
  count: number,
  chars: number,
): string[] {
  if (!values) return [];
  return values.slice(0, count).flatMap((value) => semanticClauses(value, chars));
}

function sourceTexts(input: RoomProfileInput): Record<RoomEvidenceSource, string[]> {
  return {
    focus: normalizeEntries([input.focus ?? ""], 1, 1200),
    summary: normalizeEntries([input.summary ?? ""], 1, 1200),
    tags: normalizeEntries(input.tags, 8, 200),
    decisions: normalizeEntries(input.decisions, 8, 600),
    open_loops: normalizeEntries(input.open_loops ?? input.openLoops, 8, 600),
    user_turns: [],
  };
}

function recentUserTurnTexts(input: RoomProfileInput): string[] {
  if (input.userTurns) return input.userTurns.slice(-USER_TURN_LIMIT);
  const turns = input.turns;
  if (!turns) return [];
  const selected: string[] = [];
  for (
    let index = turns.length - 1, scanned = 0;
    index >= 0 && scanned < USER_TURN_SCAN_LIMIT && selected.length < USER_TURN_LIMIT;
    index--, scanned++
  ) {
    const turn = turns[index];
    if (turn.role !== "user") continue;
    selected.push(turn.content);
  }
  return selected.reverse();
}

function withRecentUserTurns(
  texts: Record<RoomEvidenceSource, string[]>,
  input: RoomProfileInput,
): Record<RoomEvidenceSource, string[]> {
  const turns = recentUserTurnTexts(input);
  const normalized = normalizeEntries(turns, USER_TURN_LIMIT, 800);
  return normalized.length > 0 ? { ...texts, user_turns: normalized } : texts;
}

interface ActivityEvaluation {
  readonly scores: Map<FunctionalRoomActivity, number>;
  readonly supportingSources: Map<FunctionalRoomActivity, Set<RoomEvidenceSource>>;
  readonly hasPositiveCue: boolean;
}

function evaluateTexts(texts: Record<RoomEvidenceSource, string[]>): ActivityEvaluation {
  const scores = new Map<FunctionalRoomActivity, number>(
    FUNCTIONAL_ROOM_ACTIVITIES.map((activity) => [activity, 0]),
  );
  const supportingSources = new Map<FunctionalRoomActivity, Set<RoomEvidenceSource>>();
  let hasPositiveCue = false;

  for (const source of ROOM_EVIDENCE_SOURCES) {
    for (const activity of FUNCTIONAL_ROOM_ACTIVITIES) {
      const eligible = texts[source].filter((text) => !NEGATIONS[activity].test(text));
      if (eligible.length === 0) continue;
      let ruleScore = 0;
      for (const rule of RULES[activity]) {
        if (eligible.some((text) => rule.pattern.test(text))) ruleScore += rule.weight;
      }
      if (ruleScore === 0) continue;
      hasPositiveCue = true;
      scores.set(activity, (scores.get(activity) ?? 0) + SOURCE_WEIGHTS[source] * ruleScore);
      const sources = supportingSources.get(activity) ?? new Set<RoomEvidenceSource>();
      sources.add(source);
      supportingSources.set(activity, sources);
    }
  }
  return { scores, supportingSources, hasPositiveCue };
}

function profileFromEvaluation(evaluation: ActivityEvaluation): RoomProfile {
  let winner: FunctionalRoomActivity | null = null;
  let highest = 0;
  let runnerUp = 0;
  for (const activity of FUNCTIONAL_ROOM_ACTIVITIES) {
    const score = evaluation.scores.get(activity) ?? 0;
    if (score > highest) {
      runnerUp = highest;
      highest = score;
      winner = activity;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!winner || highest < MINIMUM_SCORE || highest - runnerUp < MINIMUM_MARGIN) {
    return NEUTRAL_ROOM_PROFILE;
  }

  const sources = evaluation.supportingSources.get(winner) ?? new Set<RoomEvidenceSource>();
  const evidence = ROOM_EVIDENCE_SOURCES.filter((source) => sources.has(source)).map(
    (source) => `${source}:${winner}` as RoomEvidenceLabel,
  );
  return makeProfile(winner, evidence);
}

/** Bounded, deterministic rules over semantic fields — never over a room seed. */
export function deriveRoomProfile(input: RoomProfileInput): RoomProfile {
  const texts = sourceTexts(input);
  const structured = evaluateTexts(texts);
  const direct = profileFromEvaluation(structured);
  if (direct.activity !== "neutral") return direct;

  const mayFallback = texts.summary.length === 0 || !structured.hasPositiveCue;
  if (!mayFallback) return NEUTRAL_ROOM_PROFILE;
  const withTurns = withRecentUserTurns(texts, input);
  if (withTurns === texts) return NEUTRAL_ROOM_PROFILE;
  return profileFromEvaluation(evaluateTexts(withTurns));
}
