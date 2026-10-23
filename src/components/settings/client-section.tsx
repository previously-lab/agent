"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

interface ClientStatus {
  mode: string;
  version: string;
  memoryRoot: string | null;
  home: string | null;
}

interface ClientConfig {
  home: string | null;
  exists: boolean;
  byok: { provider: "deepseek"; model: "deepseek-flash"; configured: boolean; keyPreview?: string } | null;
}

/** The server returns credential status only. A saved key is never hydrated
 * into an input or sent back unchanged by a settings refresh. */
export function ClientSection() {
  const t = useTranslations("settings.client");
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/client/status", { signal: controller.signal });
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
        const runtime = await response.json() as ClientStatus;
        if (!alive.current) return;
        setStatus(runtime);
        const settings = await fetch("/api/client/config", { signal: controller.signal });
        if (!settings.ok) throw new Error(`Config HTTP ${settings.status}`);
        const body = await settings.json() as ClientConfig;
        if (alive.current) setConfig(body);
      } catch (cause) {
        if (alive.current && !controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { alive.current = false; controller.abort(); };
  }, []);

  const saveKey = async (apiKey: string) => {
    if (saving || !config?.home) return;
    setSaving(true);
    try {
      const response = await fetch("/api/client/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ byok: { provider: "deepseek", model: "deepseek-flash", apiKey } }),
      });
      const body = await response.json() as ClientConfig & { error?: string };
      if (!response.ok) throw new Error(body.error || t("saveFailed"));
      if (alive.current) { setConfig(body); setKeyDraft(""); toast.success(t("saved")); }
    } catch (cause) {
      if (alive.current) toast.error(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  if (!status) return loadError ? <p className="text-xs text-red-500">{t("loadFailed")}: {loadError}</p> : null;

  return (
    <section data-slot="settings-client" className="space-y-8">
      <div className="space-y-1">
        <h3 className="text-base font-medium">{t("heading")}</h3>
        <p className="text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      {loadError && <p className="text-xs text-red-500">{t("loadFailed")}: {loadError}</p>}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">{t("statusHeading")}</h4>
        <Table><TableBody>
          <TableRow><TableCell className="w-36 text-muted-foreground">{t("versionLabel")}</TableCell><TableCell>v{status.version} · {status.mode}</TableCell></TableRow>
          <TableRow><TableCell className="w-36 text-muted-foreground">{t("homeLabel")}</TableCell><TableCell className="whitespace-normal break-all">{status.home ?? t("homeMissing")}</TableCell></TableRow>
          <TableRow><TableCell className="w-36 text-muted-foreground">{t("memoryRootLabel")}</TableCell><TableCell className="whitespace-normal break-all">{status.memoryRoot ?? "—"}</TableCell></TableRow>
          <TableRow><TableCell className="w-36 text-muted-foreground">{t("byokModelLabel")}</TableCell><TableCell>DeepSeek Flash</TableCell></TableRow>
        </TableBody></Table>
      </div>
      {config && <>
        <Separator />
        <div className="space-y-4">
          <h4 className="text-sm font-medium">DeepSeek API</h4>
          <p className="text-sm text-muted-foreground">{t("byokDesc")}</p>
          <p role="status" className="text-xs text-muted-foreground">{t(config.byok?.configured ? "keyConfigured" : "keyMissing")}</p>
          <Label className="block space-y-1">
            <span className="text-xs font-normal text-muted-foreground">{t(config.byok?.configured ? "keyReplace" : "byokApiKeyLabel")}</span>
            <Input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder="sk-…" autoComplete="off" disabled={saving} />
          </Label>
          <div className="flex gap-3">
            <button type="button" disabled={saving || !keyDraft.trim()} onClick={() => void saveKey(keyDraft.trim())} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40">{t(saving ? "keySaving" : "keySave")}</button>
            {config.byok?.configured && <button type="button" disabled={saving} onClick={() => void saveKey("")} className="rounded-md border px-3 py-1.5 text-sm text-destructive disabled:opacity-40">{t("keyRemove")}</button>}
          </div>
          <p className="text-xs text-muted-foreground/60">{t("applyHint")}</p>
        </div>
      </>}
    </section>
  );
}
