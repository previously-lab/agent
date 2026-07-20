/**
 * Persona selection via cookie — survives Server Action ↔ Server Component
 * boundaries where module-level state does not.
 */
import { cookies } from "next/headers";

const COOKIE = "previously-persona";
const DEFAULT = "personal_14";

export async function getPersonaId(): Promise<string> {
  const c = await cookies();
  return c.get(COOKIE)?.value ?? DEFAULT;
}

export async function setPersonaId(personaId: string): Promise<void> {
  const c = await cookies();
  c.set(COOKIE, personaId, {
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    sameSite: "lax",
  });
}
