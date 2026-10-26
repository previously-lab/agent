"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { ReaderHost } from "@/components/workspace/reader-host";
import { WorkspaceBrowser } from "@/components/workspace/workspace-browser";
import { WorkspaceRouteNav } from "@/components/workspace/workspace-route-nav";
import { RecordSwitch } from "@/components/archive/record-switch";
import type { DeskTexts } from "@/components/desk/desk-field";
import type {
  DeskDocumentObservation,
  DeskPageChange,
  DeskViewChange,
} from "@/components/desk/desk-model";
import { parseRecordRef } from "@/lib/archive/refs";
import {
  NativePersonaProvider,
  useNativeSourceScope,
} from "@/components/chat/native-source-scope";
import { useShell } from "@/components/shell/shell-provider";
import {
  deskTargetEqual,
  parseWorkspaceDocumentTarget,
  workspaceSurface,
} from "@/lib/workspace/navigation";
import "@/components/workspace/workspace.css";

export function AppShell() {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const persona = searchParams.get("persona") ?? undefined;
  const sourceScope = useNativeSourceScope();
  const lane = JSON.stringify([sourceScope, persona ?? "user"]);
  const reducedMotion = useReducedMotion() ?? false;
  const target = useMemo(() => parseWorkspaceDocumentTarget(search), [search]);
  const surface = workspaceSurface("/app", search);
  const {
    deskDoc,
    deskOpenOptions,
    deskNavigation,
    syncDeskRoute,
    resetDeskForLane,
    cleanupDesk,
    screen,
  } = useShell();
  const activeDocRef = useRef<string | null>(null);
  activeDocRef.current = target?.ref ?? null;
  const previousLaneRef = useRef(lane);

  useLayoutEffect(() => {
    if (previousLaneRef.current !== lane) {
      previousLaneRef.current = lane;
      resetDeskForLane();
      return;
    }
    syncDeskRoute(target);
  }, [lane, resetDeskForLane, syncDeskRoute, target]);

  useEffect(() => () => {
    cleanupDesk();
    screen.routeLeft();
  }, [cleanupDesk, screen]);

  const tDesk = useTranslations("desk");
  const deskTexts = useMemo<DeskTexts>(() => ({
    regionLabel: tDesk("regionLabel"),
    loading: tDesk("loading"),
    notFoundHeading: tDesk("notFoundHeading"),
    notFoundBody: (ref) => tDesk("notFoundBody", { ref }),
    prevPage: tDesk("prevPage"),
    nextPage: tDesk("nextPage"),
    pagePosition: (current, total) => tDesk("pagePosition", { current, total }),
    zoomOut: tDesk("zoomOut"),
    zoomIn: tDesk("zoomIn"),
    zoomReset: tDesk("zoomReset"),
    close: tDesk("close"),
    recordUserLabel: tDesk("recordUser"),
    recordAgentLabel: tDesk("recordAgent"),
  }), [tDesk]);

  const onDocumentObserved = useCallback((observation: DeskDocumentObservation) => {
    if (activeDocRef.current !== observation.docRef) return;
    const document = {
      ref: observation.docRef,
      title: observation.title,
      edition: observation.edition,
      page: observation.page,
      totalPages: observation.total,
    };
    const current = screen.getScreenContext()?.current;
    if (current?.kind === "document" || current?.kind === "task") {
      screen.documentObserved(document);
    } else {
      screen.documentOpened({ ...document, origin: "restored" });
    }
  }, [screen]);
  const onDocumentViewChange = useCallback((event: DeskViewChange) => {
    if (activeDocRef.current !== event.docRef) return;
    screen.documentOpened({
      ref: event.docRef,
      edition: event.view,
      page: event.page,
      origin: "manual",
    });
  }, [screen]);
  const onDocumentPageChange = useCallback((event: DeskPageChange) => {
    if (activeDocRef.current !== event.docRef) return;
    screen.documentPageChanged({
      ref: event.docRef,
      edition: event.view,
      page: event.page,
    });
  }, [screen]);

  if (surface === "game") return null;
  if (surface === "library") {
    return (
      <div className="workspace-shell" data-workspace-surface="library">
        <WorkspaceBrowser persona={persona} />
      </div>
    );
  }
  if (surface === "reader" && target) {
    const shellTarget = deskDoc ? { ref: deskDoc, options: deskOpenOptions ?? {} } : null;
    if (!deskTargetEqual(shellTarget, target)) return null;
    const relatedSlice = parseRecordRef(target.ref)?.sliceId ?? null;
    return (
      <div className="workspace-shell" data-workspace-surface="reader">
        <NativePersonaProvider value={persona ?? "user"}>
          <ReaderHost
            key={`${lane}:${deskNavigation.epoch}`}
            docRef={target.ref}
            initialLocation={deskNavigation.focus
              ? deskOpenOptions ?? target.options
              : undefined}
            reducedMotion={reducedMotion}
            texts={deskTexts}
            onDocumentObserved={onDocumentObserved}
            onViewChange={onDocumentViewChange}
            onPageChange={onDocumentPageChange}
          />
        </NativePersonaProvider>
        <RecordSwitch persona={persona} reducedMotion={reducedMotion} />
        <div className="workspace-reader-nav">
          <WorkspaceRouteNav current="reader" relatedSlice={relatedSlice} />
        </div>
      </div>
    );
  }
  return <main className="workspace-shell" data-workspace-surface="conversation" />;
}
