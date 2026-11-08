"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Check, MoreHorizontal, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface MessageActionsProps {
  content: string;
  response?: string;
  onRegenerate?: () => void;
}

export function MessageActions({ content, response, onRegenerate }: MessageActionsProps) {
  const t = useTranslations("chat.actions");
  const [copied, setCopied] = useState(false);

  const handleCopy = async (value: string, structured = false) => {
    try {
      await navigator.clipboard.writeText(value);
      if (structured) { toast.success(t("responseCopied")); return; }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { toast.error(t("copyFailed")); }
  };

  return (
    <div className="conversation-message-actions">
      {content && <button
        type="button"
        onClick={() => void handleCopy(content)}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors min-h-[28px]"
        title={copied ? t("copiedTooltip") : t("copyTooltip")}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        <span>{copied ? t("copied") : t("copy")}</span>
      </button>}
      {response && <DropdownMenu>
        <DropdownMenuTrigger className="px-2" aria-label={t("more")} title={t("more")}>
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => void handleCopy(response, true)}>{t("copyResponse")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
      {onRegenerate && (
        <button
          type="button"
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
