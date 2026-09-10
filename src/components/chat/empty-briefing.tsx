"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Brain } from "lucide-react";
import { getBriefingIdentity, getPreviously } from "@/lib/episodic/actions";
import type { BriefingIdentity, SliceSummary } from "@/lib/episodic/actions";
import { MarkdownRenderer } from "./markdown";
import { PersonaDialog } from "@/components/persona/persona-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ─── Types ──────────────────────────────────────────────────────────────

interface EmptyBriefingProps {
  /** Current persona id (demo mode only — drives the persona switcher). */
  persona?: string;
  /** The most recent slice (its focus / open_loops seed the briefing). May be
   *  null before the mount fetch resolves, or for a brand-new user. */
  active: SliceSummary | null;
  /** The few most recent slices — their focuses seed suggestion chips. */
  recent: SliceSummary[];
  /** Send a message (suggestion chips). */
  onSend: (message: string) => void;
  /**
   * "full" — the standalone full-screen arrival view (empty memory only).
   * "card" — the stream-tail seat (§1.2 Rev 2): same content, but sized to its
   * content instead of centering a full viewport, so history scrolls in above.
   */
  variant?: "full" | "card";
}

interface Chip {
  label: string;
  prompt: string;
}

/** Truncate a long topic to `max` chars for a chip label. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Open loops shown in the briefing card — the rest live behind "view full previously". */
const MAX_LOOPS = 4;

/** "2026/08/17 16:44" — the slice-card timecode format. */
function eyebrowStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 1px hairline with the card's muted foreground tint (frame-card language). */
function Hairline({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`h-px w-full bg-foreground/[0.07] ${className}`}
    />
  );
}

/** A single ledger row: fixed-width uppercase key + value (frame-card language). */
function LedgerRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="w-24 shrink-0 pt-px text-[0.65rem] uppercase leading-relaxed tracking-[0.12em] text-muted-foreground/75">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-sm leading-relaxed text-foreground/90">
        {value}
      </span>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────

/**
 * The empty-live briefing — the product's "arrival" moment, in the timeline's
 * slice-card skin: a mono eyebrow row (primary square marker + letter-spaced
 * "PREVIOUSLY ON" + the active slice's timecode) over a hairline, then the
 * user's name in the serif card-title face, then ledger-style rows for the
 * hot-start summary drawn from real memory (the last topic, open threads, and
 * contextual suggestion chips), then a quiet footer. Every section only
 * renders when it has real data — nothing says "上次聊到" followed by nothing.
 * The name doubles as the persona switcher in demo mode; "view full previously"
 * opens the same Previously On dialog used by the historical slice view.
 *
 * Since §1.2 Rev 2 the briefing has two seats: "card" rides the unified
 * message stream's tail in briefing mode (history scrolls in above it); the
 * standalone "full" form remains only for a brand-new, slice-less memory.
 */
