"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
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

    </div>
  );
}
