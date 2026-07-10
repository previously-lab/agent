import { getTranslations, setRequestLocale } from "next-intl/server";
import { SettingsForm } from "@/components/settings/settings-form";
import { loadUserProfile } from "@/lib/identity";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const profile = await loadUserProfile();

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">{t("pageTitle")}</h1>
      <p className="text-muted-foreground text-sm mb-8">
        {t("pageSubtitle")}
      </p>
      <SettingsForm initialProfile={profile} />
    </div>
  );
}
