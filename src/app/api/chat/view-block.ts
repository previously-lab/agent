/**
 * The per-turn view block (v0.13 §5 视野注入) — the VOLATILE half of the
 * design, built in housekeeping (steps.ts) and injected by the workflow into
 * the OUTBOUND tail of the last user message, exactly like the machine
 * context section (buildMachineContextSection in turn-workflow.ts, the
 * copied pattern).
 *
 * ONE compact block per turn, ONLY when the client sent a `view` (a slice IS
 * selected). The lobby default sends none — the stable system prompt already
 * states it (SPACE_FICTION_BLOCK), so a missing block needs no explanation.
 *
 * Hard rules (design §5):
 *   - the block never enters the user's message TEXT — it rides a marked
 *     section on the outbound copy; the persisted slice turn keeps only what
 *     the user typed (steps.ts appends `lastUserMessage`, never this);
 *   - never persisted to memory — a view block leaking into a slice would be
 *     permanent garbage, and it would poison the client-history match;
 *   - keep it small: a slice id, a timestamp, and ONE clause.
 *
 * Sources (never a second description language):
 *   - room: the pure `describeRoom(sliceId)` — the SAME function the agent
 *     has as a tool, derived from the same pure chain the renderer builds the
 *     room from, so the clause cannot contradict the room. The full outline
 *     stays behind the tool; only a one-line fact clause rides the turn.
 *   - card: plain data facts from the canonical timeline catalog (the card
 *     IS a data visualization): tags, strands, the gap to the previous slice.
 */

import { describeRoom, type RoomDescription } from "@/lib/game/describe-room";
import type { TimelineIndex } from "@/lib/episodic";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import type { CurrentView } from "@/lib/chat/current-view";

/** "2026-09-13 15:30" — the slice's START rendered in the user's local zone. */
function sliceLocalLabel(sliceId: string, timezone: string): string {
  const parsed = parseSliceId(sliceId);
  if (!parsed) return sliceId;
  const iso =
    `${parsed.y}-${parsed.m}-${parsed.d}T` +
    `${parsed.hm.slice(0, 2)}:${parsed.hm.slice(2)}:00.000Z`;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone && timezone.trim() ? timezone : "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .format(new Date(iso))
      .replace(", ", " ");
  } catch {
    // Unknown zone — fall back to the id's own (UTC) wall clock.
    return `${parsed.y}-${parsed.m}-${parsed.d} ${parsed.hm.slice(0, 2)}:${parsed.hm.slice(2)}`;
  }
}

const ARCH_ZH: Record<RoomDescription["archetype"], string> = {
  meadow: "草甸",
  plains: "原野",
  pool: "水池",
  forest: "森林",
  ocean: "海洋",
  lake: "湖泊",
  beach: "海滩",
  snowfield: "雪原",
  "hotel-room": "客房",
  "pool-hall": "泳池厅",
  library: "图书馆",
  ballroom: "舞厅",
  ducks: "鸭子",
  cats: "猫",
  dogs: "狗",
  balloons: "气球",
};

const REGISTER_ZH: Record<RoomDescription["lightRegister"], string> = {
  tungsten: "钨丝灯",
  fluorescent: "荧光灯",
  daylight: "日光",
  ember: "余烬",
};

/** One-clause room fact line from describeRoom's data — nothing invented. */
function buildRoomClause(desc: RoomDescription, locale: string): string {
  const zh = locale === "zh";
  const archetype = zh ? ARCH_ZH[desc.archetype] : desc.archetype;
  const light = zh ? REGISTER_ZH[desc.lightRegister] : desc.lightRegister;
  const dims = `${Math.round(desc.extent)}×${Math.round(desc.width)}m`;
  const water =
    desc.water && desc.water.coverage > 0
      ? zh
        ? "，一角有水"
        : ", water in one corner"
      : "";
  const open = desc.walled
    ? ""
    : zh
      ? "，无围墙"
      : ", unwalled";
  return zh
    ? `${archetype}，${dims}，${light}${water}${open}`
    : `${archetype}, ${dims}, ${light}${water}${open}`;
}

/** One-clause card fact line: tags, strand membership, gap to the previous
 *  slice — plain catalog data, the card's own visualization vocabulary. */
function buildCardClause(
  sliceId: string,
  timezone: string,
  locale: string,
  index: TimelineIndex | null,
): string {
  const zh = locale === "zh";
  const entry = index?.slices.find((s) => s.id === sliceId) ?? null;
  if (!entry) {
    // Today's active slice (or a slice the catalog hasn't woven yet) — the
    // conversation slice itself usually IS this; name the state, don't invent
    // facts.
    return zh ? "这是当前活动的时间片，目录尚无条目" : "today's active slice — no catalog entry yet";
  }
  const facts: string[] = [];
  if (entry.tags.length > 0) {
    facts.push(zh ? `标签：${entry.tags.join("、")}` : `tags: ${entry.tags.join(", ")}`);
  }
  facts.push(
    entry.strands.length > 0
      ? zh
        ? `线索：${entry.strands.join("、")}`
        : `strands: ${entry.strands.join(", ")}`
      : zh
        ? "核心时间线"
        : "core timeline",
  );
  // Gap to the previous slice: the newest CLOSED slice that ended before this
  // one began. Absent for the very first slice.
  const prev = (index?.slices ?? [])
    .filter((s) => s.status === "closed" && s.id < sliceId && s.end)
    .reduce<TimelineIndex["slices"][number] | null>(
      (max, s) => (max && max.id > s.id ? max : s),
      null,
    );
  if (prev?.end) {
    const gapMin = Math.round(
      (Date.parse(entry.start) - Date.parse(prev.end)) / 60_000,
    );
    if (gapMin > 0) {
      if (gapMin < 90) {
        facts.push(zh ? `距前一片约 ${gapMin} 分钟` : `~${gapMin} min after the previous slice`);
      } else if (gapMin < 48 * 60) {
        facts.push(
          zh
            ? `距前一片约 ${Math.round(gapMin / 60)} 小时`
            : `~${Math.round(gapMin / 60)} h after the previous slice`,
        );
      } else {
        facts.push(
          zh
            ? `距前一片约 ${Math.round(gapMin / (24 * 60))} 天`
            : `~${Math.round(gapMin / (24 * 60))} days after the previous slice`,
        );
      }
    }
  }
  return facts.join(zh ? "｜" : " | ");
}

/**
 * Build the turn's view block — "\n\n[当前] …" so it lands on its own
 * paragraph on the outbound tail. Pure: slice data in, one marked line out.
 * `index` is the already-read timeline catalog (no extra I/O).
 */
export function buildViewBlock(opts: {
  view: CurrentView;
  timezone: string;
  locale: string;
  index: TimelineIndex | null;
}): string {
  const { view, timezone, locale, index } = opts;
  const zh = locale === "zh";
  const label = sliceLocalLabel(view.sliceId, timezone);
  const clause =
    view.surface === "room"
      ? buildRoomClause(describeRoom(view.sliceId), locale)
      : buildCardClause(view.sliceId, timezone, locale, index);
  return zh
    ? view.surface === "room"
      ? `\n\n[当前] 用户正处于时间片 ${label}（${view.sliceId}）的房间内 —— ${clause}。`
      : `\n\n[当前] 用户正在看时间片 ${label}（${view.sliceId}）的卡片 —— ${clause}。`
    : view.surface === "room"
      ? `\n\n[Current] The user is standing in the room of time slice ${label} (${view.sliceId}) — ${clause}.`
      : `\n\n[Current] The user is looking at the card of time slice ${label} (${view.sliceId}) — ${clause}.`;
}
