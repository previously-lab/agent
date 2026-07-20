import { getUserName } from "@/lib/identity";
import { getDemoPersona, listDemoPersonas } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { loadUserConfig } from "@/lib/config/loader";
import { HeroText } from "./hero-text";
import { PersonaDialogWrapper } from "@/components/persona/persona-dialog-wrapper";

export async function HeroSection() {
  const source = resolveDataSource();
  const config = await loadUserConfig();

  if (source === "demo") {
    const personaId = await getDemoPersona();
    const personas = await listDemoPersonas().catch(() => []);
    const current = personas.find((p) => p.id === personaId);
    const name = current?.name ?? personaId;

    return (
      <PersonaDialogWrapper
        personas={personas}
        currentId={personaId}
        personaName={name}
      />
    );
  }

  // Normal mode — user's own name
  const isOnboarded = config.onboarded ?? false;
  if (!isOnboarded && source === "github") {
    // New user with their own repo — still show onboarding
    const personaId = "personal_14";
    const personas = await listDemoPersonas().catch(() => []);
    return (
      <PersonaDialogWrapper
        personas={personas}
        currentId={personaId}
        personaName="You"
      />
    );
  }

  const name = await getUserName();
  return <HeroText name={name} />;
}
