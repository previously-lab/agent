"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Check, RefreshCw } from "lucide-react";

interface MessageActionsProps {
  content: string;
  onRegenerate?: () => void;
}

export function MessageActions({ content, onRegenerate }: MessageActionsProps) {
  const t = useTranslations("chat.actions");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors min-h-[28px]"
        title={copied ? t("copiedTooltip") : t("copyTooltip")}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        <span>{copied ? t("copied") : t("copy")}</span>
      </button>
      {onRegenerate && (
        <button
          onClick={onRegenerate}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors min-h-[28px]"
          title={t("regenerateTooltip")}
        >
          <RefreshCw className="h-3 w-3" />
          <span>{t("regenerate")}</span>
        </button>
      )}
    </div>
  );
}
