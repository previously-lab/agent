import { getUserName } from "@/lib/identity";
import { getDemoPersona, listDemoPersonas } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { HeroText } from "./hero-text";
import { PersonaDialogWrapper } from "@/components/persona/persona-dialog-wrapper";

export async function HeroSection({ personaId }: { personaId?: string }) {
  const source = resolveDataSource();

  if (source === "demo") {
    const currentId = personaId || getDemoPersona();
    const personas = await listDemoPersonas().catch(() => []);
    const current = personas.find((p) => p.id === currentId);
    const name = current?.name ?? currentId;

    return (
      <PersonaDialogWrapper
        personas={personas}
        currentId={currentId}
        personaName={name}
      />
    );
  }

  // Normal mode — user's own name
  const name = await getUserName();
  return <HeroText name={name} />;
}
