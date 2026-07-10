"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { DEFAULT_MODELS, modelSupportsThinking } from "@/lib/models/registry";
import { saveUserProfile } from "@/lib/identity/actions";
import type { UserProfile } from "@/lib/identity";

export function SettingsForm({ initialProfile }: { initialProfile: UserProfile }) {
  const t = useTranslations("settings");

  // ── Profile (server-backed: memory/user/profile.md) ──
  const [name, setName] = useState(initialProfile.name ?? "");
  const [pronouns, setPronouns] = useState(initialProfile.pronouns ?? "");
  const [timezone, setTimezone] = useState(initialProfile.timezone ?? "");
  const [addressAs, setAddressAs] = useState(initialProfile.addressAs ?? "");
  const [about, setAbout] = useState(initialProfile.body ?? "");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // ── Chat model (client-only: localStorage) ──
  const [model, setModel] = useState("deepseek-chat");
  const [thinking, setThinking] = useState(true);

  useEffect(() => {
    setModel(localStorage.getItem("PREVIOUSLY_MODEL") ?? "deepseek-chat");
    setThinking(localStorage.getItem("PREVIOUSLY_THINKING") !== "false");
  }, []);

  const handleModelChange = (m: string) => {
    setModel(m);
    localStorage.setItem("PREVIOUSLY_MODEL", m);
  };
  const handleThinkingChange = (v: boolean) => {
    setThinking(v);
    localStorage.setItem("PREVIOUSLY_THINKING", String(v));
  };
  const thinkingSupported = modelSupportsThinking(model);

  const handleProfileSave = async () => {
    setSaving(true);
    setSavedMsg("");
    const res = await saveUserProfile({ name, pronouns, timezone, addressAs, body: about });
    setSaving(false);
    setSavedMsg(res.ok ? t("profile.saved") : t("profile.saveFailed"));
    if (res.ok) setTimeout(() => setSavedMsg(""), 2500);
  };

  const inputClass =
    "w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

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

      {/* Chat model */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">{t("form.modelSection")}</h3>
        <select value={model} onChange={(e) => handleModelChange(e.target.value)} className={inputClass}>
          {DEFAULT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
          <div>
            <span className="text-sm">{t("form.thinkingLabel")}</span>
            <p className="text-xs text-muted-foreground">{t("form.thinkingDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={thinking && thinkingSupported}
            disabled={!thinkingSupported}
            onClick={() => handleThinkingChange(!thinking)}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
              thinking && thinkingSupported ? "bg-primary" : "bg-muted"
            } ${thinkingSupported ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                thinking && thinkingSupported ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </section>
    </div>
  );
}
