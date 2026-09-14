"use client";

/**
 * StrandFilter (Rev 8 §R8 筛选器) — the external selector for the timeline's
 * right field: 核心时间线 (everything) or a subset of strands.
 *
 * MULTI-SELECT, because the band made it worth having. Colour in the band is
 * a HIGHLIGHT now (see `ink.ts`), so "these threads, not those" is a sentence
 * the strip can actually say — every picked strand lights in its own colour and
 * the rest of the bundle stays grey. Under the old model, where all ten lines
 * carried their hue at once, picking several would have changed nothing
 * visible; that is why this is a list of picks rather than one.
 *
 * Deliberately standalone; the design intent is to merge with the global search
 * palette later.
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BRAND_INK, strandColor } from "@/lib/timeline3d/ink";
import type { StrandListItem } from "@/lib/episodic/actions";
import { ColorSquare } from "./cards";

export interface StrandFilterProps {
  strands: StrandListItem[];
  /** The current picks, in the order they were added. Empty = 核心时间线. */
  selected: readonly string[];
  /** Add or remove one strand. */
  onToggle: (strand: string) => void;
  /** Back to 核心时间线. */
  onClear: () => void;
}

/** The trigger's swatch: the brand mark when nothing is picked, the one colour
 *  when exactly one is, and up to three small squares when several are — a
 *  28 px control cannot seat a word, so it shows what the field is filtered to
 *  and nothing else. */
function TriggerSwatch({ selected }: { selected: readonly string[] }) {
  if (selected.length === 0) return <ColorSquare color={BRAND_INK} className="size-3" />;
  if (selected.length === 1)
    return <ColorSquare color={strandColor(selected[0])} className="size-3" />;
  return (
    <span className="flex items-center gap-[3px]">
      {selected.slice(0, 3).map((name) => (
        <ColorSquare key={name} color={strandColor(name)} className="size-1.5" />
      ))}
    </span>
  );
}

export function StrandFilter({
  strands,
  selected,
  onToggle,
  onClear,
}: StrandFilterProps) {
  const t = useTranslations("timeline3d.filter");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const picked = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return strands;
    return strands.filter((s) => s.name.toLowerCase().includes(q));
  }, [strands, query]);

  const label =
    selected.length === 0
      ? t("label")
      : `${t("label")}: ${selected.join(", ")}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* A SWATCH AND NOTHING ELSE. It carried the strand's name in the board
          bar for a while, and the name is the one thing here the reader does
          not need: the colour is what the band highlights those threads in, so
          the swatch IS the answer to "which one am I following", and a word
          beside it only made the bar wide enough to crowd the lens. The name
          is still in the popover, on the row that sets it, and in the
          trigger's accessible name. */}
      <PopoverTrigger
        className="pointer-events-auto flex size-7 items-center justify-center rounded-md transition-[background-color,box-shadow] duration-200 hover:bg-muted/50"
        aria-label={label}
      >
        <TriggerSwatch selected={selected} />
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-64 gap-1 p-1.5">
        <div className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("placeholder")}
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {/* The "everything" row CLEARS rather than being one more pick: the
              core timeline is the empty selection, not a strand you can also
              have alongside others. */}
          <button
            onClick={onClear}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent ${
              selected.length === 0 ? "bg-accent/70" : ""
            }`}
          >
            <ColorSquare color={BRAND_INK} className="size-2" />
            <span className="flex-1 truncate">{t("all")}</span>
            {selected.length === 0 && <Check className="size-3 shrink-0" />}
          </button>
          {visible.map((s) => {
            const on = picked.has(s.name);
            return (
              <button
                key={s.name}
                // Stays open: picking a second strand is the point of the
                // list, and a popover that closed on every click would make
                // multi-select a chore.
                onClick={() => onToggle(s.name)}
                aria-pressed={on}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent ${
                  on ? "bg-accent/70" : ""
                }`}
              >
                <ColorSquare color={strandColor(s.name)} className="size-2" />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  ×{s.count}
                </span>
                {on && <Check className="size-3 shrink-0" />}
              </button>
            );
          })}
          {visible.length === 0 && (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              {t("empty")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
