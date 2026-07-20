"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

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
  const searchParams = useSearchParams();

  function handleSelect(personaId: string) {
    if (personaId === currentId) {
      onOpenChange(false);
      return;
    }
    onOpenChange(false);

    // Build target URL with persona query param
    const params = new URLSearchParams(searchParams.toString());
    params.set("persona", personaId);
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "/");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!sm:max-w-xl max-h-[85vh] overflow-y-auto">
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
              }`}
              onClick={() => handleSelect(p.id)}
            >
              <CardHeader>
                <CardTitle className="text-sm">{p.name}</CardTitle>
                {p.blurb && (
                  <CardDescription className="text-xs line-clamp-3">
                    {p.blurb}
                  </CardDescription>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
