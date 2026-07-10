import { getUserName } from "@/lib/identity";
import { HeroText } from "./hero-text";

export async function HeroSection() {
  // Name comes from memory/user/profile.md (loaded live); falls back to "You".
  const name = await getUserName();
  return <HeroText name={name} />;
}