export function EmptyBriefing({
  persona,
  active,
  recent,
  onSend,
  variant = "full",
}: EmptyBriefingProps) {
  const t = useTranslations("emptyBriefing");
  const [identity, setIdentity] = useState<BriefingIdentity | null>(null);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);
  const [prevContent, setPrevContent] = useState<string | null>(null);

  // Resolve the display name (+ persona list in demo mode).
  useEffect(() => {
    let cancelled = false;
    getBriefingIdentity(persona)
      .then((id) => {
        if (!cancelled) setIdentity(id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [persona]);

  // Lazily fetch the active slice's previously.md only when the dialog opens.
  useEffect(() => {
    if (!prevOpen || !active?.slice_id || prevContent !== null) return;
    let cancelled = false;
    getPreviously(active.slice_id)
      .then((md) => {
        if (!cancelled) setPrevContent(md);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prevOpen, active, prevContent]);

  const name = identity?.name ?? "";
  const focus = active?.focus?.trim() || "";
  const openLoops = (active?.open_loops ?? []).filter((l) => l.trim().length > 0);

  // Suggestion chips — each seeded from real memory, each sends a real message.
  const chips: Chip[] = [];
  if (focus) {
    const prompt = t("chipContinue", { topic: focus });
    chips.push({ label: truncate(prompt, 30), prompt });
  }
  if (openLoops.length > 0) {
    const prompt = t("chipLoops");
    chips.push({ label: prompt, prompt });
  }
  for (const s of recent) {
    const topic = s.focus?.trim();
    if (!topic || (active && s.slice_id === active.slice_id)) continue;
    const prompt = t("chipTopic", { topic });
    chips.push({ label: truncate(prompt, 30), prompt });
    break;
  }

  // Ledger-style briefing rows — each only renders when it has real data.
  // Test data runs long, so every value clamps: the topic to 3 lines, loops
  // to 4 entries × 2 lines, chips to one truncated line. The full text is
  // always one click away ("view full previously").
  const rows: { key: string; value: React.ReactNode }[] = [];
  if (focus) {
    rows.push({
      key: t("lastTopic"),
      value: <span className="line-clamp-3 break-words">{focus}</span>,
    });
  }
  if (openLoops.length > 0) {
    rows.push({
      key: t("openLoops"),
      value: (
        <ul className="space-y-1.5">
          {openLoops.slice(0, MAX_LOOPS).map((loop, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground"
            >
              <span className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="line-clamp-2 break-words">{loop}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (chips.length > 0) {
    rows.push({
      key: t("pickUp"),
      value: (
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <button
              key={chip.prompt}
              onClick={() => onSend(chip.prompt)}
              className="max-w-full truncate rounded-full border border-foreground/15 px-3.5 py-1.5 text-xs text-foreground/75 transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              {chip.label}
            </button>
          ))}
        </div>
      ),
    });
  }

  const stamp = active?.start ? eyebrowStamp(active.start) : "";

  return (
    // Full variant: tall briefings scroll instead of clipping (the parent
    // chain is a fixed h-full). Card variant: one in-flow item, sized to
    // content. Both seats render the same slice-card face.
    <div
      className={
        variant === "card"
          ? "relative flex flex-col items-center px-4 py-10"
          : "relative flex min-h-full flex-col items-center justify-center pl-0 pr-4"
      }
    >
      {/* The slice-card face — ring + soft shadow + top light falloff, the
          same language as the timeline's FrameCard. */}
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl bg-card text-left ring-1 ring-foreground/10 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)]">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
        />

        <div className="relative px-5 py-5 sm:px-6">
          {/* ── Eyebrow row — marker square + mono eyebrow, the active
               slice's timecode on the right. ── */}
          <div className="flex items-center gap-2 text-[0.65rem] leading-none tracking-[0.08em] text-muted-foreground">
            <span
              aria-hidden
              className="inline-block size-1.5 shrink-0 rounded-[1px] bg-primary"
            />
            <span className="font-mono uppercase tracking-[0.35em]">
              {t("eyebrow")}
            </span>
            {stamp && (
              <span className="ml-auto font-mono tabular-nums text-muted-foreground/60">
                {stamp}
              </span>
            )}
          </div>

          <Hairline className="mt-4" />

          {/* ── Title — the user's name in the slice card's serif face. ── */}
          {identity?.isDemo ? (
            <button
              onClick={() => setPersonaOpen(true)}
              className="mt-4 block max-w-full text-left font-serif text-3xl font-light tracking-tight break-words text-card-foreground transition-colors hover:text-foreground/60 sm:text-4xl"
            >
              {name}
            </button>
          ) : (
            <h2 className="mt-4 font-serif text-3xl font-light tracking-tight break-words text-card-foreground sm:text-4xl">
              {name}
            </h2>
          )}

          {/* ── Ledger-style briefing rows. ── */}
          {rows.length > 0 && (
            <>
              <Hairline className="mt-5" />
              <div className="flex flex-col">
                {rows.map((row, i) => (
                  <div key={row.key}>
                    {i > 0 && <Hairline />}
                    <LedgerRow label={row.key} value={row.value} />
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── View the full previously — a quiet footer row. ── */}
          {active?.slice_id && (
            <>
              <Hairline className="mt-2" />
              <div className="flex items-center justify-between pt-3">
                <button
                  onClick={() => setPrevOpen(true)}
                  className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  {t("viewFull")} →
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Persona switcher (demo mode) ─────────────────────────────── */}
      {identity?.isDemo && identity.personas && (
        <PersonaDialog
          personas={identity.personas}
          currentId={persona ?? ""}
          open={personaOpen}
          onOpenChange={setPersonaOpen}
        />
      )}

      {/* ── Previously On dialog (same component family as the slice view) ── */}
      <Dialog open={prevOpen} onOpenChange={setPrevOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Brain className="size-4" />
              Previously On
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm leading-relaxed">
            {prevContent ? (
              <MarkdownRenderer content={prevContent} />
            ) : (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t("loading")}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
