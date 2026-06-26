import { setRequestLocale } from "next-intl/server";
import { SettingsForm } from "@/components/settings/settings-form";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Settings</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Configure your GitHub repository connection.
      </p>
      <SettingsForm />
    </div>
  );
}
