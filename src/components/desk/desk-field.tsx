"use client";

/**
 * The document desk (v0.22 P1) — one tabletop plane, one light, one document
 * in the EXISTING field world. The desk is the card field's mutually
 * exclusive pane mate: while `deskDoc` is set, CardField is unmounted and
 * this component registers `DeskScene` into the SAME field world slot
 * (`useWorldScene("field", …)`). The render chain is untouched — the field
 * renderer draws whatever subtree the slot holds.
 *
 * THE SLOT HANDSHAKE. Slot registration is last-write-wins with an
 * unconditional null cleanup (world-slot.tsx), so two owners may never be
 * mounted at once. That sequencing is NOT done here: app-shell mounts this
 * component only after the card field's exit completed (and holds the card
 * field's return until this one's exit completes), so by the time DeskScene
 * registers, the slot is already free.
 *
 * THE DESK OWNS THE CAMERA. Per-frame camera writes — including the
 * `camXOffset` half-band shift that centres content in the pane — are the
 * slot owner's job (FieldScene does the same for the cards); without the
 * offset the paper would sit under the left rail.
 *
 * I18N ACROSS THE PORTAL. drei's `<Html>` mounts the paper in the Canvas's
 * own React root. The desk's few UI strings arrive as PROPS (the
 * FrameCardTexts pattern); the markdown body keeps its real components
 * (CodeBlock and friends call hooks), so it is re-wrapped in
 * `NextIntlClientProvider` — the conversation field's BillboardBlock
 * pattern.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { usePresence } from "motion/react";
import { useTheme } from "@teispace/next-themes";
import {
  NextIntlClientProvider,
  useLocale,
  useMessages,
} from "next-intl";
import { useShell } from "@/components/shell/shell-provider";
import { useWorldScene } from "@/components/timeline-3d/world-slot";
import { camZFor, clipPlanesFor } from "@/lib/timeline3d/camera";
import {
  getCaseDoc,
  type CaseDocContent,
} from "@/lib/episodic/actions";
import { MarkdownRenderer } from "@/components/chat/markdown";
import {
  deskPaperModel,
  DOC_FIRST_PAGE,
  recessIntensityFor,
  type DeskPaperModel,
} from "./desk-model";
import "./desk.css";

/** The desk's UI strings, injected from OUTSIDE the Canvas (next-intl
 *  context does not cross the Html portal — see the module header). */
export interface DeskTexts {
  /** aria-label of the desk region — carries the Escape affordance. */
  regionLabel: string;
  /** The body line while the document is in flight. */
  loading: string;
  /** The dead-link paper's heading. */
  notFoundHeading: string;
  /** The dead-link paper's body line. */
  notFoundBody(ref: string): string;
  /** The footer's category name (the shelf's translated category keys). */
  categoryName(category: string): string;
  /** The footer's centred page number, the `· 1 ·` form. */
  page(n: number): string;
}

/** The entrance/exit beat, seconds — the pane swap's own 300 ms. */
const DESK_BEAT_S = 0.3;

export function DeskField({
  docRef,
  camXOffset,
  reducedMotion,
  texts,
}: {
  /** The open document's reference (`deskDoc` — never null here: app-shell
   *  mounts the desk only when a ref is set). */
  docRef: string;
  /** The field camera's half-band x shift (the shell's same value the card
   *  field gets) — the desk writes its own camera, offset included. */
  camXOffset: number;
  reducedMotion: boolean;
  texts: DeskTexts;
}) {
  const { closeDesk } = useShell();
  const locale = useLocale();
  const messages = useMessages();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  // Presence rides the pane's AnimatePresence: false while this branch plays
  // its exit — the scene gets it as a PROP because presence context, like
  // every context, stops at the Canvas root.
  const [isPresent] = usePresence();

  // The document arrives lazily, one server-action round trip per open —
  // the shelf's own rhythm. `undefined` = in flight; null = dead link (the
  // not-found paper); a throw surfaces as the same not-found paper.
  const [doc, setDoc] = useState<CaseDocContent | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDoc(undefined);
    getCaseDoc(docRef)
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch(() => {
        if (live) setDoc(null);
      });
    return () => {
      live = false;
    };
  }, [docRef]);
  const loading = doc === undefined;
  const model = useMemo(
    () => deskPaperModel(docRef, doc ?? null),
    [docRef, doc],
  );

  // The field world's slot — registered on every render, cleared at unmount
  // (app-shell guarantees the card field remounts only after that).
  useWorldScene(
    "field",
    <DeskScene
      model={model}
      docRef={docRef}
      loading={loading}
      texts={texts}
      locale={locale}
      messages={messages}
      dark={dark}
      camXOffset={camXOffset}
      reducedMotion={reducedMotion}
      exiting={!isPresent}
    />,
  );

  // Escape puts the document back. Two bindings because the paper lives in
  // the canvas's Html portal — OUTSIDE this wrapper's DOM subtree — so a
  // keydown with focus inside the paper never reaches the wrapper. The
  // window backstop defers to any inner handler that already claimed the
  // key (defaultPrevented).
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wrapRef.current?.focus();
  }, []);
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDesk();
      }
    },
    [closeDesk],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeDesk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDesk]);

  return (
    <div
      ref={wrapRef}
      data-desk-field
      // Focusable so the Escape binding has somewhere to listen — the card
      // field's wrapper pattern. The desk's whole DOM presence is this
      // region; the paper arrives back over it as the Html portal.
      tabIndex={0}
      role="region"
      aria-label={texts.regionLabel}
      onKeyDown={onKeyDown}
      className="relative h-full w-full outline-none"
    />
  );
}

