"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("settings.error");
  const tCommon = useTranslations("common");
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-md">
        <AlertCircle className="h-8 w-8 mx-auto mb-3 text-destructive" />
        <h2 className="font-semibold mb-1">{t("title")}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {error.message || t("message")}
        </p>
        <Button variant="outline" onClick={reset}>
          {tCommon("retry")}
        </Button>
      </div>
    </div>
  );
}
