"use client";

import {
  DeskField,
  type DeskSourceOpen,
  type DeskTexts,
} from "@/components/desk/desk-field";
import type {
  DeskDocumentObservation,
  DeskPageChange,
  DeskViewChange,
} from "@/components/desk/desk-model";
import type { DeskOpenOptions } from "@/lib/workspace/navigation";

export interface ReaderHostProps {
  docRef: string;
  initialLocation?: DeskOpenOptions;
  reducedMotion: boolean;
  texts: DeskTexts;
  leaving?: boolean;
  onDocumentObserved?: (observation: DeskDocumentObservation) => void;
  onViewChange?: (event: DeskViewChange) => void;
  onPageChange?: (event: DeskPageChange) => void;
  onSourceOpen?: (event: DeskSourceOpen) => void;
}

export function ReaderHost({
  docRef,
  initialLocation,
  reducedMotion,
  texts,
  leaving = false,
  onDocumentObserved,
  onViewChange,
  onPageChange,
  onSourceOpen,
}: ReaderHostProps) {
  return (
    <div data-workspace-reader-host className="workspace-reader-host">
      <DeskField
        docRef={docRef}
        initialLocation={initialLocation}
        camXOffset={0}
        reducedMotion={reducedMotion}
        texts={texts}
        leaving={leaving}
        onDocumentObserved={onDocumentObserved}
        onViewChange={onViewChange}
        onPageChange={onPageChange}
        onSourceOpen={onSourceOpen}
      />
    </div>
  );
}
