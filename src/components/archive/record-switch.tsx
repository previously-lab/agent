"use client";

/**
 * The record switch (v0.28) — the reachability half of the record pile. The
 * pile opens its bucket's NEWEST slice; this floating control lists the
 * bucket's OTHER records while a transcript is on the desk, each opening its
 * own document. A bucket with one record sprouts nothing (the pile's open
 * already reaches it).
 *
 * THE IDIOM IS THE LIBRARY'S (library-control.tsx), not a new surface: a
 * `pointer-events-none` wrapper at a fixed seat, the toggle `ISLAND`, the
 * panel an AnimatePresence dialog with its own close control, Escape claimed
 * so the desk's backstop keeps the document down. The seat is mid-left, one
 * toggle-height below the library's — the left edge is where DOCUMENTS are
 * picked (the shelf's tree, now the bucket's records); the bottom-left bar
 * with its ‹ n/m › readout turns PAGES inside one document. Different seat,
 * different icon, different label: the two can never be read as one control.
 *
 * THE ROW'S CLOCK is the record paper's own convention (desk-model.ts's
 * masthead): the slice id IS the local wall clock at birth
 * (YYYY-MM-DD-HHMM), so the row prints the id's own HH:MM digits — never a
 * UTC conversion.
 *
 * THE DATA is one records-only read (`getArchiveRecords` — the case
 * aggregation would be wasted here) per OPENED record, bucketed client-side
 * by the field's own rule (`recordSiblings`, archive-model.ts): the bucket
 * frame's NOW is the reader's local day, which only the client knows.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { Files, X } from "lucide-react";
import { ISLAND, ISLAND_CONTROL } from "@/components/layout/island";
import { useShell } from "@/components/shell/shell-provider";
import {
  getArchiveRecords,
  type ArchiveRecord,
} from "@/lib/archive/actions";
import { parseRecordRef } from "@/lib/archive/refs";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import {
  bucketKeyFor,
  localTodayIso,
  recordClock,
  recordSiblings,
} from "./archive-model";

export function RecordSwitch({
  persona,
  reducedMotion,
}: {
  persona?: string;
  reducedMotion: boolean;
}) {
  const t = useTranslations("recordSwitch");
  const tField = useTranslations("archiveField");
  const locale = useLocale();
  const { deskDoc, openDesk } = useShell();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const sliceId = deskDoc ? (parseRecordRef(deskDoc)?.sliceId ?? null) : null;

  // The bucket's record index: one read per opened record, quiet on failure
  // (the field's own rhythm — the switch simply does not appear).
  const [records, setRecords] = useState<ArchiveRecord[] | null>(null);
  useEffect(() => {
    if (sliceId === null) {
      setRecords(null);
      setOpen(false);
      return;
    }
    let live = true;
    getArchiveRecords(persona)
      .then((list) => {
        if (live) setRecords(list);
      })
      .catch(() => {
        if (live) setRecords([]);
      });
    return () => {
      live = false;
    };
  }, [sliceId, persona]);

  const today = useMemo(() => localTodayIso(), []);
  const siblings = useMemo(
    () =>
      sliceId !== null && records !== null
        ? recordSiblings(records, sliceId, today)
        : [],
    [records, sliceId, today],
  );

  // The panel's title carries the bucket's own label (the field's row-label
  // wording: the day, or the week's Monday).
  const bucketLabel = useMemo(() => {
    const openRecord = siblings.find((r) => r.sliceId === sliceId);
    if (!openRecord) return "";
    const bucket = bucketKeyFor(openRecord.date, today);
    const date = dateTimeFormat(locale, {
      month: "short",
      day: "numeric",
    }).format(new Date(`${bucket.date}T00:00:00`));
    return bucket.kind === "week" ? tField("weekOf", { date }) : date;
  }, [siblings, sliceId, today, locale, tField]);

  // The library's own rule (v0.25 R1-A): below lg a selection CLOSES the
  // panel — seeing the paper outranks keeping the list open. The signal is
  // the deskDoc changing, not a callback threaded through the rows.
  const lastDeskDocRef = useRef(deskDoc);
  useEffect(() => {
    if (deskDoc === lastDeskDocRef.current) return;
    lastDeskDocRef.current = deskDoc;
    if (
      deskDoc !== null &&
      open &&
      !window.matchMedia("(min-width: 1024px)").matches
    ) {
      setOpen(false);
    }
  }, [deskDoc, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Claim the key: the desk's backstop must not put the document back
        // underneath the still-open panel.
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // One record in the bucket = the pile's open already reaches it — no
  // control. Nothing on the desk, or a case/dossier, earns nothing either.
  if (siblings.length < 2) return null;

  return (
    <div
      ref={rootRef}
      data-record-switch
      // Mid-left, one toggle-height below the library's seat (mt-12 past
      // centre) — document picking lives on this edge; page turning is the
      // bottom-left bar's, and the two never share a seat.
      className="pointer-events-none fixed left-2 top-1/2 z-40 mt-12 -translate-y-1/2 md:left-4"
    >
      <button
        type="button"
        data-record-switch-toggle
        aria-expanded={open}
        aria-label={t("toggle", { date: bucketLabel })}
        onClick={() => setOpen((v) => !v)}
        className={`${ISLAND} pointer-events-auto flex size-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
      >
        <Files className="size-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            data-record-switch-panel
            role="dialog"
            aria-label={t("title", { date: bucketLabel })}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
            transition={
              reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }
            }
            // The library panel's own anchoring and width law (the toggle's
            // right edge, the viewport minus the chrome on a phone).
            className="pointer-events-auto absolute left-full top-1/2 ml-3 w-[min(16rem,calc(100vw-2rem))] max-md:w-[min(16rem,calc(100vw-68px))] -translate-y-1/2 rounded-2xl bg-background/90 shadow-md ring-1 ring-border/60 backdrop-blur-md"
          >
            {/* The header stays OUTSIDE the scroll area (the library's
                ruling: a phone has no Escape, so the way out is a control,
                visible at any scroll depth). */}
            <div className="flex items-center justify-between gap-2 pb-0.5 pl-4 pr-2 pt-2">
              <h2 className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                {t("title", { date: bucketLabel })}
              </h2>
              <button
                type="button"
                data-record-switch-close
                onClick={() => setOpen(false)}
                aria-label={t("close")}
                title={t("close")}
                className={`${ISLAND_CONTROL} size-6 shrink-0`}
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="max-h-[min(30rem,70dvh)] overflow-y-auto p-1.5">
              {siblings.map((record) => {
                const current = record.sliceId === sliceId;
                const clock = recordClock(record.sliceId);
                return (
                  <button
                    key={record.sliceId}
                    type="button"
                    data-record-switch-row={record.sliceId}
                    aria-current={current || undefined}
                    aria-label={t("rowAria", {
                      time: clock,
                      count: record.turns,
                    })}
                    onClick={() => openDesk(`records/${record.sliceId}`)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                      current ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <span className="font-mono text-xs tabular-nums">
                      {clock}
                    </span>
                    <span className="text-xs">
                      {t("turns", { count: record.turns })}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
