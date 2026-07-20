"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { selectPersona } from "@/lib/demo/persona-actions";

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

export function PersonaDialog({
  personas,
  currentId,
  open,
  onOpenChange,
}: {
  personas: PersonaInfo[];
  currentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);

  async function handleSelect(personaId: string) {
    if (personaId === currentId) {
      onOpenChange(false);
      return;
    }
    setSwitching(personaId);
    try {
      await selectPersona(personaId);
      router.refresh();
    } finally {
      setSwitching(null);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose a Persona</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          {personas.map((p) => (
            <Card
              key={p.id}
              size="sm"
              className={`cursor-pointer transition-all hover:ring-2 hover:ring-primary/50 ${
                p.id === currentId ? "ring-2 ring-primary" : ""
              } ${switching === p.id ? "opacity-50 pointer-events-none" : ""}`}
              onClick={() => handleSelect(p.id)}
            >
              <CardHeader>
                <CardTitle className="text-sm">{p.name}</CardTitle>
                <CardDescription className="text-xs">
                  {p.blurb || `${p.sliceCount} sessions · ${p.dateRange[0]} → ${p.dateRange[1]}`}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
