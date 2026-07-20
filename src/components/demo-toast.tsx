"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";

const DOCS_URL = "https://previously.ldwid.com/docs/deployment";
const DISMISSED_KEY = "previously-demo-toast-dismissed";

export function DemoToast() {
  const t = useTranslations("demo");

  useEffect(() => {
    if (sessionStorage.getItem(DISMISSED_KEY)) return;

    toast(t("toastTitle"), {
      description: t("toastDesc"),
      duration: Infinity,
      dismissible: true,
      onDismiss: () => sessionStorage.setItem(DISMISSED_KEY, "1"),
      action: {
        label: t("setupAction"),
        onClick: () => {
          sessionStorage.setItem(DISMISSED_KEY, "1");
          window.open(DOCS_URL, "_blank");
          toast.dismiss();
        },
      },
      cancel: {
        label: t("dismissAction"),
        onClick: () => sessionStorage.setItem(DISMISSED_KEY, "1"),
      },
    });
  }, [t]);

  return null;
}