function DeskScene({
  model,
  docRef,
  loading,
  texts,
  locale,
  messages,
  dark,
  camXOffset,
  reducedMotion,
  exiting,
}: {
  model: DeskPaperModel;
  docRef: string;
  loading: boolean;
  texts: DeskTexts;
  locale: string;
  messages: ReturnType<typeof useMessages>;
  dark: boolean;
  camXOffset: number;
  reducedMotion: boolean;
  exiting: boolean;
}) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);

  // The clip planes follow the viewport because the camera DISTANCE does
  // (camera.ts) — the same correction FieldScene applies, before paint.
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const { near, far } = clipPlanesFor(size.height);
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, size.height]);

  // The tabletop: one big plane behind the paper, sized to cover the view
  // at its depth (a plane d behind the focal plane renders camZ/(camZ+d)
  // of its size). Parallel to the sheet, never turned.
  const table = useMemo(() => {
    const camZ = camZFor(size.height);
    const d = camZ * 0.22;
    const grow = ((camZ + d) / camZ) * 1.12;
    return { d, w: size.width * grow, h: size.height * grow };
  }, [size.width, size.height]);

  const animRef = useRef({ t: 0 });
  const groupRef = useRef<THREE.Group>(null);
  const tableMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const paperRef = useRef<HTMLDivElement>(null);

  // THE SWAP RE-PLAYS THE PULL-OUT (v0.23): the reader stays mounted while
  // `docRef` changes (picking another document in the library column), and
  // the entrance beat runs again for the new sheet — the paper dips below
  // the viewport and rises with the fresh content instead of swapping in
  // place. The write happens during render so no frame flashes the old
  // sheet with the new ref's loading state (the ref write is idempotent).
  const lastDocRefRef = useRef(docRef);
  if (lastDocRefRef.current !== docRef) {
    lastDocRefRef.current = docRef;
    animRef.current.t = 0;
  }

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const anim = animRef.current;
    // The pull-out (v0.22 §3): in, the paper rises from below the viewport
    // over the pane's own 300 ms; out, the same beat reversed. Reduced
    // motion keeps only the opacity leg.
    anim.t = THREE.MathUtils.clamp(
      anim.t + (exiting ? -dt : dt) / DESK_BEAT_S,
      0,
      1,
    );
    const eased = 1 - Math.pow(1 - anim.t, 3);

    // THE CAMERA IS THE DESK'S (see the module header): the same parallel
    // shift FieldScene writes — camXOffset parks the view half a band-width
    // left so the paper sits centred in the PANE. No scroll drift, never
    // a turn.
    const camZ = camZFor(size.height);
    camera.position.set(camXOffset, 0, camZ);
    camera.lookAt(camXOffset, 0, 0);

    const group = groupRef.current;
    if (group) {
      group.position.y = reducedMotion
        ? 0
        : (1 - eased) * -size.height * 0.6;
    }
    if (tableMatRef.current) tableMatRef.current.opacity = anim.t;
    const paper = paperRef.current;
    if (paper) paper.style.opacity = `${anim.t}`;
  });

  const bodyRef = useRef<HTMLDivElement>(null);
  const topVeilRef = useRef<HTMLDivElement>(null);
  const bottomVeilRef = useRef<HTMLDivElement>(null);
  // The edge veils (§11.4): a little of the paper's own tone veils the text
  // at whichever end has more page beyond it; at the end stops, none.
  const syncVeils = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const beyond = 4;
    if (topVeilRef.current) {
      topVeilRef.current.style.opacity = el.scrollTop > beyond ? "1" : "0";
    }
    if (bottomVeilRef.current) {
      bottomVeilRef.current.style.opacity =
        el.scrollHeight - el.scrollTop - el.clientHeight > beyond ? "1" : "0";
    }
  }, []);
  useEffect(() => {
    syncVeils();
  }, [model.markdown, loading, syncVeils]);

  // §12.2 — pointermove rewrites the paper-scoped --recess-i (0.7–1.3),
  // reaching only the header date and the page number. The global light
  // field is never touched.
  const onPaperPointerMove = useCallback((e: ReactPointerEvent) => {
    const el = paperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    el.style.setProperty("--recess-i", recessIntensityFor(relY).toFixed(3));
  }, []);

  return (
    <>
      {/* The one light: upper-left, where the house light lives (the CSS
          light field's 30%/22% default). Ambient keeps the plate readable
          in both themes. */}
      <ambientLight intensity={dark ? 0.55 : 0.75} />
      <directionalLight
        position={[-size.width * 0.3, size.height * 0.45, camZFor(size.height) * 0.6]}
        intensity={dark ? 1.1 : 0.9}
      />
      <mesh position={[0, 0, -table.d]}>
        <planeGeometry args={[table.w, table.h]} />
        <meshStandardMaterial
          ref={tableMatRef}
          // A tone step off the field's backdrop — the sheet separates by
          // its contact shadow, not by a bright slab. GL colours are hex
          // literals (the CSS tokens don't reach here), pinned to the
          // paper's cool hue family; both themes are an acceptance point.
          color={dark ? 0x23242b : 0xd8dae3}
          roughness={0.95}
          metalness={0}
          transparent
          opacity={0}
        />
      </mesh>
      <group ref={groupRef}>
        <Html
          transform
          center
          // 400 is drei's 1:1 reference at this camera (see row-group.tsx):
          // the paper's DOM px are world units, so print sizes stay honest.
          distanceFactor={400}
          zIndexRange={[30, 21]}
          pointerEvents="auto"
        >
          <div
            ref={paperRef}
            data-locale={locale}
            className="desk-paper bg-paper bg-paper-grain-card shadow-paper-contact relative flex flex-col overflow-hidden rounded-sm text-card-foreground"
            onPointerMove={onPaperPointerMove}
          >
            <header className="desk-head flex items-baseline justify-between gap-8">
              <span className="truncate">{model.caseRef ?? model.title}</span>
              <span className="desk-recess shrink-0 tabular-nums">
                {model.date}
              </span>
            </header>

            <div className="desk-bodywrap">
              <div ref={bodyRef} className="desk-body" onScroll={syncVeils}>
                {loading ? (
                  <p className="desk-note">{texts.loading}</p>
                ) : model.markdown === null ? (
                  <>
                    <h1 className="desk-title">{texts.notFoundHeading}</h1>
                    <p className="desk-note">{texts.notFoundBody(docRef)}</p>
                  </>
                ) : (
                  <>
                    <h1 className="desk-title">{model.title}</h1>
                    {/* The body keeps its real components (CodeBlock's hooks
                        included) — re-wrapped in intl context, the
                        conversation field's BillboardBlock pattern. */}
                    <NextIntlClientProvider messages={messages} locale={locale}>
                      <MarkdownRenderer content={model.markdown} />
                    </NextIntlClientProvider>
                  </>
                )}
              </div>
              <div
                ref={topVeilRef}
                aria-hidden
                className="desk-veil desk-veil-top"
              />
              <div
                ref={bottomVeilRef}
                aria-hidden
                className="desk-veil desk-veil-bottom"
              />
            </div>

            <footer className="desk-foot flex items-baseline">
              <span className="flex-1" />
              <span className="desk-recess tabular-nums">{texts.page(DOC_FIRST_PAGE)}</span>
              <span className="flex-1 truncate text-right">
                {model.category ? texts.categoryName(model.category) : ""}
              </span>
            </footer>
          </div>
        </Html>
      </group>
    </>
  );
}
