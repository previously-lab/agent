"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

const DOCS_URL = "https://previously.ldwid.com/docs/deployment";

export function DemoToast() {
  const t = useTranslations("demo");

  useEffect(() => {
    const id = toast(t("toastTitle"), {
      description: t("toastDesc"),
      duration: Infinity,
      action: {
        label: t("setupAction"),
        onClick: () => {
          window.open(DOCS_URL, "_blank");
          toast.dismiss(id);
        },
      },
      cancel: {
        label: t("dismissAction"),
        onClick: () => toast.dismiss(id),
      },
    });
    return () => toast.dismiss(id);
  }, [t]);

  return null;
}
