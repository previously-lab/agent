"use client";

import { useState } from "react";
import { HeroText } from "@/components/chat/hero-text";
import { PersonaDialog } from "@/components/persona/persona-dialog";

interface PersonaInfo {
  id: string;
  name: string;
  description: string;
  blurb?: string;
  topics: string[];
  sliceCount: number;
  dateRange: string[];
  tree?: Record<string, unknown>;
}

export function PersonaDialogWrapper({
  personas,
  currentId,
  personaName,
}: {
  personas: PersonaInfo[];
  currentId: string;
  personaName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <HeroText
        name={personaName}
        clickable
        onNameClick={() => setOpen(true)}
      />
      <PersonaDialog
        personas={personas}
        currentId={currentId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
