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
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose a Persona</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-4">
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
                  {p.sliceCount} sessions · {p.dateRange[0]} → {p.dateRange[1]}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1">
                  {p.topics.slice(0, 5).map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded-md bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
