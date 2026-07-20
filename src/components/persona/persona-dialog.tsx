"use client";

import { useSearchParams } from "next/navigation";
import { usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("persona");
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleSelect(personaId: string) {
    if (personaId === currentId) {
      onOpenChange(false);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("persona", personaId);
    window.location.href = `${pathname}?${params.toString()}`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto"
        style={{ maxWidth: "48rem" }}
      >
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
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
