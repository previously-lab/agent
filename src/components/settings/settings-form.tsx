"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { saveUserProfile } from "@/lib/identity/actions";
import { saveUserConfig } from "@/lib/config/actions";
import type { UserProfile } from "@/lib/identity";
import type { UserConfig } from "@/lib/config/types";

export function SettingsForm({
  initialProfile,
  initialConfig,
}: {
  initialProfile: UserProfile;
  initialConfig: UserConfig;
}) {
  const t = useTranslations("settings");

  // ── Profile (server-backed: memory/user/profile.md) ──
  const [name, setName] = useState(initialProfile.name ?? "");
  const [pronouns, setPronouns] = useState(initialProfile.pronouns ?? "");
  const [timezone, setTimezone] = useState(initialProfile.timezone ?? "");
  const [addressAs, setAddressAs] = useState(initialProfile.addressAs ?? "");
  const [about, setAbout] = useState(initialProfile.body ?? "");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // ── Config (server-backed: memory/user/config.json) ──
  const [maxTurnsPerSlice, setMaxTurnsPerSlice] = useState(initialConfig.slicing.maxTurnsPerSlice);
  const [timeSilenceMinutes, setTimeSilenceMinutes] = useState(initialConfig.slicing.timeSilenceMinutes);
  const [recentTurnsLimit, setRecentTurnsLimit] = useState(initialConfig.context.recentTurnsLimit);
  const [tokenBudget, setTokenBudget] = useState(initialConfig.context.tokenBudget);
  const [modelProvider, setModelProvider] = useState(initialConfig.model.provider);
  const [modelThinking, setModelThinking] = useState(initialConfig.model.thinking);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSavedMsg, setConfigSavedMsg] = useState("");

  const handleProfileSave = async () => {
    setSaving(true);
    setSavedMsg("");
    const res = await saveUserProfile({ name, pronouns, timezone, addressAs, body: about });
    setSaving(false);
    setSavedMsg(res.ok ? t("profile.saved") : t("profile.saveFailed"));
    if (res.ok) setTimeout(() => setSavedMsg(""), 2500);
  };

  const handleConfigSave = async () => {
    setConfigSaving(true);
    setConfigSavedMsg("");
    const res = await saveUserConfig({
      slicing: { maxTurnsPerSlice, timeSilenceMinutes },
      context: { recentTurnsLimit, tokenBudget },
      model: { provider: modelProvider, thinking: modelThinking },
    });
    setConfigSaving(false);
    setConfigSavedMsg(res.ok ? t("config.saved") : t("config.saveFailed"));
    if (res.ok) setTimeout(() => setConfigSavedMsg(""), 2500);
  };

  const inputClass =
    "w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
  const numberInputClass =
    "w-24 px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-8">
      {/* Profile */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-1">{t("profile.heading")}</h3>
        <p className="text-xs text-muted-foreground mb-4">{t("profile.desc")}</p>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("profile.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("profile.namePlaceholder")} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("profile.pronouns")}</span>
              <input value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder={t("profile.pronounsPlaceholder")} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("profile.addressAs")}</span>
              <input value={addressAs} onChange={(e) => setAddressAs(e.target.value)} placeholder={t("profile.addressAsPlaceholder")} className={inputClass} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("profile.timezone")}</span>
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={t("profile.timezonePlaceholder")} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("profile.about")}</span>
            <textarea value={about} onChange={(e) => setAbout(e.target.value)} placeholder={t("profile.aboutPlaceholder")} rows={4} className={`${inputClass} resize-y`} />
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={handleProfileSave} disabled={saving}>
              {saving ? t("profile.saving") : t("profile.save")}
            </Button>
            {savedMsg && <span className="text-xs text-muted-foreground">{savedMsg}</span>}
          </div>
        </div>
      </section>

      {/* Config — tunable agent behaviour (memory/user/config.json) */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-1">{t("config.heading")}</h3>
        <p className="text-xs text-muted-foreground mb-4">{t("config.desc")}</p>
        <div className="space-y-4">
          {/* Slicing */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.maxTurnsPerSlice")}</span>
              <input type="number" min={5} max={100} value={maxTurnsPerSlice} onChange={(e) => setMaxTurnsPerSlice(Number(e.target.value))} className={numberInputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.timeSilenceMinutes")}</span>
              <input type="number" min={5} max={120} value={timeSilenceMinutes} onChange={(e) => setTimeSilenceMinutes(Number(e.target.value))} className={numberInputClass} />
            </label>
          </div>
          {/* Context */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.recentTurnsLimit")}</span>
              <input type="number" min={3} max={60} value={recentTurnsLimit} onChange={(e) => setRecentTurnsLimit(Number(e.target.value))} className={numberInputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.tokenBudget")}</span>
              <input type="number" min={2000} max={64000} step={1000} value={tokenBudget} onChange={(e) => setTokenBudget(Number(e.target.value))} className={numberInputClass} />
            </label>
          </div>
          {/* Model */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.modelProvider")}</span>
              <select value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} className={inputClass}>
                <option value="deepseek-chat">deepseek-chat</option>
                <option value="deepseek-reasoner">deepseek-reasoner</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-2">
              <input type="checkbox" checked={modelThinking} onChange={(e) => setModelThinking(e.target.checked)} className="h-4 w-4" />
              <span className="text-xs text-muted-foreground">{t("config.thinking")}</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={handleConfigSave} disabled={configSaving}>
              {configSaving ? t("config.saving") : t("config.save")}
            </Button>
            {configSavedMsg && <span className="text-xs text-muted-foreground">{configSavedMsg}</span>}
          </div>
        </div>
      </section>

    </div>
  );
}
