import { getUserName } from "@/lib/identity";
import { getDemoPersona, listDemoPersonas } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { loadUserConfig } from "@/lib/config/loader";
import { HeroText } from "./hero-text";
import { PersonaDialogWrapper } from "@/components/persona/persona-dialog-wrapper";

export async function HeroSection() {
  const source = resolveDataSource();
  const config = await loadUserConfig();
  const isOnboarded = config.onboarded ?? false;

  if (source === "demo" || (source === "github" && !isOnboarded)) {
    // Show persona selector
    const personaId = getDemoPersona();
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

  // Normal mode — show user's own name
  const name = await getUserName();
  return <HeroText name={name} />;
}
