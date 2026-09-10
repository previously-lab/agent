"use client";

import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { checkForUpdate, type UpdateInfo } from "@/lib/version/actions";
import { APP_VERSION } from "@/lib/version/constants";

/**
 * Version badge, two renderings:
 * - "popover" (default): the standalone pill + update-details popover.
 * - "menu": rows for the nav overflow menu — a version label (with the
 *   update dot) plus release-notes / how-to-sync links when an update is
 *   available. Rendered inside the DropdownMenu tree from nav-overflow-menu.
 */
export function VersionBadge({ variant = "popover" }: { variant?: "popover" | "menu" }) {
  const t = useTranslations("nav");
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    checkForUpdate().then(setInfo).catch(() => {});
  }, []);

  if (variant === "menu") {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between font-normal">
            <span className="flex items-center gap-1.5">
              {t("versionLabel")}
              {info?.updateAvailable && (
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              )}
            </span>
            <span className="font-mono text-foreground">v{APP_VERSION}</span>
          </DropdownMenuLabel>
          {info?.updateAvailable && info.latest && (
            <>
              <DropdownMenuItem
                render={
                  <Link
                    href="https://github.com/previously-lab/agent/releases"
                    target="_blank"
                  />
                }
              >
                {t("releaseNotes")}
                <ExternalLink className="ml-auto" />
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href={info.docsUrl} target="_blank" />}
              >
                {t("howToSync")}
                <ExternalLink className="ml-auto" />
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuGroup>
      </>
    );
  }

  const trigger = (
    <button
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      title={`v${APP_VERSION}`}
    >
      v{APP_VERSION}
      {info?.updateAvailable && (
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      )}
    </button>
  );

  if (!info) return trigger;

  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-56 p-3 text-xs"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Current</span>
            <span className="font-mono font-medium">v{info.current}</span>
          </div>

          {info.updateAvailable && info.latest ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Latest</span>
                <span className="font-mono font-medium text-green-600 dark:text-green-400">v{info.latest}</span>
              </div>
              <hr className="border-border" />
              <Link
                href="https://github.com/previously-lab/agent/releases"
                target="_blank"
                className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400 hover:underline w-full"
              >
                View release notes
                <ExternalLink className="h-3 w-3" />
              </Link>
              <Link
                href={info.docsUrl}
                target="_blank"
                className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400 hover:underline w-full"
              >
                How to sync
                <ExternalLink className="h-3 w-3" />
              </Link>
              <p className="text-muted-foreground/70 text-[10px] leading-snug">
                Go to Settings → Sync from upstream to pull the latest code.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">You&apos;re on the latest version.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
